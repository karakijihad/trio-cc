import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, appendEvent, readEvents, eventsFile } from "../src/bus.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-bus-"));

test("makeEvent stamps ts and keeps the given fields", () => {
  const e = makeEvent({
    run: "r1",
    pass: 1,
    lane: "codex:auditor",
    actor: "codex",
    kind: "agent_message",
    payload: { text: "hi" },
  });
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(e.lane, "codex:auditor");
  assert.equal(e.actor, "codex");
  assert.equal(e.payload.text, "hi");
});

test("makeEvent scrubs secrets in string payload fields", () => {
  const e = makeEvent({
    run: "r",
    pass: 1,
    lane: "l",
    actor: "codex",
    kind: "command_execution",
    payload: { output: "token sk-proj-AAAABBBBCCCCDDDD1234" },
  });
  assert.match(e.payload.output, /<redacted:token>/);
});

test("makeEvent leaves non-string payload fields alone", () => {
  const e = makeEvent({
    run: "r",
    pass: 1,
    lane: "l",
    actor: "codex",
    kind: "command_execution",
    payload: { exit_code: 0, ok: true },
  });
  assert.equal(e.payload.exit_code, 0);
  assert.equal(e.payload.ok, true);
});

test("append then read round-trips every event kind", () => {
  const dir = tmp();
  const kinds = [
    "agent_message",
    "command_execution",
    "reasoning",
    "file_change",
    "tool_use",
    "subagent_start",
    "subagent_stop",
    "error",
    "usage",
  ];
  for (const kind of kinds)
    appendEvent(
      dir,
      makeEvent({
        run: "r",
        pass: 1,
        lane: "l",
        actor: "codex",
        kind,
        payload: {},
      }),
    );
  const back = readEvents(dir);
  assert.deepEqual(
    back.map((e) => e.kind),
    kinds,
  );
});

test("readEvents returns empty for a directory with no log", () => {
  assert.deepEqual(readEvents(tmp()), []);
});

test("readEvents skips a malformed line instead of throwing", () => {
  const dir = tmp();
  appendEvent(
    dir,
    makeEvent({
      run: "r",
      pass: 1,
      lane: "l",
      actor: "codex",
      kind: "agent_message",
      payload: {},
    }),
  );
  appendFileSync(eventsFile(dir), "this is not json\n");
  appendEvent(
    dir,
    makeEvent({
      run: "r",
      pass: 1,
      lane: "l",
      actor: "codex",
      kind: "error",
      payload: {},
    }),
  );
  const back = readEvents(dir);
  assert.equal(back.length, 2);
  assert.equal(back[1].kind, "error");
});

test("every appended event is exactly one line", () => {
  const dir = tmp();
  appendEvent(
    dir,
    makeEvent({
      run: "r",
      pass: 1,
      lane: "l",
      actor: "claude",
      kind: "agent_message",
      payload: { text: "multi\nline\ntext" },
    }),
  );
  assert.equal(readEvents(dir).length, 1);
});

test("makeEvent scrubs secrets nested in objects and arrays", () => {
  const e = makeEvent({
    run: "r",
    pass: 1,
    lane: "l",
    actor: "codex",
    kind: "command_execution",
    payload: {
      detail: { output: "token sk-proj-AAAABBBBCCCCDDDD1234" },
      lines: ["clean line", "key sk-proj-AAAABBBBCCCCDDDD1234"],
      exit_code: 0,
    },
  });
  assert.match(e.payload.detail.output, /<redacted:token>/);
  assert.match(e.payload.lines[1], /<redacted:token>/);
  assert.equal(e.payload.lines[0], "clean line");
  assert.equal(e.payload.exit_code, 0);
});
