import { mkdirSync, writeFileSync, readFileSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { diffPasses, isConverged, mergeFindings } from "./findings.mjs";
import { applyVerdicts } from "./reconcile.mjs";
import { carrySettled } from "./settled.mjs";
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
// Claude's own audit of the same scope, handed over as a lens result so the
// merge treats it exactly like one (D-claude-lane). Corroboration then falls
// out of mergeFindings for free: a defect both lanes raised carries both
// names, and a defect only one raised carries only its own — which is the
// column that did not exist before, because Claude never got to find
// anything, only to judge what Codex found.
//
// Read here rather than waited for: the file is written before the run
// starts, which is what makes the audit blind. A lane that reported nothing
// is absent, not empty — silence and "I looked and found nothing" are
// different claims, and only the second one is a lens result.
function claudeLaneResult(claudeFindings) {
  if (!claudeFindings) return null;
  return {
    lens: "claude",
    status: "ok",
    findings: claudeFindings,
    threadId: null,
  };
}

export async function runPass({
  config,
  target,
  root,
  runId,
  pass,
  prevRecord,
  runLensFn,
  briefFor,
  claudeFindings = null,
  settled = [],
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

  // Claude's lane joins the merge but not `results`: it is not a Codex lens,
  // nothing spawned it, and it must not be written into pass-N/codex/ or
  // counted as a lens that could time out or come back unparseable.
  //
  // Announced here, beside pass_started, rather than after the lenses settle.
  // Its findings were written before the run began — a lane that only appears
  // once every lens has finished tells the operator nothing while there is
  // still something to watch, which is the whole purpose of the viewer.
  const claude = claudeLaneResult(claudeFindings);
  if (claude)
    appendEvent(
      dir,
      makeEvent({
        run: runId,
        pass,
        lane: "claude:audit",
        actor: "claude",
        kind: "agent_message",
        payload: {
          text: `Independent audit: ${claude.findings.length} finding${claude.findings.length === 1 ? "" : "s"}, written before Codex's were read.`,
        },
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
  //
  // carrySettled then annotates the ones this run has already decided on,
  // after applyVerdicts rather than before, or `unreviewed` would overwrite
  // it. It attaches history only; the verdict stays `unreviewed` because that
  // is the truth about this pass.
  const reconciled = carrySettled(
    applyVerdicts(mergeFindings(claude ? [...results, claude] : results), []),
    settled,
  );
  const diff = diffPasses(previous, reconciled);
  const degraded = results.filter((r) => r.status !== "ok");

  const record = scrubDeep({
    pass,
    lenses: results,
    ...(claude ? { claude: claude.findings } : {}),
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
//
// First verdict wins, made atomic. A run cancelled from another terminal
// writes its verdict while this process may still be finishing a pass, and a
// plain read-then-write cannot promise the worker arriving late will not
// clobber "cancelled" with its own outcome — both can read "nothing there
// yet" before either writes. The fix is not a bare exclusive create on
// verdict.json itself, either: that would let a loser's read land in the gap
// between the winner's file being created and its content actually being
// written, and report "unknown" for a run that finished cleanly a moment
// later. Writing the full content to a private temp file first and then
// linking it into place means the destination only ever comes into existence
// already complete — `linkSync` either succeeds for exactly one writer or
// fails with `EEXIST` for every other one, and whichever it is, an existing
// destination is always readable.
export function finalizeRun({ root, runId, verdict, passCount }) {
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "verdict.json");
  const payload = { verdict, passes: passCount, runId };
  const tmp = join(
    dir,
    `.verdict.json.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );

  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
  try {
    linkSync(tmp, path);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    return readVerdict(dir) ?? { verdict: "unknown", passes: passCount, runId };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* the destination link (if any) survives this regardless */
    }
  }

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
  return payload;
}

