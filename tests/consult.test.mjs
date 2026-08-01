import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { askCodex } from "../src/consult.mjs";
import { readEvents } from "../src/bus.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-consult-"));

function fakeSpawn(stdout, code = 0) {
  return () => {
    const p = new EventEmitter();
    p.stdout = Readable.from([stdout]);
    p.stderr = Readable.from([]);
    p.stdin = { write() {}, end() {}, on() {} };
    p.stdout.on("end", () => setImmediate(() => p.emit("close", code)));
    return p;
  };
}

// A consult is a Codex process like any other and hangs like one; this file
// duplicates runLens's spawn-and-settle shape, so it needs the same deadline.
function hangingSpawn(onKill = () => {}) {
  return () => {
    const p = new EventEmitter();
    p.stdout = new Readable({ read() {} });
    p.stderr = Readable.from([]);
    p.stdin = { write() {}, end() {}, on() {} };
    p.kill = () => {
      onKill();
      p.stdout.push(null);
      setImmediate(() => p.emit("close", null));
    };
    return p;
  };
}

test("askCodex stops a consult that never answers", async () => {
  let killed = 0;
  const r = await askCodex({
    question: "why?",
    target: "/repo",
    model: "m",
    effort: "low",
    runDirPath: tmp(),
    run: "c1",
    spawnFn: hangingSpawn(() => killed++),
    timeoutMs: 50,
  });
  assert.equal(killed, 1);
  assert.equal(r.failed, true);
  assert.match(r.error, /timed out after/);
});

const STREAM =
  [
    '{"type":"thread.started","thread_id":"th-1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Use a mutex, not a spinlock."}}',
    '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":9}}',
  ].join("\n") + "\n";

test("askCodex returns the final answer and thread id", async () => {
  const r = await askCodex({
    question: "q",
    target: "/repo",
    model: "m",
    effort: "high",
    runDirPath: tmp(),
    run: "c1",
    spawnFn: fakeSpawn(STREAM),
  });
  assert.equal(r.threadId, "th-1");
  assert.match(r.answer, /mutex/);
});

test("askCodex records its activity on the codex:consult lane", async () => {
  const dir = tmp();
  await askCodex({
    question: "q",
    target: "/repo",
    model: "m",
    effort: "high",
    runDirPath: dir,
    run: "c1",
    spawnFn: fakeSpawn(STREAM),
  });
  assert.ok(readEvents(dir).every((e) => e.lane === "codex:consult"));
});

test("askCodex reports a failure rather than throwing", async () => {
  const r = await askCodex({
    question: "q",
    target: "/repo",
    model: "m",
    effort: "high",
    runDirPath: tmp(),
    run: "c1",
    spawnFn: fakeSpawn("", 1),
  });
  assert.equal(r.answer, "");
  assert.equal(r.failed, true);
});
