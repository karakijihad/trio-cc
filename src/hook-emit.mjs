import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { makeEvent, appendEvent } from "./bus.mjs";
import { unifiedDiff } from "./diff.mjs";
import { activeMarker, runDir } from "./paths.mjs";

export function laneOf(p) {
  if (!p.agent_type) return "claude:main";
  const suffix = String(p.agent_id ?? "").slice(0, 4);
  return suffix ? `claude:${p.agent_type}#${suffix}` : `claude:${p.agent_type}`;
}

export function normalize(p) {
  const base = { actor: "claude", lane: laneOf(p) };
  const ev = p.hook_event_name;

  if (ev === "MessageDisplay") {
    if (!p.message_text) return null;
    return {
      ...base,
      kind: "agent_message",
      payload: { text: p.message_text },
    };
  }
  if (ev === "SubagentStart") {
    return {
      ...base,
      kind: "subagent_start",
      payload: { agent_type: p.agent_type, agent_id: p.agent_id },
    };
  }
  if (ev === "SubagentStop") {
    return {
      ...base,
      kind: "subagent_stop",
      payload: {
        agent_type: p.agent_type,
        agent_id: p.agent_id,
        result: p.last_assistant_message ?? "",
      },
    };
  }
  if (ev === "PostToolUseFailure") {
    return {
      ...base,
      kind: "error",
      payload: { tool: p.tool_name, error: p.error ?? "" },
    };
  }
  if (
    ev === "PostToolUse" &&
    (p.tool_name === "Edit" || p.tool_name === "Write")
  ) {
    const i = p.tool_input ?? {};
    const diff =
      p.tool_name === "Edit"
        ? unifiedDiff(i.file_path ?? "", i.old_string ?? "", i.new_string ?? "")
        : unifiedDiff(i.file_path ?? "", "", i.content ?? "");
    return {
      ...base,
      kind: "file_change",
      payload: { file: i.file_path ?? "", diff },
    };
  }
  if (ev === "PreToolUse" || ev === "PostToolUse") {
    const i = p.tool_input ?? {};
    if (p.tool_name === "Bash") {
      return {
        ...base,
        kind: "command_execution",
        payload: { command: i.command ?? "", description: i.description ?? "" },
      };
    }
    return {
      ...base,
      kind: "tool_use",
      payload: {
        tool: p.tool_name,
        target: i.file_path ?? i.pattern ?? i.url ?? "",
      },
    };
  }
  return null;
}

export function main(rawStdin, root) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(activeMarker(root), "utf8"));
  } catch {
    return; // Trio is off — the fast path
  }
  try {
    const fields = normalize(JSON.parse(rawStdin));
    if (!fields) return;
    appendEvent(
      runDir(root, marker.run),
      makeEvent({ run: marker.run, pass: marker.pass ?? 0, ...fields }),
    );
  } catch {
    // a tap must never break a tool call
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    main(
      Buffer.concat(chunks).toString("utf8"),
      process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    );
    process.exit(0);
  });
}
