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
import {
  nextAuditNumber,
  promote,
  promotionDir,
  renderReconciliation,
} from "../src/promote.mjs";
import { runPass } from "../src/orchestrator.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-promote-"));
const NOW = new Date("2026-07-29T14:03:00Z");

// Promotion writes where .trio/config.json (or a run's stored run.json) says,
// and both are repository-writable: a path leaving the project, lexically or
// through a directory link inside it, must never be written.
test("promotion refuses a destination outside the project, lexically or through a link", async (t) => {
  const root = tmp();
  for (const bad of ["../x", "a/../../x", "/etc/trio", "C:\\trio"])
    assert.ok(promotionDir(root, bad).error, bad);
  assert.ok(promotionDir(root, "Docs/Audit").absolute);

  const outside = tmp();
  mkdirSync(join(root, "Docs"), { recursive: true });
  const { symlinkSync } = await import("node:fs");
  try {
    symlinkSync(outside, join(root, "Docs", "Audit"), "junction");
  } catch (err) {
    t.skip(`cannot create a directory link here: ${err.code}`);
    return;
  }
  assert.match(promotionDir(root, "Docs/Audit").error, /outside the project/);
  const config = {
    ...DEFAULT_CONFIG,
    artifacts: { ...DEFAULT_CONFIG.artifacts, promoteTo: "Docs/Audit" },
  };
  assert.throws(
    () => promote({ root, config, runId: "r1", passes: [PASS], verdict: "clean", now: NOW }),
    /outside the project/,
  );
  assert.equal(existsSync(join(outside, "codex")), false);
});

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

// The whole point of promoting bounds: a confirmed finding's blast radius is
// what stops the next reader over-fixing it, and basis never gets there
// because a confirm is not a disagreement.
test("the reconciliation records a confirmed finding's bounds", () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const bounded = {
    ...PASS,
    findings: [
      { ...PASS.findings[0], bounds: "same at src/c.rs:9; NOT at src/d.rs:4" },
      PASS.findings[1],
    ],
  };
  const r = promote({
    root,
    config: DEFAULT_CONFIG,
    runId: "r1",
    passes: [bounded],
    verdict: "ceiling_reached",
    now: NOW,
  });
  const md = readFileSync(r.claudePath, "utf8");
  assert.match(md, /bounds: same at src\/c\.rs:9; NOT at src\/d\.rs:4/);
});

// The document's shape cannot depend on the agent honouring "one line".
test("a multi-line bounds is flattened so it cannot break the list item", () => {
  const root = tmp();
  mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
  const messy = {
    ...PASS,
    findings: [
      { ...PASS.findings[0], bounds: "also at c.rs:9\n\nNOT at d.rs:4" },
      PASS.findings[1],
    ],
  };
  const r = promote({
    root,
    config: DEFAULT_CONFIG,
    runId: "r1",
    passes: [messy],
    verdict: "ceiling_reached",
    now: NOW,
  });
  const md = readFileSync(r.claudePath, "utf8");
  assert.match(md, /^ {2}bounds: also at c\.rs:9 NOT at d\.rs:4$/m);
});

