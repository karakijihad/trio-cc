import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findingId,
  extractFindings,
  diffPasses,
  isConverged,
  mergeFindings,
  locationOf,
} from "../src/findings.mjs";

const CONVERGE = { blockOn: ["critical", "major"], requireNoNewFindings: true };
const f = (over) => ({
  severity: "major",
  file: "a.rs",
  title: "t",
  evidence: "",
  impact: "",
  correction: "",
  ...over,
});

const lensResult = (lens, findings) => ({
  lens,
  status: "ok",
  findings: findings.map((x) => ({ ...x, id: findingId(x.file, x.title) })),
});

test("mergeFindings keeps one entry per defect and names every lens", () => {
  const out = mergeFindings([
    lensResult("auditor", [f({ title: "leak" })]),
    lensResult("security", [f({ title: "leak" })]),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].lens, "auditor, security");
});

test("mergeFindings keeps the most severe reading of one defect", () => {
  const out = mergeFindings([
    lensResult("auditor", [f({ title: "leak", severity: "major" })]),
    lensResult("security", [f({ title: "leak", severity: "critical" })]),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "critical");
});

test("mergeFindings does not merge different defects in the same file", () => {
  const out = mergeFindings([
    lensResult("auditor", [f({ title: "leak" }), f({ title: "race" })]),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((x) => x.lens),
    ["auditor", "auditor"],
  );
});

test("locationOf ignores wording and path separator style", () => {
  assert.equal(locationOf({ file: ".\\src\\a.mjs", line: 47 }), "src/a.mjs:47");
  assert.equal(
    locationOf({ file: "src/a.mjs", line: 47, title: "one wording" }),
    locationOf({ file: "src/a.mjs", line: 47, title: "another entirely" }),
  );
});

// The trap this closes: a lens rephrasing its own title mints a new id for a
// defect already reported, and requireNoNewFindings blocked on the rewrite.
test("a re-worded finding at a known location does not block convergence", () => {
  const prev = [f({ title: "all lenses off reports clean", line: 47 })].map(
    (x) => ({ ...x, id: findingId(x.file, x.title), verdict: "confirm" }),
  );
  const curr = [f({ title: "an all-off config converges", line: 47 })].map(
    (x) => ({ ...x, id: findingId(x.file, x.title), verdict: "confirm" }),
  );
  const diff = diffPasses(prev, curr);
  assert.equal(diff.new.length, 1, "still a distinct finding for reporting");
  assert.equal(diff.newHere.length, 0, "but not a new place");
  assert.equal(
    isConverged(curr, diff, { blockOn: [], requireNoNewFindings: true }),
    true,
  );
});

// The other half: an earlier fix shifts later lines, so a finding that never
// changed reports a new line number. Same id, so it is not new either.
test("a known finding whose line shifted does not block convergence", () => {
  const at = (line) =>
    [f({ title: "t", line })].map((x) => ({
      ...x,
      id: findingId(x.file, x.title),
      verdict: "confirm",
    }));
  const diff = diffPasses(at(47), at(63));
  assert.equal(diff.open.length, 1);
  assert.equal(diff.newHere.length, 0);
  assert.equal(
    isConverged(at(63), diff, { blockOn: [], requireNoNewFindings: true }),
    true,
  );
});

test("a finding at a genuinely new location still blocks convergence", () => {
  const prev = [f({ title: "t", line: 47 })].map((x) => ({
    ...x,
    id: findingId(x.file, x.title),
  }));
  const curr = [f({ title: "t2", file: "b.rs", line: 9 })].map((x) => ({
    ...x,
    id: findingId(x.file, x.title),
  }));
  const diff = diffPasses(prev, curr);
  assert.equal(diff.newHere.length, 1);
  assert.equal(
    isConverged(curr, diff, { blockOn: [], requireNoNewFindings: true }),
    false,
  );
});

test("findingId is 8 hex chars", () => {
  assert.match(findingId("src/a.rs", "handle leaked"), /^[0-9a-f]{8}$/);
});

test("findingId is stable regardless of case and surrounding whitespace", () => {
  assert.equal(
    findingId("src/a.rs", "Handle Leaked"),
    findingId("src/a.rs", "  handle leaked  "),
  );
});

test("findingId differs across files with the same title", () => {
  assert.notEqual(findingId("src/a.rs", "t"), findingId("src/b.rs", "t"));
});

test("extractFindings reads a fenced json block and assigns ids", () => {
  const text =
    'Here is my audit.\n\n```json\n{"findings":[{"severity":"major","file":"a.rs","line":10,"title":"leak","evidence":"e","impact":"i","correction":"c"}]}\n```';
  const r = extractFindings(text);
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].id, findingId("a.rs", "leak"));
});

