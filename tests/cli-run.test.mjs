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
  readdirSync,
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
  // 3, not 1: a caller that polls has to tell "the lock is held, wait" apart
  // from the refusals where waiting never helps.
  assert.equal(second.status, 3);
  assert.match(second.stdout, /already in progress/);
  assert.match(second.stdout, new RegExp(first.runId));
  // The first run's marker is untouched.
  const marker = JSON.parse(readFileSync(join(root, ".trio", "active"), "utf8"));
  assert.equal(marker.run, first.runId);
});

// A harness timeout, a crash, or a reboot leaves a marker no signal handler
// got to clear — on win32 nothing can, because kill is TerminateProcess. The
// lock has to be reclaimable without a human running /trio:cancel.
test("run: reclaims a claim whose process died mid-pass", () => {
  const { root, cli } = project({ findings: FINDING });
  const first = JSON.parse(cli(["run", "--lenses", "auditor"]).stdout);
  assert.equal(first.status, "awaiting_response");

  // Pid 1 exists on POSIX and on win32, so the marker below has to name
  // something genuinely absent. High pids are recycled; a fresh child's pid
  // is guaranteed dead the moment it has exited and reaped.
  const corpse = spawnSync(process.execPath, ["-e", ""]);
  const dead = corpse.pid;

  // Pass 1 completed, so the parked run is legitimately locked. Point the
  // marker at a pass that never reconciled — what a mid-pass kill leaves.
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: first.runId, pass: 2, pid: dead }),
  );

  const second = cli(["run", "--lenses", "auditor"]);
  assert.equal(second.status, 0);
  const parsed = JSON.parse(second.stdout);
  assert.notEqual(parsed.runId, first.runId);
  // The abandoned run is closed out, not left looking like it is still going.
  assert.equal(
    JSON.parse(
      readFileSync(join(root, ".trio", "runs", first.runId, "verdict.json"), "utf8"),
    ).verdict,
    "cancelled",
  );
});

// The counterpart: no process is running while a run waits for its reply
// either, and that lock must hold. The completed pass on disk is what tells
// the two apart.
test("run: does not reclaim a parked run just because no process is alive", () => {
  const { root, cli } = project({ findings: FINDING });
  const first = JSON.parse(cli(["run", "--lenses", "auditor"]).stdout);
  assert.equal(first.status, "awaiting_response");

  const corpse = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: first.runId, pass: 1, pid: corpse.pid }),
  );

  const second = cli(["run", "--lenses", "auditor"]);
  assert.equal(second.status, 3);
  assert.match(second.stdout, /already in progress/);
});

test("status --json reports the lock", () => {
  const { root, cli } = project({ findings: FINDING });
  const idle = JSON.parse(cli(["status", "--json"]).stdout);
  assert.equal(idle.busy, false);
  assert.equal(idle.activeRun, null);
  assert.equal(idle.enabled, true);

  const first = JSON.parse(cli(["run", "--lenses", "auditor"]).stdout);
  const busy = JSON.parse(cli(["status", "--json"]).stdout);
  assert.equal(busy.busy, true);
  assert.equal(busy.activeRun, first.runId);
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
  const root = mkdtempSync(join(tmpdir(), "trio-run-json-"));
  const pathDir = mkdtempSync(join(tmpdir(), "trio-bin-"));
  const home = mkdtempSync(join(tmpdir(), "trio-home-"));
  installFakeCodex(pathDir);
  fakeCodexHome(home);
  const touched = join(root, "codex-was-invoked.log");
  const base = { pathDir, codexHome: home, project: root };
  spawnSync("node", [CLI, "on"], { env: fakeEnv(base), encoding: "utf8" });

  // Watched from here: `on` above legitimately probes.
  const watched = fakeEnv({ ...base, extra: { FAKE_CODEX_TOUCH: touched } });
  const idle = spawnSync("node", [CLI, "status", "--json"], {
    env: watched,
    encoding: "utf8",
  });
  assert.equal(idle.status, 0);
  assert.equal(JSON.parse(idle.stdout).busy, false);

  // And again with the lock held — the busy path reads the marker too.
  mkdirSync(join(root, ".trio"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: "2026-01-01T00-00-00", pass: 1, pid: process.pid }),
  );
  const busy = spawnSync("node", [CLI, "status", "--json"], {
    env: watched,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(busy.stdout).busy, true);

  assert.equal(
    existsSync(touched)
      ? `codex was invoked with: ${readFileSync(touched, "utf8").trim()}`
      : "not invoked",
    "not invoked",
  );
});

