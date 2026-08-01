import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { makeEvent, appendEvent } from "./bus.mjs";
import {
  mapEvent,
  buildArgs,
  killTree,
  DEFAULT_TIMEOUT_MS,
} from "./codex-lane.mjs";
import { codexCommand } from "./paths.mjs";

const PREAMBLE =
  "Answer the question below on its own merits. Read whatever code you need; change nothing. Be concrete and say where you are uncertain.\n\n";

export async function askCodex({
  question,
  target,
  model,
  effort,
  runDirPath,
  run,
  spawnFn = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const cmd = codexCommand(buildArgs({ target, model, effort }));
  const proc = spawnFn(cmd.file, cmd.args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...cmd.opts,
  });

  // See runLens: an unlistened 'error' from a failed launch is an uncaught
  // exception, not a failed consult.
  let launchError = null;
  proc.on("error", (err) => {
    launchError = err;
  });
  proc.stdin?.on?.("error", () => {});

  // A consult is a Codex process like any other and hangs like one. This file
  // duplicates runLens's spawn-and-settle shape, and the deadline added there
  // has to be duplicated with it or `trio consult` waits for ever.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    killTree(proc);
  }, timeoutMs);
  try {
    proc.stdin.write(PREAMBLE + question);
    proc.stdin.end();
  } catch {
    /* the child never started */
  }

  let threadId = null;
  const messages = [];
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "thread.started") threadId = ev.thread_id;
    const mapped = mapEvent(ev);
    if (!mapped) return;
    if (mapped.kind === "agent_message") messages.push(mapped.payload.text);
    appendEvent(
      runDirPath,
      makeEvent({
        run,
        pass: 0,
        lane: "codex:consult",
        actor: "codex",
        ...mapped,
      }),
    );
  });

  const code = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    proc.on("close", done);
    proc.on("error", () => done(null));
  });
  clearTimeout(deadline);
  if (timedOut)
    return {
      answer: "",
      threadId,
      failed: true,
      error: `codex timed out after ${Math.round(timeoutMs / 60_000)}m and was stopped`,
    };
  if (launchError || code !== 0) return { answer: "", threadId, failed: true };
  return { answer: messages.join("\n\n").trim(), threadId, failed: false };
}
