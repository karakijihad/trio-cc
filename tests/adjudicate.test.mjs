import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAdjudication } from "../src/adjudicate.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { readEvents } from "../src/bus.mjs";
import { runDir, passDir } from "../src/paths.mjs";

const config = () => JSON.parse(JSON.stringify(DEFAULT_CONFIG));

const finding = (id, over = {}) => ({
  id,
  severity: "major",
  file: "a.rs",
  line: 1,
  title: `t-${id}`,
  evidence: "",
  impact: "",
  correction: "",
  lens: "auditor",
  verdict: "unreviewed",
  basis: "",
  bounds: "",
  ...over,
});

// A pass as runPass leaves it: findings present, nothing adjudicated yet.
const record = (findings) => ({
  findings,
  degraded: [],
  diff: { new: findings, closed: [], carried: [] },
});

const setup = (verdicts) => {
  const root = mkdtempSync(join(tmpdir(), "trio-adj-"));
  const runId = "r1";
  mkdirSync(passDir(root, runId, 1), { recursive: true });
  writeFileSync(
    join(passDir(root, runId, 1), "verdicts.json"),
    JSON.stringify({ verdicts }),
  );
  return { root, runId };
};

const errors = (root, runId) =>
  readEvents(runDir(root, runId)).filter((e) => e.kind === "error");

// The incident: a reconciler returned Trio's own rendered vocabulary
// (CONFIRMED) plus an invented category (OUT_OF_SCOPE), and the first bad
// entry threw away all fourteen adjudications.
test("a batch with an invented verdict still applies the sound ones", () => {
  const { root, runId } = setup([
    { id: "a1", verdict: "OUT_OF_SCOPE", basis: "not in the diff" },
    { id: "a2", verdict: "CONFIRMED", basis: "reproduced", bounds: "nowhere else" },
    { id: "a3", verdict: "REFUTED", basis: "line 4 disproves it" },
  ]);
  const { record: updated } = applyAdjudication({
    root,
    config: config(),
    runId,
    pass: 1,
    record: record([finding("a1"), finding("a2"), finding("a3")]),
  });

  assert.equal(updated.findings[0].verdict, "unreviewed");
  assert.equal(updated.findings[1].verdict, "confirm");
  assert.equal(updated.findings[1].bounds, "nowhere else");
  assert.equal(updated.findings[2].verdict, "refute");
});

test("the surviving adjudication is what lands in reconcile.json", () => {
  const { root, runId } = setup([
    { id: "a1", verdict: "nonsense" },
    { id: "a2", verdict: "confirm", basis: "reproduced" },
  ]);
  applyAdjudication({
    root,
    config: config(),
    runId,
    pass: 1,
    record: record([finding("a1"), finding("a2")]),
  });
  const written = JSON.parse(
    readFileSync(join(passDir(root, runId, 1), "reconcile.json"), "utf8"),
  );
  assert.equal(written.findings[1].verdict, "confirm");
});

test("one event names every rejected verdict and how many survived", () => {
  const { root, runId } = setup([
    { id: "a1", verdict: "OUT_OF_SCOPE" },
    { id: "a2", verdict: "confirm" },
    { id: "a3", verdict: "maybe" },
  ]);
  applyAdjudication({
    root,
    config: config(),
    runId,
    pass: 1,
    record: record([finding("a1"), finding("a2"), finding("a3")]),
  });

  const errs = errors(root, runId);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].payload.applied, 1);
  assert.deepEqual(errs[0].payload.rejected, [
    { id: "a1", verdict: "OUT_OF_SCOPE" },
    { id: "a3", verdict: "maybe" },
  ]);
  assert.match(errs[0].payload.error, /rejected 2 of 3/);
  assert.match(errs[0].payload.error, /a1=OUT_OF_SCOPE/);
  assert.match(errs[0].payload.error, /a3=maybe/);
  assert.match(errs[0].payload.error, /stay unreviewed/);
});

test("a clean verdicts file logs no error at all", () => {
  const { root, runId } = setup([{ id: "a1", verdict: "confirm" }]);
  applyAdjudication({
    root,
    config: config(),
    runId,
    pass: 1,
    record: record([finding("a1")]),
  });
  assert.equal(errors(root, runId).length, 0);
});

// Rejection must never read as agreement, and an unreviewed major is still
// live — so a pass that lost verdicts cannot quietly converge.
test("a pass whose verdicts were rejected does not converge", () => {
  const { root, runId } = setup([{ id: "a1", verdict: "CONFIRMED_AS_REPORTED" }]);
  const { converged } = applyAdjudication({
    root,
    config: config(),
    runId,
    pass: 1,
    record: record([finding("a1", { severity: "critical" })]),
  });
  assert.equal(converged, false);
});
