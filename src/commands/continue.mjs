import { continueRun } from "../driver.mjs";
import { runLens } from "../codex-lane.mjs";
import { CONTINUE_FLAGS, unknownFlags, valuelessFlags, flagValue } from "../cli-args.mjs";

// `trio continue [--claude-findings PATH]`
export default async function continueCommand({ root, rest, out, run, stopLensesOnSignal }) {
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
    run,
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
  // 3, not 1: the same distinction `run` draws for `run_in_progress` — a
  // worker actively executing a pass or finalizing is a lock waiting will
  // clear, unlike every other refusal above.
  if (r.status === "worker_busy") {
    const h = r.holder ?? {};
    out(
      `Another Trio process is already working this run: pid ${h.pid} (run ${h.run ?? "unnamed"}${Number.isSafeInteger(h.pass) ? `, pass ${h.pass}` : ""}).\n  Wait for it to finish, or /trio:cancel to end it. If no Trio process is running, the lock is stale: delete .trio/worker.lock.`,
    );
    process.exitCode = 3;
    return;
  }
  out(JSON.stringify(r, null, 2));
  if (r.status === "no_active_run") process.exitCode = 1;
}
