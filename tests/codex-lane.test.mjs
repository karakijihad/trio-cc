import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { buildArgs, mapEvent, runLens, SANDBOX } from "../src/codex-lane.mjs";
import { readEvents } from "../src/bus.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-lane-"));
const FIXTURE = readFileSync(
  new URL("./fixtures/codex-audit.jsonl", import.meta.url),
  "utf8",
);

function fakeSpawn(stdout, { code = 0 } = {}) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = Readable.from([stdout]);
    proc.stderr = Readable.from([]);
    proc.stdin = { write() {}, end() {}, on() {} };
    proc.stdout.on("end", () => setImmediate(() => proc.emit("close", code)));
    return proc;
  };
}

const LENS = {
  name: "auditor",
  model: "gpt-5.6-luna",
  effort: "xhigh",
  on: true,
};

test("sandbox is read-only and frozen", () => {
  assert.equal(SANDBOX, "read-only");
});

test("buildArgs always passes read-only and never a write sandbox", () => {
  const args = buildArgs({ target: "/repo", model: LENS.model, effort: LENS.effort });
  assert.ok(args.includes("--sandbox"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args.includes("workspace-write"), false);
  assert.equal(args.includes("danger-full-access"), false);
});

test("buildArgs carries json, cwd, model and effort", () => {
  const args = buildArgs({ target: "/repo", model: LENS.model, effort: LENS.effort });
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.equal(args[args.indexOf("--cd") + 1], "/repo");
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-luna");
  assert.ok(args.includes("model_reasoning_effort=xhigh"));
});

test("mapEvent maps an agent_message", () => {
  const e = mapEvent({
    type: "item.completed",
    item: { type: "agent_message", text: "hello" },
  });
  assert.equal(e.kind, "agent_message");
  assert.equal(e.payload.text, "hello");
});

test("mapEvent maps a completed command_execution with its exit code", () => {
  const e = mapEvent({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "ls",
      aggregated_output: "a.rs",
      exit_code: 0,
      status: "completed",
    },
  });
  assert.equal(e.kind, "command_execution");
  assert.equal(e.payload.exit_code, 0);
  assert.equal(e.payload.command, "ls");
});

test("mapEvent maps turn.completed to usage", () => {
  const e = mapEvent({
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  assert.equal(e.kind, "usage");
  assert.equal(e.payload.input_tokens, 10);
});

test("mapEvent ignores turn.started", () => {
  assert.equal(mapEvent({ type: "turn.started" }), null);
});

test("runLens returns parsed findings and the thread id", async () => {
  const dir = tmp();
  const r = await runLens({
    lens: LENS,
    target: "/repo",
    brief: "audit it",
    runDirPath: dir,
    run: "r1",
    pass: 1,
    spawnFn: fakeSpawn(FIXTURE),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.threadId, "019fad96-27d2-78c2-85fa-f03cf7925b2f");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].title, "unchecked unsafe block");
});

test("runLens writes every mapped event to the bus on the lens lane", async () => {
  const dir = tmp();
  await runLens({
    lens: LENS,
    target: "/repo",
    brief: "b",
    runDirPath: dir,
    run: "r1",
    pass: 1,
    spawnFn: fakeSpawn(FIXTURE),
  });
  const events = readEvents(dir);
  assert.ok(
    events.every((e) => e.lane === "codex:auditor" && e.actor === "codex"),
  );
  assert.ok(events.some((e) => e.kind === "command_execution"));
  assert.ok(events.some((e) => e.kind === "usage"));
});

test("runLens retries once, then reports unparseable", async () => {
  const dir = tmp();
  let calls = 0;
  const spawnFn = () => {
    calls++;
    return fakeSpawn(
      '{"type":"item.completed","item":{"type":"agent_message","text":"no block here"}}\n',
    )();
  };
  const r = await runLens({
    lens: LENS,
    target: "/repo",
    brief: "b",
    runDirPath: dir,
    run: "r1",
    pass: 1,
    spawnFn,
  });
  assert.equal(calls, 2);
  assert.equal(r.status, "unparseable");
  assert.match(r.raw, /no block here/);
});

test("runLens reports failed on a non-zero exit", async () => {
  const dir = tmp();
  const r = await runLens({
    lens: LENS,
    target: "/repo",
    brief: "b",
    runDirPath: dir,
    run: "r1",
    pass: 1,
    spawnFn: fakeSpawn("", { code: 1 }),
  });
  assert.equal(r.status, "failed");
  assert.deepEqual(r.findings, []);
});

test("a launch failure settles the lens as failed instead of crashing", async () => {
  const dir = tmp();
  // What Node does when the binary cannot be executed: an 'error' event and
  // no process. Unlistened, it becomes an uncaught exception that takes the
  // whole audit down.
  const spawnFn = () => {
    const proc = new EventEmitter();
    proc.stdout = Readable.from([]);
    proc.stderr = Readable.from([]);
    proc.stdin = { write() {}, end() {}, on() {} };
    setImmediate(() => {
      const err = new Error("spawn codex ENOENT");
      err.code = "ENOENT";
      proc.emit("error", err);
      proc.emit("close", null);
    });
    return proc;
  };
  const r = await runLens({
    lens: LENS,
    target: "/repo",
    brief: "b",
    runDirPath: dir,
    run: "r1",
    pass: 1,
    spawnFn,
  });
  assert.equal(r.status, "failed");
  assert.deepEqual(r.findings, []);
  assert.ok(
    readEvents(dir).some(
      (e) => e.kind === "error" && /failed to start/.test(e.payload.error),
    ),
  );
});

test("a failed lens still names itself in the result", async () => {
  const dir = tmp();
  const r = await runLens({
    lens: LENS,
    target: "/repo",
    brief: "b",
    runDirPath: dir,
    run: "r1",
    pass: 1,
    spawnFn: fakeSpawn("", { code: 1 }),
  });
  assert.equal(r.lens, "auditor");
});
