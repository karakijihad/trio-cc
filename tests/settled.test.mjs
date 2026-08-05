import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSettled,
  settledMatcher,
  renderSettledSection,
  carrySettled,
} from "../src/settled.mjs";
import { findingId } from "../src/findings.mjs";
import { passDir } from "../src/paths.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-settled-"));

// A finding as it sits in reconcile.json: merged, with a verdict applied.
const finding = (file, line, title, extra = {}) => ({
  id: findingId(file, title),
  file,
  line,
  title,
  severity: "major",
  lens: "auditor",
  verdict: "unreviewed",
  basis: "",
  bounds: "",
  ...extra,
});

function writePass(root, runId, pass, { findings = [], response = null } = {}) {
  const dir = passDir(root, runId, pass);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "reconcile.json"),
    JSON.stringify({ pass, findings, diff: {}, degraded: [] }),
  );
  if (response)
    writeFileSync(join(dir, "response.json"), JSON.stringify(response));
  return dir;
}

test("an empty run settles nothing", () => {
  const root = tmp();
  assert.deepEqual(buildSettled(root, "r1", 0), []);
  assert.deepEqual(buildSettled(root, "r1", 3), []);
});

test("a refute verdict settles the finding as refuted", () => {
  const root = tmp();
  writePass(root, "r1", 1, {
    findings: [
      finding("src/a.mjs", 10, "claim one", {
        verdict: "refute",
        basis: "pinned by a.test.mjs:8",
      }),
    ],
  });
  const entries = buildSettled(root, "r1", 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "refuted");
  assert.equal(entries[0].priorVerdict, "refute");
  assert.equal(entries[0].pass, 1);
  assert.equal(entries[0].basis, "pinned by a.test.mjs:8");
  assert.equal(entries[0].key, "src/a.mjs:10");
});

test("a declined response settles the finding as declined", () => {
  const root = tmp();
  const f = finding("src/b.mjs", 4, "claim two", { verdict: "confirm" });
  writePass(root, "r1", 1, {
    findings: [f],
    response: {
      findings: [{ id: f.id, action: "declined", reason: "intended" }],
    },
  });
  const entries = buildSettled(root, "r1", 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "declined");
  assert.equal(entries[0].basis, "intended");
  // The whole point of the split: this one was CONFIRMED, so it must not read
  // as "not a defect" downstream.
  assert.equal(entries[0].priorVerdict, "confirm");
});

test("a decline with no reason is not a settlement", () => {
  const root = tmp();
  const f = finding("src/c.mjs", 1, "claim three");
  writePass(root, "r1", 1, {
    findings: [f],
    response: { findings: [{ id: f.id, action: "declined" }] },
  });
  assert.deepEqual(buildSettled(root, "r1", 1), []);
});

test("`note` is accepted as a decline reason", () => {
  const root = tmp();
  const f = finding("src/c.mjs", 1, "claim three");
  writePass(root, "r1", 1, {
    findings: [f],
    response: { findings: [{ id: f.id, action: "declined", note: "by design" }] },
  });
  const entries = buildSettled(root, "r1", 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].basis, "by design");
});

test("a confirm in a later pass overturns an earlier refutation", () => {
  const root = tmp();
  const f = finding("src/a.mjs", 10, "claim one");
  writePass(root, "r1", 1, {
    findings: [{ ...f, verdict: "refute", basis: "not reachable" }],
  });
  writePass(root, "r1", 2, {
    findings: [{ ...f, verdict: "confirm", basis: "reachable via serve()" }],
  });
  assert.deepEqual(buildSettled(root, "r1", 2), []);
});

test("an escalate in a later pass overturns an earlier refutation", () => {
  const root = tmp();
  const f = finding("src/a.mjs", 10, "claim one");
  writePass(root, "r1", 1, { findings: [{ ...f, verdict: "refute", basis: "no" }] });
  writePass(root, "r1", 2, { findings: [{ ...f, verdict: "escalate", basis: "yes" }] });
  assert.deepEqual(buildSettled(root, "r1", 2), []);
});