test("a finding with no bounds gets no empty bounds line", () => {
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
  assert.doesNotMatch(readFileSync(r.claudePath, "utf8"), /bounds:/);
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

// The provenance the merge produces is a joined string, and this is the only
// place it is decoded back into lanes. A change to that separator would
// mis-sort every finding with nothing else noticing.
test("renderLaneSplit separates both-lanes, codex-only and claude-only", async () => {
  const { renderLaneSplit } = await import("../src/promote.mjs");
  const out = renderLaneSplit({
    findings: [
      { severity: "major", file: "a.js", line: 1, title: "both saw it", lens: "auditor, claude" },
      { severity: "minor", file: "b.js", line: 2, title: "codex alone", lens: "security" },
      { severity: "critical", file: "c.js", line: 3, title: "claude alone", lens: "claude" },
    ],
  });
  assert.match(out, /\*\*Both lanes\*\* \(1\)/);
  assert.match(out, /\*\*Codex only\*\* \(1\)/);
  assert.match(out, /\*\*Claude only\*\* \(1\)/);
  // Each finding lands in exactly one column.
  assert.equal((out.match(/both saw it/g) || []).length, 1);
  assert.equal((out.match(/claude alone/g) || []).length, 1);
  assert.ok(out.indexOf("both saw it") < out.indexOf("codex alone"));
  assert.ok(out.indexOf("codex alone") < out.indexOf("claude alone"));
});

test("renderLaneSplit says so plainly when a column is empty", async () => {
  const { renderLaneSplit } = await import("../src/promote.mjs");
  const out = renderLaneSplit({
    findings: [{ severity: "major", file: "a.js", title: "codex alone", lens: "auditor" }],
  });
  assert.match(out, /\*\*Claude only\*\* \(0\)/);
  assert.match(out, /Claude found nothing Codex missed/);
});

// Counting lanes instead of checking for "claude" dropped every finding two
// Codex lenses agreed on: too many lanes to be codex-only, no claude to be
// both. The corroborated findings went missing from the corroboration section.
test("renderLaneSplit keeps findings two Codex lenses agreed on", async () => {
  const { renderLaneSplit } = await import("../src/promote.mjs");
  const out = renderLaneSplit({
    findings: [
      { severity: "major", file: "a.js", title: "two codex lenses", lens: "auditor, security" },
      { severity: "major", file: "b.js", title: "all three", lens: "auditor, security, claude" },
    ],
  });
  assert.match(out, /\*\*Codex only\*\* \(1\)/);
  assert.match(out, /two codex lenses/);
  assert.match(out, /\*\*Both lanes\*\* \(1\)/);
  assert.match(out, /all three/);
});

// A carried finding is exempted from blocking convergence by isLive. It is
// listed in Open findings like any other, but without the carried line nothing
// in the report says why it did not block — an unaudited exemption, which is
// the same failure the `unreviewed` default exists to prevent.
const carriedPass = (carried) => ({
  pass: 1,
  lenses: [{ lens: "auditor", status: "ok" }],
  degraded: [],
  diff: { new: [], open: [], closed: [] },
  findings: [
    {
      id: "c1",
      severity: "major",
      file: "src/a.rs",
      line: 10,
      title: "a resource is not released",
      lens: "auditor",
      verdict: "unreviewed",
      basis: "",
      bounds: "",
      carried,
    },
  ],
});

// Only an id match is excused now (isLive, src/findings.mjs) — a location
// match proves nothing about the claim, so it is a "carried" line without
// "did not block convergence". See the sibling test below for that half.
test("the report says why a carried finding did not block", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "clean",
    passes: [
      carriedPass({
        fromPass: 1,
        kind: "refuted",
        priorVerdict: "refute",
        matchedBy: "id",
        basis: "pinned by a.test.mjs:8",
      }),
    ],
  });
  assert.match(out, /a resource is not released/);
  assert.match(out, /carried: refuted in pass 1 \(refute\)/);
  assert.match(out, /matched by id/);
  assert.match(out, /did not block convergence/);
  assert.match(out, /pinned by a\.test\.mjs:8/);
});

// The other half of the same rule: a re-raise settledMatcher only matched by
// bare location is not the claim that was refuted, so it still blocked, and
// the report must not say otherwise.
test("a carried finding matched only by location is not described as excused", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "ceiling_reached",
    passes: [
      carriedPass({
        fromPass: 1,
        kind: "refuted",
        priorVerdict: "refute",
        matchedBy: "location",
        basis: "pinned by a.test.mjs:8",
      }),
    ],
  });
  assert.match(out, /carried: refuted in pass 1 \(refute\)/);
  assert.match(out, /matched by location/);
  assert.doesNotMatch(out, /did not block convergence/);
});

test("a carried decline is not described as having been excused", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "ceiling_reached",
    passes: [
      carriedPass({
        fromPass: 1,
        kind: "declined",
        priorVerdict: "confirm",
        matchedBy: "id",
        basis: "carrying it deliberately",
      }),
    ],
  });
  assert.match(out, /carried: declined in pass 1 \(confirm\)/);
  assert.doesNotMatch(
    out,
    /did not block convergence/,
    "a confirmed defect somebody carried still blocked, and must not read otherwise",
  );
});

