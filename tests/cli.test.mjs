// CLI coverage that runs in the default suite: every case here reaches
// bin/trio.mjs without touching the network or the Codex binary, so a
// regression in argument parsing, command routing or exit codes fails
// `npm test` rather than waiting for a TRIO_E2E run.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/trio.mjs", import.meta.url));

const project = () => mkdtempSync(join(tmpdir(), "trio-cli-"));
const trio = (root, args) =>
  spawnSync("node", [CLI, ...args], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
  });

test("an unknown command exits non-zero with usage", () => {
  const r = trio(project(), ["frobnicate"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /usage|unknown/i);
});

test("config get prints the whole config as JSON", () => {
  const r = trio(project(), ["config", "get"]);
  assert.equal(r.status, 0);
  const cfg = JSON.parse(r.stdout);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.maxIterations, 2);
});

test("config set rejects an invalid value and names the valid ones", () => {
  const r = trio(project(), ["config", "set", "view.mode", "hologram"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /pane/);
});

test("config set persists a valid value", () => {
  const root = project();
  assert.equal(trio(root, ["config", "set", "maxIterations", "4"]).status, 0);
  assert.equal(JSON.parse(trio(root, ["config", "get"]).stdout).maxIterations, 4);
});

test("on and off flip the enabled flag", () => {
  const root = project();
  trio(root, ["on"]);
  assert.equal(JSON.parse(trio(root, ["config", "get"]).stdout).enabled, true);
  trio(root, ["off"]);
  assert.equal(JSON.parse(trio(root, ["config", "get"]).stdout).enabled, false);
});

test("run rejects a non-numeric --max before probing anything", () => {
  const root = project();
  const r = trio(root, ["run", "--max", "nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /positive whole number/);
  assert.equal(existsSync(join(root, ".trio", "runs")), false);
});

test("run rejects --max 0 and a negative --max", () => {
  const root = project();
  for (const bad of ["0", "-1", "1.5"]) {
    const r = trio(root, ["run", "--max", bad]);
    assert.equal(r.status, 2, `--max ${bad} was accepted`);
  }
  assert.equal(existsSync(join(root, ".trio", "runs")), false);
});

test("run rejects a stored maxIterations that is not a positive integer", () => {
  const root = project();
  mkdirSync(join(root, ".trio"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "config.json"),
    JSON.stringify({ enabled: true, maxIterations: 0 }),
  );
  const r = trio(root, ["run"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /maxIterations/);
});

test("run refuses to start while Trio is off", () => {
  const root = project();
  const r = trio(root, ["run"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /off/i);
  assert.equal(existsSync(join(root, ".trio", "runs")), false);
});

test("continue with no active run says so and exits non-zero", () => {
  const r = trio(project(), ["continue"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no_active_run/);
});

test("cancel with no active run is a no-op, not an error", () => {
  const r = trio(project(), ["cancel"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no active run/i);
});

test("cancel clears an active marker and records the cancelled verdict", () => {
  const root = project();
  const runId = "2026-01-01T00-00-00";
  mkdirSync(join(root, ".trio", "runs", runId), { recursive: true });
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: runId, pass: 1 }),
  );
  const r = trio(root, ["cancel"]);
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(root, ".trio", "active")), false);
  const verdict = JSON.parse(
    readFileSync(join(root, ".trio", "runs", runId, "verdict.json"), "utf8"),
  );
  assert.equal(verdict.verdict, "cancelled");
});

// codexCommand() throws on win32 when it cannot resolve the Codex entry
// point (it used to fall back to a shell). These two commands invoke Codex
// outside the driver's protected path, so they have to survive that throw
// with a message rather than a stack trace. Running with an empty PATH is the
// portable way to make Codex unfindable.
const noCodex = (root, args) =>
  // process.execPath, not "node": the empty PATH has to hide Codex without
  // also hiding the interpreter running the CLI.
  spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      PATH: "",
      Path: "",
      CLAUDE_PROJECT_DIR: root,
      CODEX_HOME: join(root, "no-codex-home"),
    },
    encoding: "utf8",
  });

test("doctor reports a broken Codex install instead of crashing", () => {
  const r = noCodex(project(), ["doctor"]);
  assert.doesNotMatch(r.stderr, /at .*trio\.mjs/, r.stderr);
  assert.doesNotMatch(r.stderr, /ERR_/, r.stderr);
  assert.match(r.stdout, /TRIO/);
});

test("consult reports a broken Codex install instead of crashing", () => {
  const r = noCodex(project(), ["consult", "is this sound?"]);
  assert.doesNotMatch(r.stderr, /at .*consult\.mjs/, r.stderr);
  assert.doesNotMatch(r.stderr, /ERR_/, r.stderr);
  assert.notEqual(r.status, 0);
});

test("consult with no question prints usage and exits 2", () => {
  const root = project();
  const r = trio(root, ["consult"]);
  // Usage is checked before the preflight probe, so this is deterministic
  // whether or not a Codex install exists on the machine running the suite.
  assert.equal(r.status, 2);
  assert.match(r.stdout, /usage: trio consult <question>/);
  assert.equal(existsSync(join(root, ".trio", "runs")), false);
});
