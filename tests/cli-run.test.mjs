// The CLI's success path, end to end, against a fake Codex on PATH: argument
// parsing → preflight → drift check → startRun → runLens → verdict →
// promotion. No network, no OpenAI account, runs in the default suite.
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
import {
  installFakeCodex,
  fakeCodexHome,
  fakeEnv,
  CLI,
} from "./helpers/fake-codex.mjs";

const FINDING = JSON.stringify([
  {
    severity: "major",
    file: "src/app.js",
    line: 1,
    title: "add() subtracts",
    evidence: "return a - b",
    impact: "every caller gets the wrong number",
    correction: "return a + b",
  },
]);

function project({ findings } = {}) {
  const root = mkdtempSync(join(tmpdir(), "trio-run-"));
  const pathDir = mkdtempSync(join(tmpdir(), "trio-bin-"));
  const home = mkdtempSync(join(tmpdir(), "trio-home-"));
  installFakeCodex(pathDir);
  fakeCodexHome(home);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.js"), "export const add = (a, b) => a - b;\n");

  const env = fakeEnv({
    pathDir,
    codexHome: home,
    project: root,
    extra: findings ? { FAKE_CODEX_FINDINGS: findings } : {},
  });
  const cli = (args) =>
    spawnSync("node", [CLI, ...args], { env, encoding: "utf8" });

  assert.equal(cli(["on"]).status, 0);
  assert.equal(cli(["config", "set", "view.mode", "off"]).status, 0);
  return { root, cli };
}

test("run: a clean audit produces a verdict and clears the marker", () => {
  const { root, cli } = project();
  const res = cli(["run", "--lenses", "auditor"]);
  assert.equal(res.status, 0, res.stderr);

  const r = JSON.parse(res.stdout);
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "clean");
  assert.ok(existsSync(join(root, ".trio", "runs", r.runId, "verdict.json")));
  assert.ok(existsSync(join(root, ".trio", "runs", r.runId, "events.jsonl")));
  assert.equal(existsSync(join(root, ".trio", "active")), false);

  // The lens really ran: its own artifact and stream are on disk.
  const lens = JSON.parse(
    readFileSync(
      join(root, ".trio", "runs", r.runId, "pass-1", "codex", "auditor.json"),
      "utf8",
    ),
  );
  assert.equal(lens.lens, "auditor");
  assert.equal(lens.status, "ok");
  const events = readFileSync(
    join(root, ".trio", "runs", r.runId, "events.jsonl"),
    "utf8",
  );
  assert.match(events, /codex:auditor/);
});

test("run: a major finding yields awaiting_response and holds the marker", () => {
  const { root, cli } = project({ findings: FINDING });
  const res = cli(["run", "--lenses", "auditor"]);
  assert.equal(res.status, 0, res.stderr);

  const r = JSON.parse(res.stdout);
  assert.equal(r.status, "awaiting_response");
  assert.equal(r.pass, 1);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].title, "add() subtracts");

  const marker = JSON.parse(readFileSync(join(root, ".trio", "active"), "utf8"));
  assert.equal(marker.run, r.runId);
  assert.equal(typeof marker.pid, "number");
});

test("run: refuses to start a second run while the first is awaiting a response", () => {
  const { root, cli } = project({ findings: FINDING });
  const first = JSON.parse(cli(["run", "--lenses", "auditor"]).stdout);
  assert.equal(first.status, "awaiting_response");

  const second = cli(["run", "--lenses", "auditor"]);
  assert.equal(second.status, 1);
  assert.match(second.stdout, /already in progress/);
  assert.match(second.stdout, new RegExp(first.runId));
  // The first run's marker is untouched.
  const marker = JSON.parse(readFileSync(join(root, ".trio", "active"), "utf8"));
  assert.equal(marker.run, first.runId);
});

test("continue: an unanswered finding still open at the ceiling reports ceiling_reached", () => {
  const { root, cli } = project({ findings: FINDING });
  const first = JSON.parse(cli(["run", "--lenses", "auditor", "--max", "2"]).stdout);
  assert.equal(first.status, "awaiting_response");

  const res = cli(["continue"]);
  assert.equal(res.status, 0, res.stderr);
  const r = JSON.parse(res.stdout);
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "ceiling_reached");
  assert.equal(r.passes, 2);
  assert.equal(existsSync(join(root, ".trio", "active")), false);
});

