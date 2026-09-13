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
import { classifyFailure } from "../src/failure.mjs";
import { appendEvent, makeEvent, readEvents } from "../src/bus.mjs";
import { workerLockPath } from "../src/marker.mjs";
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

// The decline ledger end to end through the real driver path: buildSettled
// reads pass 1's adjudicated record, briefFor renders it into the pass-2
// brief, and carrySettled annotates the re-raise. The layer tests each inject
// `settled` directly, so this is the only place driver.mjs's own construction
// of it is exercised.
const located = (title, line = 10, file = "a.rs") => ({
  severity: "major",
  file,
  line,
  title,
  evidence: "",
  impact: "",
  correction: "",
  id: findingId(file, title),
});

// A location-only match is not the claim that was refuted — it is a
// different claim (the title drifted) that happens to land on the same
// line — so it must stay live and keep blocking. Before this rule, any
// carried refute exempted a re-raise regardless of how it matched, which
// let a genuinely new, unadjudicated claim close a run `clean`.
test("continueRun: a refuted claim re-raised worded differently at the same line stays live and blocks", async () => {
  const root = tmp();
  // Two findings: one refuted, to seed the ledger, and one confirmed, so pass
  // 1 does not converge on the spot and there is a pass 2 at all.
  const started = await startRun({
    root,
    config: cfg({ maxIterations: 2 }),
    target: "/repo",
    runLensFn: okLens([located("leak"), located("other", 20, "b.rs")]),
  });

  writeFileSync(
    join(passDir(root, started.runId, 1), "verdicts.json"),
    JSON.stringify({
      verdicts: [
        {
          id: findingId("a.rs", "leak"),
          verdict: "refute",
          basis: "pinned by a.test.mjs:8 — intended",
        },
        { id: findingId("b.rs", "other"), verdict: "confirm", basis: "real" },
      ],
    }),
  );

  // the same defect, reworded — the drift every recorded boomerang showed.
  // b.rs is gone: Claude fixed the one the reconciler confirmed.
  let seenBrief = null;
  const r = await continueRun({
    root,
    runLensFn: async ({ lens, brief }) => {
      seenBrief = brief;
      return {
        lens: lens.name,
        status: "ok",
        findings: [located("a resource is not released")],
        threadId: "t",
        raw: "",
      };
    },
  });

  assert.match(seenBrief, /## Already settled this run/);
  assert.match(seenBrief, /leak/, "the original wording reaches the lens");
  assert.match(seenBrief, /pinned by a\.test\.mjs:8/, "and so does the basis");

  const rec = JSON.parse(
    readFileSync(join(passDir(root, started.runId, 2), "reconcile.json"), "utf8"),
  );
  const [f] = rec.findings;
  assert.equal(f.carried.priorVerdict, "refute");
  assert.equal(f.carried.matchedBy, "location", "the title drifted, the line did not");
  assert.equal(f.verdict, "unreviewed", "the carry must not invent a verdict");

  // and the payoff: a location-only match does not excuse a claim nobody has
  // adjudicated — pass 2 is the last the budget allows, so it parks rather
  // than reaching a verdict on it.
  assert.equal(r.status, "awaiting_response");
  assert.equal(r.final, true);
});

// The other half of the same rule, pinned beside it: the exact same claim —
// same file, same title — re-raised after being refuted still auto-clears,
// because settledMatcher matches it by `id` this time.
test("continueRun: the exact same refuted claim re-raised still converges without a fresh verdict", async () => {
  const root = tmp();
  const started = await startRun({
    root,
    config: cfg({ maxIterations: 2 }),
    target: "/repo",
    runLensFn: okLens([located("leak"), located("other", 20, "b.rs")]),
  });

  writeFileSync(
    join(passDir(root, started.runId, 1), "verdicts.json"),
    JSON.stringify({
      verdicts: [
        {
          id: findingId("a.rs", "leak"),
          verdict: "refute",
          basis: "pinned by a.test.mjs:8 — intended",
        },
        { id: findingId("b.rs", "other"), verdict: "confirm", basis: "real" },
      ],
    }),
  );

  // unchanged title this time — the exact same claim comes back.
  const r = await continueRun({
    root,
    runLensFn: async () => ({
      lens: "auditor",
      status: "ok",
      findings: [located("leak")],
      threadId: "t",
      raw: "",
    }),
  });

  const rec = JSON.parse(
    readFileSync(join(passDir(root, started.runId, 2), "reconcile.json"), "utf8"),
  );
  const [f] = rec.findings;
  assert.equal(f.carried.matchedBy, "id", "the exact same claim, not just the same line");
  assert.equal(f.verdict, "unreviewed", "the carry must not invent a verdict");

  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "clean");
});

