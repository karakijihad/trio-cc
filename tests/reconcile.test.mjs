import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyVerdicts,
  renderDisagreementTable,
  VERDICTS,
} from "../src/reconcile.mjs";

const f = (id, over = {}) => ({
  id,
  severity: "major",
  file: "a.rs",
  title: `t-${id}`,
  evidence: "",
  impact: "",
  correction: "",
  lens: "auditor",
  ...over,
});

test("the four verdicts are exactly the spec set", () => {
  assert.deepEqual(VERDICTS, ["confirm", "refute", "downgrade", "escalate"]);
});

test("confirm leaves severity untouched", () => {
  const out = applyVerdicts(
    [f("a1")],
    [{ id: "a1", verdict: "confirm", basis: "reproduced" }],
  );
  assert.equal(out[0].severity, "major");
  assert.equal(out[0].verdict, "confirm");
});

test("downgrade lowers severity one step", () => {
  const out = applyVerdicts(
    [f("a1", { severity: "critical" })],
    [{ id: "a1", verdict: "downgrade", basis: "dormant" }],
  );
  assert.equal(out[0].severity, "major");
});

test("escalate raises severity one step", () => {
  const out = applyVerdicts(
    [f("a1", { severity: "major" })],
    [{ id: "a1", verdict: "escalate", basis: "composes with a2" }],
  );
  assert.equal(out[0].severity, "critical");
});

test("escalate at critical stays critical", () => {
  const out = applyVerdicts(
    [f("a1", { severity: "critical" })],
    [{ id: "a1", verdict: "escalate", basis: "x" }],
  );
  assert.equal(out[0].severity, "critical");
});

test("downgrade at info stays info", () => {
  const out = applyVerdicts(
    [f("a1", { severity: "info" })],
    [{ id: "a1", verdict: "downgrade", basis: "x" }],
  );
  assert.equal(out[0].severity, "info");
});

test("refute records the basis and keeps the finding for the record", () => {
  const out = applyVerdicts(
    [f("a1")],
    [{ id: "a1", verdict: "refute", basis: "lines 394-834 are cfg(test)" }],
  );
  assert.equal(out[0].verdict, "refute");
  assert.equal(out[0].basis, "lines 394-834 are cfg(test)");
});

// Blast radius is the half of a confirmation that bounds the fix, and it
// travels in its own field because `basis` never reaches the report for a
// verdict that agreed.
test("confirm carries the bounds through to the finding", () => {
  const out = applyVerdicts(
    [f("a1")],
    [
      {
        id: "a1",
        verdict: "confirm",
        basis: "reproduced",
        bounds: "also at c.rs:9; not at d.rs:4 — that one latches",
      },
    ],
  );
  assert.equal(out[0].bounds, "also at c.rs:9; not at d.rs:4 — that one latches");
});

test("a verdict with no bounds leaves an empty string, never undefined", () => {
  const out = applyVerdicts(
    [f("a1")],
    [{ id: "a1", verdict: "confirm", basis: "reproduced" }],
  );
  assert.equal(out[0].bounds, "");
});

test("an unreviewed finding has empty bounds", () => {
  const out = applyVerdicts([f("a1")], []);
  assert.equal(out[0].bounds, "");
});

// Silence is not agreement: an unadjudicated pass used to report every
// finding "confirm" and an empty disagreement table.
test("a finding with no verdict is unreviewed, not confirmed", () => {
  const out = applyVerdicts([f("a1")], []);
  assert.equal(out[0].verdict, "unreviewed");
});

test("unreviewed findings are not listed as disagreements", () => {
  const table = renderDisagreementTable(applyVerdicts([f("a1")], []));
  assert.doesNotMatch(table, /\| /);
});

// "No disagreements" and "nobody has looked" are different reports.
test("an unadjudicated pass does not report its findings as confirmed", () => {
  const table = renderDisagreementTable(applyVerdicts([f("a1"), f("a2")], []));
  assert.match(table, /2 finding\(s\) not yet adjudicated/);
  assert.doesNotMatch(table, /confirmed as reported/);
});

test("a fully confirmed pass still says so", () => {
  const table = renderDisagreementTable(
    applyVerdicts([f("a1")], [{ id: "a1", verdict: "confirm", basis: "" }]),
  );
  assert.match(table, /confirmed as reported/);
});

