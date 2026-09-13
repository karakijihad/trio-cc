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

test("the five verdicts are exactly the spec set", () => {
  assert.deepEqual(VERDICTS, [
    "confirm",
    "refute",
    "downgrade",
    "escalate",
    "duplicate",
  ]);
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

// The defect this closes: a run extended past its ceiling re-runs
// applyAdjudication on a pass already adjudicated, feeding applyVerdicts its
// own previous output. Shifting from `f.severity` (this function's output)
// instead of a fixed reported severity moved a downgrade two steps and an
// escalate two steps the other way. Applying the same verdicts twice must
// land in the same place applying them once did.
test("applying a downgrade twice moves severity once, not twice", () => {
  const verdicts = [{ id: "a1", verdict: "downgrade", basis: "dormant" }];
  const once = applyVerdicts([f("a1", { severity: "critical" })], verdicts);
  const twice = applyVerdicts(once, verdicts);
  assert.equal(once[0].severity, "major");
  assert.equal(twice[0].severity, "major");
  assert.deepEqual(twice, once);
});

test("applying an escalate twice moves severity once, not twice", () => {
  const verdicts = [{ id: "a1", verdict: "escalate", basis: "composes" }];
  const once = applyVerdicts([f("a1", { severity: "info" })], verdicts);
  const twice = applyVerdicts(once, verdicts);
  assert.equal(once[0].severity, "minor");
  assert.equal(twice[0].severity, "minor");
  assert.deepEqual(twice, once);
});

test("applying confirm or refute twice is already stable", () => {
  const confirmed = [{ id: "a1", verdict: "confirm", basis: "reproduced" }];
  const once = applyVerdicts([f("a1")], confirmed);
  assert.deepEqual(applyVerdicts(once, confirmed), once);

  const refuted = [{ id: "a2", verdict: "refute", basis: "disproven" }];
  const onceR = applyVerdicts([f("a2")], refuted);
  assert.deepEqual(applyVerdicts(onceR, refuted), onceR);
});

// Records written before `reported` existed have no such field — the
// fallback to `f.severity` must reproduce first-time adjudication exactly.
test("a finding with no stored `reported` field still shifts correctly", () => {
  const out = applyVerdicts(
    [f("a1", { severity: "critical" })],
    [{ id: "a1", verdict: "downgrade", basis: "dormant" }],
  );
  assert.equal(out[0].severity, "major");
  assert.equal(out[0].reported, "critical");
});

// One defect reported by two lenses used to have nothing to write but
// `escalate` — counting it as two blocking findings. `duplicate` names the
// survivor in `of`.
test("duplicate keeps the survivor's severity and does not shift", () => {
  const out = applyVerdicts(
    [f("a1", { severity: "critical" }), f("a2", { severity: "major" })],
    [
      { id: "a1", verdict: "confirm", basis: "reproduced" },
      { id: "a2", verdict: "duplicate", of: "a1", basis: "same defect as a1" },
    ],
  );
  const dup = out.find((x) => x.id === "a2");
  assert.equal(dup.verdict, "duplicate");
  assert.equal(dup.severity, "major", "its own reported severity, untouched");
  assert.equal(dup.of, "a1");
});

test("duplicate folds its lens into the survivor", () => {
  const out = applyVerdicts(
    [
      f("a1", { lens: "auditor" }),
      f("a2", { lens: "tester" }),
    ],
    [
      { id: "a1", verdict: "confirm", basis: "reproduced" },
      { id: "a2", verdict: "duplicate", of: "a1", basis: "same defect" },
    ],
  );
  const survivor = out.find((x) => x.id === "a1");
  assert.equal(survivor.lens, "auditor, tester");
});

test("folding a duplicate's lens twice does not repeat it", () => {
  const verdicts = [
    { id: "a1", verdict: "confirm", basis: "reproduced" },
    { id: "a2", verdict: "duplicate", of: "a1", basis: "same defect" },
  ];
  const once = applyVerdicts(
    [f("a1", { lens: "auditor" }), f("a2", { lens: "tester" })],
    verdicts,
  );
  const twice = applyVerdicts(once, verdicts);
  assert.equal(twice.find((x) => x.id === "a1").lens, "auditor, tester");
});

test("a duplicate naming an unknown survivor still applies without crashing", () => {
  const out = applyVerdicts(
    [f("a1")],
    [{ id: "a1", verdict: "duplicate", of: "zzzz", basis: "same as zzzz" }],
  );
  assert.equal(out[0].verdict, "duplicate");
  assert.equal(out[0].of, "zzzz");
});
