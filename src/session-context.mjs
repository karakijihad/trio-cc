import { pathToFileURL, fileURLToPath } from "node:url";
import { loadConfig, configErrors } from "./config.mjs";
import { loadCapabilities, modelProposals } from "./capabilities.mjs";
import { proposalLine } from "./commands/models.mjs";
import { archiveOldRuns } from "./archive.mjs";
import { readMarker } from "./marker.mjs";
import { passDir, isRunId } from "./paths.mjs";
import { statSync } from "node:fs";
import { join } from "node:path";

const PARKED_NOTICE_MS = 3_600_000;

// A run parked between passes holds the project lock on purpose, waiting for
// its adjudication — and in practice gets forgotten while its session moves
// on, for hours, until a sibling session cancels it to get the lock. Past an
// hour it is worth one line.
export function parkedRun(root, now = Date.now()) {
  const held = readMarker(root);
  if (!held || !isRunId(held.run) || !Number.isSafeInteger(held.pass)) return null;
  try {
    const at = statSync(join(passDir(root, held.run, held.pass), "reconcile.json")).mtimeMs;
    const hours = Math.floor((now - at) / 3_600_000);
    return now - at >= PARKED_NOTICE_MS ? { run: held.run, pass: held.pass, hours } : null;
  } catch {
    return null;
  }
}

const BIN = fileURLToPath(new URL("../bin/trio.mjs", import.meta.url));

// SessionStart context: makes Claude aware Trio is here without making it a
// gate. The skill descriptions already say when each skill applies; what they
// cannot do is remind Claude to weigh an audit after work the operator never
// framed as "audit this". This nudge is advisory on purpose — the judgement
// about whether a task warrants a second reviewer stays with Claude and the
// operator, not with a hook.
//
// Silent when the project has opted out (`/trio:off`), and silent when the
// config is unreadable — loadConfig fails closed in that case, and a corrupt
// file must not re-introduce Trio to a project that had said no.
//
// Two housekeeping lines ride along. Runs past artifacts.archiveAfterDays are
// moved to .trio/archive. And every lens or consult slot whose model is
// unpinned, gone or retiring is listed with its replacement for Claude to
// offer — read from the cached capabilities only, since a hook with a 5s
// timeout must never spawn Codex.
export function main(root) {
  const config = loadConfig(root);
  if (config.enabled !== true) return null;
  const lines = [
    "Trio is enabled for this project. It is not required for every task — judge by the work:",
    "- After finishing a substantive code-writing or code-modifying task, consider an independent Codex audit (the trio:trio-audit skill), and offer it rather than assuming.",
    "- Run it without being re-asked whenever the operator requests it (\"have Codex audit this\", \"run the loop\").",
    "- For a design or technical question where a second model's answer helps, trio:trio-consult.",
    "- Trivial edits, docs-only changes, and pure questions need no audit.",
  ];
  if (configErrors(config).length) return lines.join("\n");
  const archived = archiveOldRuns(root, { days: config.artifacts.archiveAfterDays });
  if (archived.length)
    lines.push(
      `Trio archived ${archived.length} run(s) older than ${config.artifacts.archiveAfterDays} days to .trio/archive/.`,
    );
  const parked = parkedRun(root);
  if (parked)
    lines.push(
      `Trio run ${parked.run} has been paused after pass ${parked.pass} for ${parked.hours}h, waiting for its adjudication, and holds the project lock until then. Mention it once and offer: finish it (adjudicate, then trio continue) or /trio:cancel.`,
    );
  const proposals = modelProposals(loadCapabilities(root), config);
  if (proposals.length)
    lines.push(
      "Trio model check — these Codex models should change. Offer this once, early, as one yes/no; on yes run " +
        `\`node "${BIN}" models --apply\` and show its output:`,
      ...proposals.map((p) => `  - ${proposalLine(p)}`),
    );
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = main(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (text) process.stdout.write(text + "\n");
  process.exit(0);
}