test("continueRun: a declined-but-confirmed finding re-raised in pass 2 still blocks", async () => {
  const root = tmp();
  const started = await startRun({
    root,
    config: cfg({ maxIterations: 2 }),
    target: "/repo",
    runLensFn: okLens([located("leak")]),
  });

  writeFileSync(
    join(passDir(root, started.runId, 1), "verdicts.json"),
    JSON.stringify({
      verdicts: [
        { id: findingId("a.rs", "leak"), verdict: "confirm", basis: "real" },
      ],
    }),
  );
  writeFileSync(
    join(passDir(root, started.runId, 1), "response.json"),
    JSON.stringify({
      findings: [
        {
          id: findingId("a.rs", "leak"),
          action: "declined",
          reason: "carrying it deliberately",
        },
      ],
    }),
  );

  const reRaise = async ({ lens }) => ({
    lens: lens.name,
    status: "ok",
    findings: [located("a resource is not released")],
    threadId: "t",
    raw: "",
  });
  // Pass 2 is the last the budget allows, so it parks for adjudication
  // rather than reaching a verdict on findings nobody has reviewed.
  const parked = await continueRun({ root, runLensFn: reRaise });
  assert.equal(parked.status, "awaiting_response");
  assert.equal(parked.final, true);

  const rec = JSON.parse(
    readFileSync(join(passDir(root, started.runId, 2), "reconcile.json"), "utf8"),
  );
  assert.equal(rec.findings[0].carried.priorVerdict, "confirm");

  // Settling it: no verdicts.json this time, so pass 2's findings stay
  // unreviewed — and unreviewed findings still block.
  const r = await continueRun({ root, runLensFn: reRaise });
  // a real defect somebody chose to carry is not a refutation, so the run
  // must not round up to clean
  assert.equal(r.verdict, "ceiling_reached");
});

test("continueRun: pass 2 still finding the issue hits the ceiling", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const runLensFn = okLens([finding("leak")]);
  const started = await startRun({ root, config, target: "/repo", runLensFn });
  // The last pass parks first — a verdict is never reached on findings that
  // have not been adjudicated. The second call settles it.
  const parked = await continueRun({ root, runLensFn });
  assert.equal(parked.final, true);
  const r = await continueRun({ root, runLensFn });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "ceiling_reached");
  assert.equal(r.passes, 2);
  assert.equal(existsSync(activeMarker(root)), false);
  void started;
});