// A downgrade disputes how big a defect is, not whether it exists — the same
// affirmative class as confirm and escalate. Leaving it out let a stale
// refutation survive a "real, just smaller" ruling, and a later re-raise at
// that location was then carried as a past non-issue.
test("a downgrade in a later pass overturns an earlier refutation", () => {
  const root = tmp();
  const f = finding("src/a.mjs", 10, "claim one");
  writePass(root, "r1", 1, { findings: [{ ...f, verdict: "refute", basis: "no" }] });
  writePass(root, "r1", 2, {
    findings: [{ ...f, verdict: "downgrade", basis: "real, but minor" }],
  });
  assert.deepEqual(buildSettled(root, "r1", 2), []);
});

test("a downgrade still settles when the same pass declines it", () => {
  const root = tmp();
  const f = finding("src/a.mjs", 10, "claim one", { verdict: "downgrade" });
  writePass(root, "r1", 1, {
    findings: [f],
    response: { findings: [{ id: f.id, action: "declined", reason: "noise" }] },
  });
  const entries = buildSettled(root, "r1", 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "declined");
  // real but small, and carried on purpose — must not read as "not a defect"
  assert.equal(entries[0].priorVerdict, "downgrade");
});

test("a fixed action in a later pass overturns an earlier decline", () => {
  const root = tmp();
  const f = finding("src/b.mjs", 4, "claim two");
  writePass(root, "r1", 1, {
    findings: [f],
    response: { findings: [{ id: f.id, action: "declined", reason: "later" }] },
  });
  writePass(root, "r1", 2, {
    findings: [f],
    response: { findings: [{ id: f.id, action: "fixed", note: "done" }] },
  });
  assert.deepEqual(buildSettled(root, "r1", 2), []);
});

test("an overturn matches by location even when the title drifted", () => {
  const root = tmp();
  writePass(root, "r1", 1, {
    findings: [finding("src/a.mjs", 10, "old wording", { verdict: "refute", basis: "no" })],
  });
  writePass(root, "r1", 2, {
    findings: [finding("src/a.mjs", 10, "completely new wording", { verdict: "confirm", basis: "yes" })],
  });
  assert.deepEqual(buildSettled(root, "r1", 2), []);
});

test("silence overturns nothing — an unreviewed later pass keeps the settlement", () => {
  const root = tmp();
  const f = finding("src/a.mjs", 10, "claim one");
  writePass(root, "r1", 1, { findings: [{ ...f, verdict: "refute", basis: "no" }] });
  writePass(root, "r1", 2, { findings: [{ ...f, verdict: "unreviewed" }] });
  assert.equal(buildSettled(root, "r1", 2).length, 1);
});

test("a missing or malformed pass record overturns nothing and does not throw", () => {
  const root = tmp();
  writePass(root, "r1", 1, {
    findings: [finding("src/a.mjs", 10, "claim one", { verdict: "refute", basis: "no" })],
  });
  const dir = passDir(root, "r1", 2);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "reconcile.json"), "{ not json");
  assert.equal(buildSettled(root, "r1", 3).length, 1);
});

test("uptoPass bounds the fold — a later settlement is not read early", () => {
  const root = tmp();
  writePass(root, "r1", 1, {
    findings: [finding("src/a.mjs", 1, "one", { verdict: "refute", basis: "x" })],
  });
  writePass(root, "r1", 2, {
    findings: [finding("src/b.mjs", 2, "two", { verdict: "refute", basis: "y" })],
  });
  assert.equal(buildSettled(root, "r1", 1).length, 1);
  assert.equal(buildSettled(root, "r1", 2).length, 2);
});

