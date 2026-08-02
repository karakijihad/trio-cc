import { readFileSync } from "node:fs";
import { join } from "node:path";
import { passDir } from "./paths.mjs";

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
  const entries = (response.findings ?? []).map((f) => {
    const reason = f.reason ?? f.note ?? "";
    const suffix = knownIds.has(f.id)
      ? ""
      : " (id not among your previous findings)";
    return `- ${f.id}: ${f.action} — ${reason}${suffix}`;
  });
  const body = entries.length
    ? entries.join("\n")
    : "Claude's reply listed no findings.";
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
export function buildLensPrompt({ brief, lens: _lens, pass, prior, scope }) {
  const scoped = scope ? `${brief}\n\n${renderScopeSection(scope)}` : brief;
  if (pass <= 1 || prior == null) return scoped;

  const { findings = [], changes = [], response = null } = prior;
  const sections = [
    scoped,
    renderFindingsSection(findings, pass - 1),
    renderChangesSection(changes),
    renderReplySection(response, findings),
    renderInstructionSection(),
  ];
  return sections.join("\n\n");
}
