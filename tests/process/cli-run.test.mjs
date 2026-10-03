// The CLI's success path, end to end, against a fake Codex on PATH: argument
// parsing → preflight → drift check → startRun → runLens → verdict →
// promotion. No network, no OpenAI account, runs in the default suite.
//
// Node's own startup (~4-5s per process on the machine this was tuned on)
// dwarfs anything the fake Codex does, so every spawned `node` is the cost.
// That shapes how this file is built:
//
//  - One fake Codex install and home, shared by every test (they are only
//    ever read).
//  - A Codex capability cache produced once by a real `trio on`, then copied
//    into each project, so a first run/consult/lens skips the three-spawn cold
//    probe. The one test about a cold cache stays cold.
//  - "Golden" projects: a run driven to the same parked or settled state is
//    built once by the real CLI and `cpSync`'d per test. run.json's `target`
//    therefore names the golden's root, so a golden is never used by a test
//    that asserts on briefs or scope.
//  - Config is written to .trio/config.json directly, not through
//    `on`/`off`/`config set` — except where the test is about that command.
//  - Outcomes produced entirely by startRun/continueRun (promotion results,
//    Claude-lane handling, dead-pid reclaim) are in-process tests in
//    tests/integration/driver.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import {
  installFakeCodex,
  fakeCodexHome,
  fakeEnv,
  CLI,
} from "../helpers/fake-codex.mjs";
import { PING_PROMPT } from "../../src/ping.mjs";
import { loadConfig } from "../../src/config.mjs";

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

const mkTmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// One fake Codex for the whole file.
const PATH_DIR = mkTmp("trio-bin-");
const CODEX_HOME = mkTmp("trio-home-");
installFakeCodex(PATH_DIR);
fakeCodexHome(CODEX_HOME);

const envFor = (root, extra = {}) =>
  fakeEnv({ pathDir: PATH_DIR, codexHome: CODEX_HOME, project: root, extra });

// The one place a CLI process is spawned. The timeout is a backstop: a wedged
// child would otherwise hold the whole file until --test-timeout.
const spawnCli = (env, args) =>
  spawnSync("node", [CLI, ...args], {
    env,
    encoding: "utf8",
    timeout: 120_000,
  });

// A pid that is genuinely absent. Pid 1 exists on POSIX and on win32, and high
// pids are recycled, so this is a child that has exited and been reaped —
// spawned once and reused, but checked on every use so a recycled pid is
// replaced rather than trusted.
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
let corpse = null;
const deadPid = () => {
  if (corpse === null || isAlive(corpse))
    corpse = spawnSync(process.execPath, ["-e", ""]).pid;
  return corpse;
};

// The capability cache a real `trio on` leaves behind: built by the real CLI
// the first time something needs it, then copied. Fresh for 24h, which is
// longer than this file runs.
let capsJson = null;
const seededCaps = () => {
  if (capsJson === null) {
    const root = mkTmp("trio-caps-");
    const res = spawnCli(envFor(root), ["on"]);
    assert.equal(res.status, 0, res.stderr);
    capsJson = readFileSync(join(root, ".trio", "capabilities.json"), "utf8");
  }
  return capsJson;
};

// The handle every test works through for a project root. `extra` is merged
// into the child's environment for every call; `cli`'s own second argument
// overrides it for one.
const handle = (root, extra = {}) => ({
  root,
  cli: (args, more = {}) => spawnCli(envFor(root, { ...extra, ...more }), args),
});

// Trio ships enabled, so the only setting these tests actually need is the
// viewer off; it is written straight to disk. `seed: false` leaves the
// capability cache cold, for the tests whose point is what happens without one.
function project({ findings, extra = {}, seed = true } = {}) {
  const root = mkTmp("trio-run-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.js"), "export const add = (a, b) => a - b;\n");
  mkdirSync(join(root, ".trio"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "config.json"),
    JSON.stringify({ view: { mode: "off" } }),
  );
  if (seed) writeFileSync(join(root, ".trio", "capabilities.json"), seededCaps());
  return handle(root, {
    ...(findings ? { FAKE_CODEX_FINDINGS: findings } : {}),
    ...extra,
  });
}

// A project already driven, once, to some state by the real CLI, then copied
// per test. `build` runs against a scratch project and returns whatever the
// tests want to assert on from the build itself (the CLI's own output); each
// call hands back a fresh copy plus that record.
const goldens = new Map();
function golden(key, opts, build) {
  if (!goldens.has(key)) {
    const p = project(opts);
    goldens.set(key, { root: p.root, info: build(p) });
  }
  const g = goldens.get(key);
  const root = mkTmp("trio-run-");
  cpSync(g.root, root, { recursive: true });
  return { ...handle(root, opts?.findings ? { FAKE_CODEX_FINDINGS: opts.findings } : {}), info: g.info };
}

