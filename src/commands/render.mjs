import { existsSync } from "node:fs";
import { runDir, isRunId } from "../paths.mjs";

// `trio render [runId]` — the id is advertised as optional, and with no
// active run this used to throw ENOENT as a raw stack trace.
export default async function renderCommand({ root, rest, out, activeRun, latestFinishedRun }) {
  const runId =
    rest.find((a) => !a.startsWith("-")) ??
    activeRun() ??
    latestFinishedRun();
  if (!runId) {
    out("No run to render — pass a run id.");
    process.exitCode = 1;
    return;
  }
  if (!isRunId(runId)) {
    out(`Not a run id: ${runId}`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(runDir(root, runId))) {
    out(`No such run: ${runId}`);
    process.exitCode = 1;
    return;
  }
  const { writeStatic } = await import("../render-html.mjs");
  out(writeStatic(runDir(root, runId)));
}
