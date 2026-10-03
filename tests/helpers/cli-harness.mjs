// Runs a bin/trio.mjs command module in this process, so a test of argument
// handling, routing or exit codes does not pay node's own startup (4-5s per
// process on the machines this suite runs on) for what is a function call.
//
// It builds the same ctx bin/trio.mjs builds and nothing more: the command
// modules are the code under test, the ctx is the seam. What it replaces is
// everything that would otherwise spawn something.
//
//   - `out` is collected, not written.
//   - process.stderr.write is captured for the commands that write to it
//     directly (config get's unknown-key warning, run's lens warning).
//   - process.exitCode is saved and restored. Commands set it as their status;
//     left set it becomes the exit code of the whole test process and fails
//     every test file that uses this.
//   - `run`, `codexRefusal` and `gatherState` default to versions that cannot
//     reach Codex. A test that wants a different answer injects its own.
//   - stopLensesOnSignal is a no-op: it registers SIGTERM handlers that call
//     process.exit, which must not be installed on the test runner.
//   - process.kill can be told which made-up pids to treat as live and then
//     records every signal aimed at them instead of sending it, so a `cancel`
//     test can prove a signal was or was not sent without a real victim.
//
// Not covered, deliberately: bin/trio.mjs's own routing (help, unknown
// command) and anything that needs a real pid or a real Codex. Those stay in
// tests/process/.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  unavailable,
  gatherState as realGatherState,
  activeRun,
  latestFinishedRun,
  ensureGitignore,
} from "../../src/commands/context.mjs";
import { loadCapabilities, isFresh, REQUIRED_FLAGS } from "../../src/capabilities.mjs";
import { FAKE_VERSION } from "./fake-codex.mjs";
import statusCommand from "../../src/commands/status.mjs";
import onCommand from "../../src/commands/on.mjs";
import offCommand from "../../src/commands/off.mjs";
import doctorCommand from "../../src/commands/doctor.mjs";
import configCommand from "../../src/commands/config.mjs";
import lensCommand from "../../src/commands/lens.mjs";
import modelsCommand from "../../src/commands/models.mjs";
import serveCommand from "../../src/commands/serve.mjs";
import promoteCommand from "../../src/commands/promote.mjs";
import renderCommand from "../../src/commands/render.mjs";
import verdictsCommand from "../../src/commands/verdicts.mjs";
import cancelCommand from "../../src/commands/cancel.mjs";
import runCommand from "../../src/commands/run.mjs";
import extendCommand from "../../src/commands/extend.mjs";
import continueCommand from "../../src/commands/continue.mjs";
import consultCommand from "../../src/commands/consult.mjs";

// The same table bin/trio.mjs routes through, minus its help / unknown arms.
const COMMANDS = {
  status: statusCommand,
  panel: statusCommand,
  on: onCommand,
  off: offCommand,
  doctor: doctorCommand,
  config: configCommand,
  lens: lensCommand,
  models: modelsCommand,
  serve: serveCommand,
  promote: promoteCommand,
  render: renderCommand,
  verdicts: verdictsCommand,
  cancel: cancelCommand,
  run: runCommand,
  extend: extendCommand,
  continue: continueCommand,
  consult: consultCommand,
};

// What the fake Codex's own probe produces (see fake-codex.mjs): one model,
// logged in with ChatGPT, every flag Trio requires. Written to a project's
// .trio/capabilities.json it is a fresh cache, which gatherState reads
// without running anything — the cold probe is three Codex spawns.
export const fakeCaps = (over = {}) => ({
  cliVersion: FAKE_VERSION,
  defaultModel: null,
  defaultEffort: null,
  cacheClientVersion: FAKE_VERSION,
  models: [
    {
      slug: "fake-model",
      displayName: "Fake Model",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high"],
      upgrade: null,
      retiresAt: null,
    },
  ],
  flags: [...REQUIRED_FLAGS],
  authMode: "chatgpt",
  probedAt: new Date().toISOString(),
  preflight: { state: "ready", message: "Logged in using ChatGPT", fix: "" },
  ...over,
});

