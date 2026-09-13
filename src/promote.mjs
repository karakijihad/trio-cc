import { readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderDisagreementTable } from "./reconcile.mjs";
import { isLive } from "./findings.mjs";

const SEV_ORDER = ["critical", "major", "minor", "info"];
const dateOf = (now) => now.toISOString().slice(0, 10);

// A finding belongs in "## Open findings" unless something else already
// accounts for it: `refute` says it is not a defect, `duplicate` says it is
// counted under its survivor, and `outOfScope` says it is real but reported
// in its own section instead ("## Outside this change" below).
const isOpenFinding = (f) =>
  f.verdict !== "refute" && f.verdict !== "duplicate" && !f.outOfScope;

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

export function renderReconciliation({
  runId,
  passes,
  date,
  verdict,
  fixedUnverified = null,
}) {
  const last = passes.at(-1);
  const outcome =
    verdict === "clean"
      ? "Converged: no unresolved finding at a blocking severity in the final pass."
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
    // Written after the fix, on the final pass — the pass whose result is
    // this verdict, so there is no next pass to re-audit them. A blocking
    // finding marked fixed here still shows as open below and still holds
    // the run's verdict open (isConverged never reads response.json); this
    // is only the honest flag that a change landed nobody has re-checked.
    ...(fixedUnverified?.count
      ? [
          "",
          `${fixedUnverified.count} fix(es) applied after the last pass, not re-audited: ` +
            fixedUnverified.ids.map((id) => `\`${id}\``).join(", ") +
            ". Run another pass to verify them.",
        ]
      : []),
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
    // A duplicate is not a disposition of the defect the way refute is — it
    // is one lens's finding folded into another's (reconcile.mjs's
    // applyVerdicts already merged its lens name onto the survivor). Listing
    // it here too would show the one defect the survivor's row already
    // covers a second time, which is exactly the double-count `duplicate`
    // exists to stop. It is named instead in "## Duplicates" below.
    //
    // `outOfScope` is excluded the same way, for the same reason: it is
    // real and it stayed confirmed/escalated at its reported severity, but it
    // is not this run's business to fix, and it never blocked convergence
    // (isConverged, findings.mjs). Naming it here too would read as a second
    // open defect. It is named once, in "## Outside this change" below —
    // never silently, the one thing `downgrade` used to do when misused for
    // this.
    last.findings.filter(isOpenFinding).length
      ? last.findings
          .filter(isOpenFinding)
          .map((f) => {
            const head = `- **${f.severity}** \`${f.file}\` — ${f.title} (\`${f.id}\`)`;
            // An indented continuation line, not a table cell — bounds is
            // prose, and this is the one place a reader learns how far the fix
            // goes. Flattened first: the agent writing it is a language model
            // and a stray newline would break out of the list item, so the
            // shape of the document cannot rest on it following instructions.
            const bounds = String(f.bounds ?? "").replace(/\s+/g, " ").trim();
            // A carried finding is listed here like any other, but without
            // this line nothing says why it did not block the run. isLive
            // exempts a re-raise of something an earlier pass refuted, and an
            // exemption nobody can see in the report is the same unaudited
            // claim the `unreviewed` default exists to prevent.
            //
            // Asked of isLive rather than restated, because a copy of the
            // rule here would drift from the one convergence actually uses,
            // and this is the document where a drift becomes a false claim
            // about the run. Everything with a `refute` verdict is already
            // filtered out above, so within this map `!isLive` means exactly
            // "excused by an earlier pass's refutation".
            const c = f.carried;
            const flat = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
            const excused = Boolean(c) && !isLive(f);
            const carried = c
              ? `\n  carried: ${flat(c.kind)} in pass ${flat(c.fromPass)} ` +
                `(${flat(c.priorVerdict)}), matched by ${flat(c.matchedBy)}` +
                `${excused ? " — did not block convergence" : ""}` +
                `${c.basis ? `; ${flat(c.basis)}` : ""}`
              : "";
            return `${head}${bounds ? `\n  bounds: ${bounds}` : ""}${carried}`;
          })
          .join("\n")
      : "_None._",
    "",
    ...(last.findings.some((f) => f.verdict === "duplicate")
      ? [
          "## Duplicates",
          "",
          "Reported by more than one lens as the same defect. Folded into the",
          "survivor named below, which carries every lens that raised it — these",
          "never counted as open findings and never blocked convergence.",
          "",
          last.findings
            .filter((f) => f.verdict === "duplicate")
            .map(
              (f) =>
                `- \`${f.id}\` \`${f.file}\` — ${f.title} — duplicate of \`${f.of ?? "?"}\``,
            )
            .join("\n"),
          "",
        ]
      : []),
    ...(last.findings.some((f) => f.outOfScope)
      ? [
          "## Outside this change",
          "",
          "Confirmed real, at the severity shown — the reconciler ruled these",
          "outside the change under audit rather than wrong or overstated. They",
          "did not block convergence and are not counted in \"Open findings\"",
          "above.",
          "",
          last.findings
            .filter((f) => f.outOfScope)
            .map((f) => {
              const basis = String(f.basis ?? "").replace(/\s+/g, " ").trim();
              return (
                `- **${f.severity}** \`${f.file}\` — ${f.title} (\`${f.id}\`)` +
                (basis ? `\n  ${basis}` : "")
              );
            })
            .join("\n"),
          "",
        ]
      : []),
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
  fixedUnverified = null,
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
    renderReconciliation({ runId, passes, date, verdict, fixedUnverified }),
  );
  return { codexPath, claudePath };
}
