import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { activeMarker, trioDir, processIsTrio } from "./paths.mjs";

// .trio/active names the run in flight. Everything that touches it goes
// through here: it is both the hook's source of truth for which pass an event
// belongs to and the lock `trio cancel` uses to find the worker, so a second
// writer that forgets a field silently breaks one of the two.
export function readMarker(root) {
  try {
    return JSON.parse(readFileSync(activeMarker(root), "utf8"));
  } catch {
    return null;
  }
}

export function writeMarker(root, runId, pass) {
  writeFileSync(
    activeMarker(root),
    JSON.stringify({ run: runId, pass, pid: process.pid }),
  );
}

// Releasing the lock is ownership-scoped when a runId is given. A worker that
// was orphaned — left running by an `off` or a crash while a later run claimed
// the marker — finishes eventually and clears up after itself; without this
// check it would delete the newer run's lock instead of its own.
export function removeMarker(root, runId) {
  try {
    if (runId) {
      const held = readMarker(root);
      // Any marker that is not ours is somebody else's, including the
      // {run: null} a fresh claim writes before it has named its run — which
      // is the likeliest thing to be standing there when an orphan finishes.
      if (held && held.run !== runId) return false;
    }
    rmSync(activeMarker(root), { force: true });
    return true;
  } catch {
    return false; /* already gone */
  }
}

// Release by pid, for the claim that has no run id to compare — the window
// between `claimActiveRun` writing {run: null} and startRun naming the run.
// removeMarker cannot guard that case: with no runId it deletes whatever is
// there, so a claim released after another process had already replaced it
// would take the replacement with it. The pid is what identifies a claim
// before it has a name.
export function removeMarkerOwnedBy(root, pid) {
  try {
    const held = readMarker(root);
    if (!held || held.pid !== pid) return false;
    rmSync(activeMarker(root), { force: true });
    return true;
  } catch {
    return false; /* already gone */
  }
}

// The second lock. `.trio/active` names which run is in flight, and its
// exclusive `wx` create serializes *starting* one — but nothing serialized
// what came after. `continue` read the marker, decided a pass was ready to
// adjudicate, and ran the next one; two invocations doing that at once (or
// one running while a pass has not finished) both act on the same on-disk
// state and overwrite each other's artifacts. `.trio/worker.lock` is what a
// process holds for as long as it is actually executing lenses or
// finalizing — startRun, continueRun and reopenRun all take it before they
// touch anything, and release it in a `finally` on every exit, thrown errors
// included.
//
// Deliberately a second file rather than reusing the marker: the marker also
// has to survive a run parked between passes with no process running at all
// (the ordinary awaiting_response state), which is exactly when the worker
// lock must be absent so the next `continue` can take it.
export const workerLockPath = (root) => join(trioDir(root), "worker.lock");

export function readWorkerLock(root) {
  try {
    return JSON.parse(readFileSync(workerLockPath(root), "utf8"));
  } catch {
    return null;
  }
}

// Is the pid holding the lock still a live Trio worker? Two checks, both
// load-bearing, mirroring cancel's own identification (paths.mjs's
// processIsTrio) rather than driver.mjs's isAbandonedClaim: that check only
// ever needs pid liveness, because a *parked* run's marker has no process to
// identify — it holds with nobody running. A worker lock has no such state;
// if it exists at all, something claims to be actively running, so a lock
// naming a pid that is alive but positively identified as something else
// (a reused pid) is exactly as stale as one naming a pid that is gone.
//
// Fail-open, like every check this codebase does over a file the project
// itself can write: `run` not supplied, or its probe unable to tell, reads as
// "still held" — reclaiming a lock a live worker still holds corrupts that
// worker's run; refusing one that has actually gone stale costs a retry.
function isLiveWorker(pid, run) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === "ESRCH") return false; // definitely gone
    // EPERM or anything else: alive, just not signalable by us — fall
    // through to identify it rather than guessing from the failure alone.
  }
  return processIsTrio(pid, run) !== false;
}

// Takes the worker lock, reclaiming it first if it is stale. `wx` is one
// filesystem operation, so of several processes racing this call exactly one
// creates the file; every other one lands on the `EEXIST` branch and either
// reports the live holder or — if that holder turns out to be stale —
// removes it and retries the create.
//
// The removal is ownership-scoped the same way removeMarkerOwnedBy is: two
// processes can both read the same stale lock, and only one of them may
// actually delete it. Re-reading and comparing to the snapshot just taken
// means a racing reclaim that already replaced it with its own fresh claim
// is left alone — an unscoped delete here would take the winner's claim
// with it, exactly the bug ownership-scoped removal exists to prevent
// everywhere else in this file.
export function acquireWorkerLock({
  root,
  runId = null,
  pass = null,
  run,
  pid = process.pid,
  since = () => new Date().toISOString(),
}) {
  mkdirSync(trioDir(root), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(
        workerLockPath(root),
        JSON.stringify({ pid, run: runId, pass, since: since() }),
        { flag: "wx" },
      );
      return { ok: true };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const held = readWorkerLock(root);
      if (!held) continue; // vanished between the failed create and this read
      if (isLiveWorker(held.pid, run))
        return { ok: false, status: "worker_busy", holder: held };
      try {
        const stillThere = readWorkerLock(root);
        if (
          stillThere &&
          stillThere.pid === held.pid &&
          stillThere.since === held.since
        )
          rmSync(workerLockPath(root), { force: true });
      } catch {
        /* another attempt's retry will find out either way */
      }
    }
  }
  return { ok: false, status: "worker_busy", holder: readWorkerLock(root) };
}

// Ownership-scoped, exactly like removeMarkerOwnedBy: a process releases only
// the lock it holds, so a `finally` running after this process's own claim
// was already reclaimed as stale by somebody else cannot delete the
// reclaimer's fresh one.
export function releaseWorkerLock(root, pid = process.pid) {
  try {
    const held = readWorkerLock(root);
    if (!held || held.pid !== pid) return false;
    rmSync(workerLockPath(root), { force: true });
    return true;
  } catch {
    return false; /* already gone */
  }
}
