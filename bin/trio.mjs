#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { USAGE } from "../src/cli-args.mjs";
import {
  run,
  out,
  unavailable,
  codexRefusal,
  gatherState,
  beforeFirstPass,
  activeRun,
  latestFinishedRun,
  stopLensesOnSignal,
  ensureGitignore,
} from "../src/commands/context.mjs";
import statusCommand from "../src/commands/status.mjs";
import onCommand from "../src/commands/on.mjs";
import offCommand from "../src/commands/off.mjs";
import doctorCommand from "../src/commands/doctor.mjs";
import configCommand from "../src/commands/config.mjs";
import lensCommand from "../src/commands/lens.mjs";
import modelsCommand from "../src/commands/models.mjs";
import serveCommand from "../src/commands/serve.mjs";
import promoteCommand from "../src/commands/promote.mjs";
import renderCommand from "../src/commands/render.mjs";
import verdictsCommand from "../src/commands/verdicts.mjs";
import cancelCommand from "../src/commands/cancel.mjs";
import runCommand from "../src/commands/run.mjs";
import extendCommand from "../src/commands/extend.mjs";
import continueCommand from "../src/commands/continue.mjs";
import consultCommand from "../src/commands/consult.mjs";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const [cmd, ...rest] = process.argv.slice(2);
// The viewer child spawned by beforeFirstPass has to launch through this same
// entry point (`trio serve ...`), so it needs this file's own path — taken
// here, where import.meta.url still points at bin/trio.mjs.
const bin = fileURLToPath(import.meta.url);

// The context every command module receives. root and rest are read-only;
// the rest are the helpers bin/trio.mjs used to define inline, now shared
// from src/commands/context.mjs and bound to this invocation's root.
const ctx = {
  root,
  rest,
  out,
  run,
  unavailable,
  codexRefusal,
  gatherState: (opts) => gatherState(root, opts),
  beforeFirstPass: (args) => beforeFirstPass(root, bin, args),
  activeRun: () => activeRun(root),
  latestFinishedRun: () => latestFinishedRun(root),
  stopLensesOnSignal: () => stopLensesOnSignal(root),
  ensureGitignore: () => ensureGitignore(root),
};

const commands = {
  status: statusCommand,
  panel: statusCommand,
  on: onCommand,
  off: offCommand,
  doctor: doctorCommand,
  config: configCommand,
  lens: lensCommand,
  models: modelsCommand,
  serve: serveCommand,
  promote: promoteCommand,
  render: renderCommand,
  verdicts: verdictsCommand,
  cancel: cancelCommand,
  run: runCommand,
  extend: extendCommand,
  continue: continueCommand,
  consult: consultCommand,
};

const handler = commands[cmd ?? "status"];
if (handler) {
  await handler(ctx);
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  out(USAGE);
} else {
  out(`unknown command: ${cmd}\n\n${USAGE}`);
  process.exitCode = 2;
}