test("extractFindings uses the last block when several are present", () => {
  const text =
    '```json\n{"findings":[]}\n```\nrevised:\n```json\n{"findings":[{"severity":"minor","file":"b.rs","title":"x"}]}\n```';
  const r = extractFindings(text);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].file, "b.rs");
});

test("extractFindings accepts an empty findings array as a clean report", () => {
  const r = extractFindings('```json\n{"findings":[]}\n```');
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test("extractFindings fails when no block is present", () => {
  const r = extractFindings(
    "I looked and found some issues but forgot the block.",
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /no json block/i);
});

test("extractFindings fails on malformed json", () => {
  const r = extractFindings('```json\n{"findings":[,]}\n```');
  assert.equal(r.ok, false);
  assert.match(r.reason, /parse/i);
});

test("extractFindings fails when severity is not a known level", () => {
  const r = extractFindings(
    '```json\n{"findings":[{"severity":"catastrophic","file":"a","title":"t"}]}\n```',
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /severity/i);
});

test("diffPasses classifies new, open and closed", () => {
  const prev = [f({ title: "kept" }), f({ title: "fixed" })].map((x) => ({
    ...x,
    id: findingId(x.file, x.title),
  }));
  const curr = [f({ title: "kept" }), f({ title: "fresh" })].map((x) => ({
    ...x,
    id: findingId(x.file, x.title),
  }));
  const d = diffPasses(prev, curr);
  assert.deepEqual(
    d.open.map((x) => x.title),
    ["kept"],
  );
  assert.deepEqual(
    d.new.map((x) => x.title),
    ["fresh"],
  );
  assert.deepEqual(
    d.closed.map((x) => x.title),
    ["fixed"],
  );
});

test("diffPasses treats an empty previous pass as all-new", () => {
  const curr = [f({ title: "x" })].map((x) => ({
    ...x,
    id: findingId(x.file, x.title),
  }));
  assert.equal(diffPasses([], curr).new.length, 1);
});

test("isConverged is false while a major stays open", () => {
  const curr = [{ ...f({ severity: "major" }), id: "aaaa1111" }];
  assert.equal(
    isConverged(curr, { new: [], open: curr, closed: [] }, CONVERGE),
    false,
  );
});

test("isConverged is false when a new finding appeared, even at minor", () => {
  const curr = [{ ...f({ severity: "minor" }), id: "aaaa1111" }];
  assert.equal(
    isConverged(curr, { new: curr, open: [], closed: [] }, CONVERGE),
    false,
  );
});

test("isConverged is true with only pre-existing minors", () => {
  const curr = [{ ...f({ severity: "minor" }), id: "aaaa1111" }];
  assert.equal(
    isConverged(curr, { new: [], open: curr, closed: [] }, CONVERGE),
    true,
  );
});

test("isConverged is true on an empty pass", () => {
  assert.equal(
    isConverged([], { new: [], open: [], closed: [] }, CONVERGE),
    true,
  );
});

test("isConverged ignores findings already refuted by the reconciler", () => {
  const curr = [
    { ...f({ severity: "critical" }), id: "aaaa1111", verdict: "refute" },
  ];
  assert.equal(
    isConverged(curr, { new: [], open: curr, closed: [] }, CONVERGE),
    true,
  );
});

test("extractFindings rejects a null finding instead of throwing", () => {
  const r = extractFindings('```json\n{"findings":[null]}\n```');
  assert.equal(r.ok, false);
  assert.match(r.reason, /object/i);
});

test("isConverged does not throw when blockOn is absent", () => {
  const curr = [{ ...f({ severity: "critical" }), id: "aaaa1111" }];
  assert.doesNotThrow(() =>
    isConverged(curr, { new: [], open: curr, closed: [] }, {
      requireNoNewFindings: true,
    }),
  );
});

test("findingId ignores path separator style", () => {
  assert.equal(findingId("src/a.rs", "t"), findingId("src\\a.rs", "t"));
});

test("findingId ignores a leading ./", () => {
  assert.equal(findingId("a.rs", "t"), findingId("./a.rs", "t"));
});
