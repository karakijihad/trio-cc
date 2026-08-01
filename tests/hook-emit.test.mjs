import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalize,
  laneOf,
  main,
  TAP_CEILING_BYTES,
} from "../src/hook-emit.mjs";
import { readEvents, eventsFile } from "../src/bus.mjs";
import { activeMarker, trioDir, runDir } from "../src/paths.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-hook-"));

const activate = (root, runId = "r1") => {
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(activeMarker(root), JSON.stringify({ run: runId, pass: 1 }));
  return runDir(root, runId);
};

// The marker outlives a pass on purpose, so this tap would otherwise record
// hours of unrelated work while a run sits parked between passes.
test("the tap stops appending once the log is oversized", () => {
  const root = tmp();
  const dir = activate(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(eventsFile(dir), "x".repeat(TAP_CEILING_BYTES + 1));
  main(
    JSON.stringify({
      hook_event_name: "MessageDisplay",
      message_text: "after the ceiling",
    }),
    root,
  );
  assert.equal(
    readEvents(dir).some((e) => e.payload?.text === "after the ceiling"),
    false,
  );
});

// A start that claimed the marker but has not named its run yet writes
// {run: null}. A tap must never break a tool call, whatever it finds there.
test("the tap survives a marker that names no run", () => {
  const root = tmp();
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(activeMarker(root), JSON.stringify({ run: null, pass: 0 }));
  assert.doesNotThrow(() =>
    main(
      JSON.stringify({
        hook_event_name: "MessageDisplay",
        message_text: "mid-claim",
      }),
      root,
    ),
  );
});

test("the tap appends normally below the ceiling", () => {
  const root = tmp();
  const dir = activate(root);
  main(
    JSON.stringify({
      hook_event_name: "MessageDisplay",
      message_text: "under the ceiling",
    }),
    root,
  );
  assert.equal(
    readEvents(dir).some((e) => e.payload?.text === "under the ceiling"),
    true,
  );
});

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
