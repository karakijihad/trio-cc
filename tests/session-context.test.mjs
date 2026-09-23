import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/session-context.mjs";
import { trioDir, configPath, capabilitiesPath } from "../src/paths.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-session-"));

const configure = (root, json) => {
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(configPath(root), json);
};

test("a fresh project gets the advisory context", () => {
  const text = main(tmp());
  assert.ok(text, "expected context for a project with no config");
  assert.match(text, /trio:trio-audit/);
  assert.match(text, /not required for every task/);
});

test("a project that opted out gets nothing", () => {
  const root = tmp();
  configure(root, JSON.stringify({ enabled: false }));
  assert.equal(main(root), null);
});

// loadConfig fails closed on a corrupt file; the nudge must not become the
// one place that fails open and re-introduces Trio past an opt-out.
test("an unreadable config gets nothing", () => {
  const root = tmp();
  configure(root, "{not json");
  assert.equal(main(root), null);
});

test("an unpinned project is offered the models capabilities name", () => {
  const root = tmp();
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    capabilitiesPath(root),
    JSON.stringify({
      defaultModel: "m1",
      models: [{ slug: "m1", efforts: ["medium", "high"], defaultEffort: "medium" }],
    }),
  );
  const text = main(root);
  assert.match(text, /Trio model check/);
  assert.match(text, /auditor {2}codex default → m1 · medium {2}\(unpinned\)/);
  assert.match(text, /consult {2}codex default → m1 · high/);
  assert.match(text, /models --apply/);
});

test("no cached capabilities means no model check", () => {
  assert.doesNotMatch(main(tmp()), /model check/);
});

test("a run parked for over an hour is mentioned; a fresh one is not", () => {
  const root = tmp();
  const run = "2026-09-20T10-00-00";
  mkdirSync(join(trioDir(root), "runs", run, "pass-1"), { recursive: true });
  const rec = join(trioDir(root), "runs", run, "pass-1", "reconcile.json");
  writeFileSync(rec, "{}");
  writeFileSync(join(trioDir(root), "active"), JSON.stringify({ run, pass: 1, pid: 1 }));
  assert.doesNotMatch(main(root), /paused after pass/);
  const old = new Date(Date.now() - 3 * 3_600_000);
  utimesSync(rec, old, old);
  assert.match(main(root), /run 2026-09-20T10-00-00 has been paused after pass 1 for 3h/);
});
