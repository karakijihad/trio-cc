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

export function removeMarker(root) {
  try {
    rmSync(activeMarker(root), { force: true });
  } catch {
    /* already gone */
  }
}
