import { rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeMarker, runDir, isRunId, processIsTrio } from "../paths.mjs";
import { readMarker } from "../marker.mjs";
import { cancelToken, finalizeIfUnfinished } from "../driver.mjs";
import { killTree } from "../codex-lane.mjs";

// `trio cancel`
export default function cancelCommand({ root, out, run }) {
  const marker = readMarker(root);
  if (!marker) {
    out("No active run.");
    return;
  }
  const runId = isRunId(marker.run) ? marker.run : null;
  if (!runId) {
    // A start that claimed the marker but had not yet named its run.
    try {
      rmSync(activeMarker(root));
    } catch {
      /* already gone */
    }
    out("Cleared a claim from a run that never started.");
    return;
  }

  // Order matters. The token goes down first so a worker that survives the
  // signal still refuses to write anything further; only then is the
  // process stopped, and only then is the verdict recorded — a run is not
  // reported cancelled while its lenses are still running.
  mkdirSync(runDir(root, runId), { recursive: true });
  writeFileSync(
    cancelToken(root, runId),
    JSON.stringify({ at: new Date().toISOString() }),
  );

  // .trio/active is an ordinary file in the project, so its pid is not
  // trustworthy input: a tampered or simply stale marker can name any
  // process on the machine, and the next line signals it. Require a
  // well-formed pid, require the run directory that marker claims to
  // belong to, and refuse a pid positively identified as not ours.
  const pid =
    Number.isSafeInteger(marker.pid) && marker.pid > 0 ? marker.pid : null;
  const ownsRun = existsSync(join(runDir(root, runId), "run.json"));
  const identified = pid ? processIsTrio(pid, run) : null;

  let stopped = null;
  if (pid && pid !== process.pid && ownsRun && identified !== false) {
    try {
      // Signal 0 is a liveness probe: it throws ESRCH when the run process
      // is already gone, and tells us nothing was there to stop.
      process.kill(pid, 0);
      // The worker has Codex children of its own. Signalling only the
      // worker orphans them on win32 — the same defect the lens deadline
      // had before killTree, and cancellation is where it costs most.
      killTree({ pid, kill: () => process.kill(pid, "SIGTERM") });
      stopped = pid;
    } catch {
      /* already gone */
    }
  }

  finalizeIfUnfinished({ root, runId });
  try {
    rmSync(activeMarker(root));
  } catch {
    /* already gone */
  }
  out(stopped ? `Run cancelled (stopped pid ${stopped}).` : "Run cancelled.");
}