const runJson = (p, args) => {
  const res = p.cli(args);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};

// Parked after pass 1 with one major finding and the default ceiling of 2.
const parked = () =>
  golden("parked", { findings: FINDING }, (p) => ({
    first: runJson(p, ["run", "--lenses", "auditor"]),
  }));

// Run to a clean verdict.
const clean = () =>
  golden("clean", {}, (p) => ({
    done: runJson(p, ["run", "--lenses", "auditor"]),
  }));

// The last pass a run's budget allows parks for adjudication like every other
// pass, so `--max 1` comes back `awaiting_response` with `final: true`, and
// `continue` settles it. These tests care about the verdict, not about
// adjudicating anything, so they settle with --unadjudicated and no
// verdicts.json — which leaves every finding `unreviewed`, and an unreviewed
// finding is still live, so it still blocks. The gate itself, and its default
// refusal, have their own tests below.
const ceiling = () =>
  golden("ceiling", { findings: FINDING }, (p) => {
    const first = runJson(p, ["run", "--max", "1", "--lenses", "auditor"]);
    const res = p.cli(["continue", "--unadjudicated"]);
    return { first, res, ceiling: res.status === 0 ? JSON.parse(res.stdout) : null };
  });

// The one test that starts from a cold capability cache and goes the whole way.
test("run: a clean audit produces a verdict and clears the marker", () => {
  const { root, cli } = project({ seed: false });
  const res = cli(["run", "--lenses", "auditor"]);
  assert.equal(res.status, 0, res.stderr);

  const r = JSON.parse(res.stdout);
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "clean");
  assert.ok(existsSync(join(root, ".trio", "runs", r.runId, "verdict.json")));
  assert.ok(existsSync(join(root, ".trio", "runs", r.runId, "events.jsonl")));
  assert.equal(existsSync(join(root, ".trio", "active")), false);
  // The cold probe is what populated the cache this run went on to use.
  assert.ok(existsSync(join(root, ".trio", "capabilities.json")));

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
  const { root, info } = parked();
  const r = info.first;
  assert.equal(r.status, "awaiting_response");
  assert.equal(r.pass, 1);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].title, "add() subtracts");

  const marker = JSON.parse(readFileSync(join(root, ".trio", "active"), "utf8"));
  assert.equal(marker.run, r.runId);
  assert.equal(typeof marker.pid, "number");
});

// Covers the dead-pid case too: the marker is rewritten to name a process that
// is gone, because a parked run has no process alive either — the completed
// pass on disk is what keeps its lock held.
test("run: refuses to start a second run while the first is awaiting a response", () => {
  const { root, cli, info } = parked();
  const first = info.first;
  assert.equal(first.status, "awaiting_response");
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: first.runId, pass: 1, pid: deadPid() }),
  );

  const second = cli(["run", "--lenses", "auditor"]);
  // 3, not 1: a caller that polls has to tell "the lock is held, wait" apart
  // from the refusals where waiting never helps.
  assert.equal(second.status, 3);
  assert.match(second.stdout, /already in progress/);
  assert.match(second.stdout, new RegExp(first.runId));
  // Parked, not working — and the lock named is never worker.lock.
  assert.match(second.stdout, /paused after pass 1, waiting for its adjudication/);
  assert.doesNotMatch(second.stdout, /worker\.lock/);
  // The first run's marker is untouched.
  const marker = JSON.parse(readFileSync(join(root, ".trio", "active"), "utf8"));
  assert.equal(marker.run, first.runId);
});

// The worker lock's own CLI wiring, end to end through a real spawned
// process: `continue` on a legitimately parked run must refuse — distinctly
// from run_in_progress, and with the same exit code — when a second, still
// live Trio worker holds the lock that actually runs a pass, not just when
// the marker names one.
test("continue: exits 3 when a live worker holds the lock, and touches nothing", () => {
  const { root, cli, info } = parked();
  const first = info.first;
  assert.equal(first.status, "awaiting_response");

  // Spawned from a file named trio.mjs, not `node -e`: the lock's staleness
  // check identifies a holder by command line, and a stand-in nothing would
  // honestly identify as Trio proves nothing here.
  const workerDir = mkTmp("trio-worker-lock-");
  const workerPath = join(workerDir, "trio.mjs");
  writeFileSync(
    workerPath,
    'process.on("SIGTERM", () => process.exit(1));\nsetInterval(() => {}, 1000);\n',
  );
  const worker = spawn(process.execPath, [workerPath], { stdio: "ignore" });
  try {
    writeFileSync(
      join(root, ".trio", "worker.lock"),
      JSON.stringify({
        pid: worker.pid,
        run: first.runId,
        pass: 1,
        since: new Date().toISOString(),
      }),
    );

    // --unadjudicated: this run's pass 1 has live findings and no
    // verdicts.json, which D-adjudication-gate now refuses by default — but
    // that gate is not what this test is about. It bypasses the gate so the
    // worker-lock refusal underneath is what's actually exercised.
    const res = cli(["continue", "--unadjudicated"]);
    assert.equal(res.status, 3);
    assert.match(res.stdout, new RegExp(String(worker.pid)));
    assert.match(res.stdout, new RegExp(first.runId));

    // Refused before touching anything: the marker and the lock are both
    // exactly as they were.
    const marker = JSON.parse(readFileSync(join(root, ".trio", "active"), "utf8"));
    assert.equal(marker.run, first.runId);
    const lock = JSON.parse(
      readFileSync(join(root, ".trio", "worker.lock"), "utf8"),
    );
    assert.equal(lock.pid, worker.pid);
  } finally {
    try {
      worker.kill();
    } catch {
      /* already gone */
    }
  }
});

