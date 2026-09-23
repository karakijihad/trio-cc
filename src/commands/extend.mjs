import {
  continueRun,
  reopenRun,
  readClaudeFindings,
  extendAdjudicationGate,
  readRunTarget,
} from "../driver.mjs";
import { runLens } from "../codex-lane.mjs";
import {
  EXTEND_FLAGS,
  UNADJUDICATED_FLAG,
  unknownFlags,
  valuelessFlags,
  flagValue,
} from "../cli-args.mjs";

// `trio extend [runId] [--claude-findings PATH] [--unadjudicated]` — the
// "yes" half of the offer a ceiling-reached run makes: one more pass on the
// same run, rather than a fresh run that would re-find everything from
// scratch and compare against nothing.
export default async function extendCommand({ root, rest, out, run, latestFinishedRun, stopLensesOnSignal, codexRefusal }) {
  const unadjudicated = rest.includes(UNADJUDICATED_FLAG);
  // Stripped before the general flag checks: those assume every flag they
  // know takes a value, and --unadjudicated deliberately does not. The
  // positional scan below still uses the untouched `rest` — a token starting
  // with "-" that EXTEND_FLAGS does not know is already skipped there, so
  // --unadjudicated never gets mistaken for a run id.
  const checked = rest.filter((a) => a !== UNADJUDICATED_FLAG);
  const strays = unknownFlags(checked, EXTEND_FLAGS);
  if (strays.length) {
    out(`unknown flag${strays.length > 1 ? "s" : ""}: ${strays.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  // `--claude-findings` with nothing after it reads as "no lane given",
  // which is the one answer that quietly halves the audit.
  const bareExtend = valuelessFlags(checked, EXTEND_FLAGS);
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
  const claudeChecked = readClaudeFindings(extendFindings);
  if (!claudeChecked.ok) {
    out(`--claude-findings: ${claudeChecked.error}`);
    process.exitCode = 2;
    return;
  }

  // D-adjudication-gate, on the exact pass reopenRun is about to reopen —
  // before anything is claimed, reopened, or spent.
  const gate = extendAdjudicationGate({ root, runId, unadjudicated });
  if (gate) {
    out(gate.error);
    process.exitCode = 2;
    return;
  }

  // D-codex-preflight, for the same reason `run` has it and before the same
  // kind of side effect: reopenRun deletes the ceiling verdict, raises the
  // ceiling and claims the lock, and a refusal that arrived after that would
  // leave the run torn open for an account that cannot use the extra pass.
  const refused = codexRefusal(readRunTarget(root, runId));
  if (refused) {
    out(
      JSON.stringify(
        { status: "refused", reason: "codex_unavailable", codexUnavailable: refused },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const opened = reopenRun({
    root,
    runId,
    hasClaudeFindings: Boolean(claudeChecked.findings),
    run,
  });
  if (!opened.ok) {
    out(opened.error);
    // 3 for both flavors of "another Trio process owns this project right
    // now" — inProgress (the marker) and worker_busy (the lock a live pass
    // or finalize holds) — the one distinction that means waiting helps.
    process.exitCode = opened.inProgress || opened.status === "worker_busy" ? 3 : 1;
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
    run,
    codexRefusal,
  });
  if (r.status === "invalid_findings" || r.status === "claude_lane_missing") {
    out(r.error);
    process.exitCode = 2;
    return;
  }
  // The account went out between the preflight above and this pass actually
  // spawning — rare, but the same shape `run` and `continue` return either
  // way.
  if (r.status === "refused") {
    out(JSON.stringify(r, null, 2));
    process.exitCode = 1;
    return;
  }
  // reopenRun just took (and released) the worker lock, so this call should
  // find it free — but if some other process's start or continue slipped in
  // during the gap, report it the same way `run` and `continue` do.
  if (r.status === "worker_busy") {
    const h = r.holder ?? {};
    out(
      `Another Trio process is already working this run: pid ${h.pid} (run ${h.run ?? "unnamed"}${Number.isSafeInteger(h.pass) ? `, pass ${h.pass}` : ""}).\n  Wait for it to finish, or /trio:cancel to end it. If no Trio process is running, the lock is stale: delete .trio/worker.lock.`,
    );
    process.exitCode = 3;
    return;
  }
  out(JSON.stringify(r, null, 2));
}
