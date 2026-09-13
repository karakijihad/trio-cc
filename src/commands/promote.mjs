import { loadConfig } from "../config.mjs";
import { promoteRun } from "../driver.mjs";
import { isRunId } from "../paths.mjs";

// `trio promote <runId> --create` is the "yes" half of the offer a finished
// run makes when artifacts.promoteTo does not exist. Without --create it
// refuses rather than creating directories in someone's project.
export default function promoteCommand({ root, rest, out, activeRun, latestFinishedRun }) {
  const config = loadConfig(root);
  const runId =
    rest.find((a) => !a.startsWith("--")) ??
    activeRun() ??
    latestFinishedRun();
  if (!runId) {
    out("No finished run to promote.");
    process.exitCode = 1;
    return;
  }
  if (!isRunId(runId)) {
    out(`Not a run id: ${runId}`);
    process.exitCode = 2;
    return;
  }
  const r = promoteRun({
    root,
    config,
    runId,
    create: rest.includes("--create"),
  });
  if (!r.ok) {
    out(r.error);
    process.exitCode = 1;
    return;
  }
  out(
    `${r.created ? `Created ${config.artifacts.promoteTo}/ and promoted` : "Promoted"} ${runId}:\n  ${r.promoted.codexPath}\n  ${r.promoted.claudePath}`,
  );
}
