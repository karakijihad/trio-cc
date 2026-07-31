import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { askCodex, renderComparison } from "../src/consult.mjs";
import { readEvents } from "../src/bus.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-consult-"));

function fakeSpawn(stdout, code = 0) {
  return () => {
    const p = new EventEmitter();
    p.stdout = Readable.from([stdout]);
    p.stderr = Readable.from([]);
    p.stdin = { write() {}, end() {} };
    p.stdout.on("end", () => setImmediate(() => p.emit("close", code)));
    return p;
  };
}

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

test("renderComparison shows both answers under labelled headings", () => {
  const md = renderComparison({
    question: "Is this locking sound?",
    claudeAnswer: "A mutex is fine here.",
    codexAnswer: "Use a mutex, not a spinlock.",
  });
  assert.match(md, /## Claude/);
  assert.match(md, /## Codex/);
  assert.match(md, /Is this locking sound\?/);
  assert.match(md, /spinlock/);
});

test("renderComparison flags a failed Codex answer instead of pretending agreement", () => {
  const md = renderComparison({
    question: "q",
    claudeAnswer: "a",
    codexAnswer: "",
    codexFailed: true,
  });
  assert.match(md, /did not answer/i);
});
