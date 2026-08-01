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
import { startRun, continueRun } from "../src/driver.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { findingId } from "../src/findings.mjs";
import { appendEvent, makeEvent, readEvents } from "../src/bus.mjs";
import {
  runDir,
  passDir,
  activeMarker,
  trioDir,
  configPath,
} from "../src/paths.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-driver-"));

const cfg = (over = {}) => ({
  ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
  codex: {
    parallel: 1,
    lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
  },
  ...over,
});

const finding = (title, severity = "major") => ({
  severity,
  file: "a.rs",
  title,
  evidence: "",
  impact: "",
  correction: "",
  id: findingId("a.rs", title),
});

const okLens = (findings) => async ({ lens }) => ({
  lens: lens.name,
  status: "ok",
  findings,
  threadId: "t",
  raw: "",
});

test("startRun: a lens that finds nothing finishes clean immediately", async () => {
  const root = tmp();
  const r = await startRun({
    root,
    config: cfg(),
    target: "/repo",
    runLensFn: okLens([]),
  });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "clean");
  const verdict = JSON.parse(
    readFileSync(join(runDir(root, r.runId), "verdict.json"), "utf8"),
  );
  assert.equal(verdict.verdict, "clean");
  assert.equal(existsSync(activeMarker(root)), false);
});

test("startRun: a major finding yields awaiting_response with the marker held", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const r = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
  });
  assert.equal(r.status, "awaiting_response");
  assert.equal(r.pass, 1);
  assert.equal(r.findings.length, 1);
  const marker = JSON.parse(readFileSync(activeMarker(root), "utf8"));
  assert.equal(marker.run, r.runId);
  assert.equal(marker.pass, 1);
  // The owning process id is what `trio cancel` signals.
  assert.equal(marker.pid, process.pid);
  assert.ok(existsSync(join(passDir(root, r.runId, 1), "reconcile.json")));
  assert.equal(
    existsSync(join(runDir(root, r.runId), "verdict.json")),
    false,
  );
  const runJson = JSON.parse(
    readFileSync(join(runDir(root, r.runId), "run.json"), "utf8"),
  );
  assert.equal(runJson.target, "/repo");
  assert.deepEqual(runJson.config, config);
});

test("startRun: refuses to start over a run that is still in flight", async () => {
  const root = tmp();
  const first = await startRun({
    root,
    config: cfg({ maxIterations: 2 }),
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
  });
  assert.equal(first.status, "awaiting_response");

  let called = false;
  const second = await startRun({
    root,
    config: cfg({ maxIterations: 2 }),
    target: "/repo",
    runLensFn: async (...args) => {
      called = true;
      return okLens([])(...args);
    },
  });
  assert.equal(second.status, "run_in_progress");
  assert.equal(second.runId, first.runId);
  assert.equal(second.pass, 1);
  assert.equal(called, false, "the second run must not spawn a lens");
  // The first run's marker and artifacts are untouched.
  const marker = JSON.parse(readFileSync(activeMarker(root), "utf8"));
  assert.equal(marker.run, first.runId);
  assert.equal(marker.pass, 1);
});

test("startRun: a marker left behind by a finished run is cleared, not obeyed", async () => {
  const root = tmp();
  const done = await startRun({
    root,
    config: cfg(),
    target: "/repo",
    runLensFn: okLens([]),
  });
  assert.equal(done.verdict, "clean");
  // Simulate a crash after finalization that left the marker behind.
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    activeMarker(root),
    JSON.stringify({ run: done.runId, pass: 1 }),
  );

  const next = await startRun({
    root,
    config: cfg(),
    target: "/repo",
    runLensFn: okLens([]),
  });
  assert.equal(next.status, "finished");
  assert.notEqual(next.runId, done.runId);
});

test("continueRun: a refuting verdict converges without another lens call", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  let calls = 0;
  const runLensFn = async ({ lens }) => {
    calls++;
    return {
      lens: lens.name,
      status: "ok",
      findings: [finding("leak")],
      threadId: "t",
      raw: "",
    };
  };
  const started = await startRun({ root, config, target: "/repo", runLensFn });
  assert.equal(calls, 1);

  writeFileSync(
    join(passDir(root, started.runId, 1), "verdicts.json"),
    JSON.stringify({
      verdicts: [
        { id: findingId("a.rs", "leak"), verdict: "refute", basis: "not reachable" },
      ],
    }),
  );

  const r = await continueRun({ root, runLensFn });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "clean");
  assert.equal(calls, 1);
  assert.equal(existsSync(activeMarker(root)), false);
});

