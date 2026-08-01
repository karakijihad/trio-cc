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
import { nextAuditNumber, promote } from "../src/promote.mjs";
import { runPass } from "../src/orchestrator.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-promote-"));
const NOW = new Date("2026-07-29T14:03:00Z");

const PASS = {
  pass: 1,
  lenses: [{ lens: "auditor", status: "ok" }],
  degraded: [],
  diff: { new: [], open: [], closed: [] },
  findings: [
    {
      id: "a1",
      severity: "critical",
      file: "src/a.rs",
      line: 12,
      title: "unchecked unsafe",
      evidence: "src/a.rs:12",
      impact: "UB",
      correction: "add a check",
      lens: "auditor",
      verdict: "confirm",
      basis: "",
    },
    {
      id: "a2",
      severity: "minor",
      file: "src/b.rs",
      line: 3,
      title: "oversized file",
      evidence: "834 lines",
      impact: "maintenance",
      correction: "split",
      lens: "simplifier",
      verdict: "refute",
      basis: "cfg(test) from 394",
    },
  ],
};

test("nextAuditNumber starts at 1 for a missing directory", () => {
  assert.equal(nextAuditNumber(join(tmp(), "nope")), 1);
});

test("nextAuditNumber increments past existing files", () => {
  const d = tmp();
  writeFileSync(join(d, "audit-1.md"), "");
  writeFileSync(join(d, "audit-2.md"), "");
  assert.equal(nextAuditNumber(d), 3);
});

test("nextAuditNumber ignores unrelated files", () => {
  const d = tmp();
  writeFileSync(join(d, "audit-1.md"), "");
  writeFileSync(join(d, "notes.md"), "");
  assert.equal(nextAuditNumber(d), 2);
});

test("promote writes both audits under the dated folders", () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const r = promote({
    root,
    config: DEFAULT_CONFIG,
    runId: "r1",
    passes: [PASS],
    verdict: "clean",
    now: NOW,
  });
  assert.ok(
    r.codexPath.includes(
      join("Docs", "Audit", "codex", "2026-07-29", "audit-1.md"),
    ),
  );
  assert.ok(
    r.claudePath.includes(
      join("Docs", "Audit", "claude", "2026-07-29", "audit-1.md"),
    ),
  );
  assert.ok(existsSync(r.codexPath));
  assert.ok(existsSync(r.claudePath));
});

test("promote never overwrites — a second run becomes audit-2", () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const first = promote({
    root,
    config: DEFAULT_CONFIG,
    runId: "r1",
    passes: [PASS],
    verdict: "clean",
    now: NOW,
  });
  writeFileSync(first.codexPath, "ORIGINAL");
  const second = promote({
    root,
    config: DEFAULT_CONFIG,
    runId: "r2",
    passes: [PASS],
    verdict: "clean",
    now: NOW,
  });
  assert.notEqual(second.codexPath, first.codexPath);
  assert.equal(readFileSync(first.codexPath, "utf8"), "ORIGINAL");
});

test("the codex audit carries the spec section headings", () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const r = promote({
    root,
    config: DEFAULT_CONFIG,
    runId: "r1",
    passes: [PASS],
    verdict: "clean",
    now: NOW,
  });
  const md = readFileSync(r.codexPath, "utf8");
  for (const h of [
    "## Scope",
    "## Executive Summary",
    "## Findings",
    "## Verification Notes",
    "## Overall Assessment",
  ]) {
    assert.ok(md.includes(h), `missing ${h}`);
  }
});

test("the reconciliation carries the disagreement table", () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const r = promote({
    root,
    config: DEFAULT_CONFIG,
    runId: "r1",
    passes: [PASS],
    verdict: "clean",
    now: NOW,
  });
  const md = readFileSync(r.claudePath, "utf8");
  assert.match(md, /REFUTED/);
  assert.match(md, /cfg\(test\) from 394/);
});

test("a ceiling_reached verdict is stated plainly, never as clean", () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const r = promote({
    root,
    config: DEFAULT_CONFIG,
    runId: "r1",
    passes: [PASS],
    verdict: "ceiling_reached",
    now: NOW,
  });
  const md = readFileSync(r.claudePath, "utf8");
  assert.match(md, /ceiling/i);
  assert.doesNotMatch(md, /\bclean\b/i);
});

test("promote never leaks a lens finding's secret-shaped evidence into the codex audit", async () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const secretFinding = {
    severity: "critical",
    file: "src/a.rs",
    title: "leaked secret",
    evidence: "token sk-proj-AAAABBBBCCCCDDDD1234 found in src/a.rs:12",
    impact: "credential exposure",
    correction: "rotate and remove",
    id: "s1",
  };
  const { record } = await runPass({
    config: {
      ...DEFAULT_CONFIG,
      codex: {
        parallel: 1,
        lenses: [{ name: "security", model: "m", effort: "low", on: true }],
      },
    },
    target: "/repo",
    root,
    runId: "r1",
    pass: 1,
    prevRecord: null,
    runLensFn: async ({ lens }) => ({
      lens: lens.name,
      status: "ok",
      findings: [secretFinding],
      threadId: "t",
      raw: "",
    }),
    briefFor: () => "b",
  });

  const r = promote({
    root,
    config: DEFAULT_CONFIG,
    runId: "r1",
    passes: [record],
    verdict: "clean",
    now: NOW,
  });
  const md = readFileSync(r.codexPath, "utf8");
  assert.doesNotMatch(md, /sk-proj-AAAABBBBCCCCDDDD1234/);
  assert.match(md, /<redacted:token>/);
});

test("promote returns null when the promote root does not exist", () => {
  assert.equal(
    promote({
      root: tmp(),
      config: DEFAULT_CONFIG,
      runId: "r1",
      passes: [PASS],
      verdict: "clean",
      now: NOW,
    }),
    null,
  );
});
