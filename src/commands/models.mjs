import { configErrors, saveConfig } from "../config.mjs";
import {
  modelsReport,
  modelProposals,
  applyProposals,
  validateLens,
} from "../capabilities.mjs";
import { renderModelsTable, modelLabel } from "../panel.mjs";

export const proposalLine = (p) =>
  `${p.name}  ${modelLabel(p.from)} → ${p.to} · ${p.effort}  (${p.why})`;

// `trio models [--json] [--apply]`
export default function modelsCommand({ root, rest, out, gatherState }) {
  const asJson = rest.includes("--json");
  const { config, caps } = gatherState();
  const bad = configErrors(config);
  if (bad.length) {
    out(`.trio/config.json is invalid:\n  ${bad.join("\n  ")}`);
    process.exitCode = 2;
    return;
  }
  const { models, lenses, consult } = modelsReport(caps, config);
  if (!models.length) {
    out("No Codex models known yet — run /trio:doctor to probe.");
    if (asJson) process.exitCode = 1;
    return;
  }
  const proposals = modelProposals(caps, config);
  if (rest.includes("--apply")) {
    if (!proposals.length) return out("Nothing to change — every lens and consult is pinned to a current model.");
    const next = applyProposals(config, proposals);
    // The catalogue check `trio lens` makes, on the slots being changed only:
    // an unrelated stale pin must not hold the fix hostage.
    const failed = proposals
      .map((p) =>
        p.name === "consult"
          ? next.codex.consult
          : next.codex.lenses.find((l) => l.name === p.name),
      )
      .map((s) => validateLens(caps, s))
      .find((c) => !c.ok);
    if (failed) {
      out(failed.error);
      process.exitCode = 2;
      return;
    }
    saveConfig(root, next);
    return out(`Applied:\n  ${proposals.map(proposalLine).join("\n  ")}`);
  }
  const suggest = proposals.length
    ? `\n\nProposed (apply with: trio models --apply):\n  ${proposals.map(proposalLine).join("\n  ")}`
    : "";
  out(
    asJson
      ? JSON.stringify({ models, lenses, consult, proposals }, null, 2)
      : `${renderModelsTable({ models, lenses })}\n\nconsult runs on ${modelLabel(consult.model)} · ${consult.effort}${suggest}`,
  );
}
