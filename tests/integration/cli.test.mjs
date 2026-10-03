// CLI coverage that needs no process of its own: every case calls a command
// module in-process through tests/helpers/cli-harness.mjs, with Codex either
// seeded as already probed or never reached. A regression in argument parsing,
// command routing or exit codes fails `npm test` here.
//
// What stays in tests/process/cli.test.mjs is what only a real process can
// show: signalling real pids, an empty PATH, a real Codex invocation, and
// bin/trio.mjs's own routing.
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
import { runCli, seedCapabilities, fakeCaps } from "../helpers/cli-harness.mjs";

const project = () => mkdtempSync(join(tmpdir(), "trio-cli-"));
// The default harness answers gatherState from a fresh capability cache, so a
// project that reaches it has to be seeded first.
const probed = () => {
  const root = project();
  seedCapabilities(root);
  return root;
};
const trio = (root, args, opts) => runCli(root, args, opts);
const configOf = async (root) => JSON.parse((await trio(root, ["config", "get"])).stdout);

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

// Made-up pids: nothing is running as either, which is what lets these tests
// run in-process. DEAD is never reported alive; LIVE is reported alive by the
// harness's process.kill, which records the signals sent instead of sending
// them. What a real pid does under cancel is tested in tests/process/cli.test.mjs.
const DEAD = 2_147_483_000;
const LIVE = 2_147_483_001;
const asTrio = () => ({ status: 0, stdout: "node C:\\trio\\bin\\trio.mjs cancel\n", stderr: "" });
const asBystander = () => ({ status: 0, stdout: "node -e setInterval(() => {}, 1000)\n", stderr: "" });

test("cancel does not claim to have stopped a process already gone", async () => {
  const root = project();
  claimRun(root, DEAD);
  // Identified as Trio's and the run is claimed, so liveness is all that is
  // left to withhold the signal.
  const r = await trio(root, ["cancel"], { run: asTrio });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Run cancelled\./);
  assert.doesNotMatch(r.stdout, /stopped pid/);
});

// A marker naming a run that was never created is tampered or stale; either
// way its pid must not be signalled.
test("cancel will not signal a pid whose run directory is absent", async () => {
  const root = project();
  mkdirSync(join(root, ".trio"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: RUN_ID, pass: 1, pid: LIVE }),
  );
  const r = await trio(root, ["cancel"], { run: asTrio, alive: [LIVE] });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /stopped pid/);
  assert.deepEqual(r.kills, []);
});

// The command-line identification, at the seam rather than against a live
// process: a pid whose command line is not Trio's gets no signal, however well
// formed the rest of the marker is.
test("cancel withholds the signal from a pid whose command line is not Trio's", async () => {
  const root = project();
  claimRun(root, LIVE);
  const r = await trio(root, ["cancel"], { run: asBystander, alive: [LIVE] });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /stopped pid/);
  assert.deepEqual(r.kills, []);
  // Cancellation still happens — it is the signal that is withheld.
  assert.equal(existsSync(join(root, ".trio", "active")), false);
});

// The traversal the audit found: runId went straight into path.join, and
// render then wrote live.html at whatever that resolved to.
test("a runId that escapes .trio/runs is refused, not joined", async () => {
  const root = project();
  const escape = join("..", "..", "escaped-run");
  for (const cmd of [
    ["render", escape],
    ["serve", escape],
    ["promote", escape],
  ]) {
    const r = await trio(root, cmd);
    assert.equal(r.status, 2, cmd.join(" "));
    assert.match(r.stdout + r.stderr, /Not a run id/);
  }
  assert.equal(existsSync(join(root, "..", "..", "escaped-run")), false);
});