test("status --json reports the lock", () => {
  const idle = JSON.parse(project().cli(["status", "--json"]).stdout);
  assert.equal(idle.busy, false);
  assert.equal(idle.activeRun, null);
  assert.equal(idle.enabled, true);

  const { root, cli, info } = parked();
  const busy = JSON.parse(cli(["status", "--json"]).stdout);
  assert.equal(busy.busy, true);
  assert.equal(busy.activeRun, info.first.runId);
  assert.equal(busy.pass, 1);
  assert.ok(existsSync(join(root, ".trio", "active")));
});

// The file's existence is the lock. A marker that exists but does not parse
// still fails the `wx` create every start begins with, so reporting it free
// would send a polling caller straight into a refusal.
test("status --json reports an unparseable marker as busy", () => {
  const { root, cli } = project();
  writeFileSync(join(root, ".trio", "active"), "{not json");
  const s = JSON.parse(cli(["status", "--json"]).stdout);
  assert.equal(s.busy, true);
  assert.equal(s.activeRun, null);
  assert.equal(s.pass, null);
});

// The point of --json is that a second session can poll it. A poll that
// spawns the Codex CLI every few seconds is not a poll anyone can afford.
test("status --json never invokes Codex", () => {
  const touched = mkTmp("trio-touch-");
  const log = join(touched, "codex-was-invoked.log");
  // A warm cache, as after `trio on` — the case a poll loop actually lives in.
  const { root, cli } = project({ extra: { FAKE_CODEX_TOUCH: log } });
  const idle = cli(["status", "--json"]);
  assert.equal(idle.status, 0);
  assert.equal(JSON.parse(idle.stdout).busy, false);

  // And again with the lock held — the busy path reads the marker too.
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: "2026-01-01T00-00-00", pass: 1, pid: process.pid }),
  );
  const busy = cli(["status", "--json"]);
  assert.equal(JSON.parse(busy.stdout).busy, true);

  assert.equal(
    existsSync(log)
      ? `codex was invoked with: ${readFileSync(log, "utf8").trim()}`
      : "not invoked",
    "not invoked",
  );
});

// A forged marker reaches path.join, and reclaim does not only read — it
// creates a directory and writes a verdict into it.
test("run: refuses to reclaim a claim naming a run id Trio did not mint", () => {
  const { root, cli } = project({ findings: FINDING });
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: "../../escaped", pass: 1, pid: deadPid() }),
  );

  const res = cli(["run", "--lenses", "auditor"]);
  assert.equal(res.status, 3);
  // Nothing was written outside .trio/runs, and the marker still stands.
  assert.equal(existsSync(join(root, "..", "..", "escaped")), false);
  assert.ok(existsSync(join(root, ".trio", "active")));
});

