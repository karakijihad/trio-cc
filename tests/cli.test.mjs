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
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/trio.mjs", import.meta.url));

const project = () => mkdtempSync(join(tmpdir(), "trio-cli-"));
const trio = (root, args) =>
  spawnSync("node", [CLI, ...args], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
  });

// The tree-killer is asynchronous on win32 (it shells out to taskkill), so
// the process is gone shortly after cancel returns, not the instant it does.
const waitForExit = async (pid, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

// A run id has to look like one Trio minted, and cancel now requires the run
// directory it claims to belong to — a marker naming neither is exactly the
// tampered state it must not act on.
const RUN_ID = "2026-08-01T09-15-00";

const claimRun = (root, pid, runId = RUN_ID) => {
  mkdirSync(join(root, ".trio", "runs", runId), { recursive: true });
  writeFileSync(
    join(root, ".trio", "runs", runId, "run.json"),
    JSON.stringify({ runId, target: root }),
  );
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: runId, pass: 1, pid }),
  );
};

// Stands in for a Trio worker: it owns a Codex-like child of its own and
// tears it down on SIGTERM, exactly as bin/trio.mjs now does via
// stopAllLenses. A worker with no children proves nothing here — the old
// single-PID implementation would pass that too.
const WORKER = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
process.stdout.write(child.pid + "\\n");
const stop = () => {
  try { child.kill(); } catch {}
  process.exit(1);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 1000);
