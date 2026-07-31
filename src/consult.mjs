import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { makeEvent, appendEvent } from "./bus.mjs";
import { mapEvent, SANDBOX } from "./codex-lane.mjs";
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
}) {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    SANDBOX,
    "--skip-git-repo-check",
    "--cd",
    target,
    "-m",
    model,
    "-c",
    `model_reasoning_effort=${effort}`,
  ];
  const cmd = codexCommand(args);
  const proc = spawnFn(cmd.file, cmd.args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...cmd.opts,
  });
  proc.stdin.write(PREAMBLE + question);
  proc.stdin.end();

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

  const code = await new Promise((resolve) => proc.on("close", resolve));
  if (code !== 0) return { answer: "", threadId, failed: true };
  return { answer: messages.join("\n\n").trim(), threadId, failed: false };
}

export function renderComparison({
  question,
  claudeAnswer,
  codexAnswer,
  codexFailed = false,
}) {
  return [
    `# Consult — ${question}`,
    "",
    "## Claude",
    "",
    claudeAnswer.trim() || "_No answer._",
    "",
    "## Codex",
    "",
    codexFailed
      ? "_Codex did not answer — the run failed. Treat this as one opinion, not two._"
      : codexAnswer.trim() || "_No answer._",
    "",
  ].join("\n");
}