// Scope has to survive the process boundary: `continue` is a separate CLI
// invocation, and run.json is the only place it can learn what this run was
// pointed at. A regression here silently widens pass 2 to the whole repo.
test("run --scope: reaches pass 1 and survives into continue", () => {
  const dir = mkTmp("trio-briefs-");
  const briefs = join(dir, "briefs.log");
  const { root, cli } = project({
    findings: FINDING,
    extra: { FAKE_CODEX_BRIEF_LOG: briefs },
  });

  const first = JSON.parse(
    cli(["run", "--lenses", "auditor", "--scope", "src/app.js only"]).stdout,
  );
  assert.equal(first.status, "awaiting_response");
  assert.equal(
    JSON.parse(
      readFileSync(join(root, ".trio", "runs", first.runId, "run.json"), "utf8"),
    ).scope,
    "src/app.js only",
  );

  // `continue` is a separate process that knows nothing but run.json.
  writeFileSync(
    join(root, ".trio", "runs", first.runId, "pass-1", "response.json"),
    JSON.stringify({ findings: [], summary: "no change" }),
  );
  // --unadjudicated: this test is about scope propagation, not adjudication —
  // pass 1's finding is left unreviewed on purpose.
  assert.equal(cli(["continue", "--unadjudicated"]).status, 0);

  const sent = readFileSync(briefs, "utf8")
    .split("===BRIEF===")
    .filter((s) => s.trim())
    // The ping probes the account before the wave and sends its own
    // one-line prompt. It is not a pass and carries no scope.
    .filter((s) => !s.includes(PING_PROMPT));
  assert.equal(sent.length, 2, "one brief per pass");
  for (const brief of sent)
    assert.match(brief, /Concentrate on: src\/app\.js only/);
  // Pass 2 is the one that could silently widen: it rebuilds the brief from
  // disk in a process that never saw the flag.
  assert.match(sent[1], /## Your findings from pass 1/);
});

test("cancel: stops an in-flight run, records cancelled, and leaves a token", () => {
  const { root, cli, info } = parked();
  const first = info.first;
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
  const { root, cli } = project({ extra: { FAKE_CODEX_EXIT: "3" } });

  const res = cli(["run", "--lenses", "auditor", "--max", "1"]);
  assert.equal(res.status, 0, res.stderr);
  const parkedRun = JSON.parse(res.stdout);
  // A degraded pass does not converge, so this is the ceiling: it parks, and
  // the settling call is what produces the verdict.
  assert.equal(parkedRun.final, true);
  const settled = cli(["continue"]);
  assert.equal(settled.status, 0, settled.stderr);
  const r = JSON.parse(settled.stdout);
  assert.equal(r.status, "finished");
  assert.notEqual(r.verdict, "clean");
  assert.equal(existsSync(join(root, ".trio", "active")), false);
});

test("run: an invalid --max is rejected without invoking Codex at all", () => {
  const log = join(mkTmp("trio-touch-"), "codex-was-invoked.log");
  // Validation happens before the capability cache is even consulted, so
  // this must hold with no cache at all — hence unseeded.
  const { cli } = project({ seed: false, extra: { FAKE_CODEX_TOUCH: log } });
  const res = cli(["run", "--max", "nope", "--lenses", "auditor"]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /positive whole number/);
  // The whole point: validation happens before the preflight probe, so the
  // Codex binary is never executed — not for --version, not for exec --help.
  assert.equal(
    existsSync(log)
      ? `codex was invoked with: ${readFileSync(log, "utf8").trim()}`
      : "not invoked",
    "not invoked",
  );
});

// The capability probe used to be forced on every `run`, spending a
// `--version`, a `login status`, another `--version` and an `exec --help`
// before the wave even started. A fresh cache (here the one a real `on`
// left, copied in) should mean a `run` touches Codex only for the ping and
// the lens itself — the wave is what is actually being paid for.
test("run: a fresh capability cache means only the ping and the lens reach Codex", () => {
  const log = join(mkTmp("trio-touch-"), "codex-was-invoked.log");
  const { cli } = project({ extra: { FAKE_CODEX_TOUCH: log } });

  const res = cli(["run", "--lenses", "auditor"]);
  assert.equal(res.status, 0, res.stderr);

  const invocations = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  // No --version, no login status, no exec --help: the fresh cache is
  // reused rather than re-probed. Only the ping and the one lens's own exec
  // reach Codex.
  assert.equal(invocations.length, 2, invocations.join(" | "));
  for (const line of invocations) assert.match(line, /^exec /);
});

// Both audit lanes found the same gap: a slug that had moved was only
// rejected by Codex itself, after the lock was claimed and the wave spawned.
// It warns rather than refuses — models_cache.json is Codex's own cache and
// can lag, so a mismatch must never be able to block a run outright.
test("run: warns before spending when a lens names a model the catalogue lacks", () => {
  const { root, cli } = project();
  // Lenses ship unpinned, so pin a slug the fake catalogue (fake-model only)
  // does not have — a retired model, as far as the run can tell.
  const cfg = loadConfig(root);
  cfg.codex.lenses.find((l) => l.name === "auditor").model = "retired-model";
  writeFileSync(join(root, ".trio", "config.json"), JSON.stringify(cfg));
  const res = cli(["run", "--lenses", "auditor"]);
  assert.match(res.stderr, /lens auditor: unknown model/);
  // Warned, not refused — and on stderr, so stdout is still the run's JSON.
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).verdict, "clean");
});

// Consult's own model, set apart from the lens it used to borrow — so the
// invocation log proves which one reached Codex, not only what was warned.
const consultProject = (consult, extra = {}) => {
  const log = join(mkTmp("trio-touch-"), "codex-was-invoked.log");
  const p = project({ extra: { FAKE_CODEX_TOUCH: log, ...extra } });
  const cfg = loadConfig(p.root);
  cfg.codex.consult = consult;
  writeFileSync(join(p.root, ".trio", "config.json"), JSON.stringify(cfg));
  return { root: p.root, run: p.cli, touched: log };
};

