import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  setConfigValue,
} from "../src/config.mjs";
import { codexHome, trioDir } from "../src/paths.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-"));

test("ships enabled with a ceiling of 2", () => {
  assert.equal(DEFAULT_CONFIG.enabled, true);
  assert.equal(DEFAULT_CONFIG.maxIterations, 2);
});

test("loadConfig returns defaults when no file exists", () => {
  const cfg = loadConfig(tmp());
  assert.equal(cfg.maxIterations, 2);
  assert.equal(cfg.view.mode, "window");
});

test("loadConfig deep-merges over defaults, keeping untouched keys", () => {
  const root = tmp();
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    join(trioDir(root), "config.json"),
    JSON.stringify({ view: { port: 5000 } }),
  );
  const cfg = loadConfig(root);
  assert.equal(cfg.view.port, 5000);
  assert.equal(cfg.view.mode, "window");
  assert.equal(cfg.maxIterations, 2);
});

test("saveConfig round-trips", () => {
  const root = tmp();
  saveConfig(root, { ...DEFAULT_CONFIG, maxIterations: 3 });
  assert.equal(loadConfig(root).maxIterations, 3);
});

test("setConfigValue coerces numbers and booleans", () => {
  assert.equal(
    setConfigValue(DEFAULT_CONFIG, "maxIterations", "3").maxIterations,
    3,
  );
  assert.equal(setConfigValue(DEFAULT_CONFIG, "enabled", "true").enabled, true);
});

test("setConfigValue rejects counts that `trio run` would refuse", () => {
  for (const key of ["maxIterations", "codex.parallel", "view.port"]) {
    for (const bad of ["0", "-1", "1.5"]) {
      assert.throws(
        () => setConfigValue(DEFAULT_CONFIG, key, bad),
        /positive whole number/,
        `${key}=${bad} was accepted`,
      );
    }
  }
});

test("setConfigValue rejects an unknown key", () => {
  assert.throws(
    () => setConfigValue(DEFAULT_CONFIG, "view.nonsense", "x"),
    /unknown key/i,
  );
});

test("setConfigValue rejects an invalid enum value and lists the valid ones", () => {
  assert.throws(
    () => setConfigValue(DEFAULT_CONFIG, "view.mode", "hologram"),
    /pane.*window.*off/s,
  );
});

test("setConfigValue rejects a view mode with no implementation", () => {
  for (const mode of ["html", "transcript"]) {
    assert.throws(
      () => setConfigValue(DEFAULT_CONFIG, "view.mode", mode),
      /invalid value/i,
    );
  }
});

test("setConfigValue does not mutate the input", () => {
  const before = DEFAULT_CONFIG.maxIterations;
  setConfigValue(DEFAULT_CONFIG, "maxIterations", "9");
  assert.equal(DEFAULT_CONFIG.maxIterations, before);
});

test("codexHome honours CODEX_HOME", () => {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "/custom/codex";
  assert.equal(codexHome(), "/custom/codex");
  if (prev === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prev;
});
