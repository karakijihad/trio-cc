import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPass, finalizeRun, newRunId } from "../src/orchestrator.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { findingId } from "../src/findings.mjs";
import { readEvents } from "../src/bus.mjs";
import { runDir, passDir } from "../src/paths.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-orch-"));
const cfg = (over = {}) => ({
  ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
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
const scripted = (perPass) => {
  let call = 0;
  return async ({ lens }) => {
    const pass = Math.floor(call++ / 1) + 1;
    const findings = perPass[Math.min(pass, perPass.length) - 1] ?? [];
    return { lens: lens.name, status: "ok", findings, threadId: "t", raw: "" };
  };
};

const oneLens = (name = "auditor", parallel = 1) => ({
  parallel,
  lenses: [{ name, model: "m", effort: "low", on: true }],
});

test("newRunId is second-resolution and filename-safe", () => {
  const id = newRunId(new Date("2026-07-29T14:03:11Z"));
  assert.equal(id, "2026-07-29T14-03-11");
  assert.doesNotMatch(id, /[:/\\]/);
});

test("newRunId distinguishes two runs started in the same minute", () => {
  assert.notEqual(
    newRunId(new Date("2026-07-29T14:03:11Z")),
    newRunId(new Date("2026-07-29T14:03:47Z")),
  );
});

test("the configured timeout reaches every lens", async () => {
  let seen = null;
  await runPass({
    config: cfg({ codex: { ...oneLens(), timeoutMinutes: 7 } }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    pass: 1,
    prevRecord: null,
    runLensFn: async ({ lens, timeoutMs }) => {
      seen = timeoutMs;
      return { lens: lens.name, status: "ok", findings: [], threadId: "t", raw: "" };
    },
    briefFor: () => "b",
  });
  assert.equal(seen, 7 * 60_000);
});

test("only enabled lenses run", async () => {
  const seen = [];
  await runPass({
    config: cfg({
      codex: {
        parallel: 2,
        lenses: [
          { name: "auditor", model: "m", effort: "low", on: true },
          { name: "tester", model: "m", effort: "low", on: false },
        ],
      },
    }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    pass: 1,
    prevRecord: null,
    runLensFn: async ({ lens }) => {
      seen.push(lens.name);
      return {
        lens: lens.name,
        status: "ok",
        findings: [],
        threadId: "t",
        raw: "",
      };
    },
    briefFor: () => "b",
  });
  assert.deepEqual(seen, ["auditor"]);
});

test("respects the parallel cap", async () => {
  let inFlight = 0,
    peak = 0;
  const lenses = ["a", "b", "c", "d"].map((n) => ({
    name: n,
    model: "m",
    effort: "low",
    on: true,
  }));
  await runPass({
    config: cfg({ codex: { parallel: 2, lenses } }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    pass: 1,
    prevRecord: null,
    runLensFn: async ({ lens }) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        lens: lens.name,
        status: "ok",
        findings: [],
        threadId: "t",
        raw: "",
      };
    },
    briefFor: () => "b",
  });
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test("an unparseable lens blocks convergence even with no findings", async () => {
  const { converged } = await runPass({
    config: cfg({ codex: oneLens() }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    pass: 1,
    prevRecord: null,
    runLensFn: async ({ lens }) => ({
      lens: lens.name,
      status: "unparseable",
      findings: [],
      threadId: null,
      raw: "oops",
    }),
    briefFor: () => "b",
  });
  assert.equal(converged, false);
});

test("a failed lens blocks convergence and is named in the pass record", async () => {
  const { record, converged } = await runPass({
    config: cfg({ codex: oneLens("security") }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    pass: 1,
    prevRecord: null,
    runLensFn: async ({ lens }) => ({
      lens: lens.name,
      status: "failed",
      findings: [],
      threadId: null,
      raw: "",
    }),
    briefFor: () => "b",
  });
  assert.equal(converged, false);
  assert.ok(
    record.lenses.some((l) => l.lens === "security" && l.status === "failed"),
  );
});

// A pass can no longer produce a refuted finding — refutation arrives later,
// through applyAdjudication, and runPass marks everything `unreviewed`. That
// an unreviewed critical still blocks is the property that matters here;
// isConverged's handling of refuted ones is covered in findings.test.mjs.
test("an unadjudicated critical blocks convergence", async () => {
  const { record, converged } = await runPass({
    config: cfg({ codex: oneLens() }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    pass: 1,
    prevRecord: null,
    runLensFn: scripted([[finding("phantom", "critical")]]),
    briefFor: () => "b",
  });
  assert.equal(converged, false);
  assert.equal(record.findings[0].verdict, "unreviewed");
});

test("a pass records its diff against the prior pass", async () => {
  const root = tmp();
  const common = {
    config: cfg({ codex: oneLens() }),
    target: "/repo",
    root,
    runId: "r1",
    briefFor: () => "b",
  };
  const first = await runPass({
    ...common,
    pass: 1,
    prevRecord: null,
    runLensFn: scripted([[finding("a")]]),
  });
  const second = await runPass({
    ...common,
    pass: 2,
    prevRecord: first.record,
    runLensFn: scripted([[finding("b")]]),
  });
  assert.equal(second.record.diff.new.length, 1);
  assert.equal(second.record.diff.closed.length, 1);
});

test("briefFor is called with the lens, the pass number, and the prior record", async () => {
  const calls = [];
  const prevRecord = { pass: 1, findings: [finding("leak")] };
  await runPass({
    config: cfg({ codex: oneLens() }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    pass: 2,
    prevRecord,
    runLensFn: scripted([[]]),
    briefFor: (lens, pass, prior) => {
      calls.push({ lens, pass, prior });
      return "b";
    },
  });
  assert.equal(calls[0].lens.name, "auditor");
  assert.equal(calls[0].pass, 2);
  assert.equal(calls[0].prior.pass, 1);
  assert.ok(calls[0].prior.findings.some((f) => f.title === "leak"));
});

test("runPass alone executes one pass", async () => {
  const root = tmp();
  const { record, converged } = await runPass({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root,
    runId: "r1",
    pass: 1,
    prevRecord: null,
    runLensFn: scripted([[]]),
    briefFor: () => "b",
  });
  assert.equal(converged, true);
  assert.equal(record.pass, 1);
  const reconcile = JSON.parse(
    readFileSync(join(passDir(root, "r1", 1), "reconcile.json"), "utf8"),
  );
  assert.equal(reconcile.pass, 1);
  const lensJson = JSON.parse(
    readFileSync(
      join(passDir(root, "r1", 1), "codex", "auditor.json"),
      "utf8",
    ),
  );
  assert.equal(lensJson.lens, "auditor");
});

test("finalizeRun writes verdict.json and emits run_finished", () => {
  const root = tmp();
  const result = finalizeRun({
    root,
    runId: "r1",
    verdict: "clean",
    passCount: 2,
  });
  assert.deepEqual(result, { verdict: "clean", passes: 2, runId: "r1" });
  const v = JSON.parse(
    readFileSync(join(runDir(root, "r1"), "verdict.json"), "utf8"),
  );
  assert.deepEqual(v, { verdict: "clean", passes: 2, runId: "r1" });
  const events = readEvents(runDir(root, "r1"));
  assert.ok(
    events.some(
      (e) => e.kind === "run_finished" && e.payload.verdict === "clean",
    ),
  );
});

test("a finding's secret-shaped evidence is scrubbed before it hits disk", async () => {
  const root = tmp();
  const secretFinding = {
    severity: "major",
    file: "a.rs",
    title: "leaked secret",
    evidence: "found sk-proj-AAAABBBBCCCCDDDD1234 in code",
    impact: "",
    correction: "",
    id: findingId("a.rs", "leaked secret"),
  };
  const { record } = await runPass({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "security", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root,
    runId: "r1",
    pass: 1,
    prevRecord: null,
    runLensFn: async ({ lens }) => ({
      lens: lens.name,
      status: "ok",
      findings: [secretFinding],
      threadId: "t",
      raw: "",
    }),
    briefFor: () => "b",
  });

  assert.doesNotMatch(
    JSON.stringify(record),
    /sk-proj-AAAABBBBCCCCDDDD1234/,
  );
  assert.match(JSON.stringify(record), /<redacted:token>/);

  const reconcile = readFileSync(
    join(passDir(root, "r1", 1), "reconcile.json"),
    "utf8",
  );
  assert.doesNotMatch(reconcile, /sk-proj-AAAABBBBCCCCDDDD1234/);
  assert.match(reconcile, /<redacted:token>/);

  const lensJson = readFileSync(
    join(passDir(root, "r1", 1), "codex", "security.json"),
    "utf8",
  );
  assert.doesNotMatch(lensJson, /sk-proj-AAAABBBBCCCCDDDD1234/);
  assert.match(lensJson, /<redacted:token>/);
});

test("finalizeRun keeps the written verdict even if the run_finished event write fails", () => {
  const root = tmp();
  const dir = runDir(root, "r1");
  // Pre-create events.jsonl as a directory so appendFileSync throws.
  mkdirSync(join(dir, "events.jsonl"), { recursive: true });
  const result = finalizeRun({
    root,
    runId: "r1",
    verdict: "clean",
    passCount: 2,
  });
  assert.deepEqual(result, { verdict: "clean", passes: 2, runId: "r1" });
  const v = JSON.parse(
    readFileSync(join(runDir(root, "r1"), "verdict.json"), "utf8"),
  );
  assert.deepEqual(v, { verdict: "clean", passes: 2, runId: "r1" });
});
