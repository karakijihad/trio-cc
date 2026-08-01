import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { runPass, finalizeRun, newRunId } from "./orchestrator.mjs";
import { buildLensPrompt, readPassResponse, claudeChanges } from "./prompt.mjs";
import {
  readReconcile,
  collectPasses,
  applyAdjudication,
} from "./adjudicate.mjs";
import { promote, promoteTarget } from "./promote.mjs";
import { readEvents, makeEvent, appendEvent } from "./bus.mjs";
import { runDir, passDir, activeMarker, trioDir } from "./paths.mjs";
import { readMarker, writeMarker, removeMarker } from "./marker.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";

// The durable half of cancellation: `trio cancel` signals the worker process,
// but a signal can be missed (the pid is gone, the kill is refused). The token
// is what a surviving worker checks before it writes anything else, so a
// cancelled run stays cancelled either way.
export const cancelToken = (root, runId) =>
  join(runDir(root, runId), "cancelled");

export const isCancelled = (root, runId) =>
  existsSync(cancelToken(root, runId));

// Claiming the marker IS the lock. Exclusive creation ("wx") is one atomic
// filesystem operation, so of two starts racing each other exactly one wins —
// a read-then-write guard cannot promise that, because both can read "absent"
// before either writes. The claim goes down before a run id exists; startRun
// rewrites it with the real id once the run directory is its own.
//
// An existing marker means: another start is mid-flight (run: null), a run is
// genuinely in progress, or a crash left a marker whose run already reached a
// verdict — only the last is stale, and only that one is cleared and retried.
function claimActiveRun(root) {
  mkdirSync(trioDir(root), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(
        activeMarker(root),
        JSON.stringify({ run: null, pass: 0, pid: process.pid }),
        { flag: "wx" },
      );
      return { ok: true };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const held = readMarker(root);
      if (!held?.run) return { ok: false, runId: null, pass: null };
      if (!existsSync(join(runDir(root, held.run), "verdict.json")))
        return { ok: false, runId: held.run, pass: held.pass ?? null };
      removeMarker(root);
    }
  }
  return { ok: false, runId: null, pass: null };
}

