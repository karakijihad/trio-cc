import { configErrors } from "../config.mjs";
import { modelsReport } from "../capabilities.mjs";
import { renderModelsTable, modelLabel } from "../panel.mjs";

// `trio models [--json]`
export default function modelsCommand({ rest, out, gatherState }) {
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
  out(
    asJson
      ? JSON.stringify({ models, lenses, consult }, null, 2)
      : `${renderModelsTable({ models, lenses })}\n\nconsult runs on ${modelLabel(consult.model)} · ${consult.effort}`,
  );
}
