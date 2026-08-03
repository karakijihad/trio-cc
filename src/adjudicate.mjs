import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffPasses, isConverged } from "./findings.mjs";
import { applyVerdicts, VERDICTS } from "./reconcile.mjs";
import { makeEvent, appendEvent } from "./bus.mjs";
import { runDir, passDir } from "./paths.mjs";
import { scrubDeep } from "./scrub.mjs";

// Claude's half of the loop, lifted out of the run lifecycle: reading a
// pass's verdicts, applying them, and deciding whether the pass converged.
// The driver's job is to sequence passes; this decides what a pass means.

export function readReconcile(root, runId, pass) {
  return JSON.parse(
    readFileSync(join(passDir(root, runId, pass), "reconcile.json"), "utf8"),
  );
}

// Collects every completed pass's record, in order, for finalization and
// promotion. Passes are always written contiguously from 1 by runPass.
export function collectPasses(root, runId) {
  const passes = [];
  for (
    let n = 1;
    existsSync(join(passDir(root, runId, n), "reconcile.json"));
    n++
  ) {
    passes.push(readReconcile(root, runId, n));
  }
  return passes;
}

export function readVerdictsFile(root, runId, pass) {
  try {
    const parsed = JSON.parse(
      readFileSync(join(passDir(root, runId, pass), "verdicts.json"), "utf8"),
    );
    return Array.isArray(parsed?.verdicts) ? parsed : null;
  } catch {
    return null;
  }
}

// Applies Claude's adjudication (pass-<N>/verdicts.json, D18) to a stored
// pass record, if present and parseable. An invalid verdict value must not
// crash the run — it is logged and the pass proceeds unadjudicated.
export function applyAdjudication({ root, config, runId, pass, record }) {
  const parsed = readVerdictsFile(root, runId, pass);
  if (!parsed) {
    const converged =
      record.degraded.length === 0 &&
      isConverged(record.findings, record.diff, config.converge);
    return { record, converged };
  }

  let findings = record.findings;
  const rejected = [];
  try {
    findings = applyVerdicts(record.findings, parsed.verdicts, {
      onInvalid: (bad) => rejected.push(...bad),
    });
  } catch (err) {
    // An unrecognized verdict no longer throws — it rejects its own entry. So
    // reaching here means the file was malformed in a way readVerdictsFile
    // could not see, and the pass still proceeds unadjudicated rather than
    // taking the run down.
    appendEvent(
      runDir(root, runId),
      makeEvent({
        run: runId,
        pass,
        lane: "trio",
        actor: "trio",
        kind: "error",
        payload: { error: `verdicts could not be applied: ${err.message}` },
      }),
    );
  }

  // One event for the whole file, not one per bad entry and not just the
  // first: the operator needs to know how much adjudication survived, which
  // findings lost theirs, and what was written that Trio would not take.
  if (rejected.length) {
    const total = parsed.verdicts.length;
    const named = rejected
      .map((r) => `${r.id ?? "(no id)"}=${r.verdict ?? "(none)"}`)
      .join(", ");
    appendEvent(
      runDir(root, runId),
      makeEvent({
        run: runId,
        pass,
        lane: "trio",
        actor: "trio",
        kind: "error",
        payload: {
          error: `rejected ${rejected.length} of ${total} verdicts — those findings stay unreviewed: ${named}. valid: ${VERDICTS.join(", ")}`,
          rejected,
          applied: total - rejected.length,
        },
      }),
    );
  }

  const prevFindings =
    pass > 1 ? readReconcile(root, runId, pass - 1).findings : [];
  const diff = diffPasses(prevFindings, findings);
  const updated = scrubDeep({ ...record, findings, diff });
  writeFileSync(
    join(passDir(root, runId, pass), "reconcile.json"),
    JSON.stringify(updated, null, 2) + "\n",
  );

  const converged =
    record.degraded.length === 0 && isConverged(findings, diff, config.converge);
  return { record: updated, converged };
}