// The final pass's fix, applied after the run's last look. Nothing re-audits
// it — there is no pass 3 — so the verdict must still reflect the pre-fix
// finding (unreviewed still blocks), while the result and the promoted
// report say plainly that a fix landed unverified.
test("continueRun: a fix applied after the final pass is recorded as fixedUnverified and still blocks", async () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const config = cfg({ maxIterations: 2 });
  const runLensFn = okLens([finding("leak")]);
  const started = await startRun({ root, config, target: "/repo", runLensFn });
  const parked = await continueRun({ root, runLensFn });
  assert.equal(parked.final, true);

  // Claude "fixes" it and writes response.json before settling — but there
  // is no next pass to re-audit the fix.
  writeFileSync(
    join(passDir(root, started.runId, 2), "response.json"),
    JSON.stringify({
      findings: [
        { id: findingId("a.rs", "leak"), action: "fixed", note: "patched" },
      ],
    }),
  );

  const r = await continueRun({ root, runLensFn });
  assert.equal(r.status, "finished");
  // Still blocking: nobody adjudicated pass 2's finding, so it stays
  // `unreviewed`, and unreviewed findings block regardless of response.json.
  assert.equal(r.verdict, "ceiling_reached");
  assert.deepEqual(r.fixedUnverified, {
    ids: [findingId("a.rs", "leak")],
    count: 1,
  });

  const report = readFileSync(r.promoted.claudePath, "utf8");
  assert.match(
    report,
    /1 fix\(es\) applied after the last pass, not re-audited/,
  );
  assert.match(report, new RegExp(findingId("a.rs", "leak")));
});

test("continueRun: no fixedUnverified when nothing was fixed after the final pass", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const runLensFn = okLens([finding("leak")]);
  await startRun({ root, config, target: "/repo", runLensFn });
  await continueRun({ root, runLensFn });
  const r = await continueRun({ root, runLensFn });
  assert.equal(r.verdict, "ceiling_reached");
  assert.equal(r.fixedUnverified, undefined);
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

  const parked = await continueRun({ root, runLensFn });
  assert.equal(parked.final, true);
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

  const parked = await continueRun({ root, runLensFn });
  assert.equal(parked.final, true, "the snapshotted max, not the edited one");
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
  mkdirSync(runDir(root, "2026-01-01T00-00-00"), { recursive: true });
  writeFileSync(join(runDir(root, "2026-01-01T00-00-00"), "run.json"), "{ not json");
  writeFileSync(activeMarker(root), JSON.stringify({ run: "2026-01-01T00-00-00", pass: 1 }));

  const r = await continueRun({ root, runLensFn: okLens([]) });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "failed");
  assert.equal(existsSync(activeMarker(root)), false);
});

test("continueRun: no completed pass on disk finalizes failed", async () => {
  const root = tmp();
  mkdirSync(runDir(root, "2026-01-01T00-00-00"), { recursive: true });
  writeFileSync(
    join(runDir(root, "2026-01-01T00-00-00"), "run.json"),
    JSON.stringify({
      runId: "2026-01-01T00-00-00",
      target: "/repo",
      startedAt: new Date().toISOString(),
      config: cfg(),
    }),
  );
  writeFileSync(activeMarker(root), JSON.stringify({ run: "2026-01-01T00-00-00", pass: 1 }));

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
  mkdirSync(runDir(root, "2026-01-01T00-00-00"), { recursive: true });
  writeFileSync(join(runDir(root, "2026-01-01T00-00-00"), "run.json"), "{ not json");
  const verdictPath = join(runDir(root, "2026-01-01T00-00-00"), "verdict.json");
  const canceled =
    JSON.stringify({ verdict: "cancelled", passes: 1, runId: "2026-01-01T00-00-00" }, null, 2) +
    "\n";
  writeFileSync(verdictPath, canceled);
  writeFileSync(activeMarker(root), JSON.stringify({ run: "2026-01-01T00-00-00", pass: 1 }));

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

// The graceful half of lock release, exercised directly. Testing it by
// signalling a real CLI process would prove nothing on win32, where kill is
// TerminateProcess and no JS handler ever runs — which is exactly why
// isAbandonedClaim exists as the other half.
test("releaseOwnClaim: frees this process's claim and records a verdict", async () => {
  const { releaseOwnClaim } = await import("../src/driver.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-release-"));
  const runId = "2026-01-01T00-00-00";
  mkdirSync(runDir(root, runId), { recursive: true });
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    activeMarker(root),
    JSON.stringify({ run: runId, pass: 1, pid: process.pid }),
  );

  assert.equal(releaseOwnClaim({ root }), true);
  assert.equal(existsSync(activeMarker(root)), false);
  assert.equal(
    JSON.parse(readFileSync(join(runDir(root, runId), "verdict.json"), "utf8"))
      .verdict,
    "cancelled",
  );
});