// The ledger's known blind spot, pinned deliberately rather than fixed.
// locationOf gives a line-less finding the key `file#id`, so a retitled
// re-raise has a new id AND a new key and matches on neither. Widening the
// key to the bare filename would fix this case by breaking a worse one: every
// line-less finding in a file would collapse onto one key, merging defects
// that have nothing to do with each other (findings.mjs:96). A line-less
// finding whose title holds still matches by id.
test("a retitled line-less finding is not recognised — the accepted blind spot", () => {
  const root = tmp();
  writePass(root, "r1", 1, {
    findings: [
      finding("src/a.mjs", undefined, "file is too long", {
        verdict: "refute",
        basis: "by design",
      }),
    ],
  });
  const match = settledMatcher(buildSettled(root, "r1", 1));

  const retitled = {
    id: findingId("src/a.mjs", "this module does too much"),
    file: "src/a.mjs",
    line: undefined,
  };
  assert.equal(match(retitled), null, "the blind spot");

  const sameTitle = {
    id: findingId("src/a.mjs", "file is too long"),
    file: "src/a.mjs",
    line: undefined,
  };
  assert.ok(match(sameTitle), "a stable title still matches by id");

  // and it must not have swallowed an unrelated line-less finding in the file
  const unrelated = {
    id: findingId("src/a.mjs", "file has no header"),
    file: "src/a.mjs",
    line: undefined,
  };
  assert.equal(match(unrelated), null);
});

test("settledMatcher matches by id and by location, but never by file alone", () => {
  const entries = buildSettledFrom([
    { file: "src/a.mjs", line: 10, title: "the claim" },
  ]);
  const match = settledMatcher(entries);

  // same id, drifted line
  assert.ok(match({ id: findingId("src/a.mjs", "the claim"), file: "src/a.mjs", line: 99 }));
  // same location, drifted title
  assert.ok(match({ id: "ffffffff", file: "src/a.mjs", line: 10 }));
  // same file, different line, different title — a different defect
  assert.equal(match({ id: "eeeeeeee", file: "src/a.mjs", line: 42 }), null);
  // unrelated
  assert.equal(match({ id: "dddddddd", file: "src/z.mjs", line: 10 }), null);
});

test("settledMatcher reports how it matched", () => {
  const entries = buildSettledFrom([{ file: "src/a.mjs", line: 10, title: "the claim" }]);
  const match = settledMatcher(entries);
  assert.equal(
    match({ id: findingId("src/a.mjs", "the claim"), file: "src/a.mjs", line: 99 }).matchedBy,
    "id",
  );
  assert.equal(match({ id: "ffffffff", file: "src/a.mjs", line: 10 }).matchedBy, "location");
});

// Build entries without touching disk, for the pure-function tests above.
function buildSettledFrom(specs) {
  const root = tmp();
  writePass(root, "rX", 1, {
    findings: specs.map((s) =>
      finding(s.file, s.line, s.title, { verdict: "refute", basis: "because" }),
    ),
  });
  return buildSettled(root, "rX", 1);
}

test("carrySettled attaches history without inventing a verdict", () => {
  const entries = buildSettledFrom([{ file: "src/a.mjs", line: 10, title: "the claim" }]);
  const findings = [
    { id: "ffffffff", file: "src/a.mjs", line: 10, title: "reworded", verdict: "unreviewed" },
    { id: "eeeeeeee", file: "src/z.mjs", line: 3, title: "unrelated", verdict: "unreviewed" },
  ];
  const carried = carrySettled(findings, entries);

  assert.equal(carried[0].verdict, "unreviewed", "must not synthesise a verdict");
  assert.equal(carried[0].carried.priorVerdict, "refute");
  assert.equal(carried[0].carried.kind, "refuted");
  assert.equal(carried[0].carried.fromPass, 1);
  assert.equal(carried[0].carried.matchedBy, "location");
  assert.equal(carried[0].carried.basis, "because");
  assert.equal(carried[1].carried, undefined);
});

test("carrySettled is a no-op with no entries", () => {
  const findings = [{ id: "a", file: "f", line: 1, verdict: "unreviewed" }];
  assert.deepEqual(carrySettled(findings, []), findings);
});

test("renderSettledSection is null when nothing is settled", () => {
  assert.equal(renderSettledSection([]), null);
});

