import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveOldRuns, archiveDir, isoWeek } from "../src/archive.mjs";
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
