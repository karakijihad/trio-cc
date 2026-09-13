import { continueRun } from "../driver.mjs";
import { runLens } from "../codex-lane.mjs";
import { CONTINUE_FLAGS, unknownFlags, valuelessFlags, flagValue } from "../cli-args.mjs";

// `trio continue [--claude-findings PATH]`
export default async function continueCommand({ root, rest, out, stopLensesOnSignal }) {
  const strays = unknownFlags(rest, CONTINUE_FLAGS);
  if (strays.length) {
    out(`unknown flag${strays.length > 1 ? "s" : ""}: ${strays.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const bareContinue = valuelessFlags(rest, CONTINUE_FLAGS);
  if (bareContinue.length) {
    out(`${bareContinue.join(", ")} needs a value`);
    process.exitCode = 2;
    return;
  }
  stopLensesOnSignal();
  const r = await continueRun({
    root,
    runLensFn: runLens,
    claudeFindingsPath: flagValue(rest, "--claude-findings"),
  });
  if (r.status === "invalid_findings") {
    out(`--claude-findings: ${r.error}`);
    process.exitCode = 2;
    return;
  }
  if (r.status === "claude_lane_missing") {
    out(r.error);
    process.exitCode = 2;
    return;
  }
  if (r.status === "invalid_marker") {
    out(r.error);
    process.exitCode = 1;
    return;
  }
  out(JSON.stringify(r, null, 2));
  if (r.status === "no_active_run") process.exitCode = 1;
}
