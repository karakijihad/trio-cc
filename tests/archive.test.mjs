import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, existsSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveOldRuns, archiveDir, isoWeek, archivedHint } from "../src/archive.mjs";
import { runDir, activeMarker } from "../src/paths.mjs";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const run = (root, id, iso) => {
  mkdirSync(runDir(root, id), { recursive: true });
  const t = new Date(iso);
  utimesSync(runDir(root, id), t, t);
};

test("isoWeek matches ISO 8601 across a year boundary", () => {
  assert.equal(isoWeek(new Date("2026-09-23T00:00:00Z")), "2026-W39");
  assert.equal(isoWeek(new Date("2027-01-01T00:00:00Z")), "2026-W53");
});

test("runs older than the cutoff move to their week; recent and active stay", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-archive-"));
  run(root, "2026-09-01T10-00-00", "2026-09-01T10:00:00Z");
  run(root, "2026-09-02T10-00-00", "2026-09-02T10:00:00Z");
  run(root, "2026-09-20T10-00-00", "2026-09-20T10:00:00Z");
  writeFileSync(activeMarker(root), JSON.stringify({ run: "2026-09-02T10-00-00" }));

  const moved = archiveOldRuns(root, { days: 7, now: NOW });

  assert.deepEqual(moved, ["2026-09-01T10-00-00"]);
  assert.ok(existsSync(join(archiveDir(root), "2026-W36", "2026-09-01T10-00-00")));
  assert.ok(existsSync(runDir(root, "2026-09-02T10-00-00")), "active run kept");
  assert.ok(existsSync(runDir(root, "2026-09-20T10-00-00")), "recent run kept");
});

test("null or missing days archives nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-archive-"));
  run(root, "2026-01-01T10-00-00", "2026-01-01T10:00:00Z");
  assert.deepEqual(archiveOldRuns(root, { days: null, now: NOW }), []);
  assert.deepEqual(archiveOldRuns(mkdtempSync(join(tmpdir(), "t-")), { days: 7 }), []);
});

test("an archive redirected outside .trio by a link gets nothing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "trio-archive-"));
  const outside = mkdtempSync(join(tmpdir(), "trio-outside-"));
  run(root, "2026-09-01T10-00-00", "2026-09-01T10:00:00Z");
  try {
    symlinkSync(outside, archiveDir(root), "junction");
  } catch {
    t.skip("cannot create a link here");
    return;
  }
  assert.deepEqual(archiveOldRuns(root, { days: 7, now: NOW }), []);
  assert.ok(existsSync(runDir(root, "2026-09-01T10-00-00")), "run stays put");
  assert.deepEqual(readdirSync(outside), [], "nothing created outside");
});

test("archivedHint names where an archived run went, and nothing otherwise", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-archive-"));
  run(root, "2026-09-01T10-00-00", "2026-09-01T10:00:00Z");
  assert.equal(archivedHint(root, "2026-09-01T10-00-00"), "");
  archiveOldRuns(root, { days: 7, now: NOW });
  assert.match(archivedHint(root, "2026-09-01T10-00-00"), /archived to .*2026-W36.*move it back/);
});

test("a .trio/runs that links outside .trio is never enumerated or moved", (t) => {
  const root = mkdtempSync(join(tmpdir(), "trio-archive-"));
  const outside = mkdtempSync(join(tmpdir(), "trio-outside-"));
  const victim = join(outside, "2026-09-01T10-00-00");
  mkdirSync(victim);
  const old = new Date("2026-09-01T10:00:00Z");
  utimesSync(victim, old, old);
  mkdirSync(join(root, ".trio"), { recursive: true });
  try {
    symlinkSync(outside, join(root, ".trio", "runs"), "junction");
  } catch {
    t.skip("cannot create a link here");
    return;
  }
  assert.deepEqual(archiveOldRuns(root, { days: 7, now: NOW }), []);
  assert.ok(existsSync(victim), "external directory stays where it was");
});
