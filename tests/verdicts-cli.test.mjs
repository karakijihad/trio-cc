// The write boundary for adjudication: `trio verdicts` is the sanctioned way
// pass-N/verdicts.json gets written, and the point of it is that a bad
// submission leaves no file behind at all.
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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseVerdictsInput, validateVerdicts } from "../src/reconcile.mjs";

const RUN = "2026-08-03T10-00-00";
const CLI = fileURLToPath(new URL("../bin/trio.mjs", import.meta.url));

const finding = (id) => ({
  id,
  severity: "major",
  file: "a.rs",
  title: `t-${id}`,
  evidence: "",
  impact: "",
  correction: "",
  lens: "auditor",
  verdict: "unreviewed",
  basis: "",
  bounds: "",
});

const project = (ids = ["a1", "a2"]) => {
  const root = mkdtempSync(join(tmpdir(), "trio-verdicts-"));
  const dir = join(root, ".trio", "runs", RUN, "pass-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "reconcile.json"),
    JSON.stringify({ findings: ids.map(finding) }),
  );
  return { root, dir };
};

const submit = (root, body, args = [RUN, "1"]) =>
  spawnSync("node", [CLI, "verdicts", ...args], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
    input: body,
  });

const verdict = (id, over = {}) => ({
  id,
  verdict: "confirm",
  basis: "reproduced: input x hits the branch at a.rs:4",
  bounds: "nowhere else",
  ...over,
});

const ok = (over = {}) => ({
  verdicts: [verdict("a1", over), verdict("a2")],
});

test("a clean submission is accepted and written canonically", () => {
  const { root, dir } = project();
  const r = submit(root, JSON.stringify(ok()));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const written = JSON.parse(readFileSync(join(dir, "verdicts.json"), "utf8"));
  assert.equal(written.verdicts.length, 2);
  assert.equal(written.verdicts[0].verdict, "confirm");
});

// The incident, refused at the boundary this time.
test("an invented verdict is refused and nothing is written", () => {
  const { root, dir } = project();
  const r = submit(
    root,
    JSON.stringify({
      verdicts: [verdict("a1", { verdict: "OUT_OF_SCOPE" }), verdict("a2")],
    }),
  );
  assert.equal(r.status, 2);
  assert.match(r.stdout, /OUT_OF_SCOPE/);
  assert.match(r.stdout, /not written/);
  assert.equal(existsSync(join(dir, "verdicts.json")), false);
});

test("uppercase past tense is accepted and normalized on the way in", () => {
  const { root, dir } = project();
  const r = submit(
    root,
    JSON.stringify({
      verdicts: [verdict("a1", { verdict: "CONFIRMED" }), verdict("a2")],
    }),
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const written = JSON.parse(readFileSync(join(dir, "verdicts.json"), "utf8"));
  assert.equal(written.verdicts[0].verdict, "confirm");
  assert.match(r.stderr, /normalized a1: CONFIRMED → confirm/);
});

// The reply that started this was prose with the block buried in it.
test("a fenced json block inside prose is pulled out", () => {
  const { root, dir } = project();
  const r = submit(
    root,
    `## Adjudication\n\nSome reasoning here.\n\n\`\`\`json\n${JSON.stringify(ok())}\n\`\`\`\n`,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(join(dir, "verdicts.json")), true);
});

test("a refused submission does not overwrite a good file already there", () => {
  const { root, dir } = project();
  assert.equal(submit(root, JSON.stringify(ok())).status, 0);
  const before = readFileSync(join(dir, "verdicts.json"), "utf8");
  const r = submit(root, JSON.stringify({ verdicts: [{ id: "a1" }] }));
  assert.equal(r.status, 2);
  assert.equal(readFileSync(join(dir, "verdicts.json"), "utf8"), before);
});

test("a finding left without a verdict is refused, not silently unreviewed", () => {
  const { root, dir } = project();
  const r = submit(root, JSON.stringify({ verdicts: [verdict("a1")] }));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /no verdict for finding a2/);
  assert.equal(existsSync(join(dir, "verdicts.json")), false);
});

test("a verdict for a finding this pass never raised is refused", () => {
  const { root } = project();
  const r = submit(
    root,
    JSON.stringify({ verdicts: [verdict("a1"), verdict("a2"), verdict("zz")] }),
  );
  assert.equal(r.status, 2);
  assert.match(r.stdout, /no finding zz in this pass/);
});

test("every problem is reported at once, not one per resubmission", () => {
  const { root } = project(["a1", "a2", "a3"]);
  const r = submit(
    root,
    JSON.stringify({
      verdicts: [
        verdict("a1", { verdict: "OUT_OF_SCOPE" }),
        verdict("a2", { verdict: "refute", basis: "" }),
      ],
    }),
  );
  assert.equal(r.status, 2);
  assert.match(r.stdout, /OUT_OF_SCOPE/);
  assert.match(r.stdout, /refute needs a basis/);
  assert.match(r.stdout, /no verdict for finding a3/);
  assert.match(r.stdout, /Refusing 3 problem/);
});

test("a bare confirm with no basis is refused", () => {
  const { root } = project(["a1"]);
  const r = submit(root, JSON.stringify({ verdicts: [verdict("a1", { basis: "" })] }));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /confirm needs a basis stating the failure path/);
});

test("a confirm with no bounds warns but is still accepted", () => {
  const { root, dir } = project(["a1"]);
  const r = submit(
    root,
    JSON.stringify({ verdicts: [verdict("a1", { bounds: "" })] }),
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /confirmed with no bounds/);
  assert.equal(existsSync(join(dir, "verdicts.json")), true);
});

test("input that is not JSON at all is refused, not thrown on", () => {
  const { root } = project();
  const r = submit(root, "the reconciler said everything looked fine");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /not JSON/);
});

test("a pass that does not exist is refused", () => {
  const { root } = project();
  const r = submit(root, JSON.stringify(ok()), [RUN, "7"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No pass 7/);
});

test("duplicate verdicts for one finding are refused", () => {
  const { root } = project(["a1"]);
  const r = submit(
    root,
    JSON.stringify({ verdicts: [verdict("a1"), verdict("a1")] }),
  );
  assert.equal(r.status, 2);
  assert.match(r.stdout, /a second verdict for a1/);
});

// Unit-level checks of the pieces the command composes.
test("parseVerdictsInput prefers a bare object and falls back to the block", () => {
  assert.equal(parseVerdictsInput('{"verdicts":[]}').ok, true);
  const fenced = parseVerdictsInput('noise\n```json\n{"verdicts":[]}\n```\nmore');
  assert.equal(fenced.ok, true);
  assert.deepEqual(fenced.parsed, { verdicts: [] });
  assert.equal(parseVerdictsInput("").ok, false);
});

test("validateVerdicts rejects a non-string basis rather than coercing it", () => {
  const r = validateVerdicts(
    { verdicts: [{ id: "a1", verdict: "confirm", basis: 3 }] },
    { knownIds: ["a1"] },
  );
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /basis must be a string/.test(p)));
});

test("validateVerdicts with no knownIds checks shape but not coverage", () => {
  const r = validateVerdicts({
    verdicts: [{ id: "a1", verdict: "CONFIRMED", basis: "path: x breaks y" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.verdicts[0].verdict, "confirm");
});
