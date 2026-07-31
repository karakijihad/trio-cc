import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, laneOf, main } from "../src/hook-emit.mjs";
import { readEvents } from "../src/bus.mjs";
import { activeMarker, trioDir, runDir } from "../src/paths.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-hook-"));

const activate = (root, runId = "r1") => {
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(activeMarker(root), JSON.stringify({ run: runId, pass: 1 }));
  return runDir(root, runId);
};

test("laneOf returns claude:main outside a subagent", () => {
  assert.equal(laneOf({ hook_event_name: "MessageDisplay" }), "claude:main");
});

test("laneOf names the subagent lane from agent_type and agent_id", () => {
  assert.equal(
    laneOf({ agent_type: "code-reviewer", agent_id: "a91f3c2d" }),
    "claude:code-reviewer#a91f",
  );
});

test("normalize maps MessageDisplay to an agent_message", () => {
  const e = normalize({
    hook_event_name: "MessageDisplay",
    message_text: "thinking out loud",
  });
  assert.equal(e.kind, "agent_message");
  assert.equal(e.payload.text, "thinking out loud");
  assert.equal(e.actor, "claude");
});

test("normalize turns an Edit PostToolUse into a unified diff", () => {
  const e = normalize({
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: "src/a.js",
      old_string: "let y = 2;",
      new_string: "let y = 3;",
    },
  });
  assert.equal(e.kind, "file_change");
  assert.match(e.payload.diff, /^-let y = 2;$/m);
  assert.match(e.payload.diff, /^\+let y = 3;$/m);
});

test("normalize maps a Bash PreToolUse to command_execution", () => {
  const e = normalize({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  assert.equal(e.kind, "command_execution");
  assert.equal(e.payload.command, "npm test");
});

test("normalize maps PostToolUseFailure to an error", () => {
  const e = normalize({
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    error: "exit 1",
  });
  assert.equal(e.kind, "error");
  assert.equal(e.payload.error, "exit 1");
});

test("normalize maps subagent lifecycle events", () => {
  assert.equal(
    normalize({
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      agent_id: "ab12",
    }).kind,
    "subagent_start",
  );
  assert.equal(
    normalize({
      hook_event_name: "SubagentStop",
      agent_type: "Explore",
      agent_id: "ab12",
      last_assistant_message: "done",
    }).kind,
    "subagent_stop",
  );
});

test("normalize returns null for an event with nothing to record", () => {
  assert.equal(
    normalize({ hook_event_name: "MessageDisplay", message_text: "" }),
    null,
  );
});

test("main is a no-op when the active marker is absent", () => {
  const root = tmp();
  main(
    JSON.stringify({ hook_event_name: "MessageDisplay", message_text: "hi" }),
    root,
  );
  assert.deepEqual(readEvents(runDir(root, "r1")), []);
});

test("main appends to the active run when the marker is present", () => {
  const root = tmp();
  const dir = activate(root);
  main(
    JSON.stringify({ hook_event_name: "MessageDisplay", message_text: "hi" }),
    root,
  );
  const events = readEvents(dir);
  assert.equal(events.length, 1);
  assert.equal(events[0].lane, "claude:main");
  assert.equal(events[0].pass, 1);
});

test("main swallows malformed stdin rather than throwing", () => {
  const root = tmp();
  activate(root);
  assert.doesNotThrow(() => main("not json at all", root));
});
