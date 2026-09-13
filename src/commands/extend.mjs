import { continueRun, reopenRun, readClaudeFindings } from "../driver.mjs";
import { runLens } from "../codex-lane.mjs";
import { EXTEND_FLAGS, unknownFlags, valuelessFlags, flagValue } from "../cli-args.mjs";

// `trio extend [runId]` — the "yes" half of the offer a ceiling-reached run
// makes: one more pass on the same run, rather than a fresh run that would
// re-find everything from scratch and compare against nothing.
export default async function extendCommand({ root, rest, out, latestFinishedRun, stopLensesOnSignal }) {
  const strays = unknownFlags(rest, EXTEND_FLAGS);
  if (strays.length) {
    out(`unknown flag${strays.length > 1 ? "s" : ""}: ${strays.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  // `--claude-findings` with nothing after it reads as "no lane given",
  // which is the one answer that quietly halves the audit.
  const bareExtend = valuelessFlags(rest, EXTEND_FLAGS);
  if (bareExtend.length) {
    out(`${bareExtend.join(", ")} needs a value`);
    process.exitCode = 2;
    return;
  }
  // Every flag extend knows takes a value, so a bare scan for the first
  // non-flag token picks up `--claude-findings`'s path and calls it a run
  // id. Step over a known flag's value the way unknownFlags does.
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (EXTEND_FLAGS.has(rest[i])) i++;
    else if (!rest[i].startsWith("-")) positional.push(rest[i]);
  }
  const runId = positional[0] ?? latestFinishedRun();
  if (!runId) {
    out("No finished run to extend.");
    process.exitCode = 1;
    return;
  }
  // Before reopenRun, not after. reopenRun deletes the verdict, raises the
  // ceiling and claims the lock; a handover file rejected afterwards would
  // leave the run torn open with the claim held and nothing to release it.
  // Validate the cheap thing first and mutate nothing until it passes.
  const extendFindings = flagValue(rest, "--claude-findings");
  const checked = readClaudeFindings(extendFindings);
  if (!checked.ok) {
    out(`--claude-findings: ${checked.error}`);
    process.exitCode = 2;
    return;
  }

  const opened = reopenRun({
    root,
    runId,
    hasClaudeFindings: Boolean(checked.findings),
  });
  if (!opened.ok) {
    out(opened.error);
    process.exitCode = opened.inProgress ? 3 : 1;
    return;
  }
  process.stderr.write(
    `Extended ${opened.runId} to ${opened.maxIterations} passes.\n`,
  );
  stopLensesOnSignal();
  // The extra pass is a pass like any other, so it gets both lanes. Without
  // this the pass the operator paid extra for would quietly be Codex-only,
  // and continueRun would refuse it outright once the run has a Claude lane.
  const r = await continueRun({
    root,
    runLensFn: runLens,
    claudeFindingsPath: extendFindings,
  });
  if (r.status === "invalid_findings" || r.status === "claude_lane_missing") {
    out(r.error);
    process.exitCode = 2;
    return;
  }
  out(JSON.stringify(r, null, 2));
}