test("consult: invokes Codex with its own model and effort", () => {
  const { run, touched } = consultProject({ model: "fake-model", effort: "high" });
  const res = run(["consult", "is this sound?"]);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /consult: /);
  // the last exec is the consult; the one before it is the ping
  const exec = readFileSync(touched, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("exec") && !l.includes("--help"))
    .at(-1);
  assert.match(exec, /--model fake-model/);
  assert.match(exec, /model_reasoning_effort=high/);
});

test("consult: warns when its own model is not in the catalogue", () => {
  const { run, touched } = consultProject({ model: "retired-model", effort: null });
  const res = run(["consult", "is this sound?"]);
  assert.match(res.stderr, /consult: unknown model: retired-model/);
  assert.match(readFileSync(touched, "utf8"), /--model retired-model/);
  // warned, not refused: the consult still completes
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).failed, false);
});

test("lens consult refuses a malformed consult block instead of faking success", () => {
  for (const consult of [[], "x"]) {
    const { root, run } = consultProject(consult);
    const file = join(root, ".trio", "config.json");
    const before = readFileSync(file, "utf8");
    const res = run(["lens", "consult", "model", "fake-model", "effort", "high"]);
    assert.equal(res.status, 2, JSON.stringify(consult));
    assert.match(res.stdout, /codex\.consult must be an object/);
    assert.equal(readFileSync(file, "utf8"), before);
  }
});

test("lens consult validates, saves, and reports consult's own model", () => {
  const { root, run } = consultProject({ model: null, effort: null });
  const consultOf = () => loadConfig(root).codex.consult;

  const set = run(["lens", "consult", "model", "fake-model", "effort", "high"]);
  assert.equal(set.status, 0, set.stdout + set.stderr);
  assert.match(set.stdout, /^consult {2}fake-model {2}high/);
  assert.deepEqual(consultOf(), { model: "fake-model", effort: "high" });

  const bad = run(["lens", "consult", "model", "not-in-catalogue"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /unknown model: not-in-catalogue/);
  assert.deepEqual(consultOf(), { model: "fake-model", effort: "high" });
});

test("consult: a spent account is refused by the ping, with the reason", () => {
  const { run, touched } = consultProject(
    { model: null, effort: null },
    { FAKE_CODEX_STDERR: "You've hit your usage limit." },
  );
  const res = run(["consult", "is this sound?"]);
  assert.equal(res.status, 1, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.failed, true);
  assert.equal(out.codexUnavailable.kind, "usage");
  assert.match(out.error, /no usage left/);
  // one exec — the ping — and never the consult itself
  const execs = readFileSync(touched, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("exec") && !l.includes("--help"));
  assert.equal(execs.length, 1);
});

test("consult: refuses a malformed config instead of crashing", () => {
  const { root, run } = consultProject({ model: null, effort: null });
  const cfg = JSON.parse(readFileSync(join(root, ".trio", "config.json"), "utf8"));
  cfg.codex.lenses = null;
  writeFileSync(join(root, ".trio", "config.json"), JSON.stringify(cfg));
  const res = run(["consult", "is this sound?"]);
  assert.doesNotMatch(res.stderr, /TypeError/);
  assert.match(res.stdout, /codex\.lenses/);
  assert.notEqual(res.status, 0);
});

test("models --json carries what consult runs on", () => {
  const { run } = consultProject({ model: "fake-model", effort: "low" });
  const res = run(["models", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).consult, {
    model: "fake-model",
    effort: "low",
  });
});

// Trio ships on, so /trio:off is the whole opt-out. It has to hold before the
// forced probe, not after it — the fake records any invocation, for any
// subcommand, so absence of the log is proof rather than inference. Unseeded
// on purpose: a warm cache would make "never probed" true for the wrong reason.
for (const [name, args] of [
  ["run", ["run", "--lenses", "auditor"]],
  ["consult", ["consult", "is this safe?"]],
]) {
  test(`${name}: an opted-out project never invokes Codex`, () => {
    const log = join(mkTmp("trio-touch-"), "codex-was-invoked.log");
    const { root, cli } = project({ seed: false, extra: { FAKE_CODEX_TOUCH: log } });
    writeFileSync(
      join(root, ".trio", "config.json"),
      JSON.stringify({ enabled: false, view: { mode: "off" } }),
    );

    const res = cli(args);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Trio is off/);
    assert.equal(
      existsSync(log)
        ? `codex was invoked with: ${readFileSync(log, "utf8").trim()}`
        : "not invoked",
      "not invoked",
    );
  });
}

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

// What startRun/continueRun put in a finished run's `promotion` block — a
// missing directory, offerToCreate:false, an existing directory, a link out of
// the project — is in-process in tests/integration/driver.test.mjs. What
// stays here is the `promote` command itself.