// The uppercase past tense is Trio's own vocabulary coming back at it: LABEL
// renders `refute` as REFUTED, so a model that has read one report writes
// REFUTED into the next set of verdicts. The meaning is unambiguous; only the
// spelling is wrong, and rejecting on spelling threw away real adjudication.
test("a verdict is read case- and tense-insensitively", () => {
  for (const [written, canonical] of [
    ["CONFIRMED", "confirm"],
    ["REFUTED", "refute"],
    ["DOWNGRADED", "downgrade"],
    ["ESCALATED", "escalate"],
    ["  Confirm  ", "confirm"],
  ]) {
    const out = applyVerdicts([f("a1")], [{ id: "a1", verdict: written }]);
    assert.equal(out[0].verdict, canonical, `${written} -> ${canonical}`);
  }
});

test("a normalized downgrade still moves severity", () => {
  const out = applyVerdicts(
    [f("a1", { severity: "critical" })],
    [{ id: "a1", verdict: "DOWNGRADED", basis: "dormant" }],
  );
  assert.equal(out[0].severity, "major");
  assert.equal(out[0].verdict, "downgrade");
});

// The incident this guards: one invented verdict at the head of the array
// threw, and fourteen findings — thirteen of them adjudicated correctly —
// were all discarded and left unreviewed.
test("an unrecognized verdict does not discard the valid ones", () => {
  const out = applyVerdicts(
    [f("a1"), f("a2"), f("a3")],
    [
      { id: "a1", verdict: "OUT_OF_SCOPE", basis: "not in the diff" },
      { id: "a2", verdict: "CONFIRMED", basis: "reproduced" },
      { id: "a3", verdict: "refute", basis: "line 4 disproves it" },
    ],
  );
  assert.equal(out[0].verdict, "unreviewed");
  assert.equal(out[1].verdict, "confirm");
  assert.equal(out[2].verdict, "refute");
});

// Skipping is only safe because the finding lands on `unreviewed`, which
// blocks convergence and reports as "not yet adjudicated". It must never
// inherit a verdict from anywhere.
test("a finding whose verdict was rejected keeps no basis or bounds", () => {
  const out = applyVerdicts(
    [f("a1")],
    [{ id: "a1", verdict: "maybe", basis: "b", bounds: "everywhere" }],
  );
  assert.equal(out[0].verdict, "unreviewed");
  assert.equal(out[0].basis, "");
  assert.equal(out[0].bounds, "");
});

test("every rejected verdict is reported, not just the first", () => {
  const seen = [];
  applyVerdicts(
    [f("a1"), f("a2"), f("a3")],
    [
      { id: "a1", verdict: "maybe" },
      { id: "a2", verdict: "confirm" },
      { id: "a3", verdict: "OUT_OF_SCOPE" },
    ],
    { onInvalid: (r) => seen.push(...r) },
  );
  assert.deepEqual(seen, [
    { id: "a1", verdict: "maybe" },
    { id: "a3", verdict: "OUT_OF_SCOPE" },
  ]);
});

test("nothing rejected means nothing reported", () => {
  let called = false;
  applyVerdicts([f("a1")], [{ id: "a1", verdict: "confirm" }], {
    onInvalid: () => {
      called = true;
    },
  });
  assert.equal(called, false);
});

// A malformed verdicts file must not crash the run — it is the one input
// written by hand between passes.
test("a missing or non-string verdict is rejected, not thrown on", () => {
  const seen = [];
  const out = applyVerdicts(
    [f("a1"), f("a2")],
    [{ id: "a1" }, { id: "a2", verdict: 3 }],
    { onInvalid: (r) => seen.push(...r) },
  );
  assert.equal(out[0].verdict, "unreviewed");
  assert.equal(out[1].verdict, "unreviewed");
  assert.equal(seen.length, 2);
});

test("a verdict for an unknown id is ignored, not fatal", () => {
  const out = applyVerdicts(
    [f("a1")],
    [{ id: "zzzz", verdict: "refute", basis: "x" }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].verdict, "unreviewed");
});

test("the table lists only findings whose verdict changed something", () => {
  const findings = applyVerdicts(
    [f("a1"), f("a2"), f("a3")],
    [
      { id: "a1", verdict: "confirm", basis: "" },
      { id: "a2", verdict: "refute", basis: "cfg(test)" },
      { id: "a3", verdict: "escalate", basis: "composes" },
    ],
  );
  const md = renderDisagreementTable(findings);
  assert.doesNotMatch(md, /t-a1/);
  assert.match(md, /t-a2/);
  assert.match(md, /REFUTED/);
  assert.match(md, /ESCALATED/);
});

test("the table renders a placeholder when everything was confirmed", () => {
  const md = renderDisagreementTable(
    applyVerdicts([f("a1")], [{ id: "a1", verdict: "confirm", basis: "" }]),
  );
  assert.match(md, /no disagreements/i);
});
