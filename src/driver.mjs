import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { runPass, finalizeRun, newRunId } from "./orchestrator.mjs";
import { buildLensPrompt, readPassResponse, claudeChanges } from "./prompt.mjs";
import {
  readReconcile,
  collectPasses,
  applyAdjudication,
} from "./adjudicate.mjs";
import { validateFindings } from "./findings.mjs";
import { buildSettled } from "./settled.mjs";
import { promote, promoteTarget } from "./promote.mjs";
import { readEvents, makeEvent, appendEvent } from "./bus.mjs";
import { runDir, passDir, activeMarker, trioDir, isRunId } from "./paths.mjs";
import {
  readMarker,
  writeMarker,
  removeMarker,
  removeMarkerOwnedBy,
} from "./marker.mjs";
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
// An existing marker means one of four things: another start is mid-flight
// (run: null), a run is genuinely in progress, a run is parked between passes
// waiting to be adjudicated, or a claim was abandoned — by a crash, a kill, or
// a reboot. Two of those are stale and are cleared and retried: a marker whose
// run already reached a verdict, and one isAbandonedClaim identifies below. A
// marker naming a run id Trio did not mint is never touched at all.

// Did the process holding this claim die without releasing it? Both halves of
// the test are load-bearing.
//
// The pid being gone is not enough on its own: a run parked between passes has
// no process either — that is the ordinary awaiting_response state, where the
// worker has exited and the operator's session owes it a reply — and its lock
// has to keep holding or a second session would start on top of it.
//
// What separates the two is the pass on disk. A parked run always completed
// the pass its marker names, so pass-N/reconcile.json is there. A run killed
// mid-pass — a harness timeout, a crash, a SIGKILL, a reboot — never wrote it.
//
// Every uncertain answer is "not abandoned": a lock wrongly held costs one
// `/trio:cancel`, a lock wrongly broken costs two concurrent audits writing
// into one run directory.
function isAbandonedClaim(root, held) {
  const pid = Number.isSafeInteger(held.pid) && held.pid > 0 ? held.pid : null;
  if (!pid || pid === process.pid) return false;
  try {
    // Signal 0 tests for existence without delivering anything. ESRCH is the
    // only answer that means gone; EPERM means alive and not ours to inspect.
    process.kill(pid, 0);
    return false;
  } catch (err) {
    if (err.code !== "ESRCH") return false;
  }
  const pass = Number.isSafeInteger(held.pass) && held.pass > 0 ? held.pass : null;
  if (!pass) return false;
  return !existsSync(join(passDir(root, held.run, pass), "reconcile.json"));
}

// Release a claim this process owns, on the way out of a signal. process.exit
// skips the `finally` in startRun that would have done it, and on win32 no
// handler runs at all — so this is the graceful half, and isAbandonedClaim
// above is what covers a kill that gives no warning.
//
// Ownership is by pid, so a signal here can never free a concurrent run's
// lock. The verdict matters as much as the marker: the detached viewer polls
// for verdict.json before it closes, and a run that ends without one leaves a
// server listening for the rest of the session.
//
// Exported and pid-injectable because the alternative is testing it by
// signalling a real CLI process — which on win32 is TerminateProcess, so the
// handler that calls this would never run and the test would prove nothing.
export function releaseOwnClaim({ root, pid = process.pid } = {}) {
  const held = readMarker(root);
  if (!held || held.pid !== pid) return false;
  const runId = isRunId(held.run) ? held.run : null;
  if (runId && !existsSync(join(runDir(root, runId), "verdict.json"))) {
    let passCount = 0;
    while (
      existsSync(join(passDir(root, runId, passCount + 1), "reconcile.json"))
    )
      passCount++;
    finalizeRun({ root, runId, verdict: "cancelled", passCount });
  }
  // Compare-and-delete either way. A named claim is matched on its run id; an
  // unnamed one has no id to match, so it is matched on the pid that wrote it
  // — passing undefined here would delete whatever marker happened to be
  // standing, including a replacement another process had already claimed.
  if (runId) removeMarker(root, runId);
  else removeMarkerOwnedBy(root, pid);
  return true;
}