test("continueRun: pass 2's brief carries forward findings, response, and claude's diff", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const started = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
  });

  writeFileSync(
    join(passDir(root, started.runId, 1), "response.json"),
    JSON.stringify({
      findings: [
        { id: findingId("a.rs", "leak"), action: "declined", reason: "by design" },
      ],
    }),
  );
  appendEvent(
    runDir(root, started.runId),
    makeEvent({
      run: started.runId,
      pass: 1,
      lane: "claude",
      actor: "claude",
      kind: "file_change",
      payload: { file: "a.rs", diff: "@@ -1 +1 @@\n-old\n+new" },
    }),
  );

  let seenBrief = null;
  const runLensFn2 = async ({ lens, brief }) => {
    seenBrief = brief;
    return { lens: lens.name, status: "ok", findings: [], threadId: "t", raw: "" };
  };
  const r = await continueRun({ root, runLensFn: runLensFn2 });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "clean");
  assert.equal(r.passes, 2);
  assert.match(seenBrief, /leak/);
  assert.match(seenBrief, /by design/);
  assert.match(seenBrief, /new/);
});

test("continueRun: pass 2 still finding the issue hits the ceiling", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const runLensFn = okLens([finding("leak")]);
  const started = await startRun({ root, config, target: "/repo", runLensFn });
  const r = await continueRun({ root, runLensFn });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "ceiling_reached");
  assert.equal(r.passes, 2);
  assert.equal(existsSync(activeMarker(root)), false);
  void started;
});

test("continueRun: no active run", async () => {
  const root = tmp();
  const r = await continueRun({ root, runLensFn: okLens([]) });
  assert.deepEqual(r, { status: "no_active_run" });
});

test("continueRun: a rejecting lens finishes failed", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const started = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
  });
  const boom = async () => {
    throw new Error("boom");
  };
  const r = await continueRun({ root, runLensFn: boom });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "failed");
  const verdict = JSON.parse(
    readFileSync(join(runDir(root, started.runId), "verdict.json"), "utf8"),
  );
  assert.equal(verdict.verdict, "failed");
  assert.equal(existsSync(activeMarker(root)), false);
});

test("continueRun: a pre-existing verdict.json wins without being rewritten", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const started = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
  });
  const verdictPath = join(runDir(root, started.runId), "verdict.json");
  const canceled =
    JSON.stringify({ verdict: "cancelled", passes: 1, runId: started.runId }, null, 2) +
    "\n";
  writeFileSync(verdictPath, canceled);

  const r = await continueRun({ root, runLensFn: okLens([finding("leak")]) });
  assert.equal(r.status, "already_finished");
  assert.equal(r.verdict, "cancelled");
  assert.equal(readFileSync(verdictPath, "utf8"), canceled);
  assert.equal(existsSync(activeMarker(root)), false);
});

test("continueRun: a malformed verdict value does not crash the run", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const runLensFn = okLens([finding("leak")]);
  const started = await startRun({ root, config, target: "/repo", runLensFn });
  writeFileSync(
    join(passDir(root, started.runId, 1), "verdicts.json"),
    JSON.stringify({
      verdicts: [{ id: findingId("a.rs", "leak"), verdict: "maybe", basis: "??" }],
    }),
  );

  const r = await continueRun({ root, runLensFn });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "ceiling_reached");
  assert.equal(r.passes, 2);
});

test("continueRun: a live config edit mid-run is ignored", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const runLensFn = okLens([finding("leak")]);
  await startRun({ root, config, target: "/repo", runLensFn });

  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(configPath(root), JSON.stringify({ ...config, maxIterations: 99 }));

  const r = await continueRun({ root, runLensFn });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "ceiling_reached");
  assert.equal(r.passes, 2);
});

