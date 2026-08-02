import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findingId,
  extractFindings,
  validateFindings,
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

const withId = (over) => {
  const x = f(over);
  return { ...x, id: findingId(x.file, x.title), verdict: "confirm" };
};

// The defect this closes, measured on run 2026-08-01T12-27-09: 21 of 21
// findings reported closed and 0 open, while 14 of them were still in the
// code — the lenses had merely reworded them.
test("a re-worded finding is neither closed nor new", () => {
  const prev = [withId({ title: "all lenses off reports clean", line: 47 })];
  const curr = [withId({ title: "an all-off config converges", line: 47 })];
  const diff = diffPasses(prev, curr);
  assert.equal(diff.closed.length, 0, "it was never fixed");
  assert.equal(diff.new.length, 0, "and it is not a new defect");
  assert.equal(diff.open.length, 1, "it is the same one, still open");
  assert.equal(
    isConverged(curr, diff, { blockOn: [], requireNoNewFindings: true }),
    true,
  );
});

// The mirror: an earlier fix shifts later lines, so an unchanged finding
// reports a new line number.
test("a finding whose line shifted is neither closed nor new", () => {
  const at = (line) => [withId({ title: "t", line })];
  const diff = diffPasses(at(47), at(63));
  assert.equal(diff.closed.length, 0);
  assert.equal(diff.new.length, 0);
  assert.equal(diff.open.length, 1);
});

test("a defect that really went away is reported closed", () => {
  const diff = diffPasses([withId({ title: "t", line: 47 })], []);
  assert.equal(diff.closed.length, 1);
  assert.equal(diff.open.length, 0);
});

test("a finding at a genuinely new place is new and blocks convergence", () => {
  const diff = diffPasses(
    [withId({ title: "t", line: 47 })],
    [withId({ title: "t2", file: "b.rs", line: 9 })],
  );
  assert.equal(diff.new.length, 1);
  assert.equal(diff.closed.length, 1, "and the old one really is gone");
  assert.equal(
    isConverged(diff.new, diff, { blockOn: [], requireNoNewFindings: true }),
    false,
  );
});

// Line-less findings must not all collapse onto their filename, or two
// unrelated whole-file findings would silently mask each other.
test("line-less findings in one file stay distinct", () => {
  const prev = [withId({ title: "file is too long", line: undefined })];
  const curr = [withId({ title: "file has no header", line: undefined })];
  const diff = diffPasses(prev, curr);
  assert.equal(diff.new.length, 1);
  assert.equal(diff.closed.length, 1);
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

// mergeFindings resolves provenance as `f.lens ?? r.lens`, so a finding that
// arrives carrying its own lens outranks the lane that produced it. This
// validator is the boundary where findings authored outside Trio come in.
test("validateFindings strips a lens the payload tried to declare", () => {
  const r = validateFindings({
    findings: [
      { severity: "major", file: "a.js", title: "t", lens: "auditor, security" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.findings[0].lens, undefined);
});

// The rejected value is quoted back to whoever ran the command, and the file
// it came from was not necessarily written by them.
test("validateFindings neutralises control characters and bounds the echo", () => {
  const r = validateFindings({
    findings: [{ severity: "\u001b[2J" + "x".repeat(300), file: "a", title: "t" }],
  });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.reason, /\u001b/);
  assert.ok(r.reason.length < 140, `reason was ${r.reason.length} chars`);
});