function claimActiveRun(root) {
  mkdirSync(trioDir(root), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
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
      // .trio/active is an ordinary file in the project, so its run id is
      // attacker-influencable — and every line below joins it into a path, one
      // of which creates a directory and writes a verdict into it. `../../..`
      // is how a crafted id escapes .trio/runs. An id Trio did not mint is
      // never reclaimed: refusing to start costs a `/trio:cancel`, writing
      // outside the run directory costs whatever was already there.
      if (!isRunId(held.run)) return { ok: false, runId: null, pass: null };
      if (!existsSync(join(runDir(root, held.run), "verdict.json"))) {
        if (!isAbandonedClaim(root, held))
          return { ok: false, runId: held.run, pass: held.pass ?? null };
        // Close the abandoned run out rather than orphaning it: its verdict is
        // what the detached viewer waits for before it stops listening, and a
        // run directory with no verdict reads as still in flight for ever.
        try {
          let passCount = 0;
          while (
            existsSync(
              join(passDir(root, held.run, passCount + 1), "reconcile.json"),
            )
          )
            passCount++;
          finalizeRun({ root, runId: held.run, verdict: "cancelled", passCount });
        } catch {
          /* reclaiming the lock matters more than the epitaph */
        }
      }
      // Ownership-scoped, and that is the whole lock. Two starters can both
      // read the same stale marker; if the first clears it and wins the `wx`
      // race, an unscoped delete here would remove the *winner's* fresh claim
      // and let both proceed. removeMarker compares before it deletes, so the
      // loser's delete is a no-op and its next `wx` attempt fails honestly.
      removeMarker(root, held.run);
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

// Claude's blind audit, handed over as a file. Read before the pass runs,
// because the file having been written first is the only thing that makes the
// audit independent — Claude that has already read Codex's findings is not a
// second opinion, it is an echo. A bad file is refused loudly rather than
// dropped: a run that silently audits one lane while reporting two is worse
// than a run that will not start.
export function readClaudeFindings(path) {
  if (!path) return { ok: true, findings: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `could not read ${path}: ${err.message}` };
  }
  const checked = validateFindings(parsed);
  if (!checked.ok)
    return { ok: false, error: `${path} has ${checked.reason}` };
  return { ok: true, findings: checked.findings };
}

function readRunJson(root, runId) {
  const parsed = JSON.parse(
    readFileSync(join(runDir(root, runId), "run.json"), "utf8"),
  );
  // scope is optional and only ever operator-supplied — an older run.json
  // simply has none, and every pass of it reviews the whole target as before.
  return {
    target: parsed.target,
    config: parsed.config,
    scope: typeof parsed.scope === "string" ? parsed.scope : null,
  };
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
// `ceiling_reached` is two different situations wearing one word. A pass that
// closed twelve findings and opened eight is still converging and ran out of
// budget; a pass that closed nothing and opened the same eight is thrashing,
// and another pass buys nothing but spend. Only the operator can tell those
// apart, so the numbers go on the result and the skill asks once — the same
// shape as the promotion offer above, and for the same reason.
//
// Offered only at the ceiling with blocking findings still live: a run that
// converged has nothing to extend, and one that failed or was cancelled did
// not stop because of the ceiling.
function extensionOffer({ root, runId, config, verdict, passes }) {
  if (verdict !== "ceiling_reached") return {};
  if (config.converge?.offerExtension === false) return {};
  const last = passes[passes.length - 1];
  if (!last) return {};
  const blockOn = config.converge?.blockOn ?? [];
  const blocking = (last.findings ?? []).filter(
    (f) => f.verdict !== "refute" && blockOn.includes(f.severity),
  );
  if (!blocking.length) return {};
  return {
    extension: {
      offer: true,
      // Progress and churn, side by side: this is the whole basis for the
      // answer, so it travels with the question rather than being described.
      closed: last.diff?.closed?.length ?? 0,
      new: last.diff?.new?.length ?? 0,
      blocking: blocking.length,
      passes: passes.length,
      nextMax: (config.maxIterations ?? passes.length) + 1,
    },
  };
}

// Reopens a run that stopped at the ceiling, for one more pass. Deliberately
// narrow: only `ceiling_reached` qualifies — a clean, failed, or cancelled
// run reached its verdict on the merits and is not the ceiling's business.
//
// The verdict is evidence and is never simply deleted: it moves into the pass
// that produced it, so the record still shows the run stopped at the ceiling
// and was extended, rather than pretending it never did.
export function reopenRun({ root, runId, by = 1, hasClaudeFindings = false }) {
  if (!isRunId(runId)) return { ok: false, error: `Not a run id: ${runId}` };
  const verdictPath = join(runDir(root, runId), "verdict.json");
  let verdict;
  try {
    verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
  } catch {
    return { ok: false, error: `No finished run to extend: ${runId}` };
  }
  if (verdict.verdict !== "ceiling_reached")
    return {
      ok: false,
      error: `Only a run that stopped at the ceiling can be extended — ${runId} is "${verdict.verdict}".`,
    };

  // Asked here, before anything is claimed or torn open. continueRun refuses
  // a missing Claude lane too, but by then reopenRun has deleted the verdict,
  // raised the ceiling and taken the lock — so the same refusal arriving one
  // step later leaves the run in pieces. The cheap check goes first.
  const passCount = verdict.passes ?? collectPasses(root, runId).length;
  let lastPass = null;
  try {
    if (Number.isSafeInteger(passCount) && passCount > 0)
      lastPass = readReconcile(root, runId, passCount);
  } catch {
    // readReconcile throws on a missing or unreadable pass record, and this
    // runs outside the try below — an escaping throw would break reopenRun's
    // contract of always returning. An unreadable record is also not evidence
    // that there was no Claude lane, so it is left null and the run is
    // extended only on what can actually be established.
    lastPass = null;
  }
  if (lastPass?.claude && !hasClaudeFindings)
    return {
      ok: false,
      error:
        `Run ${runId} carries a Claude audit. Audit the scope again and pass ` +
        `--claude-findings, or its findings would be diffed as closed without ` +
        `anyone re-checking them.`,
    };

  // Nothing is touched unless this process owns the lock, exactly as a start
  // does: extending is starting more work on this project.
  const claim = claimActiveRun(root);
  if (!claim.ok)
    return {
      ok: false,
      inProgress: true,
      error: `A run is already in progress: ${claim.runId ?? "(unnamed)"}.`,
    };

  try {
    const parsed = JSON.parse(
      readFileSync(join(runDir(root, runId), "run.json"), "utf8"),
    );
    // verdict.json is an ordinary file in the project, so its pass count is
    // not a number until it has been checked — and it is about to be joined
    // into a path that gets written to. finalizeRun always writes a plain
    // integer here; anything else was not written by Trio.
    const claimed = verdict.passes;
    const passes = Number.isSafeInteger(claimed) && claimed > 0
      ? claimed
      : collectPasses(root, runId).length;
    // Throw rather than return: this sits inside the try, and a bare return
    // here would skip the catch's release and leave the claim standing —
    // the same unreclaimable-lock defect this function was just fixed for,
    // reintroduced by the guard that was meant to harden it.
    if (!passes)
      throw new Error(`${runId} has no completed pass to extend`);

    parsed.config.maxIterations = (parsed.config.maxIterations ?? passes) + by;

    // Ordered so that every failure leaves a state something can recover, and
    // the cheapest-to-undo mutation goes first. The archive is additive. The
    // marker is named next, so from here the catch can always release it by
    // pid. run.json's raised ceiling comes after both, because a bump that
    // survived a failed extend would compound on the next attempt. Removing
    // the verdict is last: until it goes, continueRun reads the run as
    // already_finished and releases the claim by itself.
    writeFileSync(
      join(passDir(root, runId, passes), "verdict-at-ceiling.json"),
      JSON.stringify(verdict, null, 2) + "\n",
    );
    writeMarker(root, runId, passes);
    writeFileSync(
      join(runDir(root, runId), "run.json"),
      JSON.stringify(parsed, null, 2) + "\n",
    );
    rmSync(verdictPath, { force: true });
    return { ok: true, runId, maxIterations: parsed.config.maxIterations };
  } catch (err) {
    // By pid, not by run id. claimActiveRun above wrote an *unnamed* claim,
    // and writeMarker is the only line that ever names it — so on any throw
    // before that, removeMarker(root, runId) compares runId against a marker
    // whose run is still null, refuses, and silently leaves a claim that
    // isAbandonedClaim will not reclaim either (it requires pass > 0). One
    // failed extend would have locked the project out of every future run.
    removeMarkerOwnedBy(root, process.pid);
    return { ok: false, error: `Could not extend ${runId}: ${err.message}` };
  }
}

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
      ...extensionOffer({ root, runId, config, verdict, passes }),
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

// A lens name reaches two path joins here, and .trio/config.json is an
// ordinary file in the project — the same trust class as .trio/active, which
// this file already refuses to take a run id from unchecked. A name like
// `../../../../etc/passwd` would be read straight into the brief and sent to
// Codex, which is disclosure, not just a bad read. Names Trio ships and names
// an operator can sensibly write are both this shape; anything else is not a
// lens name and gets no file.
const LENS_NAME = /^[a-z][a-z0-9-]*$/;

function baseBrief(root, lens) {
  if (!LENS_NAME.test(String(lens?.name ?? "")))
    throw new Error(`not a lens name: ${lens?.name}`);
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
function briefFor(root, runId, scope, settled = []) {
  return (lens, pass, prevRecord) => {
    const brief = baseBrief(root, lens);
    if (pass <= 1 || !prevRecord) return buildLensPrompt({ brief, scope });
    return buildLensPrompt({
      brief,
      lens,
      pass,
      scope,
      settled,
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
  scope = null,
  claudeFindingsPath = null,
}) {
  const selection = applyLensSelection(config, lenses);
  if (selection.error) return { status: "invalid_lenses", error: selection.error };
  config = selection.config;

  // Before the marker is claimed: a handover file that will not parse must
  // not cost a lock, let alone a wave of Codex processes.
  const claude = readClaudeFindings(claudeFindingsPath);
  if (!claude.ok) return { status: "invalid_findings", error: claude.error };

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
        // scope is written even when null: `continue` is a separate CLI
        // invocation and run.json is the only place it can learn what this
        // run was pointed at.
        { runId, target, scope, startedAt: startedAt.toISOString(), config },
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
      briefFor: briefFor(root, runId, scope),
      claudeFindings: claude.findings,
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
export async function continueRun({
  root,
  runLensFn,
  claudeFindingsPath = null,
}) {
  // The marker first: "there is nothing to continue" is the more useful
  // answer, and reporting a bad handover file instead sends the operator to
  // fix the wrong thing.
  const marker = readMarker(root);
  if (!marker) return { status: "no_active_run" };
  const claude = readClaudeFindings(claudeFindingsPath);
  if (!claude.ok) return { status: "invalid_findings", error: claude.error };
  const runId = marker.run;

  // The same contract the reclaim path above holds to, and for the same
  // reason: .trio/active is an ordinary file in the project, so its run id is
  // attacker-influencable, and every line below joins it into a path — one
  // that runPass creates directories under and writes a verdict into.
  // `../../..` is how a crafted id escapes .trio/runs. Refuse before the
  // first join, not after.
  if (!isRunId(runId))
    return {
      status: "invalid_marker",
      error:
        ".trio/active names a run id Trio did not mint — refusing to continue it. /trio:cancel clears the claim.",
    };

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

  let target, config, scope;
  try {
    ({ target, config, scope } = readRunJson(root, runId));
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

    // A lane that audited the previous pass and not this one is worse than a
    // lane that never ran. diffPasses compares this pass against the last, so
    // every Claude-only finding from pass N would appear in pass N+1's
    // `closed` column — reported fixed because nobody looked, which is the
    // precise failure the diff was rewritten to stop (see findings.mjs, run
    // 2026-08-01T12-27-09: 21 of 21 "closed", 14 still in the code).
    if (stored?.claude && !claude.findings)
      return {
        status: "claude_lane_missing",
        error:
          `Pass ${N} carried a Claude audit and this one does not. Its findings ` +
          `would be diffed as closed without anyone re-checking them. Audit the ` +
          `scope again and pass --claude-findings.`,
      };

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

    // Built once, after applyAdjudication has folded pass N's verdicts into
    // its record, and handed to both consumers: the prompt (so a lens is told
    // what this run already settled) and the merge (so a re-raise carries that
    // history). Building it inside briefFor would re-read every prior pass
    // once per lens.
    const settled = buildSettled(root, runId, N);

    const { record: record2, converged: converged2 } = await runPass({
      config,
      target,
      root,
      runId,
      pass: N + 1,
      prevRecord: record,
      runLensFn,
      briefFor: briefFor(root, runId, scope, settled),
      claudeFindings: claude.findings,
      settled,
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