// Ownership is by pid so a signal can never free a concurrent run's lock.
test("releaseOwnClaim: leaves another process's claim alone", async () => {
  const { releaseOwnClaim } = await import("../src/driver.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-release-other-"));
  const runId = "2026-01-01T00-00-00";
  mkdirSync(runDir(root, runId), { recursive: true });
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    activeMarker(root),
    JSON.stringify({ run: runId, pass: 1, pid: process.pid + 1 }),
  );

  assert.equal(releaseOwnClaim({ root }), false);
  assert.ok(existsSync(activeMarker(root)));
  assert.equal(existsSync(join(runDir(root, runId), "verdict.json")), false);
});

// A claim taken before the run was named — the window claimActiveRun opens
// with. There is no run to finalize, but the lock still has to come off.
test("releaseOwnClaim: frees an unnamed claim without inventing a run", async () => {
  const { releaseOwnClaim } = await import("../src/driver.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-release-unnamed-"));
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    activeMarker(root),
    JSON.stringify({ run: null, pass: 0, pid: process.pid }),
  );

  assert.equal(releaseOwnClaim({ root }), true);
  assert.equal(existsSync(activeMarker(root)), false);
});

// A run that already finished keeps the verdict it earned — releasing a lock
// must never overwrite the record of what the run actually decided.
test("releaseOwnClaim: does not overwrite an existing verdict", async () => {
  const { releaseOwnClaim } = await import("../src/driver.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-release-done-"));
  const runId = "2026-01-01T00-00-00";
  mkdirSync(runDir(root, runId), { recursive: true });
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    join(runDir(root, runId), "verdict.json"),
    JSON.stringify({ verdict: "clean" }),
  );
  writeFileSync(
    activeMarker(root),
    JSON.stringify({ run: runId, pass: 1, pid: process.pid }),
  );

  assert.equal(releaseOwnClaim({ root }), true);
  assert.equal(
    JSON.parse(readFileSync(join(runDir(root, runId), "verdict.json"), "utf8"))
      .verdict,
    "clean",
  );
});

// The same contract claimActiveRun holds to. continueRun writes: it creates
// pass directories and finalizes verdicts, so a crafted marker run id here
// escapes .trio/runs exactly as it would there.
test("continueRun: refuses a marker naming a run id Trio did not mint", async () => {
  const root = mkdtempSync(join(tmpdir(), "trio-cont-bad-"));
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    activeMarker(root),
    JSON.stringify({ run: "../../escaped", pass: 1, pid: process.pid }),
  );

  const r = await continueRun({
    root,
    runLensFn: () => {
      throw new Error("no lens may run for an unminted run id");
    },
  });
  assert.equal(r.status, "invalid_marker");
  assert.equal(existsSync(join(root, "..", "..", "escaped")), false);
  // The claim is left standing: clearing it is /trio:cancel's job, and
  // deleting a marker on the strength of its own bad contents is how the
  // reclaim path got into trouble in the first place.
  assert.ok(existsSync(activeMarker(root)));
});

// The window between claimActiveRun writing {run: null} and startRun naming
// the run. With no run id to compare, the pid is the only thing identifying
// the claim — releasing on anything less takes the replacement with it.
test("releaseOwnClaim: an unnamed claim will not delete another process's replacement", async () => {
  const { releaseOwnClaim } = await import("../src/driver.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-release-race-"));
  mkdirSync(trioDir(root), { recursive: true });

  // Ours was unnamed; by the time we release, somebody else holds the lock.
  writeFileSync(
    activeMarker(root),
    JSON.stringify({ run: null, pass: 0, pid: process.pid + 1 }),
  );
  assert.equal(releaseOwnClaim({ root }), false);
  assert.ok(existsSync(activeMarker(root)), "released a claim that was not ours");
  assert.equal(
    JSON.parse(readFileSync(activeMarker(root), "utf8")).pid,
    process.pid + 1,
  );
});