test("promote --create makes the directory and promotes the finished run", () => {
  const { root, cli, info } = ceiling();
  const r = info.ceiling;

  const p = cli(["promote", r.runId, "--create"]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /Created Docs\/Audit\/ and promoted/);

  // The run the operator just watched is written out, not only future ones.
  const codex = join(root, "Docs", "Audit", "codex");
  const claude = join(root, "Docs", "Audit", "claude");
  assert.ok(existsSync(codex) && existsSync(claude));
  const day = readdirSync(codex)[0];
  assert.match(
    readFileSync(join(codex, day, "audit-1.md"), "utf8"),
    /## Findings/,
  );
  assert.match(
    readFileSync(join(claude, readdirSync(claude)[0], "audit-1.md"), "utf8"),
    /Where we disagreed/,
  );
});

test("promote without --create refuses rather than creating the directory", () => {
  const { root, cli, info } = ceiling();
  const p = cli(["promote", info.ceiling.runId]);
  assert.equal(p.status, 1);
  assert.match(p.stdout, /does not exist/);
  assert.equal(existsSync(join(root, "Docs")), false);
});

// .trio/config.json is repository-writable and promotion writes where it
// points, so a path leaving the project is refused before anything is made.
test("promote --create refuses a promoteTo outside the project and creates nothing", () => {
  const { root, cli, info } = ceiling();
  const r = info.ceiling;
  const outsideName = `trio-escape-${r.runId}`;
  const configFile = join(root, ".trio", "config.json");
  for (const promoteTo of [`../${outsideName}`, join(root, "..", outsideName)]) {
    const cfg = JSON.parse(readFileSync(configFile, "utf8"));
    cfg.artifacts = { ...cfg.artifacts, promoteTo };
    writeFileSync(configFile, JSON.stringify(cfg));
    const p = cli(["promote", r.runId, "--create"]);
    assert.equal(p.status, 2, `${promoteTo}: ${p.stdout}`);
    assert.match(p.stdout, /artifacts\.promoteTo/);
    assert.equal(existsSync(join(root, "..", outsideName)), false);
  }
});

test("promote defaults to the most recent finished run", () => {
  const { cli, info } = clean();
  assert.equal(info.done.status, "finished");
  const p = cli(["promote", "--create"]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, new RegExp(info.done.runId));
});

// A lexically valid promoteTo can still lead outside through a directory
// link; the lexical CLI tests never reach promote() for that. Junctions need
// no admin on Windows; the test skips where the OS refuses.
test("promote refuses, without crashing, a promotion directory that links outside", async (t) => {
  const { symlinkSync } = await import("node:fs");
  const { root, cli, info } = ceiling();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const outside = mkTmp("trio-outside-");
  try {
    symlinkSync(outside, join(root, "Docs", "Audit", "codex"), "junction");
  } catch (err) {
    t.skip(`cannot create a directory link here: ${err.code}`);
    return;
  }

  const p = cli(["promote", info.ceiling.runId]);
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stdout, /outside the project/);
  assert.doesNotMatch(p.stderr, /\n\s+at /, "a refusal must not be a stack trace");
  assert.deepEqual(readdirSync(outside), []);
});

// Hitting the ceiling with blockers open is two situations wearing one word:
// still converging, or thrashing. The counts are what tell them apart, so
// they travel with the offer. `--max 1` hits the ceiling on its settling
// continue: pass 1 both runs and exhausts the budget. The result asserted on
// is the one the real CLI produced when the golden project was built.
test("ceiling_reached carries an extension offer with the progress counts", () => {
  const { info } = ceiling();
  assert.equal(info.ceiling.verdict, "ceiling_reached");
  assert.equal(info.ceiling.extension.offer, true);
  assert.equal(info.ceiling.extension.blocking, 1);
  assert.equal(info.ceiling.extension.nextMax, 2);
  assert.equal(typeof info.ceiling.extension.closed, "number");
  assert.equal(typeof info.ceiling.extension.new, "number");
});

// A converged run has nothing to extend, so it must not be asked about.
test("a clean run carries no extension offer", () => {
  const { info } = clean();
  assert.equal(info.done.verdict, "clean");
  assert.equal(info.done.extension, undefined);
});

// One more pass on the same run, so pass N+1 compares against pass N instead
// of starting over with nothing to diff against.
test("extend: reopens a ceiling-reached run for one more pass", () => {
  const { root, cli, info } = ceiling();
  const first = info.ceiling;
  assert.equal(first.verdict, "ceiling_reached");

  // --unadjudicated: the golden's settling continue left pass 1 unreviewed on
  // purpose; the gate this bypasses gets its own dedicated tests below.
  const r = cli(["extend", first.runId, "--unadjudicated"]);
  assert.equal(r.status, 0);
  const after = JSON.parse(r.stdout);
  assert.equal(after.runId, first.runId, "extend must not start a new run");
  // The verdict it stopped on is evidence, not something to quietly drop.
  assert.ok(
    existsSync(
      join(root, ".trio", "runs", first.runId, "pass-1", "verdict-at-ceiling.json"),
    ),
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(root, ".trio", "runs", first.runId, "run.json"), "utf8"),
    ).config.maxIterations,
    2,
  );
});

