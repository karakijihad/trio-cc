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
