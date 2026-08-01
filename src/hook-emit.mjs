import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { makeEvent, appendEvent, eventsFile } from "./bus.mjs";
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

// The marker deliberately outlives a pass so Claude's fixes reach the next
// one, and this tap fires on every tool call for as long as it exists. A run
// parked between passes therefore records hours of work that has nothing to
// do with the audit — the 2026-08-01 run logged 23 minutes of it, and its
// only "error" event was an unrelated shell exit code. The audit record
// itself is written on the Codex lane and is never capped; only this is.
export const TAP_CEILING_BYTES = 8 * 1024 * 1024;

const tapIsFull = (dir) => {
  try {
    return statSync(eventsFile(dir)).size > TAP_CEILING_BYTES;
  } catch {
    return false; // no log yet — nothing to outgrow
  }
};

export function main(rawStdin, root) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(activeMarker(root), "utf8"));
  } catch {
    return; // Trio is off — the fast path
  }
  // `run: null` is a real marker state — a start that claimed the marker but
  // has not named its run yet. runDir would throw on it, and this line sits
  // outside the catch below, so the guard has to come first: a tap must never
  // break a tool call.
  if (!marker.run || tapIsFull(runDir(root, marker.run))) return;
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
