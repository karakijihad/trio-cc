import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { activeMarker } from "./paths.mjs";

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
