import { continueRun, adjudicationGate } from "../driver.mjs";
import { runLens } from "../codex-lane.mjs";
import { readMarker } from "../marker.mjs";
import {
  CONTINUE_FLAGS,
  UNADJUDICATED_FLAG,
  unknownFlags,
  valuelessFlags,
  flagValue,
} from "../cli-args.mjs";

// `trio continue [--claude-findings PATH] [--unadjudicated]`
export default async function continueCommand({ root, rest, out, run, codexRefusal, stopLensesOnSignal }) {
  const unadjudicated = rest.includes(UNADJUDICATED_FLAG);
  // Stripped before the general flag checks: those assume every flag they
  // know takes a value, and --unadjudicated deliberately does not.
  const checked = rest.filter((a) => a !== UNADJUDICATED_FLAG);
  const strays = unknownFlags(checked, CONTINUE_FLAGS);
  if (strays.length) {
    out(`unknown flag${strays.length > 1 ? "s" : ""}: ${strays.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const bareContinue = valuelessFlags(checked, CONTINUE_FLAGS);
  if (bareContinue.length) {
    out(`${bareContinue.join(", ")} needs a value`);
    process.exitCode = 2;
    return;
  }

  // D-adjudication-gate: refuse before either lock is claimed, when the
  // marker's own pass has live findings and no verdicts.json. Checked against
  // the marker as it stands right now — continueRun re-reads it under the
  // worker lock and refuses its own way (run_advanced) if it has moved on by
  // the time that lock is granted, so a stale read here only ever costs a
  // retry, never a wrong mutation.
  const marker = readMarker(root);
  const gate = adjudicationGate({
    root,
    runId: marker?.run,
    pass: marker?.pass,
    unadjudicated,
  });
  if (gate) {
    out(gate.error);
    process.exitCode = 2;
    return;
  }

  stopLensesOnSignal();
  const r = await continueRun({
    root,
    runLensFn: runLens,
    claudeFindingsPath: flagValue(rest, "--claude-findings"),
    run,
    codexRefusal,
  });
  if (r.status === "refused") {
    out(JSON.stringify(r, null, 2));
    process.exitCode = 1;
    return;
  }
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
