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
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { askCodex } from "../../src/consult.mjs";
import { readEvents } from "../../src/bus.mjs";
import consultCommand from "../../src/commands/consult.mjs";
import { unavailable, ensureGitignore } from "../../src/commands/context.mjs";
import { fakeCodexOnPath } from "../helpers/fake-codex.mjs";

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
// `trio consult`'s command module (src/commands/consult.mjs) in-process, the
// way bin/trio.mjs does, rather than askCodex directly: run.json is written
// there, not in this file's askCodex. Only the fake codex it launches is a
// child process; the CLI shell around it is not what is under test.
async function runConsult(root, question, { exit } = {}) {
  const outs = [];
  const priorExitCode = process.exitCode;
  const priorFakeExit = process.env.FAKE_CODEX_EXIT;
  if (exit !== undefined) process.env.FAKE_CODEX_EXIT = String(exit);
  process.exitCode = undefined;
  try {
    await consultCommand({
      root,
      rest: [question],
      out: (t) => outs.push(t),
      gatherState: () => ({
        pre: { state: "ready" },
        caps: null,
        consult: { model: null, effort: "high" },
      }),
      codexRefusal: () => null,
      unavailable,
      ensureGitignore: () => ensureGitignore(root),
    });
    return { status: process.exitCode ?? 0, out: outs.join("") };
  } finally {
    process.exitCode = priorExitCode;
    if (priorFakeExit === undefined) delete process.env.FAKE_CODEX_EXIT;
    else process.env.FAKE_CODEX_EXIT = priorFakeExit;
  }
}

function consultProject() {
  const root = mkdtempSync(join(tmpdir(), "trio-consult-cmd-"));
  mkdirSync(join(root, ".trio"), { recursive: true });
  return root;
}

function consultRunJson(root) {
  const runsDir = join(root, ".trio", "runs");
  const [runId] = readdirSync(runsDir).filter((n) => n.startsWith("consult-"));
  return JSON.parse(readFileSync(join(runsDir, runId, "run.json"), "utf8"));
}

test("trio consult writes run.json with the question, model, effort and trio's version", async () => {
  const root = consultProject();
  // A git checkout: the question is persisted verbatim, so .trio/ has to be
  // ignored before run.json is written.
  mkdirSync(join(root, ".git"));
  const res = await runConsult(root, "is this sound?");
  assert.equal(res.status, 0, res.out);
  const json = consultRunJson(root);
  assert.equal(json.kind, "consult");
  assert.equal(json.question, "is this sound?");
  assert.match(json.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(json.trioVersion, pkg.version);
  assert.match(json.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(json.failed, false);
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.trio\/$/m);
});

test("trio consult marks run.json failed when Codex exits non-zero", async () => {
  const root = consultProject();
  const res = await runConsult(root, "is this sound?", { exit: 1 });
  assert.equal(res.status, 1);
  const json = consultRunJson(root);
  assert.equal(json.failed, true);
  assert.match(json.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("two consults minted in the same second get separate directories", async () => {
  const { claimConsultDir } = await import("../../src/commands/consult.mjs");
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runDir } = await import("../../src/paths.mjs");
  const root = mkdtempSync(join(tmpdir(), "trio-consult-id-"));
  const base = "consult-2026-09-23T20-20-24";
  const a = claimConsultDir(root, base);
  const b = claimConsultDir(root, base);
  assert.equal(a, base);
  assert.equal(b, `${base}-2`);
  assert.ok(existsSync(runDir(root, a)) && existsSync(runDir(root, b)));
});
