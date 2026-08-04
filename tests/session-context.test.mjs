import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/session-context.mjs";
import { trioDir, configPath } from "../src/paths.mjs";

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