test("cancel: stops an in-flight run, records cancelled, and leaves a token", () => {
  const { root, cli } = project({ findings: FINDING });
  const first = JSON.parse(cli(["run", "--lenses", "auditor"]).stdout);
  assert.equal(first.status, "awaiting_response");

  const res = cli(["cancel"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /cancelled/i);

  const runDir = join(root, ".trio", "runs", first.runId);
  assert.ok(existsSync(join(runDir, "cancelled")), "cancellation token");
  assert.equal(
    JSON.parse(readFileSync(join(runDir, "verdict.json"), "utf8")).verdict,
    "cancelled",
  );
  assert.equal(existsSync(join(root, ".trio", "active")), false);

  // A worker arriving late cannot overwrite the cancelled verdict, and a
  // continue against a cancelled run does not start another pass.
  const after = cli(["continue"]);
  assert.equal(
    JSON.parse(readFileSync(join(runDir, "verdict.json"), "utf8")).verdict,
    "cancelled",
  );
  assert.notEqual(after.stdout.includes('"verdict": "clean"'), true);
});

test("run: a lens that exits non-zero finishes the run rather than crashing", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-run-fail-"));
  const pathDir = mkdtempSync(join(tmpdir(), "trio-bin-"));
  const home = mkdtempSync(join(tmpdir(), "trio-home-"));
  installFakeCodex(pathDir);
  fakeCodexHome(home);
  const env = fakeEnv({
    pathDir,
    codexHome: home,
    project: root,
    extra: { FAKE_CODEX_EXIT: "3" },
  });
  const cli = (args) =>
    spawnSync("node", [CLI, ...args], { env, encoding: "utf8" });
  cli(["on"]);
  cli(["config", "set", "view.mode", "off"]);

  const res = cli(["run", "--lenses", "auditor", "--max", "1"]);
  assert.equal(res.status, 0, res.stderr);
  const r = JSON.parse(res.stdout);
  assert.equal(r.status, "finished");
  assert.notEqual(r.verdict, "clean");
  assert.equal(existsSync(join(root, ".trio", "active")), false);
});

test("run: an invalid --max is rejected without invoking Codex at all", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-run-args-"));
  const pathDir = mkdtempSync(join(tmpdir(), "trio-bin-"));
  const home = mkdtempSync(join(tmpdir(), "trio-home-"));
  installFakeCodex(pathDir);
  fakeCodexHome(home);
  const touched = join(root, "codex-was-invoked.log");
  const base = { pathDir, codexHome: home, project: root };
  const setup = fakeEnv(base);
  spawnSync("node", [CLI, "on"], { env: setup, encoding: "utf8" });
  spawnSync("node", [CLI, "config", "set", "view.mode", "off"], {
    env: setup,
    encoding: "utf8",
  });

  // Only the run invocation is watched — `on` and `config set` legitimately
  // probe, and the probe cache is deliberately bypassed by run's force:true.
  const res = spawnSync(
    "node",
    [CLI, "run", "--max", "nope", "--lenses", "auditor"],
    {
      env: fakeEnv({ ...base, extra: { FAKE_CODEX_TOUCH: touched } }),
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 2);
  assert.match(res.stdout, /positive whole number/);
  // The whole point: validation happens before the preflight probe, so the
  // Codex binary is never executed — not for --version, not for exec --help.
  assert.equal(
    existsSync(touched)
      ? `codex was invoked with: ${readFileSync(touched, "utf8").trim()}`
      : "not invoked",
    "not invoked",
  );
});

test("run: a hand-edited view.port is refused instead of reaching the browser launcher", () => {
  const { root, cli } = project();
  writeFileSync(
    join(root, ".trio", "config.json"),
    JSON.stringify({
      enabled: true,
      view: { mode: "window", port: "4319 & calc.exe", autoOpen: true },
    }),
  );
  const res = cli(["run", "--lenses", "auditor"]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /view\.port/);
  assert.equal(existsSync(join(root, ".trio", "runs")), false);
});

test("run: promotes both audits when the promote directory exists", () => {
  const { root, cli } = project({ findings: FINDING });
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const r = JSON.parse(cli(["run", "--lenses", "auditor", "--max", "1"]).stdout);
  assert.equal(r.status, "finished");
  assert.ok(r.promoted, "promotion result");
  assert.ok(existsSync(r.promoted.codexPath));
  assert.match(readFileSync(r.promoted.codexPath, "utf8"), /## Findings/);
});
