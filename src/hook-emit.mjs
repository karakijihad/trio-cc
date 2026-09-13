import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { makeEvent, appendEvent, eventsFile } from "./bus.mjs";
import { unifiedDiff } from "./diff.mjs";
import { activeMarker, runDir, trioDir } from "./paths.mjs";

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

// Windows paths are case-insensitive and drive-lettered, and tool_input
// arrives with whatever separators the tool used — resolve() folds `/` and
// `\` into the platform separator, and lower-casing on win32 makes `C:\Foo`
// and `c:\foo` compare equal.
function canonical(p) {
  const abs = resolve(String(p ?? ""));
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function isWithin(parentDir, candidatePath) {
  if (!parentDir || !candidatePath) return false;
  const parent = canonical(parentDir);
  const child = canonical(candidatePath);
  return child === parent || child.startsWith(parent + sep);
}

// run.json is the run's own record of what it was pointed at (D-scope) — read
// fresh per hook fire rather than cached, since a tap is a short-lived process
// with nothing to cache across. Absence or a malformed file reads as "unknown
// target": readTarget returns null, and inScope below fails closed on that
// rather than guessing.
function readTarget(dir) {
  try {
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    return typeof run.target === "string" ? run.target : null;
  } catch {
    return null;
  }
}

// A file_change event reaches Codex's next-pass brief verbatim
// (prompt.mjs renderChangesSection, "What Claude changed since"). This tap
// fires on every Edit/Write with no regard for what got edited, and that
// included Claude's own bookkeeping — a run's scratchpad files, its own
// pass's response.json, .trio/runs/**/*.json — none of which the audited
// project contains and none of which a lens should ever read. A real run
// (.trio/runs/2026-09-13T14-28-20) had Codex's pass 2 reading Claude's own
// pass-2 findings this way, which is exactly the lane-independence break the
// separate Claude/Codex lanes exist to prevent.
//
// This filter runs here, at capture, rather than at render in prompt.mjs.
// Render-time filtering would be the better shape — it would keep this raw
// event log (which render-html.mjs's viewer reads in full) complete, and
// narrow only what a lens's brief receives. But the run's target only reaches
// prompt.mjs's claudeChanges()/buildLensPrompt() through driver.mjs's
// briefFor closure, which is outside this change's file list; filtering
// there would need driver.mjs threading `target` into calls it does not
// currently pass it to. Filtering at capture needs no such change: this tap
// already resolves the run directory to check the tap ceiling, and run.json
// lives right there.
function inScope(root, target, filePath) {
  if (isWithin(trioDir(root), filePath)) return false;
  return isWithin(target, filePath);
}

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
    const dir = runDir(root, marker.run);
    const input = JSON.parse(rawStdin);
    // Scope before normalize: normalize computes the diff, which can be a
    // 4000×4000 LCS, and an out-of-scope edit is dropped anyway.
    if (
      input?.hook_event_name === "PostToolUse" &&
      (input.tool_name === "Edit" || input.tool_name === "Write") &&
      !inScope(root, readTarget(dir), input.tool_input?.file_path ?? "")
    ) {
      return;
    }
    const fields = normalize(input);
    if (!fields) return;
    appendEvent(
      dir,
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