// A run that reached its verdict on the merits did not stop because of the
// ceiling, and extending it would overwrite a real answer.
test("extend: refuses a run that did not stop at the ceiling", () => {
  const { root, cli, info } = clean();
  const done = info.done;
  assert.equal(done.verdict, "clean");
  const r = cli(["extend", done.runId]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /stopped at the ceiling/);
  assert.equal(
    JSON.parse(
      readFileSync(
        join(root, ".trio", "runs", done.runId, "verdict.json"),
        "utf8",
      ),
    ).verdict,
    "clean",
  );
});

test("extend: refuses a run id Trio did not mint", () => {
  const { cli } = project();
  const r = cli(["extend", "../../escaped"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Not a run id/);
});

// Corroboration and disagreement in one pass: the shared finding carries both
// lane names, the Claude-only one carries just "claude". That last column is
// the reason the second lane exists — before it, Claude could only judge.
// The rest of the Claude-lane behaviour (blocking convergence, surviving into
// pass 2, refusing to be dropped, the malformed-file variants) is in-process in
// tests/integration/driver.test.mjs.
test("--claude-findings merges as a lane beside the Codex lenses", () => {
  const { root, cli } = project({ findings: FINDING });
  const f = join(root, "claude-audit.json");
  writeFileSync(
    f,
    JSON.stringify({
      findings: [
        {
          severity: "major",
          file: "src/app.js",
          line: 1,
          title: "add() subtracts",
          evidence: "return a - b",
          impact: "wrong number",
          correction: "return a + b",
        },
        {
          severity: "major",
          file: "src/only-claude.js",
          line: 3,
          title: "codex never looked here",
          evidence: "n/a",
          impact: "n/a",
          correction: null,
        },
      ],
    }),
  );

  const r = JSON.parse(
    cli(["run", "--lenses", "auditor", "--claude-findings", f]).stdout,
  );
  assert.equal(r.status, "awaiting_response");

  const rec = JSON.parse(
    readFileSync(
      join(root, ".trio", "runs", r.runId, "pass-1", "reconcile.json"),
      "utf8",
    ),
  );
  const shared = rec.findings.find((x) => x.title === "add() subtracts");
  const mine = rec.findings.find((x) => x.title === "codex never looked here");
  assert.match(shared.lens, /auditor/);
  assert.match(shared.lens, /claude/);
  assert.equal(mine.lens, "claude");
  // The lane is recorded, but it is not a Codex lens and must not be filed
  // as one — nothing spawned it and it cannot time out.
  assert.equal(rec.claude.length, 2);
  assert.equal(rec.lenses.length, 1);
  assert.equal(
    existsSync(join(root, ".trio", "runs", r.runId, "pass-1", "codex", "claude.json")),
    false,
  );

  // The exit-code wiring for the in-process `claude_lane_missing` refusal:
  // `continue` carries no --claude-findings, and this run's pass 1 had one.
  // --unadjudicated bypasses the newer gate in front of it.
  const dropped = cli(["continue", "--unadjudicated"]);
  assert.equal(dropped.status, 2);
  assert.match(dropped.stdout, /carried a Claude audit/);
  assert.equal(
    existsSync(join(root, ".trio", "runs", r.runId, "pass-2")),
    false,
    "a refused continue must not have run a pass",
  );
});

// A handover that will not parse must cost neither a lock nor a wave of
// Codex processes — a run that silently audits one lane while reporting two
// is worse than one that refuses to start. One case here, for the flag and
// exit-code wiring; the other malformed shapes are in the driver tests.
test("--claude-findings refuses a malformed file before claiming the lock", () => {
  const { root, cli } = project({ findings: FINDING });
  const f = join(root, "bad.json");
  writeFileSync(f, "{ not json");
  const r = cli(["run", "--lenses", "auditor", "--claude-findings", f]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--claude-findings/);
  assert.equal(existsSync(join(root, ".trio", "active")), false);
});

// continue and extend inherit target, scope and lenses from run.json, so a
// run-only flag here is a silent no-op — exactly what the guard exists for.
test("continue and extend refuse run-only flags instead of ignoring them", () => {
  const { cli } = project({ findings: FINDING });
  for (const args of [
    ["continue", "--lenses", "security"],
    ["continue", "--scope", "x"],
    ["extend", "--target", "."],
  ]) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stdout, /unknown flag/);
  }
});

// --- D-adjudication-gate: continue/extend refuse to advance an unadjudicated pass ---