// Timestamps alone are not collision-resistant — two runs inside the same
// second would share a directory and overwrite each other's artifacts. Suffix
// until the directory is genuinely new.
function uniqueRunId(root, base) {
  if (!existsSync(runDir(root, base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(runDir(root, candidate))) return candidate;
  }
}

function readRunJson(root, runId) {
  const parsed = JSON.parse(
    readFileSync(join(runDir(root, runId), "run.json"), "utf8"),
  );
  return { target: parsed.target, config: parsed.config };
}

// Promotes a run that has already finished — what "yes, create it" runs, so
// the audit the operator just watched is written out too, not only the next
// one. `create` is the operator's answer: without it this is a dry no-op,
// because Trio does not make directories in a project on its own.
export function promoteRun({ root, config, runId, create = false }) {
  const verdictPath = join(runDir(root, runId), "verdict.json");
  let verdict;
  try {
    verdict = JSON.parse(readFileSync(verdictPath, "utf8")).verdict;
  } catch {
    return { ok: false, error: `no finished run at ${runId}` };
  }

  const target = promoteTarget(root, config);
  if (!target.exists) {
    if (!create) return { ok: false, error: `${target.path} does not exist` };
    mkdirSync(target.absolute, { recursive: true });
  }

  const passes = collectPasses(root, runId);
  if (!passes.length) return { ok: false, error: `run ${runId} has no passes` };

  const promoted = promote({ root, config, runId, passes, verdict });
  return promoted
    ? { ok: true, created: !target.exists, promoted }
    : { ok: false, error: "promotion produced nothing" };
}

// The highest pass-<n>/reconcile.json under the run dir, or null if none.
function latestCompletedPass(root, runId) {
  let entries;
  try {
    entries = readdirSync(runDir(root, runId));
  } catch {
    return null;
  }
  const ns = entries
    .map((e) => e.match(/^pass-(\d+)$/))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((n) => existsSync(join(passDir(root, runId, n), "reconcile.json")));
  return ns.length ? Math.max(...ns) : null;
}

// Finalization tail shared by every terminal outcome: writes verdict.json
// (via finalizeRun) — the correct verdict, once written, is never revisited
// — then promotes finished artifacts, and always clears the active marker
// in a finally. promote() is wrapped in its own try/catch: a promote
// failure (e.g. the promote root existing as a non-directory) must not be
// allowed to look like the whole run failed and overwrite a correct
// verdict.json with "failed" — it is logged as an error event instead and
// the run still reports its real, already-written verdict.
function finalize({ root, runId, config, verdict }) {
  const passes = collectPasses(root, runId);
  try {
    finalizeRun({ root, runId, verdict, passCount: passes.length });
    let promoted = null;
    try {
      promoted = promote({ root, config, runId, passes, verdict });
    } catch (err) {
      appendEvent(
        runDir(root, runId),
        makeEvent({
          run: runId,
          pass: passes.length,
          lane: "trio",
          actor: "trio",
          kind: "error",
          payload: { error: `promote failed: ${err.message}` },
        }),
      );
    }
    return {
      status: "finished",
      verdict,
      runId,
      passes: passes.length,
      promoted,
      // Only present when there was nothing to promote into. `offer` is what
      // tells Claude to ask once whether to create it; the operator declining
      // sets artifacts.offerToCreate false and this goes quiet for good.
      ...(promoted
        ? {}
        : {
            promotion: {
              skipped: true,
              path: config.artifacts.promoteTo,
              offer: config.artifacts.offerToCreate !== false,
            },
          }),
    };
  } finally {
    // Scoped to this run: an orphaned worker finishing late must release its
    // own lock, never the lock of whatever run claimed the marker after it.
    removeMarker(root, runId);
  }
}

// The "failed" tail (D13's carry-over): records an error event naming the
// cause, then finalizes as failed, and surfaces the cause on the result.
// startRun/continueRun must never reject, so nothing this calls is allowed
// to escape as a throw — if finalize() itself fails, the marker is still
// cleared (best-effort) and a safe "failed" result is returned regardless.
function finalizeFailed({ root, runId, config, err }) {
  try {
    const passes = collectPasses(root, runId);
    appendEvent(
      runDir(root, runId),
      makeEvent({
        run: runId,
        pass: passes.length,
        lane: "trio",
        actor: "trio",
        kind: "error",
        payload: { error: `run failed: ${err.message}` },
      }),
    );
    const result = finalize({ root, runId, config, verdict: "failed" });
    return { ...result, error: err.message };
  } catch (finalizeErr) {
    removeMarker(root, runId);
    return {
      status: "finished",
      verdict: "failed",
      runId,
      error: err.message,
      finalizeError: finalizeErr.message,
    };
  }
}

// Shared decision (D18): converged -> clean, ceiling hit -> ceiling_reached,
// otherwise null (caller proceeds — either to the next pass, or by
// returning awaiting_response if there is no next pass this invocation).
function finalizeIfDone({ root, runId, config, pass, converged }) {
  if (converged) return finalize({ root, runId, config, verdict: "clean" });
  if (pass >= config.maxIterations)
    return finalize({ root, runId, config, verdict: "ceiling_reached" });
  return null;
}

function baseBrief(root, lens) {
  const overridePath = join(trioDir(root), "lenses", `${lens.name}.md`);
  if (existsSync(overridePath)) return readFileSync(overridePath, "utf8");
  return readFileSync(
    new URL(`../lenses/${lens.name}.md`, import.meta.url),
    "utf8",
  );
}

// The pass-aware brief builder (D14): pass 1 (or no prior pass) is the
// lens's base brief unchanged; pass 2+ folds in that lens's own prior
// findings, Claude's file changes since, and Claude's response.json.
function briefFor(root, runId) {
  return (lens, pass, prevRecord) => {
    const brief = baseBrief(root, lens);
    if (pass <= 1 || !prevRecord) return brief;
    return buildLensPrompt({
      brief,
      lens,
      pass,
      prior: {
        findings:
          prevRecord.lenses.find((l) => l.lens === lens.name)?.findings ?? [],
        changes: claudeChanges(readEvents(runDir(root, runId)), prevRecord.pass),
        response: readPassResponse(root, runId, prevRecord.pass),
      },
    });
  };
}


// Applies a per-run lens selection (optional `lenses`, D-lens-select) to a
// config before it is ever written to disk. `names` is an array of lens
// names or the string "all"; omitted/empty leaves config untouched (today's
// behavior). Returns { config } on success, or { error } naming the first
// unknown lens — callers must check for `error` before writing anything.
function applyLensSelection(config, names) {
  if (!names || (Array.isArray(names) && names.length === 0)) {
    return { config };
  }
  const known = config.codex.lenses.map((l) => l.name);
  if (names !== "all") {
    const unknown = names.find((n) => !known.includes(n));
    if (unknown) {
      return {
        error: `unknown lens: ${unknown}. known: ${known.join(", ")}`,
      };
    }
  }
  return {
    config: {
      ...config,
      codex: {
        ...config.codex,
        lenses: config.codex.lenses.map((l) => ({
          ...l,
          on: names === "all" ? true : names.includes(l.name),
        })),
      },
    },
  };
}

// Starts a run and executes pass 1 only (D18) — the audit loop yields back
// to the caller (Claude, via the CLI) so it can adjudicate, fix, and reply
// before pass 2. Everything the run needs lives on disk under
// .trio/runs/<runId>/ from here on; this call and any later continueRun
// call are independent CLI invocations.
export async function startRun({
  root,
  config,
  target,
  runLensFn,
  beforeFirstPass,
  now,
  lenses,
}) {
  const selection = applyLensSelection(config, lenses);
  if (selection.error) return { status: "invalid_lenses", error: selection.error };
  config = selection.config;

  // A pass with no lenses reviews nothing, finds nothing, and converges — so
  // an all-off config would report `clean` on the strength of no audit at all.
  // Refuse before the marker is claimed or anything is written.
  if (!config.codex.lenses.some((l) => l.on))
    return {
      status: "no_lenses",
      error:
        "No lenses are on, so a run would report clean without reviewing anything. Turn one on with `trio lens <name> on`, or pass --lenses.",
    };

  // Nothing below this line runs unless this process owns the marker.
  const claim = claimActiveRun(root);
  if (!claim.ok)
    return {
      status: "run_in_progress",
      runId: claim.runId,
      pass: claim.pass,
    };

  let runId, dir;
  try {
    const startedAt = now ?? new Date();
    runId = uniqueRunId(root, newRunId(startedAt));
    dir = runDir(root, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify(
        { runId, target, startedAt: startedAt.toISOString(), config },
        null,
        2,
      ) + "\n",
    );
    writeMarker(root, runId, 1);
  } catch (err) {
    // The claim is held but the run never existed — release it, or every
    // later start would refuse against a marker naming nothing.
    removeMarker(root);
    return { status: "finished", verdict: "failed", runId: null, error: err.message };
  }

  if (beforeFirstPass) {
    try {
      await beforeFirstPass({ runId, dir });
    } catch {
      /* a viewer must never block a run */
    }
  }

  try {
    const { record, converged } = await runPass({
      config,
      target,
      root,
      runId,
      pass: 1,
      prevRecord: null,
      runLensFn,
      briefFor: briefFor(root, runId),
    });

    // Cancelled mid-pass: the verdict is already on disk and is the
    // authority. Report it rather than asking Claude to adjudicate a run the
    // operator has ended.
    if (isCancelled(root, runId))
      return finalize({ root, runId, config, verdict: "cancelled" });

    const done = finalizeIfDone({ root, runId, config, pass: 1, converged });
    if (done) return done;
    return {
      status: "awaiting_response",
      runId,
      pass: 1,
      findings: record.findings,
      degraded: record.degraded,
    };
  } catch (err) {
    return finalizeFailed({ root, runId, config, err });
  }
}

// Reads the active run's latest completed pass, applies any adjudication
// Claude produced, re-evaluates convergence, and either finalizes or runs
// the next pass (D18). Never throws — every failure mode finalizes "failed".
export async function continueRun({ root, runLensFn }) {
  const marker = readMarker(root);
  if (!marker) return { status: "no_active_run" };
  const runId = marker.run;

  // The overwrite guard needs neither config nor target, so it is checked
  // before run.json is even read — a corrupt run.json must never bypass it
  // and reach a code path that could rewrite an existing verdict.json.
  const verdictPath = join(runDir(root, runId), "verdict.json");
  if (existsSync(verdictPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(verdictPath, "utf8"));
    } catch {
      // The file is evidence — a corrupt verdict.json is never rewritten,
      // only reported as unknown.
      removeMarker(root, runId);
      return { status: "already_finished", verdict: "unknown" };
    }
    removeMarker(root, runId);
    return { status: "already_finished", verdict: parsed.verdict };
  }

  let target, config;
  try {
    ({ target, config } = readRunJson(root, runId));
  } catch (err) {
    return finalizeFailed({
      root,
      runId,
      config: DEFAULT_CONFIG,
      err: new Error(`could not read run.json: ${err.message}`),
    });
  }

  const N = latestCompletedPass(root, runId);
  if (N == null) {
    return finalizeFailed({
      root,
      runId,
      config,
      err: new Error("no completed pass found on disk (corrupt run state)"),
    });
  }

  if (isCancelled(root, runId))
    return finalize({ root, runId, config, verdict: "cancelled" });

  try {
    const stored = readReconcile(root, runId, N);
    const { record, converged } = applyAdjudication({
      root,
      config,
      runId,
      pass: N,
      record: stored,
    });

    const done1 = finalizeIfDone({ root, runId, config, pass: N, converged });
    if (done1) return done1;

    writeMarker(root, runId, N + 1);
    const { record: record2, converged: converged2 } = await runPass({
      config,
      target,
      root,
      runId,
      pass: N + 1,
      prevRecord: record,
      runLensFn,
      briefFor: briefFor(root, runId),
    });

    if (isCancelled(root, runId))
      return finalize({ root, runId, config, verdict: "cancelled" });

    const done2 = finalizeIfDone({
      root,
      runId,
      config,
      pass: N + 1,
      converged: converged2,
    });
    if (done2) return done2;

    return {
      status: "awaiting_response",
      runId,
      pass: N + 1,
      findings: record2.findings,
      degraded: record2.degraded,
    };
  } catch (err) {
    return finalizeFailed({ root, runId, config, err });
  }
}
