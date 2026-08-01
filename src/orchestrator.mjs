import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diffPasses, isConverged, mergeFindings } from "./findings.mjs";
import { applyVerdicts } from "./reconcile.mjs";
import { makeEvent, appendEvent } from "./bus.mjs";
import { runDir, passDir } from "./paths.mjs";
import { writeMarker } from "./marker.mjs";
import { scrubDeep } from "./scrub.mjs";

// Seconds, not minutes: two runs started in the same minute would otherwise
// share a directory and overwrite each other's artifacts.
export function newRunId(now = new Date()) {
  return now.toISOString().slice(0, 19).replace(/:/g, "-");
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

// One audit pass: run the enabled lenses, merge their findings, diff against
// the prior pass, and write the pass's artifacts. `prevRecord` is the
// previous pass's record (`null` for pass 1); `briefFor` is pass-aware
// (D14) so pass 2+ can carry forward findings, diffs, and Claude's reply.
//
// There is no reconcile hook here. Both callers passed the same do-nothing
// function, and adjudication genuinely happens later, in applyAdjudication,
// once Claude's verdicts.json lands between passes — a seam that suggested
// otherwise was worth more confusion than it was worth flexibility.
export async function runPass({
  config,
  target,
  root,
  runId,
  pass,
  prevRecord,
  runLensFn,
  briefFor,
}) {
  const dir = runDir(root, runId);
  const enabled = config.codex.lenses.filter((l) => l.on);
  const previous = prevRecord?.findings ?? [];

  // keep the hook's marker in step so Claude-lane events carry the right pass
  try {
    writeMarker(root, runId, pass);
  } catch {
    /* not enabled */
  }
  appendEvent(
    dir,
    makeEvent({
      run: runId,
      pass,
      lane: "trio",
      actor: "trio",
      kind: "pass_started",
      payload: { lenses: enabled.map((l) => l.name) },
    }),
  );

  const results = (
    await pool(enabled, config.codex.parallel, (lens) =>
      runLensFn({
        lens,
        target,
        brief: briefFor(lens, pass, prevRecord),
        runDirPath: dir,
        run: runId,
        pass,
        timeoutMs: config.codex.timeoutMinutes * 60_000,
      }),
    )
  ).map(scrubDeep);

  // Unadjudicated until Claude says otherwise — applyVerdicts with no
  // verdicts marks every finding `unreviewed`, which is what a pass that
  // nobody has looked at should say.
  const reconciled = applyVerdicts(mergeFindings(results), []);
  const diff = diffPasses(previous, reconciled);
  const degraded = results.filter((r) => r.status !== "ok");

  const record = scrubDeep({
    pass,
    lenses: results,
    findings: reconciled,
    diff,
    degraded: degraded.map((r) => r.lens),
  });

  const pdir = passDir(root, runId, pass);
  mkdirSync(join(pdir, "codex"), { recursive: true });
  writeFileSync(
    join(pdir, "reconcile.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  for (const r of results) {
    writeFileSync(
      join(pdir, "codex", `${r.lens}.json`),
      JSON.stringify(r, null, 2) + "\n",
    );
  }

  const converged =
    degraded.length === 0 && isConverged(reconciled, diff, config.converge);
  appendEvent(
    dir,
    makeEvent({
      run: runId,
      pass,
      lane: "trio",
      actor: "trio",
      kind: "pass_completed",
      payload: {
        findings: reconciled.length,
        new: diff.new.length,
        closed: diff.closed.length,
        degraded: record.degraded,
        converged,
      },
    }),
  );

  return { record, converged };
}

function readVerdict(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
    return typeof parsed?.verdict === "string" ? parsed : null;
  } catch {
    return null;
  }
}

// The run's tail: writes verdict.json and emits run_finished. Always runs,
// including on the "failed" path (D13).
export function finalizeRun({ root, runId, verdict, passCount }) {
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true });

  // First verdict wins. A run cancelled from another terminal writes its
  // verdict while this process may still be finishing a pass; the worker
  // arriving late must not overwrite "cancelled" with its own outcome.
  const existing = readVerdict(dir);
  if (existing) return existing;

  writeFileSync(
    join(dir, "verdict.json"),
    JSON.stringify({ verdict, passes: passCount, runId }, null, 2) + "\n",
  );
  try {
    appendEvent(
      dir,
      makeEvent({
        run: runId,
        pass: passCount,
        lane: "trio",
        actor: "trio",
        kind: "run_finished",
        payload: { verdict },
      }),
    );
  } catch {
    // verdict.json is already written and is the authority; a bus-write
    // fault here must not bubble up and be mistaken for a run failure.
  }
  return { verdict, passes: passCount, runId };
}

