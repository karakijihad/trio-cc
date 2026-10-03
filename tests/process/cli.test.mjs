// The CLI cases that need a real process: signalling real pids, an empty PATH,
// a real (fake) Codex being invoked, and bin/trio.mjs's own routing. Each one
// pays node's startup, so everything that does not need that lives in
// tests/integration/cli.test.mjs and calls the command modules in-process.
//
// Every case here reaches bin/trio.mjs without touching the network or a real
// Codex binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installFakeCodex, fakeCodexHome, fakeEnv } from "../helpers/fake-codex.mjs";
import { seedCapabilities } from "../helpers/cli-harness.mjs";

const CLI = fileURLToPath(new URL("../../bin/trio.mjs", import.meta.url));

// A fake Codex on PATH, shared by every test in this file (node:test runs
// each file in its own process, so this cannot leak into another file's
// suite). Without it, any command reaching gatherState probed whatever Codex
// the machine running the tests happened to have installed, and the result
// depended on it.
const fakePathDir = mkdtempSync(join(tmpdir(), "trio-cli-bin-"));
const fakeHomeDir = mkdtempSync(join(tmpdir(), "trio-cli-home-"));
installFakeCodex(fakePathDir);
fakeCodexHome(fakeHomeDir);

const project = () => mkdtempSync(join(tmpdir(), "trio-cli-"));
const trio = (root, args, extra = {}) =>
  spawnSync("node", [CLI, ...args], {
    env: fakeEnv({ pathDir: fakePathDir, codexHome: fakeHomeDir, project: root, extra }),
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
// ESM, because it is written out as trio.mjs — see the spawn below for why
// the name matters.
const WORKER = `
import { spawn } from "node:child_process";
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

// Generous: this waits on a cold node start plus its child, and node alone is
// 4-5s here when the machine is busy.
const firstLine = (stream, ms = 30_000) =>
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
  // Spawned from a file named trio.mjs, not `node -e`: cancel identifies its
  // target by command line, and a stand-in that no honest identification
  // would accept is not standing in for anything.
  const workerPath = join(mkdtempSync(join(tmpdir(), "trio-worker-")), "trio.mjs");
  writeFileSync(workerPath, WORKER);
  const worker = spawn(process.execPath, [workerPath], {
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

// The whole exploit, end to end. `.trio/active` is an ordinary file in the
// project, so a hostile repo can pre-seed one naming a live pid, and a
// matching run.json is just as easy to plant. On win32 the identification
// used to be `tasklist`, which reports the image name alone — so every
// node.exe on the machine passed, and cancel killed its whole tree.
test("cancel will not kill an unrelated node process a forged marker names", async () => {
  const root = project();
  const bystander = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  try {
    // Everything the attacker controls, planted: a valid-format run id, the
    // run directory that gates the signal, and the victim's pid.
    claimRun(root, bystander.pid);

    const r = trio(root, ["cancel"]);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /stopped pid/);
    // Cancellation still happens — it is the signal that is withheld, not the
    // record — but the bystander is untouched.
    assert.equal(
      await waitForExit(bystander.pid, 1500),
      false,
      "cancel killed a process that was never Trio's",
    );
  } finally {
    try {
      bystander.kill();
    } catch {
      /* already gone */
    }
  }
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

// The consult cases that reach the fake Codex start from a seeded capability
// cache: the cold probe is three more Codex spawns, and what these assert is
// what happens after it, not the probe itself.
const execLines = (touched) =>
  readFileSync(touched, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("exec") && !l.includes("--help"));

// A model named on the command line is resolved against the catalogue before
// it ever reaches Codex — this proves the resolved slug is what's spawned, not
// the substring the operator typed. The override is named on the command line
// and nowhere else: it must not leak into the file the next, un-overridden
// consult reads.
test("consult resolves a partial --model and passes the resolved slug to Codex", () => {
  const root = project();
  seedCapabilities(root);
  const configPath = join(root, ".trio", "config.json");
  writeFileSync(configPath, JSON.stringify({ enabled: true }, null, 2) + "\n");
  const before = readFileSync(configPath, "utf8");
  const touched = join(root, "codex-was-invoked.log");
  const r = trio(
    root,
    ["consult", "--model", "fake", "--effort", "low", "is", "this", "ok?"],
    { FAKE_CODEX_TOUCH: touched },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.model, "fake-model");
  assert.equal(result.effort, "low");
  const exec = execLines(touched).at(-1);
  assert.match(exec, /--model fake-model/);
  assert.match(exec, /model_reasoning_effort=low/);
  assert.equal(readFileSync(configPath, "utf8"), before, "an inline override must not persist");
});

// The defect a solo audit found: `--model` mid-question swallowed the next
// word as a model name and dropped it from the question, silently. A bare
// `--` ends flag parsing, so everything after it — dashes and all — reaches
// Codex exactly as typed, with no override applied.
test("a question after -- keeps every word, --model-looking ones included", () => {
  const root = project();
  seedCapabilities(root);
  const briefLog = join(root, "brief.log");
  const r = trio(
    root,
    ["consult", "--", "explain", "what", "--model", "does", "in", "trio"],
    { FAKE_CODEX_BRIEF_LOG: briefLog },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const brief = readFileSync(briefLog, "utf8");
  assert.match(brief, /explain what --model does in trio/);
  // No override was named, so the pair Codex ran on is whatever is configured
  // — never a model called "does".
  assert.notEqual(JSON.parse(r.stdout).model, "does");
});

// bin/trio.mjs's own routing: what the command modules cannot show, because
// the in-process suite calls them directly.
test("help prints usage and exits clean", () => {
  for (const arg of ["help", "--help", "-h"]) {
    const r = trio(project(), [arg]);
    assert.equal(r.status, 0, arg);
    assert.match(r.stdout, /trio run /);
  }
});

test("an unknown command exits non-zero with usage", () => {
  const r = trio(project(), ["frobnicate"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /usage|unknown/i);
});
