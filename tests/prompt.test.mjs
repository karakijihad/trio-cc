import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPassResponse,
  claudeChanges,
  buildLensPrompt,
} from "../src/prompt.mjs";
import { passDir } from "../src/paths.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-prompt-"));

test("readPassResponse returns null when response.json is missing", () => {
  const root = tmp();
  assert.equal(readPassResponse(root, "r1", 1), null);
});

test("readPassResponse returns null on malformed json", () => {
  const root = tmp();
  const dir = passDir(root, "r1", 1);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "response.json"), "{ not json");
  assert.equal(readPassResponse(root, "r1", 1), null);
});

test("readPassResponse round-trips a valid file", () => {
  const root = tmp();
  const dir = passDir(root, "r1", 1);
  mkdirSync(dir, { recursive: true });
  const payload = {
    findings: [{ id: "ab12cd34", action: "fixed", note: "done" }],
    summary: "all good",
  };
  writeFileSync(join(dir, "response.json"), JSON.stringify(payload));
  assert.deepEqual(readPassResponse(root, "r1", 1), payload);
});

test("claudeChanges filters by actor, kind, and pass, preserving order", () => {
  const events = [
    {
      actor: "claude",
      kind: "file_change",
      pass: 1,
      payload: { file: "a.rs", diff: "diffA" },
    },
    {
      actor: "codex",
      kind: "file_change",
      pass: 1,
      payload: { file: "b.rs", diff: "diffB" },
    },
    {
      actor: "claude",
      kind: "agent_message",
      pass: 1,
      payload: { text: "hi" },
    },
    {
      actor: "claude",
      kind: "file_change",
      pass: 2,
      payload: { file: "c.rs", diff: "diffC" },
    },
    {
      actor: "claude",
      kind: "file_change",
      pass: 1,
      payload: { file: "d.rs", diff: "diffD" },
    },
  ];
  assert.deepEqual(claudeChanges(events, 1), [
    { file: "a.rs", diff: "diffA" },
    { file: "d.rs", diff: "diffD" },
  ]);
});

test("buildLensPrompt returns the brief verbatim for pass 1", () => {
  const out = buildLensPrompt({
    brief: "BRIEF TEXT",
    lens: "auditor",
    pass: 1,
    prior: { findings: [], changes: [], response: null },
  });
  assert.equal(out, "BRIEF TEXT");
});

test("buildLensPrompt returns the brief verbatim when prior is null", () => {
  const out = buildLensPrompt({
    brief: "BRIEF TEXT",
    lens: "auditor",
    pass: 2,
    prior: null,
  });
  assert.equal(out, "BRIEF TEXT");
});

// The decline ledger's prompt half (src/settled.mjs). It is the primary
// mechanism: across every recorded boomerang the lens reworded its title
// completely, so no mechanical key matched — only prose reaches a lens that is
// about to write a new title for an old claim.
const SETTLED = [
  {
    id: "aaaa1111",
    key: "src/a.mjs:10",
    file: "src/a.mjs",
    line: 10,
    title: "the old claim",
    lens: "security",
    kind: "refuted",
    priorVerdict: "refute",
    pass: 1,
    basis: "pinned by a.test.mjs:8",
  },
];