test("continue: refuses (exit 2) a pass with live findings and no verdicts.json, touching neither lock", () => {
  const { root, cli, info } = parked();
  const first = info.first;
  assert.equal(first.status, "awaiting_response");

  const res = cli(["continue"]);
  assert.equal(res.status, 2, res.stdout);
  assert.match(res.stdout, /pass-1\/verdicts\.json/);
  assert.match(res.stdout, /trio verdicts/);
  assert.match(res.stdout, /--unadjudicated/);

  // Nothing moved: the marker still names pass 1 exactly as it did, no worker
  // lock was ever created, and no pass 2 exists.
  const marker = JSON.parse(readFileSync(join(root, ".trio", "active"), "utf8"));
  assert.equal(marker.run, first.runId);
  assert.equal(marker.pass, 1);
  assert.equal(existsSync(join(root, ".trio", "worker.lock")), false);
  assert.equal(existsSync(join(root, ".trio", "runs", first.runId, "pass-2")), false);
});

// Also the CLI-level proof that a ceiling-reached pass settles: the golden's
// settling `continue --unadjudicated` is the call under test. (An unanswered
// finding still open at the ceiling reporting ceiling_reached is the driver's
// own "pass 2 still finding the issue hits the ceiling".)
test("continue: --unadjudicated bypasses the gate, advances the run, and marks the pass", () => {
  const { root, info } = ceiling();
  assert.equal(info.first.final, true);
  assert.equal(info.res.status, 0, info.res.stderr);
  assert.equal(info.ceiling.verdict, "ceiling_reached");

  const rec = JSON.parse(
    readFileSync(
      join(root, ".trio", "runs", info.first.runId, "pass-1", "reconcile.json"),
      "utf8",
    ),
  );
  assert.equal(rec.unadjudicated, true);
});

test("extend: refuses (exit 2) a ceiling-reached run whose last pass was never adjudicated", () => {
  const { root, cli, info } = ceiling();
  const ceilingRun = info.ceiling;
  assert.equal(ceilingRun.verdict, "ceiling_reached");

  const res = cli(["extend", ceilingRun.runId]);
  assert.equal(res.status, 2, res.stdout);
  assert.match(res.stdout, /pass-1\/verdicts\.json/);

  // reopenRun never ran: the run is exactly as extend found it.
  assert.equal(
    JSON.parse(
      readFileSync(join(root, ".trio", "runs", ceilingRun.runId, "verdict.json"), "utf8"),
    ).verdict,
    "ceiling_reached",
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(root, ".trio", "runs", ceilingRun.runId, "run.json"), "utf8"),
    ).config.maxIterations,
    1,
  );
});

// --- D-codex-preflight: continue/extend check Codex availability too ---

test("continue: refuses before spawning pass N+1's lens when Codex reports no usage left", () => {
  const { root, cli, info } = parked();
  const first = info.first;
  assert.equal(first.status, "awaiting_response");

  // Adjudicate pass 1 so the gate above lets this through and the
  // codex-availability check is the only thing left standing in the way.
  const rec = JSON.parse(
    readFileSync(
      join(root, ".trio", "runs", first.runId, "pass-1", "reconcile.json"),
      "utf8",
    ),
  );
  writeFileSync(
    join(root, ".trio", "runs", first.runId, "pass-1", "verdicts.json"),
    JSON.stringify({
      verdicts: rec.findings.map((f) => ({ id: f.id, verdict: "confirm", basis: "still real" })),
    }),
  );

  const res = cli(["continue"], { FAKE_CODEX_STDERR: "You've hit your usage limit." });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "codex_unavailable");
  assert.equal(out.codexUnavailable.kind, "usage");
  // Pass 2 was never created: the check ran before the lens wave.
  assert.equal(existsSync(join(root, ".trio", "runs", first.runId, "pass-2")), false);
  const marker = JSON.parse(readFileSync(join(root, ".trio", "active"), "utf8"));
  assert.equal(marker.pass, 1, "the marker never advanced");
});

test("extend: refuses before reopening the run when Codex reports no usage left", () => {
  const { root, cli, info } = ceiling();
  const ceilingRun = info.ceiling;
  assert.equal(ceilingRun.verdict, "ceiling_reached");

  const res = cli(["extend", ceilingRun.runId, "--unadjudicated"], {
    FAKE_CODEX_STDERR: "You've hit your usage limit.",
  });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, "refused");
  assert.equal(out.codexUnavailable.kind, "usage");

  // reopenRun never ran: the ceiling verdict stands, unextended.
  assert.equal(
    JSON.parse(
      readFileSync(join(root, ".trio", "runs", ceilingRun.runId, "verdict.json"), "utf8"),
    ).verdict,
    "ceiling_reached",
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(root, ".trio", "runs", ceilingRun.runId, "run.json"), "utf8"),
    ).config.maxIterations,
    1,
    "not raised",
  );
});