// verdict.json is an ordinary file in the project, and its pass count is
// joined into a path that gets written to.
test("reopenRun: refuses a pass count that is not a pass count", async () => {
  const { reopenRun } = await import("../src/driver.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-reopen-bad-"));
  const runId = "2026-01-01T00-00-00";
  mkdirSync(passDir(root, runId, 1), { recursive: true });
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    join(runDir(root, runId), "run.json"),
    JSON.stringify({ runId, config: { maxIterations: 1 } }),
  );
  writeFileSync(
    join(runDir(root, runId), "verdict.json"),
    JSON.stringify({ verdict: "ceiling_reached", passes: "../../../escaped" }),
  );
  writeFileSync(
    join(passDir(root, runId, 1), "reconcile.json"),
    JSON.stringify({ pass: 1, findings: [], diff: {}, degraded: [], lenses: [] }),
  );

  const r = reopenRun({ root, runId });
  assert.equal(r.ok, true, "a bad pass count falls back rather than failing");
  assert.equal(existsSync(join(root, "..", "..", "..", "escaped")), false);
  // It fell back to counting the passes on disk, and archived in the real one.
  assert.ok(existsSync(join(passDir(root, runId, 1), "verdict-at-ceiling.json")));
});

// claimActiveRun writes an *unnamed* claim, and writeMarker is the only line
// that ever names it. A throw before that left removeMarker(root, runId)
// comparing against a null run, refusing, and isAbandonedClaim would not
// reclaim it either (it requires pass > 0) — one failed extend used to lock
// the project out of every future run.
test("reopenRun: a failure releases the claim instead of wedging the project", async () => {
  const { reopenRun } = await import("../src/driver.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-reopen-fail-"));
  const runId = "2026-01-01T00-00-00";
  mkdirSync(runDir(root, runId), { recursive: true });
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    join(runDir(root, runId), "verdict.json"),
    JSON.stringify({ verdict: "ceiling_reached", passes: 1 }),
  );
  // No run.json: the first read inside the try throws.
  const r = reopenRun({ root, runId });
  assert.equal(r.ok, false);
  assert.equal(
    existsSync(activeMarker(root)),
    false,
    "a failed extend left a claim nothing can reclaim",
  );
});

// reopenRun deletes the verdict, raises the ceiling and takes the lock. A
// refusal that arrives after all that leaves the run in pieces with a claim
// nothing releases, so the lane requirement is asked before anything moves.
test("reopenRun: refuses a missing Claude lane before it touches the run", async () => {
  const { reopenRun } = await import("../src/driver.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-reopen-lane-"));
  const runId = "2026-01-01T00-00-00";
  mkdirSync(passDir(root, runId, 1), { recursive: true });
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    join(runDir(root, runId), "run.json"),
    JSON.stringify({ runId, config: { maxIterations: 1 } }),
  );
  writeFileSync(
    join(runDir(root, runId), "verdict.json"),
    JSON.stringify({ verdict: "ceiling_reached", passes: 1 }),
  );
  writeFileSync(
    join(passDir(root, runId, 1), "reconcile.json"),
    JSON.stringify({ pass: 1, findings: [], diff: {}, degraded: [], lenses: [], claude: [] }),
  );

  const r = reopenRun({ root, runId, hasClaudeFindings: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /carries a Claude audit/);
  // Nothing moved: verdict intact, ceiling unchanged, no claim taken.
  assert.ok(existsSync(join(runDir(root, runId), "verdict.json")));
  assert.equal(existsSync(activeMarker(root)), false);
  assert.equal(
    JSON.parse(readFileSync(join(runDir(root, runId), "run.json"), "utf8"))
      .config.maxIterations,
    1,
  );

  // And with the lane supplied it proceeds.
  assert.equal(reopenRun({ root, runId, hasClaudeFindings: true }).ok, true);
});

