import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { askCodex } from "../src/consult.mjs";
import { readEvents } from "../src/bus.mjs";
import {
  fakeCodexOnPath,
  installFakeCodex,
  fakeCodexHome,
  fakeEnv,
  CLI,
} from "./helpers/fake-codex.mjs";

// codexCommand resolves against PATH; without this these tests only pass on
// a machine that happens to have the real Codex installed.
fakeCodexOnPath();

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
  // `[].every(...)` is true, so this asserted nothing until it also required
  // events to exist: recording none at all used to pass.
  const events = readEvents(dir);
  assert.ok(events.length > 0, "no consult activity was recorded");
  assert.ok(events.every((e) => e.lane === "codex:consult"));
  assert.ok(events.every((e) => e.actor === "codex"));
  for (const kind of ["agent_message", "usage"])
    assert.ok(
      events.some((e) => e.kind === kind),
      `no ${kind} event`,
    );
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

// The reason was in the log all along; a consult has to read it.
test("askCodex says why Codex failed, from its error events", async () => {
  const r = await askCodex({
    question: "q",
    target: "/repo",
    model: "m",
    effort: "high",
    runDirPath: tmp(),
    run: "c1",
    spawnFn: fakeSpawn(
      '{"type":"error","message":"You\'ve hit your usage limit. Try again at 9:28 PM."}\n',
      1,
    ),
  });
  assert.equal(r.failed, true);
  assert.equal(r.failure.kind, "usage");
  assert.match(r.error, /no usage left/);
});

// A consult used to persist nothing but events.jsonl — no record on disk of
// what was asked, of which model, or whether it ever finished. These drive
// the CLI itself (`trio consult`), the way an operator actually reaches
// src/commands/consult.mjs, rather than askCodex directly: run.json is
// written there, not in this file's askCodex.
function consultProject() {
  const root = mkdtempSync(join(tmpdir(), "trio-consult-cmd-"));
  const pathDir = mkdtempSync(join(tmpdir(), "trio-consult-bin-"));
  const home = mkdtempSync(join(tmpdir(), "trio-consult-home-"));
  installFakeCodex(pathDir);
  fakeCodexHome(home);
  mkdirSync(join(root, ".trio"), { recursive: true });
  const env = fakeEnv({ pathDir, codexHome: home, project: root });
  const cli = (args, extraEnv = {}) =>
    spawnSync("node", [CLI, ...args], {
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
  return { root, cli };
}

function consultRunJson(root) {
  const runsDir = join(root, ".trio", "runs");
  const [runId] = readdirSync(runsDir).filter((n) => n.startsWith("consult-"));
  return JSON.parse(readFileSync(join(runsDir, runId, "run.json"), "utf8"));
}

test("trio consult writes run.json with the question, model, effort and trio's version", () => {
  const { root, cli } = consultProject();
  const res = cli(["consult", "is this sound?"]);
  assert.equal(res.status, 0, res.stderr);
  const json = consultRunJson(root);
  assert.equal(json.kind, "consult");
  assert.equal(json.question, "is this sound?");
  assert.match(json.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(json.trioVersion, pkg.version);
  assert.match(json.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(json.failed, false);
});

test("trio consult marks run.json failed when Codex exits non-zero", () => {
  const { root, cli } = consultProject();
  const res = cli(["consult", "is this sound?"], { FAKE_CODEX_EXIT: "1" });
  assert.equal(res.status, 1);
  const json = consultRunJson(root);
  assert.equal(json.failed, true);
  assert.match(json.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
});