// Written once per process and copied into each project, so seeding is one
// file copy rather than a write that has to be re-serialised every time. The
// probedAt inside stays fresh for the 24h a test file takes to run.
let seedFile = null;
const seed = () => {
  if (!seedFile) {
    seedFile = join(mkdtempSync(join(tmpdir(), "trio-caps-seed-")), "capabilities.json");
    writeFileSync(seedFile, JSON.stringify(fakeCaps(), null, 2) + "\n");
  }
  return seedFile;
};

// Makes `root` look probed. Pass `caps` for a catalogue of your own.
export function seedCapabilities(root, caps) {
  mkdirSync(join(root, ".trio"), { recursive: true });
  if (caps) {
    writeFileSync(
      join(root, ".trio", "capabilities.json"),
      JSON.stringify(caps, null, 2) + "\n",
    );
    return;
  }
  copyFileSync(seed(), join(root, ".trio", "capabilities.json"));
}

// The real gatherState over a fresh cache, and a loud failure over anything
// else: a cold probe here would spawn `codex` from whatever the machine
// running the suite has installed, which is the dependence the process tests'
// fake Codex exists to remove. `force` is ignored — doctor forces a probe,
// and a harness that honoured it would spawn.
const cachedState = (root, opts) => {
  const cached = loadCapabilities(root);
  if (!(isFresh(cached) && cached.preflight))
    throw new Error(
      "cli-harness: gatherState reached a cold probe — call seedCapabilities(root) or pass a gatherState stub",
    );
  return realGatherState(root, { ...opts, force: false });
};

const NOT_STUBBED = {
  status: 127,
  stdout: "",
  stderr: "cli-harness: no process in the harness",
};

export async function runCli(root, args, opts = {}) {
  const [name = "status", ...rest] = args;
  const handler = COMMANDS[name];
  if (!handler) throw new Error(`cli-harness: no command module for "${name}"`);

  const calls = { gatherState: 0, run: [], codexRefusal: 0 };
  const lines = [];
  let stderr = "";
  const kills = [];

  const baseRun = opts.run ?? (() => NOT_STUBBED);
  const baseRefusal = opts.codexRefusal ?? (() => null);
  const baseState = opts.gatherState ?? cachedState;
  const ctx = {
    root,
    rest,
    out: (s) => lines.push(s.endsWith("\n") ? s : s + "\n"),
    run: (bin, a) => {
      calls.run.push([bin, ...a]);
      return baseRun(bin, a);
    },
    unavailable,
    codexRefusal: (target) => {
      calls.codexRefusal++;
      return baseRefusal(target);
    },
    gatherState: (o) => {
      calls.gatherState++;
      return baseState(root, o);
    },
    beforeFirstPass: async () => {},
    activeRun: () => activeRun(root),
    latestFinishedRun: () => latestFinishedRun(root),
    stopLensesOnSignal: () => {},
    ensureGitignore: () => ensureGitignore(root),
  };

  const savedExit = process.exitCode;
  const savedWrite = process.stderr.write;
  const savedKill = process.kill;
  const alive = new Set(opts.alive ?? []);
  process.exitCode = undefined;
  process.stderr.write = (chunk, ...more) => {
    stderr += String(chunk);
    const cb = more.find((m) => typeof m === "function");
    if (cb) cb();
    return true;
  };
  if (alive.size)
    process.kill = (pid, signal = "SIGTERM") => {
      if (!alive.has(pid)) return savedKill.call(process, pid, signal);
      // Signal 0 is the liveness probe; anything else is the thing under test.
      if (signal !== 0) kills.push({ pid, signal });
      return true;
    };
  let status;
  try {
    await handler(ctx);
    status = process.exitCode ?? 0;
  } finally {
    process.exitCode = savedExit;
    process.stderr.write = savedWrite;
    process.kill = savedKill;
  }
  return { status, stdout: lines.join(""), stderr, calls, kills };
}