// A forged marker reaches path.join, and reclaim does not only read — it
// creates a directory and writes a verdict into it.
test("run: refuses to reclaim a claim naming a run id Trio did not mint", () => {
  const { root, cli } = project({ findings: FINDING });
  const corpse = spawnSync(process.execPath, ["-e", ""]);
  mkdirSync(join(root, ".trio"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: "../../escaped", pass: 1, pid: corpse.pid }),
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
  const root = mkdtempSync(join(tmpdir(), "trio-run-scope-"));
  const pathDir = mkdtempSync(join(tmpdir(), "trio-bin-"));
  const home = mkdtempSync(join(tmpdir(), "trio-home-"));
  installFakeCodex(pathDir);
  fakeCodexHome(home);
  const briefs = join(root, "briefs.log");
  const env = fakeEnv({
    pathDir,
    codexHome: home,
    project: root,
    extra: { FAKE_CODEX_FINDINGS: FINDING, FAKE_CODEX_BRIEF_LOG: briefs },
  });
  const cli = (args) => spawnSync("node", [CLI, ...args], { env, encoding: "utf8" });
  assert.equal(cli(["on"]).status, 0);
  assert.equal(cli(["config", "set", "view.mode", "off"]).status, 0);

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
  assert.equal(cli(["continue"]).status, 0);

  const sent = readFileSync(briefs, "utf8")
    .split("===BRIEF===")
    .filter((s) => s.trim());
  assert.equal(sent.length, 2, "one brief per pass");
  for (const brief of sent)
    assert.match(brief, /Concentrate on: src\/app\.js only/);
  // Pass 2 is the one that could silently widen: it rebuilds the brief from
  // disk in a process that never saw the flag.
  assert.match(sent[1], /## Your findings from pass 1/);
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

// Trio ships on, so /trio:off is the whole opt-out. It has to hold before the
// forced probe, not after it — the fake records any invocation, for any
// subcommand, so absence of the log is proof rather than inference.
for (const [name, args] of [
  ["run", ["run", "--lenses", "auditor"]],
  ["consult", ["consult", "is this safe?"]],
]) {
  test(`${name}: an opted-out project never invokes Codex`, () => {
    const root = mkdtempSync(join(tmpdir(), "trio-optout-"));
    const pathDir = mkdtempSync(join(tmpdir(), "trio-bin-"));
    const home = mkdtempSync(join(tmpdir(), "trio-home-"));
    installFakeCodex(pathDir);
    fakeCodexHome(home);
    const touched = join(root, "codex-was-invoked.log");
    const base = { pathDir, codexHome: home, project: root };
    spawnSync("node", [CLI, "off"], { env: fakeEnv(base), encoding: "utf8" });

    const res = spawnSync("node", [CLI, ...args], {
      env: fakeEnv({ ...base, extra: { FAKE_CODEX_TOUCH: touched } }),
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Trio is off/);
    assert.equal(
      existsSync(touched)
        ? `codex was invoked with: ${readFileSync(touched, "utf8").trim()}`
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

test("run: a missing promote directory is reported as an offer, not a silence", () => {
  const { root, cli } = project({ findings: FINDING });
  const r = JSON.parse(cli(["run", "--lenses", "auditor", "--max", "1"]).stdout);
  assert.equal(r.promoted, null);
  assert.deepEqual(r.promotion, {
    skipped: true,
    path: "Docs/Audit",
    offer: true,
  });
  assert.equal(existsSync(join(root, "Docs", "Audit")), false);
});

test("promote --create makes the directory and promotes the finished run", () => {
  const { root, cli } = project({ findings: FINDING });
  const r = JSON.parse(cli(["run", "--lenses", "auditor", "--max", "1"]).stdout);

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
  const { root, cli } = project({ findings: FINDING });
  const r = JSON.parse(cli(["run", "--lenses", "auditor", "--max", "1"]).stdout);
  const p = cli(["promote", r.runId]);
  assert.equal(p.status, 1);
  assert.match(p.stdout, /does not exist/);
  assert.equal(existsSync(join(root, "Docs")), false);
});

test("promote defaults to the most recent finished run", () => {
  const { root, cli } = project();
  const first = JSON.parse(cli(["run", "--lenses", "auditor"]).stdout);
  assert.equal(first.status, "finished");
  const p = cli(["promote", "--create"]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, new RegExp(first.runId));
});

test("declining the offer silences it for good", () => {
  const { root, cli } = project({ findings: FINDING });
  assert.equal(
    cli(["config", "set", "artifacts.offerToCreate", "false"]).status,
    0,
  );
  const r = JSON.parse(cli(["run", "--lenses", "auditor", "--max", "1"]).stdout);
  assert.equal(r.promotion.offer, false);
  assert.equal(r.promotion.skipped, true);
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

// Hitting the ceiling with blockers open is two situations wearing one word:
// still converging, or thrashing. The counts are what tell them apart, so
// they travel with the offer.
test("ceiling_reached carries an extension offer with the progress counts", () => {
  const { cli } = project({ findings: FINDING });
  // --max 1 hits the ceiling inside the first invocation: pass 1 both runs
  // and exhausts the budget, so this finalizes without ever parking.
  const done = JSON.parse(cli(["run", "--max", "1", "--lenses", "auditor"]).stdout);
  assert.equal(done.verdict, "ceiling_reached");
  assert.equal(done.extension.offer, true);
  assert.equal(done.extension.blocking, 1);
  assert.equal(done.extension.nextMax, 2);
  assert.equal(typeof done.extension.closed, "number");
  assert.equal(typeof done.extension.new, "number");
});

// A converged run has nothing to extend, so it must not be asked about.
test("a clean run carries no extension offer", () => {
  const { cli } = project();
  const done = JSON.parse(cli(["run", "--lenses", "auditor"]).stdout);
  assert.equal(done.verdict, "clean");
  assert.equal(done.extension, undefined);
});

// One more pass on the same run, so pass N+1 compares against pass N instead
// of starting over with nothing to diff against.
test("extend: reopens a ceiling-reached run for one more pass", () => {
  const { root, cli } = project({ findings: FINDING });
  const first = JSON.parse(cli(["run", "--max", "1", "--lenses", "auditor"]).stdout);
  assert.equal(first.verdict, "ceiling_reached");

  const r = cli(["extend", first.runId]);
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
  const { root, cli } = project();
  const done = JSON.parse(cli(["run", "--lenses", "auditor"]).stdout);
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

const CLAUDE_FINDINGS = (extra = []) =>
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
      ...extra,
    ],
  });

// Corroboration and disagreement in one pass: the shared finding carries both
// lane names, the Claude-only one carries just "claude". That last column is
// the reason the second lane exists — before it, Claude could only judge.
test("--claude-findings merges as a lane beside the Codex lenses", () => {
  const { root, cli } = project({ findings: FINDING });
  const f = join(root, "claude-audit.json");
  writeFileSync(
    f,
    CLAUDE_FINDINGS([
      {
        severity: "major",
        file: "src/only-claude.js",
        line: 3,
        title: "codex never looked here",
        evidence: "n/a",
        impact: "n/a",
        correction: null,
      },
    ]),
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
});

// A Claude-only finding has to be able to hold a run open on its own, or the
// second lane is decoration.
test("a Claude-only finding blocks convergence like any other", () => {
  const { root, cli } = project();
  const f = join(root, "claude-audit.json");
  writeFileSync(f, CLAUDE_FINDINGS());
  const r = JSON.parse(
    cli(["run", "--lenses", "auditor", "--claude-findings", f]).stdout,
  );
  // Codex found nothing this time; without the lane this run would be clean.
  assert.equal(r.status, "awaiting_response");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].lens, "claude");
});

// A handover that will not parse must cost neither a lock nor a wave of
// Codex processes — a run that silently audits one lane while reporting two
// is worse than one that refuses to start.
test("--claude-findings refuses a malformed file before claiming the lock", () => {
  const { root, cli } = project({ findings: FINDING });
  const f = join(root, "bad.json");

  writeFileSync(f, "{ not json");
  let r = cli(["run", "--lenses", "auditor", "--claude-findings", f]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--claude-findings/);
  assert.equal(existsSync(join(root, ".trio", "active")), false);

  writeFileSync(f, JSON.stringify({ findings: [{ severity: "urgent", file: "a", title: "b" }] }));
  r = cli(["run", "--lenses", "auditor", "--claude-findings", f]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /unknown severity/);
  assert.equal(existsSync(join(root, ".trio", "active")), false);

  writeFileSync(f, JSON.stringify({ findings: [{ severity: "major", file: "a" }] }));
  r = cli(["run", "--lenses", "auditor", "--claude-findings", f]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /file and a title/);
});

// The lane is optional: a Codex-only run must behave exactly as before.
test("no --claude-findings leaves the record without a claude lane", () => {
  const { root, cli } = project({ findings: FINDING });
  const r = JSON.parse(cli(["run", "--lenses", "auditor"]).stdout);
  const rec = JSON.parse(
    readFileSync(
      join(root, ".trio", "runs", r.runId, "pass-1", "reconcile.json"),
      "utf8",
    ),
  );
  assert.equal(rec.claude, undefined);
  assert.equal(rec.findings[0].lens, "auditor");
});

// The lane has to survive adjudication into pass 2. It rides on
// applyAdjudication spreading `...record` and re-using record.findings rather
// than re-merging from record.lenses — which does not contain the claude
// result. Both are load-bearing and neither was asserted anywhere.
test("the Claude lane survives adjudication into pass 2", () => {
  const { root, cli } = project({ findings: FINDING });
  const f = join(root, "claude-audit.json");
  const only = {
    severity: "major",
    file: "src/only-claude.js",
    line: 3,
    title: "codex never looked here",
    evidence: "n/a",
    impact: "n/a",
    correction: null,
  };
  writeFileSync(f, CLAUDE_FINDINGS([only]));
  const first = JSON.parse(
    cli(["run", "--lenses", "auditor", "--claude-findings", f]).stdout,
  );
  writeFileSync(
    join(root, ".trio", "runs", first.runId, "pass-1", "response.json"),
    JSON.stringify({ findings: [], summary: "none" }),
  );

  assert.equal(cli(["continue", "--claude-findings", f]).status, 0);
  const rec2 = JSON.parse(
    readFileSync(
      join(root, ".trio", "runs", first.runId, "pass-2", "reconcile.json"),
      "utf8",
    ),
  );
  const mine = rec2.findings.find((x) => x.title === "codex never looked here");
  assert.ok(mine, "the claude-only finding vanished in pass 2");
  assert.equal(mine.lens, "claude");
  assert.equal(rec2.claude.length, 2);
});

// The failure this prevents is the one this repo already shipped once: a
// finding reported closed because nobody re-checked it.
test("continue refuses to drop a Claude lane the previous pass had", () => {
  const { root, cli } = project({ findings: FINDING });
  const f = join(root, "claude-audit.json");
  writeFileSync(f, CLAUDE_FINDINGS());
  const first = JSON.parse(
    cli(["run", "--lenses", "auditor", "--claude-findings", f]).stdout,
  );
  writeFileSync(
    join(root, ".trio", "runs", first.runId, "pass-1", "response.json"),
    JSON.stringify({ findings: [], summary: "none" }),
  );

  const r = cli(["continue"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /carried a Claude audit/);
  assert.equal(
    existsSync(join(root, ".trio", "runs", first.runId, "pass-2")),
    false,
    "a refused continue must not have run a pass",
  );
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
