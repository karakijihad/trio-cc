import { loadConfig } from "../config.mjs";
import { start } from "../serve.mjs";
import { existsSync } from "node:fs";
import { runDir, isRunId } from "../paths.mjs";
import { archivedHint } from "../archive.mjs";

// `trio serve [runId] [--auto-exit]`
export default async function serveCommand({ root, rest, out, activeRun }) {
  const config = loadConfig(root);
  const runId = rest.find((a) => !a.startsWith("-")) ?? activeRun();
  if (!runId) {
    out("No active run — pass a run id.");
    process.exitCode = 1;
    return;
  }
  if (!isRunId(runId)) {
    out(`Not a run id: ${runId}`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(runDir(root, runId))) {
    out(`No such run: ${runId}.${archivedHint(root, runId)}`);
    process.exitCode = 1;
    return;
  }
  const { url } = await start({
    runDirPath: runDir(root, runId),
    port: config.view.port,
    autoExit: rest.includes("--auto-exit"),
  });
  out(url);
}
