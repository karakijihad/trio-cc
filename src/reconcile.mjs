import { SEVERITIES } from "./findings.mjs";

export const VERDICTS = ["confirm", "refute", "downgrade", "escalate"];

// The absence of a verdict is not agreement. Every finding used to default to
// "confirm", so a pass nobody had adjudicated reported sixteen confirmed
// findings and an empty disagreement table — which reads as "the two agree"
// when it means "nobody has looked yet".
export const UNREVIEWED = "unreviewed";

// Only these are disagreements. "confirm" is agreement and "unreviewed" is
// silence; neither belongs in a table of where the two models differ.
const DISAGREEMENTS = ["refute", "downgrade", "escalate"];

const shift = (severity, by) => {
  const i = SEVERITIES.indexOf(severity);
  if (i === -1) return severity;
  return SEVERITIES[Math.min(SEVERITIES.length - 1, Math.max(0, i + by))];
};

// `bounds` is where a confirmed defect stops: the other call sites the pattern
// reaches, and the ones it demonstrably does not. It is separate from `basis`
// because the two have different readers — `basis` answers "why this verdict"
// and only reaches the report when the verdict was a disagreement, while
// `bounds` answers "how wide is the fix" and belongs in the permanent record
// of every finding that stayed open. A confirmed defect whose blast radius
// nobody wrote down gets over-fixed.
export function applyVerdicts(findings, verdicts) {
  const byId = new Map();
  for (const v of verdicts ?? []) {
    if (!VERDICTS.includes(v.verdict))
      throw new Error(
        `unknown verdict: ${v.verdict}. valid: ${VERDICTS.join(", ")}`,
      );
    byId.set(v.id, v);
  }
  return findings.map((f) => {
    const v = byId.get(f.id);
    if (!v) return { ...f, verdict: UNREVIEWED, basis: "", bounds: "" };
    const severity =
      v.verdict === "downgrade"
        ? shift(f.severity, 1)
        : v.verdict === "escalate"
          ? shift(f.severity, -1)
          : f.severity;
    return {
      ...f,
      verdict: v.verdict,
      basis: v.basis ?? "",
      bounds: v.bounds ?? "",
      severity,
    };
  });
}

const LABEL = {
  refute: "REFUTED",
  downgrade: "DOWNGRADED",
  escalate: "ESCALATED",
};

export function renderDisagreementTable(findings) {
  const rows = findings.filter((f) => DISAGREEMENTS.includes(f.verdict));
  if (!rows.length) {
    // "No disagreements" and "nobody has looked" are different reports, and
    // this line claimed the first while meaning the second.
    const pending = findings.filter((f) => f.verdict === UNREVIEWED).length;
    return pending
      ? `_No disagreements recorded — ${pending} finding(s) not yet adjudicated._\n`
      : "_No disagreements — every finding was confirmed as reported._\n";
  }
  const lines = [
    "| Finding | Lens | Verdict | Basis |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (f) =>
        `| ${f.title} (${f.file}) | ${f.lens ?? "—"} | **${LABEL[f.verdict]}** | ${f.basis || "—"} |`,
    ),
  ];
  return lines.join("\n") + "\n";
}
