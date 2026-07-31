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
  const reader = res.body.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /^data: /m);
  assert.match(chunk, /agent_message/);
  await reader.cancel();
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

test("autoExit closes the server once verdict.json exists", async () => {
  const dir = tmp();
  writeFileSync(
    join(dir, "verdict.json"),
    JSON.stringify({ verdict: "clean" }),
  );
  const { server } = await start({
    runDirPath: dir,
    port: 0,
    autoExit: true,
    pollMs: 20,
    lingerMs: 20,
  });
  await new Promise((resolve, reject) => {
    const guard = setTimeout(
      () => reject(new Error("server did not auto-exit")),
      2000,
    );
    server.on("close", () => {
      clearTimeout(guard);
      resolve();
    });
  });
});