test("startRun: a throwing beforeFirstPass does not block the run", async () => {
  const root = tmp();
  const beforeFirstPass = async () => {
    throw new Error("viewer exploded");
  };
  const r = await startRun({
    root,
    config: cfg(),
    target: "/repo",
    runLensFn: okLens([]),
    beforeFirstPass,
  });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "clean");
});

test("startRun: a throwing lens finalizes failed, not a crash", async () => {
  const root = tmp();
  const runLensFn = async () => {
    throw new Error("boom");
  };
  const r = await startRun({ root, config: cfg(), target: "/repo", runLensFn });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "failed");
  assert.equal(r.error, "boom");
  assert.equal(existsSync(activeMarker(root)), false);
});

test("continueRun: a corrupt run.json finalizes failed instead of throwing", async () => {
  const root = tmp();
  mkdirSync(runDir(root, "r1"), { recursive: true });
  writeFileSync(join(runDir(root, "r1"), "run.json"), "{ not json");
  writeFileSync(activeMarker(root), JSON.stringify({ run: "r1", pass: 1 }));

  const r = await continueRun({ root, runLensFn: okLens([]) });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "failed");
  assert.equal(existsSync(activeMarker(root)), false);
});

test("continueRun: no completed pass on disk finalizes failed", async () => {
  const root = tmp();
  mkdirSync(runDir(root, "r1"), { recursive: true });
  writeFileSync(
    join(runDir(root, "r1"), "run.json"),
    JSON.stringify({
      runId: "r1",
      target: "/repo",
      startedAt: new Date().toISOString(),
      config: cfg(),
    }),
  );
  writeFileSync(activeMarker(root), JSON.stringify({ run: "r1", pass: 1 }));

  const r = await continueRun({ root, runLensFn: okLens([]) });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "failed");
  assert.equal(existsSync(activeMarker(root)), false);
});

// --- Fix round 1 regressions ---

test("continueRun: a corrupt verdict.json returns already_finished/unknown without throwing", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const started = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
  });
  const verdictPath = join(runDir(root, started.runId), "verdict.json");
  const corrupt = "{ not json";
  writeFileSync(verdictPath, corrupt);

  const r = await continueRun({ root, runLensFn: okLens([finding("leak")]) });
  assert.equal(r.status, "already_finished");
  assert.equal(r.verdict, "unknown");
  assert.equal(readFileSync(verdictPath, "utf8"), corrupt);
  assert.equal(existsSync(activeMarker(root)), false);
});

test("startRun: a promote() throw does not corrupt the verdict or escape", async () => {
  const root = tmp();
  mkdirSync(root, { recursive: true });
  const promoteFile = join(root, "promote-target-is-a-file");
  writeFileSync(promoteFile, "not a directory");
  const config = cfg({
    artifacts: { promoteTo: "promote-target-is-a-file" },
  });

  const r = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([]),
  });

  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "clean");
  assert.equal(r.promoted, null);

  const verdictPath = join(runDir(root, r.runId), "verdict.json");
  const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
  assert.equal(verdict.verdict, "clean");

  const events = readEvents(runDir(root, r.runId));
  assert.ok(
    events.some((e) => e.kind === "error" && /promote/i.test(e.payload.error)),
  );
});

test("continueRun: a corrupt run.json does not prevent an existing verdict.json from winning", async () => {
  const root = tmp();
  mkdirSync(runDir(root, "r1"), { recursive: true });
  writeFileSync(join(runDir(root, "r1"), "run.json"), "{ not json");
  const verdictPath = join(runDir(root, "r1"), "verdict.json");
  const canceled =
    JSON.stringify({ verdict: "cancelled", passes: 1, runId: "r1" }, null, 2) +
    "\n";
  writeFileSync(verdictPath, canceled);
  writeFileSync(activeMarker(root), JSON.stringify({ run: "r1", pass: 1 }));

  const r = await continueRun({ root, runLensFn: okLens([]) });
  assert.equal(r.status, "already_finished");
  assert.equal(r.verdict, "cancelled");
  assert.equal(readFileSync(verdictPath, "utf8"), canceled);
  assert.equal(existsSync(activeMarker(root)), false);
});

// --- Per-run lens selection ---