test("the settled ledger reaches a pass-2 prompt, before the instructions", () => {
  const out = buildLensPrompt({
    brief: "BRIEF",
    lens: "auditor",
    pass: 2,
    prior: { findings: [], changes: [], response: null },
    settled: SETTLED,
  });
  assert.match(out, /## Already settled this run/);
  assert.match(out, /src\/a\.mjs:10/);
  assert.match(out, /pinned by a\.test\.mjs:8/);
  assert.ok(
    out.indexOf("## Already settled this run") < out.indexOf("## Instructions"),
    "the ledger must sit closest to the ask",
  );
});

test("no settled section when the run has settled nothing", () => {
  const out = buildLensPrompt({
    brief: "BRIEF",
    lens: "auditor",
    pass: 2,
    prior: { findings: [], changes: [], response: null },
    settled: [],
  });
  assert.doesNotMatch(out, /Already settled/);
});

test("an absent settled argument is not an error", () => {
  const out = buildLensPrompt({
    brief: "BRIEF",
    lens: "auditor",
    pass: 2,
    prior: { findings: [], changes: [], response: null },
  });
  assert.doesNotMatch(out, /Already settled/);
  assert.match(out, /## Instructions/);
});

test("pass 1 never carries the ledger, even if one is passed", () => {
  const out = buildLensPrompt({
    brief: "BRIEF",
    lens: "auditor",
    pass: 1,
    prior: null,
    settled: SETTLED,
  });
  assert.equal(out, "BRIEF");
});

test("pass-2 prompt carries the brief, a prior finding, a diff hunk, and a declined reason", () => {
  const prior = {
    findings: [
      {
        id: "f1",
        severity: "major",
        file: "a.rs",
        line: 10,
        title: "leaked handle",
        correction: "close it",
      },
    ],
    changes: [
      {
        file: "a.rs",
        diff: "--- a/a.rs\n+++ b/a.rs\n-old\n+new",
      },
    ],
    response: {
      findings: [
        {
          id: "f1",
          action: "declined",
          reason: "false positive, handle is pooled",
        },
      ],
    },
  };
  const out = buildLensPrompt({
    brief: "BRIEF TEXT",
    lens: "auditor",
    pass: 2,
    prior,
  });
  assert.match(out, /BRIEF TEXT/);
  assert.match(out, /leaked handle/);
  assert.match(out, /f1/);
  assert.match(out, /-old/);
  assert.match(out, /\+new/);
  assert.match(out, /false positive, handle is pooled/);
});

test("absent response states Claude left no structured reply", () => {
  const prior = {
    findings: [
      { id: "f1", severity: "minor", file: "a.rs", line: 1, title: "t" },
    ],
    changes: [],
    response: null,
  };
  const out = buildLensPrompt({ brief: "b", lens: "auditor", pass: 2, prior });
  assert.match(out, /no structured reply/i);
});

test("a response entry with an unknown id is listed and marked", () => {
  const prior = {
    findings: [
      { id: "f1", severity: "minor", file: "a.rs", line: 1, title: "t" },
    ],
    changes: [],
    response: { findings: [{ id: "ghost", action: "fixed", note: "n/a" }] },
  };
  const out = buildLensPrompt({ brief: "b", lens: "auditor", pass: 2, prior });
  assert.match(out, /ghost/);
  assert.match(out, /not among your previous findings/);
});

test("empty prior findings and changes produce fallback statements", () => {
  const prior = { findings: [], changes: [], response: null };
  const out = buildLensPrompt({ brief: "b", lens: "auditor", pass: 2, prior });
  assert.match(out, /no findings/i);
  assert.match(out, /no file changes/i);
});

test("scope is absent from the prompt when no scope was given", () => {
  const out = buildLensPrompt({ brief: "BRIEF", pass: 1, prior: null });
  assert.equal(out, "BRIEF");
});

test("scope reaches pass 1, which has no prior turn to carry it", () => {
  const out = buildLensPrompt({
    brief: "BRIEF",
    pass: 1,
    prior: null,
    scope: "src/driver.mjs",
  });
  assert.match(out, /^BRIEF/);
  assert.match(out, /## Scope/);
  assert.match(out, /Concentrate on: src\/driver\.mjs/);
});

// A lens that narrowed on pass 1 and widened on pass 2 would report the whole
// repository as newly found, and the convergence check would never settle.
test("scope rides every later pass too", () => {
  const out = buildLensPrompt({
    brief: "BRIEF",
    pass: 2,
    scope: "src/driver.mjs",
    prior: { findings: [], changes: [], response: null },
  });
  assert.match(out, /## Scope/);
  assert.match(out, /## Your findings from pass 1/);
  // Scope belongs to the brief, before the conversation history it frames.
  assert.ok(out.indexOf("## Scope") < out.indexOf("## Your findings"));
});

// The findings block has no field for "resolved" — omission is the channel.
test("the pass-2 instruction asks for omission, not a resolved field", () => {
  const out = buildLensPrompt({
    brief: "BRIEF",
    pass: 2,
    prior: { findings: [], changes: [], response: null },
  });
  assert.match(out, /Omit a finding the changes resolved/);
  assert.doesNotMatch(out, /which are resolved/);
});

// response.json is a handover file written outside Trio. readPassResponse only
// guards a parse failure, not a wrong shape, and either throw here escapes
// through briefFor and pool() to fail the whole run.
const replyFor = (response) =>
  buildLensPrompt({
    brief: "BRIEF",
    lens: "auditor",
    pass: 2,
    prior: { findings: [], changes: [], response },
  });

for (const [label, bad] of [
  ["a string", { findings: "x" }],
  ["a number", { findings: 3 }],
  ["an object", { findings: { a: 1 } }],
]) {
  test(`a response whose findings is ${label} costs its section, not the run`, () => {
    let out;
    assert.doesNotThrow(() => {
      out = replyFor(bad);
    });
    assert.match(out, /## Claude's reply/);
    assert.match(out, /is not a list/);
    assert.match(out, /## Instructions/);
    // "replied about nothing" and "could not be read" are different claims
    assert.doesNotMatch(out, /listed no findings/);
  });
}

test("entries that could not be read are counted, not silently dropped", () => {
  const out = replyFor({ findings: [null, null] });
  assert.match(out, /2 entries in Claude's reply could not be read/);
  assert.doesNotMatch(out, /listed no findings/);
});

test("a partly unreadable reply does not look complete", () => {
  const out = replyFor({
    findings: [null, { id: "aa11", action: "declined", reason: "by design" }],
  });
  assert.match(out, /aa11: declined — by design/);
  assert.match(out, /1 entry in Claude's reply could not be read/);
});

test("a genuinely empty reply still says it listed no findings", () => {
  const out = replyFor({ findings: [] });
  assert.match(out, /listed no findings/);
  assert.doesNotMatch(out, /could not be read/);
});

