import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeEvent,
  appendEvent,
  readEvents,
  readEventsFrom,
  eventsFile,
} from "../src/bus.mjs";

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

test("readEventsFrom returns nothing and offset 0 for a directory with no log", () => {
  const r = readEventsFrom(tmp());
  assert.deepEqual(r.events, []);
  assert.equal(r.offset, 0);
});

test("readEventsFrom parses only the lines appended after the given offset", () => {
  const dir = tmp();
  const ev = (kind) =>
    makeEvent({ run: "r", pass: 1, lane: "l", actor: "codex", kind, payload: {} });
  appendEvent(dir, ev("agent_message"));
  const first = readEventsFrom(dir, 0);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].kind, "agent_message");

  appendEvent(dir, ev("reasoning"));
  appendEvent(dir, ev("error"));
  const second = readEventsFrom(dir, first.offset);
  assert.deepEqual(
    second.events.map((e) => e.kind),
    ["reasoning", "error"],
  );

  // Nothing new since the last read: no lines, offset unchanged.
  const third = readEventsFrom(dir, second.offset);
  assert.deepEqual(third.events, []);
  assert.equal(third.offset, second.offset);
});

test("readEventsFrom holds back a trailing partial line", () => {
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
  const { offset } = readEventsFrom(dir, 0);
  // A write in progress: valid JSON so far, but no trailing newline yet.
  appendFileSync(eventsFile(dir), '{"kind":"reasoning"');
  const mid = readEventsFrom(dir, offset);
  assert.deepEqual(mid.events, []);
  assert.equal(mid.offset, offset, "must not consume the incomplete line");

  // The rest of the line arrives, plus the terminating newline.
  appendFileSync(eventsFile(dir), ',"finished":true}\n');
  const after = readEventsFrom(dir, mid.offset);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].finished, true);
});

test("readEventsFrom resets to the start when the log is truncated or replaced", () => {
  const dir = tmp();
  const ev = (kind) =>
    makeEvent({ run: "r", pass: 1, lane: "l", actor: "codex", kind, payload: {} });
  appendEvent(dir, ev("agent_message"));
  appendEvent(dir, ev("reasoning"));
  const { offset } = readEventsFrom(dir, 0);

  // A new run reusing the path, or a rotation: the file is now shorter than
  // the offset a stale reader is holding.
  writeFileSync(eventsFile(dir), JSON.stringify(ev("error")) + "\n");
  const after = readEventsFrom(dir, offset);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].kind, "error");
});

test("readEventsFrom does not re-read bytes before the offset", () => {
  const dir = tmp();
  const big = "x".repeat(16 * 1024);
  appendEvent(
    dir,
    makeEvent({
      run: "r",
      pass: 1,
      lane: "l",
      actor: "codex",
      kind: "agent_message",
      payload: { text: big },
    }),
  );
  const first = readEventsFrom(dir, 0);
  appendEvent(
    dir,
    makeEvent({
      run: "r",
      pass: 1,
      lane: "l",
      actor: "codex",
      kind: "reasoning",
      payload: {},
    }),
  );
  const size = statSync(eventsFile(dir)).size;
  // A read positioned at the prior offset only pulls the bytes appended
  // since — proof it is not re-scanning the (now large) start of the file.
  assert.ok(size - first.offset < big.length);
  const second = readEventsFrom(dir, first.offset);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].kind, "reasoning");
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
