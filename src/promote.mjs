import { readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderDisagreementTable } from "./reconcile.mjs";

const SEV_ORDER = ["critical", "major", "minor", "info"];
const dateOf = (now) => now.toISOString().slice(0, 10);

export function nextAuditNumber(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 1;
  }
  const used = entries
    .map((f) => f.match(/^audit-(\d+)\.md$/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return used.length ? Math.max(...used) + 1 : 1;
}

const bySeverity = (findings) =>
  SEV_ORDER.map((sev) => [
    sev,
    findings.filter((f) => f.severity === sev),
  ]).filter(([, list]) => list.length);

// What each lane saw that the other did not. `lens` carries every lane that
// raised a finding, joined — so "claude" alone means Codex's five lenses all
// missed it, and that column is the reason the second lane exists at all.
// Corroboration is the cheap half; the disagreement is the interesting half.
export function renderLaneSplit(record) {
  const lanes = (f) => String(f.lens ?? "").split(", ").filter(Boolean);
  // Partitioned on whether "claude" is among the lanes, not on how many lanes
  // there are. Counting them dropped every finding two Codex lenses agreed on:
  // too many lanes to be "codex only", no claude to be "both", so it fell out
  // of all three columns — the corroborated findings, silently missing from
  // the section about corroboration.
  const hasClaude = (f) => lanes(f).includes("claude");
  const both = record.findings.filter((f) => hasClaude(f) && lanes(f).length > 1);
  const only = (who) =>
    record.findings.filter((f) =>
      who === "claude"
        ? hasClaude(f) && lanes(f).length === 1
        : !hasClaude(f) && lanes(f).length > 0,
    );
  const line = (f) =>
    `- [${f.severity}] \`${f.file}${f.line ? `:${f.line}` : ""}\` — ${f.title}`;
  const block = (title, list, empty) =>
    `**${title}** (${list.length})\n\n${list.length ? list.map(line).join("\n") : `_${empty}_`}`;

  return [
    `Claude audited the same scope independently, writing its findings before reading Codex's.`,
    "",
    block("Both lanes", both, "Nothing was found by both — the lanes agreed on nothing, which is itself worth reading twice."),
    "",
    block("Codex only", only("codex"), "Nothing Codex found was missed by Claude."),
    "",
    block("Claude only", only("claude"), "Claude found nothing Codex missed."),
  ].join("\n");
}

export function renderCodexAudit({ runId, passes, date }) {
  const last = passes.at(-1);
  const counts =
    bySeverity(last.findings)
      .map(([sev, list]) => `${list.length} ${sev}`)
      .join(", ") || "no findings";
  const lensLine = last.lenses.map((l) => `${l.lens} (${l.status})`).join(", ");

  const sections = bySeverity(last.findings).map(([sev, list]) => {
    const items = list.map((f) =>
      [
        `#### ${f.title}`,
        "",
        `**Where** \`${f.file}${f.line ? `:${f.line}` : ""}\` · **Lens** ${f.lens ?? "—"} · **Id** \`${f.id}\``,
        "",
        `**Evidence** ${f.evidence || "—"}`,
        "",
        `**Impact** ${f.impact || "—"}`,
        "",
        `**Correction** ${f.correction || "—"}`,
      ].join("\n"),
    );
    return `### ${sev[0].toUpperCase()}${sev.slice(1)}\n\n${items.join("\n\n")}`;
  });

  return [
    `# Codex Audit — ${date}`,
    "",
    "## Scope",
    "",
    `Run \`${runId}\`, ${passes.length} pass(es). Lenses: ${lensLine}. Codex ran read-only; it changed nothing.`,
    "",
    "## Executive Summary",
    "",
    `Findings: ${counts}.`,
    "",
    "## Findings",
    "",
    sections.join("\n\n") || "_No findings._",
    "",
    "## Verification Notes",
    "",
    last.degraded.length
      ? `Lenses that did not complete cleanly: ${last.degraded.join(", ")}. Coverage is partial.`
      : "All enabled lenses completed and returned a parseable findings block.",
    "",
    ...(last.claude ? ["## Two Lanes", "", renderLaneSplit(last), ""] : []),
    "## Overall Assessment",
    "",
    `${last.findings.length} finding(s) across ${last.lenses.length} lens(es).`,
    "",
  ].join("\n");
}

export function renderReconciliation({ runId, passes, date, verdict }) {
  const last = passes.at(-1);
  const outcome =
    verdict === "clean"
      ? "Converged: no unresolved critical or major findings, and no new findings in the final pass."
      : verdict === "ceiling_reached"
        ? `Stopped at the iteration ceiling after ${passes.length} pass(es). Findings below remain open.`
        : `Run ended as \`${verdict}\`.`;

  const trail = passes.map(
    (p) =>
      `| ${p.pass} | ${p.findings.length} | ${p.diff.new.length} | ${p.diff.closed.length} | ${p.degraded.length ? p.degraded.join(", ") : "—"} |`,
  );

  return [
    `# Claude Reconciliation — ${date}`,
    "",
    "## Scope",
    "",
    `Adjudication of Codex findings for run \`${runId}\`.`,
    "",
    "## Outcome",
    "",
    outcome,
    "",
    "## Pass trail",
    "",
    "| Pass | Findings | New | Closed | Degraded lenses |",
    "| --- | --- | --- | --- | --- |",
    ...trail,
    "",
    "## Where we disagreed",
    "",
    renderDisagreementTable(last.findings),
    "",
    "## Open findings",
    "",
    last.findings.filter((f) => f.verdict !== "refute").length
      ? last.findings
          .filter((f) => f.verdict !== "refute")
          .map(
            (f) =>
              `- **${f.severity}** \`${f.file}\` — ${f.title} (\`${f.id}\`)`,
          )
          .join("\n")
      : "_None._",
    "",
  ].join("\n");
}

// Where promotion would write, and whether that place exists yet. The run
// result carries this so Claude can offer to create it instead of the
// operator finding out later that nothing was promoted.
export function promoteTarget(root, config) {
  const path = config.artifacts.promoteTo;
  return { path, absolute: join(root, path), exists: existsSync(join(root, path)) };
}

export function promote({
  root,
  config,
  runId,
  passes,
  verdict,
  now = new Date(),
}) {
  const base = join(root, config.artifacts.promoteTo);
  if (!existsSync(base)) return null;

  const date = dateOf(now);
  const codexDir = join(base, "codex", date);
  const claudeDir = join(base, "claude", date);
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  const n = Math.max(nextAuditNumber(codexDir), nextAuditNumber(claudeDir));
  const codexPath = join(codexDir, `audit-${n}.md`);
  const claudePath = join(claudeDir, `audit-${n}.md`);

  writeFileSync(codexPath, renderCodexAudit({ runId, passes, date }));
  writeFileSync(
    claudePath,
    renderReconciliation({ runId, passes, date, verdict }),
  );
  return { codexPath, claudePath };
}
