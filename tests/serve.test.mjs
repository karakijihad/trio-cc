import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../src/serve.mjs";
import { appendEvent, makeEvent } from "../src/bus.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-serve-"));
const seed = (dir, kind) =>
  appendEvent(
    dir,
    makeEvent({
      run: "r",
      pass: 1,
      lane: "codex:auditor",
      actor: "codex",
      kind,
      payload: { text: "x" },
    }),
  );

test("binds loopback only", async () => {
  const { server, port } = await start({ runDirPath: tmp(), port: 0 });
  assert.equal(server.address().address, "127.0.0.1");
  assert.ok(port > 0);
  server.close();
});

test("walks past an occupied port and reports the one it actually bound", async () => {
  const first = await start({ runDirPath: tmp(), port: 0 });
  // Ask for the port already in use: the server must move on, and the URL it
  // returns is the only truthful one — the configured port is a request.
  const second = await start({ runDirPath: tmp(), port: first.port });
  assert.notEqual(second.port, first.port);
  assert.equal(second.url, `http://127.0.0.1:${second.port}`);
  const res = await fetch(second.url);
  assert.equal(res.status, 200);
  first.server.close();
  second.server.close();
});

test("serves the pane html at /", async () => {
  const { server, url } = await start({ runDirPath: tmp(), port: 0 });
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /<!doctype html>/i);
  server.close();
});

test("/events replays the existing backlog as SSE data lines", async () => {
  const dir = tmp();
  seed(dir, "agent_message");
  seed(dir, "command_execution");
  const { server, url } = await start({ runDirPath: dir, port: 0 });

  const res = await fetch(`${url}/events`);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);

  // Reading one chunk and checking for the first event let a server that
  // dropped everything after it pass. Read until both seeded events arrive.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + 5000;
  while (
    !(seen.includes("agent_message") && seen.includes("command_execution")) &&
    Date.now() < deadline
  ) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  server.close();

  assert.match(seen, /^data: /m);
  assert.ok(seen.includes("agent_message"), "first backlog event missing");
  assert.ok(seen.includes("command_execution"), "second backlog event missing");
  assert.ok(
    seen.indexOf("agent_message") < seen.indexOf("command_execution"),
    "backlog replayed out of order",
  );
});

test("/version reports the plugin manifest's version", async () => {
  const { server, url } = await start({ runDirPath: tmp(), port: 0 });
  const res = await fetch(`${url}/version`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  const body = await res.json();
  // Pinning the exact number here would make every release touch this test;
  // what matters is that it is the manifest's value, not a hardcoded one.
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(
    readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url)),
  );
  assert.equal(body.version, manifest.version);
  server.close();
});

test("unknown paths return 404", async () => {
  const { server, url } = await start({ runDirPath: tmp(), port: 0 });
  assert.equal((await fetch(`${url}/nope`)).status, 404);
  server.close();
});

test("the server never writes to the run directory", async () => {
  const dir = tmp();
  seed(dir, "agent_message");
  const { server, url } = await start({ runDirPath: dir, port: 0 });
  await fetch(url);
  const res = await fetch(`${url}/events`);
  await res.body.getReader().cancel();
  const { readEvents } = await import("../src/bus.mjs");
  assert.equal(readEvents(dir).length, 1);
  server.close();
});

test("/events survives a run directory with no log file yet", async () => {
  const { server, url } = await start({ runDirPath: tmp(), port: 0 });
  const res = await fetch(`${url}/events`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  await res.body.getReader().cancel();
  server.close();
});

// The verdict has to land *after* the server is listening, or this never
// exercises the poll at all — it just starts a server next to a file that
// was already there.
test("autoExit closes the server once verdict.json appears", async () => {
  const dir = tmp();
  const { server } = await start({
    runDirPath: dir,
    port: 0,
    autoExit: true,
    pollMs: 20,
    lingerMs: 20,
  });
  const closed = new Promise((resolve, reject) => {
    const guard = setTimeout(
      () => reject(new Error("server did not auto-exit")),
      2000,
    );
    server.on("close", () => {
      clearTimeout(guard);
      resolve();
    });
  });

  // Still up before the verdict exists — the poll must be what closes it.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(server.listening, true, "closed before any verdict was written");

  writeFileSync(join(dir, "verdict.json"), JSON.stringify({ verdict: "clean" }));
  await closed;
});
