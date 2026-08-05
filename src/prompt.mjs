import { readFileSync } from "node:fs";
import { join } from "node:path";
import { passDir } from "./paths.mjs";
import { renderSettledSection } from "./settled.mjs";
import { scrub } from "./scrub.mjs";

// Claude's reply to a pass's reconciled findings (D17), written by the
// trio-audit skill before the next pass starts. Absence is never an error —
// missing file, unreadable file, or invalid JSON all read as "no reply".
export function readPassResponse(root, runId, pass) {
  try {
    const raw = readFileSync(
      join(passDir(root, runId, pass), "response.json"),
      "utf8",
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// The Claude-lane file_change events stamped with the given pass — Claude's
// fix wave between that pass and the next (D14).
export function claudeChanges(events, pass) {
  return events
    .filter(
      (e) =>
        e.actor === "claude" && e.kind === "file_change" && e.pass === pass,
    )
    .map((e) => ({ file: e.payload.file, diff: e.payload.diff }));
}

function renderFindingsSection(findings, prevPass) {
  const header = `## Your findings from pass ${prevPass}`;
  if (!findings.length) {
    return `${header}\n\nThis lens reported no findings last pass.`;
  }
  const lines = findings.map((f) => {
    const head = `- [${f.severity}] ${f.file}:${f.line} — ${f.title} (id ${f.id})`;
    return f.correction ? `${head}\n  correction: ${f.correction}` : head;
  });
  return `${header}\n\n${lines.join("\n")}`;
}

function renderChangesSection(changes) {
  const header = "## What Claude changed since";
  if (!changes.length) {
    return `${header}\n\nNo file changes were recorded since your last pass.`;
  }
  const blocks = changes.map(
    (c) => `${c.file}\n\`\`\`diff\n${c.diff}\n\`\`\``,
  );
  return `${header}\n\n${blocks.join("\n\n")}`;
}

function renderReplySection(response, findings) {
  const header = "## Claude's reply";
  if (response == null) {
    return `${header}\n\nClaude left no structured reply. Re-examine the code alone.`;
  }
  const knownIds = new Set(findings.map((f) => f.id));
  // response.json is a handover file written outside Trio, and readPassResponse
  // only guards against it failing to parse — not against it parsing to the
  // wrong shape. `{"findings":"x"}` has no .map and `{"findings":[null]}` has
  // no .reason, and either throw escapes buildLensPrompt through briefFor and
  // pool() to reject runPass, which continueRun catches and finalizes as a
  // failed run. A malformed reply must cost its own section, not the run.
  const raw = response.findings;
  const listed = Array.isArray(raw) ? raw : [];
  const entries = listed
    .filter((f) => f && typeof f === "object")
    .map((f) => {
      // Scrubbed for the same reason settled.mjs scrubs its entries: this text
      // comes from response.json, which nothing else scrubs, and it goes into
      // a brief written straight to Codex's stdin. Scrubbing only the ledger
      // closed the wider path and left the original one open.
      const reason = scrub(f.reason ?? f.note ?? "");
      const suffix = knownIds.has(f.id)
        ? ""
        : " (id not among your previous findings)";
      return `- ${f.id}: ${f.action} — ${reason}${suffix}`;
    });
  // "Claude replied about nothing" and "Claude's reply could not be read" are
  // different claims, and the guard above made them render identically —
  // dropping every malformed entry and then reporting no findings. That is the
  // same conflation `unreviewed` exists to stop: silence is not an answer. Say
  // which it was, and say it even when some entries did survive, or a partly
  // unreadable handover looks complete.
  const dropped = listed.length - entries.length;
  const note =
    raw != null && !Array.isArray(raw)
      ? "Claude's reply had a findings field that is not a list — none of it could be read."
      : dropped
        ? `${dropped} entr${dropped === 1 ? "y" : "ies"} in Claude's reply could not be read.`
        : "";
  const body = entries.length
    ? note
      ? `${entries.join("\n")}\n\n${note}`
      : entries.join("\n")
    : note || "Claude's reply listed no findings.";
  const summary = response.summary ? `\n\n${response.summary}` : "";
  return `${header}\n\n${body}${summary}`;
}

// The findings block has no field for "resolved" — a finding is resolved by
// being left out, and diffPasses reads the omission. Asking in prose for a
// distinction the output shape cannot carry is how a lens ends up writing
// commentary the extractor discards, or a second json block it rejects.
function renderInstructionSection() {
  return (
    "## Instructions\n\n" +
    "Re-examine the code. Report the findings that still stand, plus " +
    "anything new the changes introduced. Omit a finding the changes " +
    "resolved — omission is how you report it resolved; do not add a field " +
    "for it. End your final message with the same fenced ```json findings " +
    "block as before."
  );
}

// Operator-supplied, and only ever narrows attention — Codex is started with
// --cd on the target either way, so this cannot widen what a read-only lens
// can reach. Without it a lens re-reads the whole repository every pass and
// spends most of a run on code nobody touched.
function renderScopeSection(scope) {
  return (
    "## Scope\n\n" +
    `Concentrate on: ${scope}\n\n` +
    "Read whatever else you need to judge these correctly — callers, tests, " +
    "config. Report defects outside this scope only when they are why " +
    "something in it is wrong."
  );
}

// Composes a lens's pass-N prompt. pass 1 (or no prior pass) is the brief
// plus any scope; pass 2+ also turns Codex's own pass-N-1 findings, Claude's
// file changes since, and Claude's response.json into a conversation turn
// (D14). Scope rides every pass — a lens that narrowed on pass 1 and widened
// on pass 2 would report the whole repository as newly found.
// `settled` is the run-level decline ledger (src/settled.mjs) — every pass's
// refutations and declines, not just the previous one's. It goes last before
// the instructions, closest to the ask, because it is the section that has to
// survive a lens rewording an old claim into a new title.
export function buildLensPrompt({
  brief,
  lens: _lens,
  pass,
  prior,
  scope,
  settled,
}) {
  const scoped = scope ? `${brief}\n\n${renderScopeSection(scope)}` : brief;
  if (pass <= 1 || prior == null) return scoped;

  const { findings = [], changes = [], response = null } = prior;
  const settledSection = renderSettledSection(settled);
  const sections = [
    scoped,
    renderFindingsSection(findings, pass - 1),
    renderChangesSection(changes),
    renderReplySection(response, findings),
    ...(settledSection ? [settledSection] : []),
    renderInstructionSection(),
  ];
  return sections.join("\n\n");
}