const twoLensCfg = (over = {}) =>
  cfg({
    codex: {
      parallel: 2,
      lenses: [
        { name: "auditor", model: "m", effort: "low", on: true },
        { name: "security", model: "m", effort: "low", on: true },
      ],
    },
    ...over,
  });

test("startRun: lenses array restricts run.json snapshot and which lenses run", async () => {
  const root = tmp();
  const config = twoLensCfg();
  const calls = [];
  const runLensFn = async ({ lens }) => {
    calls.push(lens.name);
    return { lens: lens.name, status: "ok", findings: [], threadId: "t", raw: "" };
  };
  const r = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn,
    lenses: ["auditor"],
  });
  assert.equal(r.status, "finished");
  assert.deepEqual(calls, ["auditor"]);
  const runJson = JSON.parse(
    readFileSync(join(runDir(root, r.runId), "run.json"), "utf8"),
  );
  const snapLenses = runJson.config.codex.lenses;
  assert.equal(snapLenses.find((l) => l.name === "auditor").on, true);
  assert.equal(snapLenses.find((l) => l.name === "security").on, false);
});

test('startRun: lenses "all" enables every configured lens', async () => {
  const root = tmp();
  const config = cfg({
    codex: {
      parallel: 3,
      lenses: [
        { name: "auditor", model: "m", effort: "low", on: true },
        { name: "security", model: "m", effort: "low", on: false },
        { name: "tester", model: "m", effort: "low", on: false },
      ],
    },
  });
  const calls = [];
  const runLensFn = async ({ lens }) => {
    calls.push(lens.name);
    return { lens: lens.name, status: "ok", findings: [], threadId: "t", raw: "" };
  };
  const r = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn,
    lenses: "all",
  });
  assert.equal(r.status, "finished");
  assert.deepEqual(calls.sort(), ["auditor", "security", "tester"]);
});

test("startRun: an unknown lens name returns invalid_lenses and creates nothing", async () => {
  const root = tmp();
  const config = twoLensCfg();
  const r = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([]),
    lenses: ["bogus"],
  });
  assert.equal(r.status, "invalid_lenses");
  assert.match(r.error, /unknown lens: bogus/);
  assert.match(r.error, /known: auditor, security/);
  assert.equal(r.runId, undefined);
  assert.equal(existsSync(trioDir(root)), false);
});

// A pass with no lenses reviews nothing, finds nothing, and converges — it
// would have reported `clean` on the strength of no audit at all.
test("startRun: an all-off config is refused rather than reported clean", async () => {
  const root = tmp();
  const config = twoLensCfg();
  config.codex.lenses = config.codex.lenses.map((l) => ({ ...l, on: false }));
  let ran = 0;
  const r = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: async (a) => {
      ran++;
      return okLens([])(a);
    },
  });
  assert.equal(r.status, "no_lenses");
  assert.match(r.error, /without reviewing anything/);
  assert.equal(ran, 0);
  assert.equal(existsSync(trioDir(root)), false);
});

test("continueRun: pass 2 keeps the lens restriction startRun applied", async () => {
  const root = tmp();
  const config = twoLensCfg({ maxIterations: 2 });
  const started = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
    lenses: ["auditor"],
  });
  assert.equal(started.status, "awaiting_response");

  const calls = [];
  const runLensFn2 = async ({ lens }) => {
    calls.push(lens.name);
    return { lens: lens.name, status: "ok", findings: [], threadId: "t", raw: "" };
  };
  const r = await continueRun({ root, runLensFn: runLensFn2 });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "clean");
  assert.deepEqual(calls, ["auditor"]);
});

test("continueRun: a corrupt reconcile.json still degrades to a safe failed result", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const started = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
  });
  // Corrupts the very record continueRun (and finalizeFailed's own
  // collectPasses) both need to read, so finalize() itself throws.
  writeFileSync(
    join(passDir(root, started.runId, 1), "reconcile.json"),
    "{ not json",
  );

  const r = await continueRun({ root, runLensFn: okLens([finding("leak")]) });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "failed");
  assert.ok(r.error);
  assert.ok(r.finalizeError);
  assert.equal(existsSync(activeMarker(root)), false);
});