// .trio/config.json is an ordinary file in the project, and a lens name is
// joined into two paths and read into a brief that is sent to Codex.
test("baseBrief refuses a lens name that is not a lens name", async () => {
  const { startRun } = await import("../src/driver.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-lensname-"));
  mkdirSync(trioDir(root), { recursive: true });
  const config = {
    ...DEFAULT_CONFIG,
    enabled: true,
    codex: {
      ...DEFAULT_CONFIG.codex,
      lenses: [{ name: "../../../../etc/passwd", model: "m", effort: "low", on: true }],
    },
  };
  const r = await startRun({
    root,
    config,
    target: root,
    runLensFn: async ({ brief }) => ({
      lens: "x",
      status: "ok",
      findings: [],
      raw: brief,
    }),
  });
  // The run fails rather than reading and forwarding an arbitrary file.
  assert.equal(r.verdict, "failed");
  assert.match(String(r.error ?? ""), /not a lens name/);
});

// Every lens down for a reason waiting will not fix. The run is over — there
// is nothing to adjudicate and nothing to park for — and it must not keep the
// project's lock, because trio-solo is the next thing the operator reaches for
// and it would be blocked by the very run that failed.
test("startRun: a run where every lens ran out of usage finalizes and says so", async () => {
  const root = tmp();
  const outOfUsage = async ({ lens }) => ({
    lens: lens.name,
    status: "failed",
    findings: [],
    threadId: null,
    raw: "",
    failure: classifyFailure("You have hit your usage limit"),
  });
  const r = await startRun({
    root,
    config: cfg({ maxIterations: 2 }),
    target: "/repo",
    runLensFn: outOfUsage,
  });
  assert.equal(r.status, "finished");
  assert.equal(r.verdict, "failed");
  assert.equal(r.codexUnavailable.kind, "usage");
  assert.equal(r.codexUnavailable.available, false);
  assert.equal(existsSync(activeMarker(root)), false, "the lock must be released");
});

// One lens dying is a degraded pass, which the run already reports. Telling
// the operator Codex is unavailable on that evidence — and offering to replace
// it — would be wrong: four lenses did audit the code.
test("startRun: one failed lens among several is degraded, not an outage", async () => {
  const root = tmp();
  const mixed = async ({ lens }) =>
    lens.name === "auditor"
      ? {
          lens: lens.name,
          status: "failed",
          findings: [],
          threadId: null,
          raw: "",
          failure: classifyFailure("usage limit"),
        }
      : { lens: lens.name, status: "ok", findings: [finding("leak")], threadId: "t", raw: "" };
  const config = cfg({ maxIterations: 2 });
  config.codex.lenses = [
    { name: "auditor", model: "m", effort: "low", on: true },
    { name: "security", model: "m", effort: "low", on: true },
  ];
  const r = await startRun({ root, config, target: "/repo", runLensFn: mixed });
  assert.equal(r.status, "awaiting_response");
  assert.equal(r.codexUnavailable, undefined);
  assert.deepEqual(r.degraded, ["auditor"]);
});

// The outage this guards against demonstrated itself: run 2026-08-18T14-44-53
// promoted Docs/Audit/codex/2026-08-18/audit-1.md, headed "Codex Audit" with a
// findings count, for four lenses that never ran. A lane that reported nothing
// is absent, not empty — and a document outlives the terminal that explained
// it.
test("finalize: a run where no lens succeeded promotes nothing", async () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const r = await startRun({
    root,
    config: cfg({ maxIterations: 2 }),
    target: "/repo",
    runLensFn: async ({ lens }) => ({
      lens: lens.name,
      status: "failed",
      findings: [],
      threadId: null,
      raw: "",
      failure: classifyFailure("usage limit reached"),
    }),
  });
  assert.equal(r.promoted, null);
  assert.equal(r.promotion.offer, false, "there is no directory to offer to create");
  assert.match(r.promotion.reason, /nothing to promote/);
  assert.equal(existsSync(join(root, "Docs", "Audit", "codex")), false);
});

