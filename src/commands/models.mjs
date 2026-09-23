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

const MODELS_FLAGS = new Set(["--json", "--apply"]);

// `trio models [--json] [--apply]`
export default function modelsCommand({ root, rest, out, gatherState }) {
  // --apply rewrites the config, so a mistyped extra argument is refused
  // rather than applied around.
  const strays = rest.filter((a) => !MODELS_FLAGS.has(a));
  if (strays.length) {
    out(
      `unknown argument${strays.length > 1 ? "s" : ""}: ${strays.join(", ")}\n  trio models [--json] [--apply]`,
    );
    process.exitCode = 2;
    return;
  }
  const asJson = rest.includes("--json");
  const say = (json, text) => out(asJson ? JSON.stringify(json, null, 2) : text);
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
    if (!proposals.length)
      return say(
        { applied: [] },
        "Nothing to change — every lens and consult is pinned to a current model.",
      );
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
      say({ applied: [], error: failed.error }, failed.error);
      process.exitCode = 2;
      return;
    }
    saveConfig(root, next);
    return say(
      { applied: proposals },
      `Applied:\n  ${proposals.map(proposalLine).join("\n  ")}`,
    );
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
