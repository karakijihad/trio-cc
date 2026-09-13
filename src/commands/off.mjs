import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../config.mjs";
import { activeMarker, runDir } from "../paths.mjs";
import { readMarker } from "../marker.mjs";

// `trio off`
export default function offCommand({ root, out }) {
  // Deleting the marker out from under a live run does not stop it: the
  // worker keeps going, keeps spending, and is now unreachable by `cancel`,
  // which finds the run through that very marker. Refuse instead, and name
  // the command that actually ends it.
  const held = readMarker(root);
  if (
    held?.run &&
    !existsSync(join(runDir(root, held.run), "verdict.json"))
  ) {
    out(
      `A run is in progress: ${held.run}${held.pass ? ` (pass ${held.pass})` : ""}.\n  /trio:cancel to end it, then /trio:off.`,
    );
    process.exitCode = 1;
    return;
  }

  saveConfig(root, { ...loadConfig(root), enabled: false });
  try {
    rmSync(activeMarker(root));
  } catch {
    /* not active */
  }
  out(
    "Trio is off. It stays loaded, so I will tell you when something would have used it.",
  );
}
