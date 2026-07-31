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