test("a finding with no carry renders exactly as before", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "ceiling_reached",
    passes: [carriedPass(undefined)],
  });
  assert.match(out, /a resource is not released/);
  assert.doesNotMatch(out, /carried:/);
});

// The clause has to mirror isLive, not just priorVerdict. A carried refutation
// the reconciler has since confirmed does block, and saying otherwise would be
// a false claim about the run in the document the operator keeps.
test("a carried refutation the reconciler reopened is not called excused", () => {
  const pass = carriedPass({
    fromPass: 1,
    kind: "refuted",
    priorVerdict: "refute",
    matchedBy: "location",
    basis: "was thought pinned by a.test.mjs:8",
  });
  pass.findings[0].verdict = "confirm";
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "ceiling_reached",
    passes: [pass],
  });
  assert.match(out, /carried: refuted in pass 1 \(refute\)/);
  assert.doesNotMatch(out, /did not block convergence/);
});

// One defect reported by two lenses used to have nothing to write but
// `escalate`, counting as two blocking findings. `duplicate` folds it into
// its survivor, and the report must say so without listing it as open.
test("a duplicate is not listed as an open finding but is named in Duplicates", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "clean",
    passes: [
      {
        pass: 1,
        lenses: [{ lens: "auditor", status: "ok" }],
        degraded: [],
        diff: { new: [], open: [], closed: [] },
        findings: [
          {
            id: "c61d24bc",
            severity: "major",
            file: "bin/trio.mjs",
            line: 343,
            title: "duplicate detection races",
            lens: "auditor, tester",
            verdict: "confirm",
            basis: "reproduced",
            bounds: "",
          },
          {
            id: "745cb2bd",
            severity: "major",
            file: "bin/trio.mjs",
            line: 344,
            title: "same race, worded differently",
            lens: "tester",
            verdict: "duplicate",
            of: "c61d24bc",
            basis: "same defect as c61d24bc",
            bounds: "",
          },
        ],
      },
    ],
  });
  const [openSection] = out.split("## Duplicates");
  assert.doesNotMatch(
    openSection,
    /same race, worded differently/,
    "a duplicate must not be listed as an open finding",
  );
  assert.match(out, /## Duplicates/);
  assert.match(out, /`745cb2bd`.*duplicate of `c61d24bc`/);
  assert.match(out, /same race, worded differently/, "says what it duplicated");
  assert.match(openSection, /duplicate detection races/, "the survivor stays open");
});

test("no Duplicates section is rendered when nothing duplicated", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "clean",
    passes: [PASS],
  });
  assert.doesNotMatch(out, /## Duplicates/);
});

test("a newline in a carried field cannot break out of the list item", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "clean",
    passes: [
      carriedPass({
        fromPass: 1,
        kind: "refuted\n\n## Injected heading",
        priorVerdict: "refute",
        matchedBy: "location",
        basis: "one\ntwo",
      }),
    ],
  });
  assert.doesNotMatch(out, /^## Injected heading/m);
  assert.match(out, /carried: refuted ## Injected heading in pass 1/);
  assert.match(out, /one two/);
});

// `outOfScope` (reconcile.mjs) says the reconciler confirmed or escalated a
// real defect but ruled it outside the change under audit. It must never
// disappear the way a misused `downgrade` would — it gets its own section,
// named plainly, and it must not also appear as an open finding (that would
// double-count the one defect).
test("an outOfScope finding is named in its own section, not Open findings", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "clean",
    passes: [
      {
        pass: 1,
        lenses: [{ lens: "auditor", status: "ok" }],
        degraded: [],
        diff: { new: [], open: [], closed: [] },
        findings: [
          {
            id: "o1",
            severity: "major",
            file: "src/legacy.rs",
            line: 5,
            title: "retries without a cap",
            lens: "auditor",
            verdict: "confirm",
            basis: "real, but only reachable from the migration script",
            bounds: "",
            outOfScope: true,
          },
        ],
      },
    ],
  });
  const [openSection] = out.split("## Outside this change");
  assert.doesNotMatch(
    openSection,
    /retries without a cap/,
    "an out-of-scope finding must not also read as an open finding",
  );
  assert.match(out, /## Outside this change/);
  assert.match(out, /retries without a cap/);
  assert.match(out, /real, but only reachable from the migration script/);
});

