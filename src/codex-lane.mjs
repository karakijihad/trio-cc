import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { makeEvent, appendEvent } from "./bus.mjs";
import { extractFindings } from "./findings.mjs";
import { codexCommand } from "./paths.mjs";

export const SANDBOX = "read-only";

const STRICTER =
  '\n\nYour previous reply omitted or malformed the required block. Reply again and end your message with exactly one fenced ```json block of the shape {"findings":[...]}, and nothing after it.';

export function buildArgs({ lens, target }) {
  return [
    "exec",
    "--json",
    "--sandbox",
    SANDBOX,
    "--skip-git-repo-check",
    "--cd",
    target,
    "-m",
    lens.model,
    "-c",
    `model_reasoning_effort=${lens.effort}`,
  ];
}

export function mapEvent(ev) {
  if (ev.type === "turn.completed")
    return { kind: "usage", payload: ev.usage ?? {} };
  if (ev.type === "error")
    return { kind: "error", payload: { error: ev.message ?? "codex error" } };
  if (ev.type !== "item.completed" && ev.type !== "item.started") return null;

  const item = ev.item ?? {};
  if (item.type === "agent_message")
    return { kind: "agent_message", payload: { text: item.text ?? "" } };
  if (item.type === "reasoning")
    return { kind: "reasoning", payload: { text: item.text ?? "" } };
  if (item.type === "command_execution") {
    return {
      kind: "command_execution",
      payload: {
        command: item.command ?? "",
        output: item.aggregated_output ?? "",
        exit_code: item.exit_code ?? null,
        status: item.status ?? "",
      },
    };
  }
  if (item.type === "file_change")
    return {
      kind: "file_change",
      payload: { file: item.path ?? "", diff: item.diff ?? "" },
    };
  return null;
}

export async function runLens({
  lens,
  target,
  brief,
  runDirPath,
  run,
  pass,
  spawnFn = nodeSpawn,
  retried = false,
}) {
  const lane = `codex:${lens.name}`;
  const cmd = codexCommand(buildArgs({ lens, target }));
  const proc = spawnFn(cmd.file, cmd.args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...cmd.opts,
  });

  proc.stdin.write(retried ? brief + STRICTER : brief);
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
      makeEvent({ run, pass, lane, actor: "codex", ...mapped }),
    );
  });

  const code = await new Promise((resolve) => proc.on("close", resolve));
  const raw = messages.join("\n");

  if (code !== 0) {
    appendEvent(
      runDirPath,
      makeEvent({
        run,
        pass,
        lane,
        actor: "codex",
        kind: "error",
        payload: { error: `codex exited ${code}` },
      }),
    );
    return { lens: lens.name, status: "failed", findings: [], threadId, raw };
  }

  const parsed = extractFindings(raw);
  if (parsed.ok)
    return {
      lens: lens.name,
      status: "ok",
      findings: parsed.findings,
      threadId,
      raw,
    };

  if (!retried) {
    return runLens({
      lens,
      target,
      brief,
      runDirPath,
      run,
      pass,
      spawnFn,
      retried: true,
    });
  }
  appendEvent(
    runDirPath,
    makeEvent({
      run,
      pass,
      lane,
      actor: "codex",
      kind: "error",
      payload: { error: `unparseable: ${parsed.reason}` },
    }),
  );
  return {
    lens: lens.name,
    status: "unparseable",
    findings: [],
    threadId,
    raw,
  };
}
