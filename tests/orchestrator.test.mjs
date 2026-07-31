import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop, runPass, finalizeRun, newRunId } from "../src/orchestrator.mjs";
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
const passthrough = async (findings) => findings;

const scripted = (perPass) => {
  let call = 0;
  return async ({ lens }) => {
    const pass = Math.floor(call++ / 1) + 1;
    const findings = perPass[Math.min(pass, perPass.length) - 1] ?? [];
    return { lens: lens.name, status: "ok", findings, threadId: "t", raw: "" };
  };
};

test("newRunId is minute-resolution and filename-safe", () => {
  const id = newRunId(new Date("2026-07-29T14:03:11Z"));
  assert.equal(id, "2026-07-29T14-03");
  assert.doesNotMatch(id, /[:/\\]/);
});

test("a first pass with nothing found converges immediately", async () => {
  const r = await runLoop({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    runLensFn: scripted([[]]),
    reconcileFn: passthrough,
    briefFor: () => "b",
  });
  assert.equal(r.verdict, "clean");
  assert.equal(r.passes.length, 1);
});

test("a major in pass 1 that closes in pass 2 converges", async () => {
  const r = await runLoop({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    runLensFn: scripted([[finding("leak")], []]),
    reconcileFn: passthrough,
    briefFor: () => "b",
  });
  assert.equal(r.verdict, "clean");
  assert.equal(r.passes.length, 2);
});

test("a major still open at the ceiling reports ceiling_reached, not clean", async () => {
  const r = await runLoop({
    config: cfg({
      maxIterations: 2,
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    runLensFn: scripted([[finding("leak")], [finding("leak")]]),
    reconcileFn: passthrough,
    briefFor: () => "b",
  });
  assert.equal(r.verdict, "ceiling_reached");
  assert.equal(r.passes.length, 2);
});

test("never runs more passes than maxIterations", async () => {
  const r = await runLoop({
    config: cfg({
      maxIterations: 3,
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    runLensFn: scripted([
      [finding("a")],
      [finding("a")],
      [finding("a")],
      [finding("a")],
    ]),
    reconcileFn: passthrough,
    briefFor: () => "b",
  });
  assert.equal(r.passes.length, 3);
});

test("an unparseable lens blocks a clean verdict even with no findings", async () => {
  const r = await runLoop({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    runLensFn: async ({ lens }) => ({
      lens: lens.name,
      status: "unparseable",
      findings: [],
      threadId: null,
      raw: "oops",
    }),
    reconcileFn: passthrough,
    briefFor: () => "b",
  });
  assert.notEqual(r.verdict, "clean");
  assert.equal(r.verdict, "ceiling_reached");
});

test("a failed lens blocks a clean verdict and is named in the pass", async () => {
  const root = tmp();
  const r = await runLoop({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "security", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root,
    runId: "r1",
    runLensFn: async ({ lens }) => ({
      lens: lens.name,
      status: "failed",
      findings: [],
      threadId: null,
      raw: "",
    }),
    reconcileFn: passthrough,
    briefFor: () => "b",
  });
  assert.notEqual(r.verdict, "clean");
  assert.ok(
    r.passes[0].lenses.some(
      (l) => l.lens === "security" && l.status === "failed",
    ),
  );
});

test("only enabled lenses run", async () => {
  const seen = [];
  await runLoop({
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
    reconcileFn: passthrough,
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
  await runLoop({
    config: cfg({ codex: { parallel: 2, lenses } }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
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
    reconcileFn: passthrough,
    briefFor: () => "b",
  });
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test("a refuted critical does not block convergence", async () => {
  const r = await runLoop({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    runLensFn: scripted([[finding("phantom", "critical")]]),
    reconcileFn: async (findings) =>
      findings.map((f) => ({
        ...f,
        verdict: "refute",
        basis: "not reachable",
      })),
    briefFor: () => "b",
  });
  assert.equal(r.verdict, "clean");
});

test("each pass records its cross-pass diff", async () => {
  const r = await runLoop({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    runLensFn: scripted([[finding("a")], [finding("b")]]),
    reconcileFn: passthrough,
    briefFor: () => "b",
  });
  assert.equal(r.passes[1].diff.new.length, 1);
  assert.equal(r.passes[1].diff.closed.length, 1);
});

test("an unexpected rejection ends the run as failed rather than throwing", async () => {
  const r = await runLoop({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    runLensFn: async () => {
      throw new Error("boom");
    },
    reconcileFn: passthrough,
    briefFor: () => "b",
  });
  assert.equal(r.verdict, "failed");
});

test("a failed run still writes verdict.json so the marker can be cleared", async () => {
  const root = tmp();
  await runLoop({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root,
    runId: "r1",
    runLensFn: async () => {
      throw new Error("boom");
    },
    reconcileFn: passthrough,
    briefFor: () => "b",
  });
  const v = JSON.parse(
    readFileSync(join(runDir(root, "r1"), "verdict.json"), "utf8"),
  );
  assert.equal(v.verdict, "failed");
});

test("briefFor is called pass-aware, with the prior pass's record", async () => {
  const calls = [];
  const r = await runLoop({
    config: cfg({
      codex: {
        parallel: 1,
        lenses: [{ name: "auditor", model: "m", effort: "low", on: true }],
      },
    }),
    target: "/repo",
    root: tmp(),
    runId: "r1",
    runLensFn: scripted([[finding("leak")], []]),
    reconcileFn: passthrough,
    briefFor: (lens, pass, prevRecord) => {
      calls.push({ lens, pass, prevRecord });
      return "b";
    },
  });
  assert.equal(r.passes.length, 2);
  assert.equal(calls[0].lens.name, "auditor");
  assert.equal(calls[0].pass, 1);
  assert.equal(calls[0].prevRecord, null);
  assert.equal(calls[1].lens.name, "auditor");
  assert.equal(calls[1].pass, 2);
  assert.equal(calls[1].prevRecord.pass, 1);
  assert.ok(calls[1].prevRecord.findings.some((f) => f.title === "leak"));
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
    reconcileFn: passthrough,
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
    reconcileFn: passthrough,
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
