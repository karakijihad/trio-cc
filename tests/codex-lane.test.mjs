import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  buildArgs,
  mapEvent,
  runLens,
  killTree,
  stopAllLenses,
  SANDBOX,
} from "../src/codex-lane.mjs";
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

// A Codex process that produces nothing and never exits on its own — the
// hang the deadline exists for. kill() is what settles it, as the real one does.
function hangingSpawn({ onSpawn = () => {}, onKill = () => {} } = {}) {
  return () => {
    onSpawn();
    const proc = new EventEmitter();
    proc.stdout = new Readable({ read() {} });
    proc.stderr = Readable.from([]);
    proc.stdin = { write() {}, end() {}, on() {} };
    proc.kill = () => {
      onKill();
      proc.stdout.push(null);
      setImmediate(() => proc.emit("close", null));
    };
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

test("killTree takes the whole tree when the platform needs it", () => {
  const calls = [];
  let killed = 0;
  const proc = { pid: 4321, kill: () => killed++ };
  killTree(proc, (file, args) => {
    calls.push([file, args]);
    return { on: () => {} };
  });
  if (process.platform === "win32") {
    assert.deepEqual(calls, [["taskkill", ["/pid", "4321", "/t", "/f"]]]);
    assert.equal(killed, 0);
  } else {
    assert.deepEqual(calls, []);
    assert.equal(killed, 1);
  }
});

// A lens that will not die is worse than one killed imprecisely.
test("killTree falls back to kill() when the tree-killer will not launch", () => {
  let killed = 0;
  const proc = { pid: 4321, kill: () => killed++ };
  killTree(proc, () => {
    throw new Error("ENOENT: taskkill");
  });
  assert.equal(killed, 1);
});

test("killTree falls back to kill() when the tree-killer errors after launch", () => {
  let killed = 0;
  const proc = { pid: 4321, kill: () => killed++ };
  killTree(proc, () => ({
    on: (ev, fn) => {
      if (ev === "error") fn(new Error("spawn failed"));
    },
  }));
  assert.equal(killed, 1);
});

// Off win32 the tree-killer is a no-op, so this registry is the only thing
// that reaches a cancelled run's Codex children. Platform-independent, unlike
// the end-to-end cancel test in cli.test.mjs.
// Bounded: if the registry regresses, these lenses never settle, and a hang
// is a much worse failure signal than a timeout.
test("stopAllLenses tears down every lens still running", { timeout: 15_000 }, async () => {
  const dir = tmp();
  let killed = 0;
  const pending = [1, 2, 3].map((i) =>
    runLens({
      lens: { ...LENS, name: `lens${i}` },
      target: "/repo",
      brief: "b",
      runDirPath: dir,
      run: "r1",
      pass: 1,
      spawnFn: hangingSpawn({ onKill: () => killed++ }),
      timeoutMs: 600_000,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  stopAllLenses();
  const results = await Promise.all(pending);
  assert.equal(killed, 3, "a lens was left running");
  assert.deepEqual(
    results.map((r) => r.status),
    ["failed", "failed", "failed"],
  );
});

test("stopAllLenses forgets lenses that already settled", async () => {
  const dir = tmp();
  let killed = 0;
  await runLens({
    lens: LENS,
    target: "/repo",
    brief: "b",
    runDirPath: dir,
    run: "r1",
    pass: 1,
    spawnFn: hangingSpawn({ onKill: () => killed++ }),
    timeoutMs: 50,
  });
  assert.equal(killed, 1, "the deadline should have killed it once");
  stopAllLenses();
  assert.equal(killed, 1, "a settled lens must not be killed again");
});

test("runLens stops a lens that never produces output", async () => {
  const dir = tmp();
  let killed = 0;
  const r = await runLens({
    lens: LENS,
    target: "/repo",
    brief: "b",
    runDirPath: dir,
    run: "r1",
    pass: 1,
    spawnFn: hangingSpawn({ onKill: () => killed++ }),
    timeoutMs: 50,
  });
  assert.equal(killed, 1);
  assert.equal(r.status, "timeout");
  const errs = readEvents(dir).filter((e) => e.kind === "error");
  assert.equal(errs.length, 1);
  assert.match(errs[0].payload.error, /timed out after/);
});

// A hang retried is two hangs. The timeout has to short-circuit the retry
// path, and must not be reported as a plain non-zero exit.
test("a timed-out lens is not retried", async () => {
  const dir = tmp();
  let spawns = 0;
  const r = await runLens({
    lens: LENS,
    target: "/repo",
    brief: "b",
    runDirPath: dir,
    run: "r1",
    pass: 1,
    spawnFn: hangingSpawn({ onSpawn: () => spawns++ }),
    timeoutMs: 50,
  });
  assert.equal(spawns, 1);
  assert.equal(r.status, "timeout");
  assert.equal(
    readEvents(dir).some((e) => /exited/.test(e.payload.error ?? "")),
    false,
  );
});

test("runLens announces the retry instead of silently doubling", async () => {
  const dir = tmp();
  const spawnFn = () =>
    fakeSpawn(
      '{"type":"item.completed","item":{"type":"agent_message","text":"no block here"}}\n',
    )();
  await runLens({
    lens: LENS,
    target: "/repo",
    brief: "b",
    runDirPath: dir,
    run: "r1",
    pass: 1,
    spawnFn,
  });
  const retries = readEvents(dir).filter((e) => e.kind === "lens_retry");
  assert.equal(retries.length, 1);
  assert.equal(retries[0].lane, "codex:auditor");
  assert.match(retries[0].payload.error, /running this lens once more/);
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
