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

test("a finding with no verdict defaults to confirm", () => {
  const out = applyVerdicts([f("a1")], []);
  assert.equal(out[0].verdict, "confirm");
});

test("an unknown verdict is rejected", () => {
  assert.throws(
    () => applyVerdicts([f("a1")], [{ id: "a1", verdict: "maybe", basis: "" }]),
    /unknown verdict/i,
  );
});

test("a verdict for an unknown id is ignored, not fatal", () => {
  const out = applyVerdicts(
    [f("a1")],
    [{ id: "zzzz", verdict: "refute", basis: "x" }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].verdict, "confirm");
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
