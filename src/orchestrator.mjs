import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffPasses, isConverged } from "./findings.mjs";
import { makeEvent, appendEvent } from "./bus.mjs";
import { runDir, passDir, activeMarker } from "./paths.mjs";
import { scrubDeep } from "./scrub.mjs";

export function newRunId(now = new Date()) {
  return now.toISOString().slice(0, 16).replace(/:/g, "-");
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

// One audit pass: run the enabled lenses, reconcile their findings, diff
// against the prior pass, and write the pass's artifacts. `prevRecord` is the
// previous pass's record (`null` for pass 1); `briefFor` is pass-aware
// (D14) so pass 2+ can carry forward findings, diffs, and Claude's reply.
export async function runPass({
  config,
  target,
  root,
  runId,
  pass,
  prevRecord,
  runLensFn,
  reconcileFn,
  briefFor,
}) {
  const dir = runDir(root, runId);
  const enabled = config.codex.lenses.filter((l) => l.on);
  const previous = prevRecord?.findings ?? [];

  // keep the hook's marker in step so Claude-lane events carry the right pass
  try {
    writeFileSync(activeMarker(root), JSON.stringify({ run: runId, pass }));
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
      }),
    )
  ).map(scrubDeep);

  const raw = results.flatMap((r) => r.findings);
  const reconciled = await reconcileFn(raw, { pass, target, root });
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

// The run's tail: writes verdict.json and emits run_finished. Always runs,
// including on the "failed" path (D13).
export function finalizeRun({ root, runId, verdict, passCount }) {
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true });
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

export async function runLoop({
  config,
  target,
  root,
  runId,
  runLensFn,
  reconcileFn,
  briefFor,
}) {
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true });

  const passes = [];
  let prevRecord = null;
  let verdict = "ceiling_reached";

  try {
    for (let pass = 1; pass <= config.maxIterations; pass++) {
      const { record, converged } = await runPass({
        config,
        target,
        root,
        runId,
        pass,
        prevRecord,
        runLensFn,
        reconcileFn,
        briefFor,
      });
      passes.push(record);
      prevRecord = record;
      if (converged) {
        verdict = "clean";
        break;
      }
    }
  } catch (err) {
    verdict = "failed";
    appendEvent(
      dir,
      makeEvent({
        run: runId,
        pass: passes.length,
        lane: "trio",
        actor: "trio",
        kind: "error",
        payload: { error: `run failed: ${err.message}` },
      }),
    );
  }

  finalizeRun({ root, runId, verdict, passCount: passes.length });
  return { verdict, passes };
}