test("renderSettledSection labels each kind and quotes the basis", () => {
  const root = tmp();
  const f = finding("src/b.mjs", 4, "declined claim", { verdict: "confirm" });
  writePass(root, "r1", 1, {
    findings: [
      finding("src/a.mjs", 10, "refuted claim", {
        verdict: "refute",
        basis: "pinned by a.test.mjs:8",
        lens: "security",
      }),
      f,
    ],
    response: {
      findings: [{ id: f.id, action: "declined", reason: "carried on purpose" }],
    },
  });
  const out = renderSettledSection(buildSettled(root, "r1", 1));

  assert.match(out, /## Already settled this run/);
  assert.match(out, /REFUTED/);
  assert.match(out, /DECLINED/);
  assert.match(out, /src\/a\.mjs:10/);
  assert.match(out, /pinned by a\.test\.mjs:8/);
  assert.match(out, /carried on purpose/);
  assert.match(out, /security/, "names the lens that raised it");
  // The anti-priming and pinning-test framing both have to survive edits.
  assert.match(out, /independently reproduce/i);
  assert.match(out, /not new evidence/i);
});

// response.json is written by the trio-audit skill and nothing scrubs it, yet
// renderSettledSection replays a decline reason into every later pass's brief,
// which goes to Codex's stdin. Scrubbed at the settle boundary so no entry can
// exist unscrubbed, whichever source it came from.
test("a secret in a decline reason never becomes an entry", () => {
  const root = tmp();
  const f = finding("src/b.mjs", 4, "claim two", { verdict: "confirm" });
  writePass(root, "r1", 1, {
    findings: [f],
    response: {
      findings: [
        {
          id: f.id,
          action: "declined",
          reason: "the token sk-proj-AAAABBBBCCCCDDDD1234 is a test fixture",
        },
      ],
    },
  });
  const [entry] = buildSettled(root, "r1", 1);
  assert.doesNotMatch(entry.basis, /sk-proj-AAAABBBBCCCCDDDD1234/);
  assert.match(entry.basis, /<redacted:/);
  assert.doesNotMatch(renderSettledSection([entry]), /sk-proj-AAAABBBB/);
});

test("a secret in a refuted basis is scrubbed at the same boundary", () => {
  const root = tmp();
  writePass(root, "r1", 1, {
    findings: [
      finding("src/a.mjs", 10, "claim one", {
        verdict: "refute",
        basis: "harmless: Authorization: Bearer abcdefghijklmnop1234",
      }),
    ],
  });
  const [entry] = buildSettled(root, "r1", 1);
  assert.doesNotMatch(entry.basis, /abcdefghijklmnop1234/);
});

// The module's contract is that a malformed record contributes nothing and
// overturns nothing. Array.isArray only proves the container — a null entry
// still reached f.verdict, locationOf and the byId map, and a throw escaping
// into runPass fails the whole run, which is the opposite of tolerant.
test("a null finding entry does not crash the fold", () => {
  const root = tmp();
  const good = finding("src/a.mjs", 10, "claim one", {
    verdict: "refute",
    basis: "no",
  });
  writePass(root, "r1", 1, { findings: [null, good, "nonsense", 7] });
  const entries = buildSettled(root, "r1", 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "claim one");
});

test("a null reply entry does not crash the fold", () => {
  const root = tmp();
  const f = finding("src/b.mjs", 4, "claim two");
  writePass(root, "r1", 1, {
    findings: [f],
    response: {
      findings: [null, { id: f.id, action: "declined", reason: "intended" }],
    },
  });
  assert.equal(buildSettled(root, "r1", 1).length, 1);
});

test("a non-string decline reason is not a decision", () => {
  const root = tmp();
  const f = finding("src/c.mjs", 1, "claim three");
  writePass(root, "r1", 1, {
    findings: [f],
    response: {
      findings: [{ id: f.id, action: "declined", reason: { why: "object" } }],
    },
  });
  // String() would make this "[object Object]" — truthy, and enough to settle
  assert.deepEqual(buildSettled(root, "r1", 1), []);
});
