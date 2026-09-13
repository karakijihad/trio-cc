import { loadConfig, saveConfig, configErrors, consultSettings } from "../config.mjs";
import { validateLens } from "../capabilities.mjs";
import { modelLabel } from "../panel.mjs";
import { parseLensArgs } from "../cli-args.mjs";

// `trio lens <name> [on|off] [model <slug>] [effort <level>]`
export default function lensCommand({ root, rest, out, gatherState }) {
  const [name, ...pairs] = rest;
  const config = loadConfig(root);
  // A malformed block cannot hold a change: an array drops named keys on
  // save and a primitive never takes them, and either would report success.
  const bad = configErrors(config);
  if (bad.length) {
    out(`.trio/config.json is invalid:\n  ${bad.join("\n  ")}`);
    process.exitCode = 2;
    return;
  }
  // `consult` is addressed like a lens so /trio:model can set it the same
  // way, but it is not one: it never runs in an audit, so it has no on/off.
  const isConsult = name === "consult";
  const lens = isConsult
    ? config.codex.consult
    : config.codex.lenses.find((l) => l.name === name);
  if (!lens) {
    out(
      `unknown lens: ${name}. known: ${config.codex.lenses.map((l) => l.name).join(", ")}, consult`,
    );
    process.exitCode = 2;
    return;
  }
  const parsed = parseLensArgs(pairs);
  if (parsed.error) {
    out(parsed.error);
    process.exitCode = 2;
    return;
  }
  if (isConsult && "on" in parsed.changes) {
    out("consult has no on/off — it only sets model and effort.");
    process.exitCode = 2;
    return;
  }
  Object.assign(lens, parsed.changes);

  // What consult will actually run on, fallbacks resolved — the pair that
  // gets validated and the pair worth reporting.
  const effective = isConsult ? consultSettings(config) : lens;
  const line = isConsult
    ? `consult  ${modelLabel(effective.model)}  ${effective.effort}`
    : `${lens.name}  ${modelLabel(lens.model)}  ${lens.effort}  ${lens.on ? "on" : "off"}`;

  // No arguments is a query, not a change: report the lens and touch nothing.
  if (!Object.keys(parsed.changes).length) {
    out(line);
    return;
  }
  const { caps, pre } = gatherState();
  if (!caps) {
    out(`${pre.message}\n  ${pre.fix}`);
    process.exitCode = 1;
    return;
  }
  const check = validateLens(caps, effective);
  if (!check.ok) {
    out(check.error);
    process.exitCode = 2;
    return;
  }
  saveConfig(root, config);
  out(line);
}