`;

const firstLine = (stream, ms = 5000) =>
  new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("worker said nothing")), ms);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      resolve(buf.slice(0, nl).trim());
    });
  });

// The grandchild is the point: a worker with no children proves nothing, and
// the test this replaced had none.
//
// Honest limits. On win32 this passes even with killTreeCommand stubbed to
// null — verified by mutation — because Windows tears the grandchild down
// with its parent anyway, so nothing black-box can discriminate here. It does
// discriminate on POSIX, where a bare SIGTERM to the worker leaves the child
// running and only the worker's own handler reaches it. The mechanism that
// handler depends on is tested directly in codex-lane.test.mjs
// ("stopAllLenses tears down every lens still running"), which is
// platform-independent; this test covers the wiring end to end.
test("cancel stops the worker's children, not just the worker", async () => {
  const root = project();
  const worker = spawn(process.execPath, ["-e", WORKER], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let childPid = null;
  try {
    childPid = Number(await firstLine(worker.stdout));
    assert.ok(childPid > 0, "worker never reported a child");
    claimRun(root, worker.pid);

    const r = trio(root, ["cancel"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, new RegExp(`stopped pid ${worker.pid}`));
    assert.equal(await waitForExit(worker.pid), true, "worker outlived cancel");
    assert.equal(await waitForExit(childPid), true, "child outlived cancel");
  } finally {
    for (const pid of [worker.pid, childPid])
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          /* already gone, which is the point */
        }
      }
  }
});

test("cancel does not claim to have stopped a process already gone", () => {
  const root = project();
  // spawnSync has waited for this one, so its pid is dead by definition.
  claimRun(root, spawnSync(process.execPath, ["-e", ""]).pid);
  const r = trio(root, ["cancel"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Run cancelled\./);
  assert.doesNotMatch(r.stdout, /stopped pid/);
});

// The traversal the audit found: runId went straight into path.join, and
// render then wrote live.html at whatever that resolved to.
test("a runId that escapes .trio/runs is refused, not joined", () => {
  const root = project();
  const escape = join("..", "..", "escaped-run");
  for (const cmd of [
    ["render", escape],
    ["serve", escape],
    ["promote", escape],
  ]) {
    const r = trio(root, cmd);
    assert.equal(r.status, 2, cmd.join(" "));
    assert.match(r.stdout + r.stderr, /Not a run id/);
  }
  assert.equal(existsSync(join(root, "..", "..", "escaped-run")), false);
});

test("render with no run says so instead of throwing", () => {
  const r = trio(project(), ["render"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No run to render/);
  assert.doesNotMatch(r.stdout + r.stderr, /ENOENT|at Object|Error:/);
});

test("render names a run id that does not exist", () => {
  const r = trio(project(), ["render", "2026-01-01T00-00-00"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No such run/);
});

// A marker naming a run that was never created is tampered or stale; either
// way its pid must not be signalled.
test("cancel will not signal a pid whose run directory is absent", () => {
  const root = project();
  mkdirSync(join(root, ".trio"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: "2026-08-01T09-15-00", pass: 1, pid: process.pid }),
  );
  const r = trio(root, ["cancel"]);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /stopped pid/);
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
  assert.equal(cfg.enabled, true);
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

// The bug this guards: /trio:on used to announce that .trio/ had been added
// to .gitignore whether or not there was a checkout to add it to.
test("on gitignores .trio/ inside a checkout", () => {
  const root = project();
  mkdirSync(join(root, ".git"));
  trio(root, ["on"]);
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.trio\/$/m);
});

test("on writes no .gitignore where there is no checkout", () => {
  const root = project();
  trio(root, ["on"]);
  assert.equal(existsSync(join(root, ".gitignore")), false);
});

test("help prints usage and exits clean", () => {
  for (const arg of ["help", "--help", "-h"]) {
    const r = trio(project(), [arg]);
    assert.equal(r.status, 0, arg);
    assert.match(r.stdout, /trio run /);
  }
});

// The regression this exists for: an unrecognised flag used to fall through
// to a full five-lens run on the operator's OpenAI credit.
test("run refuses an unrecognised flag instead of starting", () => {
  const r = trio(project(), ["run", "--frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /unknown flag: --frobnicate/);
});

test("run --help prints usage rather than running", () => {
  const r = trio(project(), ["run", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /trio run /);
});

test("run keeps accepting the flags it knows", () => {
  const r = trio(project(), ["run", "--lenses", "auditor", "--max", "nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /--max takes a positive whole number/);
});

test("consult treats a leading dash as a typo, not a question", () => {
  const r = trio(project(), ["consult", "--help"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /usage: trio consult/);
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

// Trio ships enabled, so the opt-out has to be written before this means
// anything. That it holds *without reaching Codex* is proved in
// cli-run.test.mjs, where a fake Codex can record its own invocation.
test("run refuses to start while Trio is off", () => {
  const root = project();
  trio(root, ["off"]);
  const r = trio(root, ["run"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /off/i);
  assert.equal(existsSync(join(root, ".trio", "runs")), false);
});

test("consult honours the opt-out too", () => {
  const root = project();
  trio(root, ["off"]);
  const r = trio(root, ["consult", "is this safe?"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /off/i);
});

test("run rejects a flag that was given no value", () => {
  for (const args of [
    ["run", "--target"],
    ["run", "--lenses"],
    ["run", "--max"],
  ]) {
    const r = trio(project(), args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stdout + r.stderr, /needs a value/);
  }
});

// `--lenses ""` parsed to an empty list, which reads as "no selection given"
// and quietly ran every lens — the opposite of what was asked for.
test("run rejects an empty flag value rather than running everything", () => {
  const r = trio(project(), ["run", "--lenses", ""]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /--lenses needs a value/);
});

// A value can be present and still name nothing. Rejecting whitespace alone
// left `--lenses ,` running every lens.
test("run rejects a lens list that names nothing", () => {
  for (const arg of [",", ",,,", " , "]) {
    const r = trio(project(), ["run", "--lenses", arg]);
    assert.equal(r.status, 2, JSON.stringify(arg));
    assert.match(r.stdout + r.stderr, /--lenses needs (a value|at least one)/);
  }
});

test("off refuses to abandon a run that is still in flight", () => {
  const root = project();
  mkdirSync(join(root, ".trio", "runs", "r1"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: "r1", pass: 1, pid: 424242 }),
  );
  const r = trio(root, ["off"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /run is in progress: r1/);
  assert.match(r.stdout, /trio:cancel/);
  // The lock has to survive, or cancel can no longer find the run.
  assert.equal(existsSync(join(root, ".trio", "active")), true);
});

test("off still works once the run has a verdict", () => {
  const root = project();
  mkdirSync(join(root, ".trio", "runs", "r1"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "runs", "r1", "verdict.json"),
    JSON.stringify({ verdict: "clean", passes: 1, runId: "r1" }),
  );
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: "r1", pass: 1 }),
  );
  const r = trio(root, ["off"]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(trio(root, ["config", "get"]).stdout).enabled, false);
});

// A dashed value is a badly chosen value, not a missing one — it has to reach
// the check that can say why.
test("a negative --max still gets the message that explains it", () => {
  const r = trio(project(), ["run", "--max", "-1"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /positive whole number/);
});

// The unknown-flag walk steps over the token after a known flag, so without
// this guard `--target --lenses auditor` audits a path named "--lenses".
test("run does not let one flag be swallowed as another's value", () => {
  const r = trio(project(), ["run", "--target", "--lenses", "auditor"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /--target needs a value/);
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