test("no Outside-this-change section is rendered when nothing is out of scope", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "clean",
    passes: [PASS],
  });
  assert.doesNotMatch(out, /## Outside this change/);
});

// D-adjudication-gate's own reporting half: a pass applyAdjudication marked
// `unadjudicated` (src/adjudicate.mjs, missing verdicts.json) must not have
// its unreviewed findings read as "Open" the way a finding the reconciler
// actually weighed and left open does — 10 real runs reached ceiling_reached
// this way, and their reports said "Open findings" for every one of them.
const unadjudicatedPass = () => ({
  pass: 3,
  unadjudicated: true,
  lenses: [{ lens: "auditor", status: "ok" }],
  degraded: [],
  diff: { new: [], open: [], closed: [] },
  findings: [
    {
      id: "u1",
      severity: "major",
      file: "src/a.rs",
      line: 5,
      title: "never looked at",
      lens: "auditor",
      verdict: "unreviewed",
      basis: "",
      bounds: "",
    },
    {
      id: "u2",
      severity: "minor",
      file: "src/b.rs",
      line: 9,
      title: "also never looked at",
      lens: "auditor",
      verdict: "unreviewed",
      basis: "",
      bounds: "",
    },
  ],
});

test("an unadjudicated pass's findings are named in their own section, not Open findings", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "ceiling_reached",
    passes: [unadjudicatedPass()],
  });
  const [openSection] = out.split("## Never adjudicated");
  assert.doesNotMatch(
    openSection,
    /never looked at/,
    "an unadjudicated finding must not also read as an open finding",
  );
  assert.match(out, /## Never adjudicated/);
  assert.match(out, /Pass 3 advanced with no pass-3\/verdicts\.json: 2 findings were never checked/);
  assert.match(out, /never looked at/);
  assert.match(out, /also never looked at/);
  const openBlock = out.split("## Open findings")[1].split("## Never adjudicated")[0];
  assert.match(openBlock, /_None\._/, "both findings moved out, so Open findings is empty");
});

// A merely-open finding (the pass WAS adjudicated; this one just wasn't
// resolved) must keep reading exactly as before — the new section is scoped
// to `last.unadjudicated`, not to the verdict on any one finding.
test("no Never-adjudicated section when the pass was adjudicated, even with unreviewed findings left over from a carry", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "ceiling_reached",
    passes: [carriedPass({
      fromPass: 1,
      kind: "refuted",
      priorVerdict: "refute",
      matchedBy: "id",
      basis: "pinned by a.test.mjs:8",
    })],
  });
  assert.doesNotMatch(out, /## Never adjudicated/);
  assert.match(out, /a resource is not released/);
});

// The verification-pass flag: a fix landed after the run's last look, and
// nothing re-audited it. Rendered regardless of the verdict — see
// isConverged/isLive, which never read response.json, so the verdict above
// is already honest about whether the pre-fix finding still blocks.
test("fixedUnverified is reported in its own line, naming the ids", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "ceiling_reached",
    passes: [PASS],
    fixedUnverified: { ids: ["a1"], count: 1 },
  });
  assert.match(out, /1 fix\(es\) applied after the last pass, not re-audited/);
  assert.match(out, /`a1`/);
  assert.match(out, /verify/i);
});

test("no fixedUnverified line when nothing was fixed after the last pass", () => {
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "clean",
    passes: [PASS],
  });
  assert.doesNotMatch(out, /not re-audited/);
});

test("an earlier pass advanced unadjudicated is still reported after a later adjudicated pass", () => {
  const earlier = { ...unadjudicatedPass(), pass: 1 };
  const later = { ...unadjudicatedPass(), pass: 2, unadjudicated: false, findings: [] };
  const out = renderReconciliation({
    runId: "r1",
    date: "2026-08-05",
    verdict: "ceiling_reached",
    passes: [earlier, later],
  });
  assert.match(out, /## Never adjudicated/);
  assert.match(out, /Pass 1 advanced with no pass-1\/verdicts.json: 2 findings/);
  assert.match(out, /never looked at/);
});