// The mirror: one lens surviving is a degraded audit, and a degraded audit is
// still an audit. It must still be written out.
test("finalize: a partially degraded run still promotes", async () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const config = cfg({ maxIterations: 1 });
  config.codex.lenses = [
    { name: "auditor", model: "m", effort: "low", on: true },
    { name: "security", model: "m", effort: "low", on: true },
  ];
  const r = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: async ({ lens }) =>
      lens.name === "auditor"
        ? {
            lens: lens.name,
            status: "failed",
            findings: [],
            threadId: null,
            raw: "",
            failure: classifyFailure("Segmentation fault"),
          }
        : { lens: lens.name, status: "ok", findings: [], threadId: "t", raw: "" },
  });
  // Degraded, so it did not converge; the ceiling parks it. Settle to finish.
  const done = await continueRun({ root, runLensFn: okLens([]) });
  assert.equal(done.status, "finished");
  assert.ok(done.promoted, "a degraded audit is still an audit");
  void r;
});

// --- Worker lock: mutual exclusion across run/continue/extend ---

// Old code had no second lock: two continueRun calls on the same parked run
// both read pass 1 complete, both adjudicated it and both ran pass 2,
// overwriting each other's artifacts. Since Node runs each call's synchronous
// prefix (marker read, lock acquire, adjudicate, writeMarker to N+1) to
// completion before the first `await runPass` ever yields, calling
// continueRun a second time — without awaiting the first — genuinely lands
// while the first still holds the lock, no real OS concurrency required.
test("continueRun: two concurrent calls on the same parked run — exactly one runs the pass, the other is refused", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 3 });
  const started = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
  });
  assert.equal(started.status, "awaiting_response");

  let release;
  const gate = new Promise((r) => (release = r));
  const firstLensFn = async ({ lens }) => {
    await gate;
    return { lens: lens.name, status: "ok", findings: [], threadId: "t", raw: "" };
  };

  // Not awaited: this runs synchronously up to the pending `gate`, by which
  // point it has already taken the worker lock and advanced the marker.
  const firstPromise = continueRun({ root, runLensFn: firstLensFn });

  const second = await continueRun({ root, runLensFn: okLens([]) });
  assert.equal(second.status, "worker_busy");
  assert.equal(second.holder.run, started.runId);
  assert.equal(second.holder.pid, process.pid);

  release();
  const first = await firstPromise;
  assert.equal(first.status, "finished");
  assert.equal(first.verdict, "clean");

  // Only the winner's pass exists — the loser never touched the run.
  assert.ok(existsSync(join(passDir(root, started.runId, 2), "reconcile.json")));
  assert.equal(existsSync(workerLockPath(root)), false);
});

// The bug named in the background: calling `continue` while pass 1 has not
// finished used to find no completed pass on disk and finalize the run as
// "failed" out from under the still-running worker. The worker lock, taken
// by startRun before it ever calls a lens, must stop that before it ever
// reaches the "no completed pass" check at all.
test("continueRun: refused while the run's pass 1 is still executing, and never finalizes it", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  let release;
  const gate = new Promise((r) => (release = r));
  const hangingLensFn = async ({ lens }) => {
    await gate;
    return {
      lens: lens.name,
      status: "ok",
      findings: [finding("leak")],
      threadId: "t",
      raw: "",
    };
  };

  const firstPromise = startRun({ root, config, target: "/repo", runLensFn: hangingLensFn });

  const second = await continueRun({ root, runLensFn: okLens([]) });
  assert.equal(second.status, "worker_busy");

  release();
  const first = await firstPromise;
  assert.equal(first.status, "awaiting_response");
  assert.equal(
    existsSync(join(runDir(root, first.runId), "verdict.json")),
    false,
    "continue must not have finalized the still-running run as failed",
  );
  assert.equal(existsSync(workerLockPath(root)), false);
});

