import { existsSync } from "node:fs";
import { loadConfig, configErrors, unknownKeys } from "../config.mjs";
import { renderPanel } from "../panel.mjs";
import { activeMarker, isRunId } from "../paths.mjs";
import { readMarker } from "../marker.mjs";

// `trio [status|panel]` (and the bare `trio` default).
export default function statusCommand({ root, rest, out, gatherState }) {
  // --json is the lock check a second session polls before it starts, so it
  // reads the marker and the config and stops there. gatherState probes the
  // real Codex CLI when its cache has aged out, and a poll loop must not
  // spawn a process every time it asks whether the repo is busy.
  if (rest.includes("--json")) {
    const held = readMarker(root);
    const runId = held && isRunId(held.run) ? held.run : null;
    out(
      JSON.stringify(
        {
          enabled: loadConfig(root).enabled,
          // The file's existence is the lock, not whether it parses. A claim
          // with no run yet is a start mid-flight, and a corrupt marker still
          // fails the `wx` create that every start begins with — reporting
          // either as free sends a polling caller into a refusal.
          busy: existsSync(activeMarker(root)),
          activeRun: runId,
          pass: held?.pass ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  const s = gatherState();
  out(renderPanel({ ...s, configErrors: configErrors(s.config), unknownKeys: unknownKeys(s.config) }));
}