test("render with no run says so instead of throwing", async () => {
  const r = await trio(project(), ["render"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No run to render/);
  assert.doesNotMatch(r.stdout + r.stderr, /ENOENT|at Object|Error:/);
});

test("render names a run id that does not exist", async () => {
  const r = await trio(project(), ["render", "2026-01-01T00-00-00"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No such run/);
});

test("render points at the archive when the run was archived", async () => {
  const root = project();
  const dir = join(root, ".trio", "archive", "2026-W01", "2026-01-01T00-00-00");
  mkdirSync(dir, { recursive: true });
  const r = await trio(root, ["render", "2026-01-01T00-00-00"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No such run: 2026-01-01T00-00-00\. It was archived to .*2026-W01/);
});

// The old parser stepped in twos from index 0, so the "on" token shifted
// everything after it and the model was dropped — with a success message.
// parseLensArgs refuses each shape in tests/unit/cli-args.test.mjs; one row
// here proves the command turns that refusal into an exit code.
test("lens rejects malformed arguments instead of reporting success", async () => {
  const r = await trio(project(), ["lens", "auditor", "model"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /model needs a value/);
});

// `lens auditor on model X` used to drop the model and still exit 0. The
// seeded catalogue only ever knows "fake-model" (see cli-harness.mjs), so the
// outcome is deterministic: the capability check refuses X, and refuses it by
// name — proving the model reached the check rather than being dropped.
test("lens does not silently drop a value after on/off", async () => {
  const root = probed();
  const modelOf = async () =>
    (await configOf(root)).codex.lenses.find((l) => l.name === "auditor").model;
  const before = await modelOf();
  const r = await trio(root, ["lens", "auditor", "on", "model", "not-a-real-model"]);

  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /not-a-real-model/);
  assert.equal(await modelOf(), before, "a rejected change must not persist");
});

test("lens consult is addressable, but has no on/off", async () => {
  const root = project();
  const q = await trio(root, ["lens", "consult"]);
  assert.equal(q.status, 0);
  assert.match(q.stdout, /^consult {2}codex default {2}high/);
  for (const flip of ["on", "off"]) {
    const r = await trio(root, ["lens", "consult", flip]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /no on\/off/);
  }
  assert.match((await trio(root, ["lens", "nope"])).stdout, /known: .*consult/);
});

// `"codex.lenses": null` is valid JSON and survives config.mjs's merge as
// null (see config.mjs's own comment on `merge`). Every command below used to
// reach `config.codex.lenses.forEach` or `.map` on it and throw a raw
// TypeError instead of a message an operator could act on.
const withNullLenses = (root) => {
  mkdirSync(join(root, ".trio"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "config.json"),
    JSON.stringify({ codex: { lenses: null } }),
  );
};

test("the panel reports a malformed lens list instead of crashing", async () => {
  const root = probed();
  withNullLenses(root);
  const r = await trio(root, []);
  assert.doesNotMatch(r.stderr, /TypeError|forEach is not a function/);
  assert.match(r.stdout, /codex\.lenses/);
});

test("on reports a malformed lens list instead of crashing", async () => {
  const root = probed();
  withNullLenses(root);
  const r = await trio(root, ["on"]);
  assert.doesNotMatch(r.stderr, /TypeError|forEach is not a function/);
  assert.match(r.stdout, /codex\.lenses/);
  // `on` still does its own job — config get/set has to keep working so the
  // file can be repaired.
  assert.equal((await configOf(root)).enabled, true);
});

test("doctor reports a malformed lens list instead of crashing", async () => {
  const root = probed();
  withNullLenses(root);
  const r = await trio(root, ["doctor"]);
  assert.doesNotMatch(r.stderr, /TypeError|forEach is not a function/);
  assert.match(r.stdout, /codex\.lenses/);
});

test("models refuses a malformed lens list instead of crashing", async () => {
  const root = probed();
  withNullLenses(root);
  const r = await trio(root, ["models"]);
  assert.doesNotMatch(r.stderr, /TypeError|map is not a function/);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /codex\.lenses/);
});

// config get/set are the way out of a malformed file, so they must keep
// working over one — this is the whole point of refusing rather than
// crashing everywhere else.
test("config get and set still work over a malformed lens list", async () => {
  const root = project();
  withNullLenses(root);
  const got = await trio(root, ["config", "get"]);
  assert.equal(got.status, 0);
  assert.equal(JSON.parse(got.stdout).codex.lenses, null);
  const set = await trio(root, ["config", "set", "maxIterations", "3"]);
  assert.equal(set.status, 0);
});

// .trio/config.json can carry keys this version of Trio no longer reads —
// left behind by an older release, or a hand edit — and that must never be a
// reason to refuse. It should only ever warn.
test("an unknown config key warns without refusing anything", async () => {
  const root = probed();
  mkdirSync(join(root, ".trio"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "config.json"),
    JSON.stringify({ artifacts: { raw: ".trio/runs" }, auto: "ask" }),
  );
  const got = await trio(root, ["config", "get"]);
  assert.equal(got.status, 0);
  assert.match(got.stderr, /artifacts\.raw/);
  assert.match(got.stderr, /auto/);

  const panel = await trio(root, []);
  assert.equal(panel.status, 0);
  assert.match(panel.stdout, /artifacts\.raw/);
});

test("config set rejects an invalid value and names the valid ones", async () => {
  const r = await trio(project(), ["config", "set", "view.mode", "hologram"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /pane/);
});

test("config set persists a valid value", async () => {
  const root = project();
  assert.equal((await trio(root, ["config", "set", "maxIterations", "4"])).status, 0);
  assert.equal((await configOf(root)).maxIterations, 4);
});

test("on and off flip the enabled flag", async () => {
  const root = probed();
  await trio(root, ["on"]);
  assert.equal((await configOf(root)).enabled, true);
  await trio(root, ["off"]);
  assert.equal((await configOf(root)).enabled, false);
});

// The bug this guards: /trio:on used to announce that .trio/ had been added
// to .gitignore whether or not there was a checkout to add it to.
test("on gitignores .trio/ inside a checkout", async () => {
  const root = probed();
  mkdirSync(join(root, ".git"));
  await trio(root, ["on"]);
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.trio\/$/m);
});

test("on writes no .gitignore where there is no checkout", async () => {
  const root = probed();
  await trio(root, ["on"]);
  assert.equal(existsSync(join(root, ".gitignore")), false);
});

// The regression this exists for: an unrecognised flag used to fall through
// to a full five-lens run on the operator's OpenAI credit.
test("run refuses an unrecognised flag instead of starting", async () => {
  const r = await trio(project(), ["run", "--frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /unknown flag: --frobnicate/);
  assert.equal(r.calls.gatherState, 0);
});

test("run --help prints usage rather than running", async () => {
  const r = await trio(project(), ["run", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /trio run /);
  assert.equal(r.calls.gatherState, 0);
});

test("consult treats a leading dash as a typo, not a question", async () => {
  const r = await trio(project(), ["consult", "--help"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /usage: trio consult/);
});

// A dashed value is a badly chosen value, not a missing one — it has to reach
// the check that can say why. Every row is refused before the probe, so the
// capability cache is never consulted.
test("run rejects --max 0 and a negative --max", async () => {
  const root = project();
  for (const bad of ["0", "-1", "1.5", "nope"]) {
    const r = await trio(root, ["run", "--max", bad]);
    assert.equal(r.status, 2, `--max ${bad} was accepted`);
    assert.match(r.stdout + r.stderr, /positive whole number/, `--max ${bad}`);
    assert.equal(r.calls.gatherState, 0, `--max ${bad} reached the probe`);
  }
  assert.equal(existsSync(join(root, ".trio", "runs")), false);
});

test("run rejects a stored maxIterations that is not a positive integer", async () => {
  const root = project();
  mkdirSync(join(root, ".trio"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "config.json"),
    JSON.stringify({ enabled: true, maxIterations: 0 }),
  );
  const r = await trio(root, ["run"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /maxIterations/);
});

test("run rejects a flag that was given no value", async () => {
  for (const [args, expected] of [
    [["run", "--target"], /needs a value/],
    [["run", "--lenses"], /needs a value/],
    [["run", "--max"], /needs a value/],
    // The unknown-flag walk steps over the token after a known flag, so
    // without this guard `--target --lenses auditor` audits a path named
    // "--lenses".
    [["run", "--target", "--lenses", "auditor"], /--target needs a value/],
    // `--lenses ""` parsed to an empty list, which reads as "no selection
    // given" and quietly ran every lens — the opposite of what was asked for.
    [["run", "--lenses", ""], /--lenses needs a value/],
  ]) {
    const r = await trio(project(), args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stdout + r.stderr, expected, JSON.stringify(args));
  }
});

// A value can be present and still name nothing. Rejecting whitespace alone
// left `--lenses ,` running every lens.
test("run rejects a lens list that names nothing", async () => {
  for (const arg of [",", ",,,", " , "]) {
    const r = await trio(project(), ["run", "--lenses", arg]);
    assert.equal(r.status, 2, JSON.stringify(arg));
    assert.match(r.stdout + r.stderr, /--lenses needs (a value|at least one)/);
  }
});

test("off refuses to abandon a run that is still in flight", async () => {
  const root = project();
  mkdirSync(join(root, ".trio", "runs", "r1"), { recursive: true });
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: "r1", pass: 1, pid: 424242 }),
  );
  const r = await trio(root, ["off"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /run is in progress: r1/);
  assert.match(r.stdout, /trio:cancel/);
  // The lock has to survive, or cancel can no longer find the run.
  assert.equal(existsSync(join(root, ".trio", "active")), true);
});

test("off still works once the run has a verdict", async () => {
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
  const r = await trio(root, ["off"]);
  assert.equal(r.status, 0);
  assert.equal((await configOf(root)).enabled, false);
});

test("continue with no active run says so and exits non-zero", async () => {
  const r = await trio(project(), ["continue"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no_active_run/);
});

test("cancel with no active run is a no-op, not an error", async () => {
  const r = await trio(project(), ["cancel"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no active run/i);
});

test("cancel clears an active marker and records the cancelled verdict", async () => {
  const root = project();
  const runId = "2026-01-01T00-00-00";
  mkdirSync(join(root, ".trio", "runs", runId), { recursive: true });
  writeFileSync(
    join(root, ".trio", "active"),
    JSON.stringify({ run: runId, pass: 1 }),
  );
  const r = await trio(root, ["cancel"]);
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(root, ".trio", "active")), false);
  const verdict = JSON.parse(
    readFileSync(join(root, ".trio", "runs", runId, "verdict.json"), "utf8"),
  );
  assert.equal(verdict.verdict, "cancelled");
});

test("consult with no question prints usage and exits 2", async () => {
  const root = project();
  const r = await trio(root, ["consult"]);
  // Usage is checked before the preflight probe, so this holds whether or not
  // a Codex install exists on the machine running the suite.
  assert.equal(r.status, 2);
  assert.match(
    r.stdout,
    /usage: trio consult \[--model NAME\] \[--effort LEVEL\] \[--\] <question>/,
  );
  assert.equal(r.calls.gatherState, 0);
  assert.equal(existsSync(join(root, ".trio", "runs")), false);
});

// An unrecognised --model is a typo worth catching before Codex is spawned at
// all, not just before the question is asked. The seeded catalogue answers the
// lookup, so what is asserted is that nothing past it ran: no ping, no process.
test("consult refuses an unresolvable --model before Codex answers anything", async () => {
  const root = probed();
  const r = await trio(root, ["consult", "--model", "nonexistent", "is", "this", "ok?"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /unknown model: nonexistent/);
  assert.equal(r.calls.codexRefusal, 0, "the ping must not run on a typo");
  assert.deepEqual(r.calls.run, []);
  assert.equal(existsSync(join(root, ".trio", "runs")), false);
});

// A leading dash is still a mistyped flag, not part of the question — this
// is the direction the narrower guard (below) must not have given up.
test("consult still refuses a leading dash as a mistyped flag", async () => {
  const r = await trio(project(), ["consult", "-h", "is", "this", "ok?"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /unrecognised flag: -h/);
});

// A short-dash token elsewhere in the question is a value, not a flag: only a
// long flag anywhere, or any dash in the leading position, is refused. This
// is the case that almost shipped as a refusal: "-1" is part of the
// question, and the unknown-model error below is proof it got there.
test("consult lets a short dash inside the question through to the model check", async () => {
  const r = await trio(probed(), [
    "consult",
    "--model",
    "nope",
    "-1",
    "is",
    "a",
    "valid",
    "index?",
  ]);
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout, /unrecognised flag/);
  assert.match(r.stdout, /unknown model: nope/);
});

// `--model astra --model nope` used to take the first silently. It is now a
// refusal, caught before Codex is even probed — not just before the question
// is asked.
test("a repeated flag is refused before Codex is spawned at all", async () => {
  const r = await trio(project(), [
    "consult",
    "--model",
    "astra",
    "--model",
    "nope",
    "is",
    "this",
    "ok?",
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--model given twice/);
  assert.equal(r.calls.gatherState, 0, "the probe must not run");
  assert.equal(r.calls.codexRefusal, 0, "Codex must not be invoked at all");
  assert.deepEqual(r.calls.run, []);
});

// A catalogue of its own, so `models` reads this one rather than the fake
// Codex's.
const m1Caps = () =>
  fakeCaps({
    cliVersion: "1.0.0",
    cacheClientVersion: "1.0.0",
    defaultModel: "m1",
    models: [{ slug: "m1", displayName: "M1", defaultEffort: "medium", efforts: ["medium", "high"] }],
    flags: [],
    preflight: { state: "ready", message: "", fix: "" },
  });

test("models --apply --json writes the proposals and answers in JSON", async () => {
  const root = project();
  seedCapabilities(root, m1Caps());
  const r = await trio(root, ["models", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(
    out.applied.map((p) => [p.name, p.to]),
    ["auditor", "security", "tester", "simplifier", "consistency", "consult"].map((n) => [n, "m1"]),
  );
  const cfg = JSON.parse(readFileSync(join(root, ".trio", "config.json"), "utf8"));
  assert.equal(cfg.codex.consult.model, "m1");
  const again = JSON.parse((await trio(root, ["models", "--apply", "--json"])).stdout);
  assert.deepEqual(again.applied, []);
});

test("models refuses an unknown argument before touching the config", async () => {
  const root = project();
  seedCapabilities(root, m1Caps());
  const r = await trio(root, ["models", "--apply", "--typo"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /unknown argument: --typo/);
  assert.equal(existsSync(join(root, ".trio", "config.json")), false);
});