// Every exit path releases the lock, thrown errors included — otherwise one
// failed pass would wedge the project until something noticed the (in this
// case, perfectly alive) pid was stale.
test("startRun: the worker lock is released even when a lens throws, and does not wedge later runs", async () => {
  const root = tmp();
  const boom = async () => {
    throw new Error("boom");
  };
  const r = await startRun({ root, config: cfg(), target: "/repo", runLensFn: boom });
  assert.equal(r.verdict, "failed");
  assert.equal(existsSync(workerLockPath(root)), false);

  const next = await startRun({
    root,
    config: cfg(),
    target: "/repo",
    runLensFn: okLens([]),
  });
  assert.equal(next.status, "finished");
  assert.equal(next.verdict, "clean");
});

test("continueRun: the worker lock is released even when a lens throws", async () => {
  const root = tmp();
  const config = cfg({ maxIterations: 2 });
  const started = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
  });
  assert.equal(started.status, "awaiting_response");

  const boom = async () => {
    throw new Error("boom");
  };
  const r = await continueRun({ root, runLensFn: boom });
  assert.equal(r.verdict, "failed");
  assert.equal(existsSync(workerLockPath(root)), false);
});

// D-artifacts-promoteTo: the operator's promoteTo setting has to reach the
// off-limits section of every lens brief, not just the shipped default —
// otherwise a project that promotes somewhere other than Docs/Audit leaves
// that real directory unguarded against a repo-wide lens exploring into it.
test("startRun: a custom artifacts.promoteTo reaches the lens brief's off-limits section", async () => {
  const root = tmp();
  const config = cfg({ artifacts: { promoteTo: "Reports/Audits" } });
  let seenBrief = null;
  const r = await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: async ({ lens, brief }) => {
      seenBrief = brief;
      return { lens: lens.name, status: "ok", findings: [], threadId: "t", raw: "" };
    },
  });
  assert.equal(r.status, "finished");
  assert.match(seenBrief, /Reports\/Audits\/`/);
  assert.doesNotMatch(seenBrief, /Docs\/Audit\//);
});

test("continueRun: a custom artifacts.promoteTo reaches pass 2's lens brief too", async () => {
  const root = tmp();
  const config = cfg({
    maxIterations: 2,
    artifacts: { promoteTo: "Reports/Audits" },
  });
  await startRun({
    root,
    config,
    target: "/repo",
    runLensFn: okLens([finding("leak")]),
  });

  let seenBrief = null;
  const r = await continueRun({
    root,
    runLensFn: async ({ lens, brief }) => {
      seenBrief = brief;
      return { lens: lens.name, status: "ok", findings: [], threadId: "t", raw: "" };
    },
  });
  assert.equal(r.status, "finished");
  assert.match(seenBrief, /Reports\/Audits\/`/);
});

// The signal handler's own release path (context.mjs's stopLensesOnSignal)
// calls releaseOwnClaim, and it has to free both locks a process can be
// holding when a signal lands mid-pass — not just the marker.
test("releaseOwnClaim: also releases a worker lock this process holds", async () => {
  const { releaseOwnClaim } = await import("../src/driver.mjs");
  const { acquireWorkerLock } = await import("../src/marker.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-release-lock-"));
  const runId = "2026-01-01T00-00-00";
  mkdirSync(runDir(root, runId), { recursive: true });
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    activeMarker(root),
    JSON.stringify({ run: runId, pass: 1, pid: process.pid }),
  );
  const lock = acquireWorkerLock({ root, runId, pass: 1 });
  assert.equal(lock.ok, true);

  assert.equal(releaseOwnClaim({ root }), true);
  assert.equal(existsSync(activeMarker(root)), false);
  assert.equal(existsSync(workerLockPath(root)), false);
});
