import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCodexScript,
  codexCommand,
  killTreeCommand,
  openUrlCommand,
} from "../src/paths.mjs";

test("resolveCodexScript finds the npm shim's JS entry point", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-shim-"));
  writeFileSync(join(dir, "codex.cmd"), "@echo off\n");
  const binDir = join(dir, "node_modules", "@openai", "codex", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "codex.js"), "");
  assert.equal(resolveCodexScript(dir), join(binDir, "codex.js"));
});

test("resolveCodexScript returns null when the shim is not on PATH", () => {
  assert.equal(resolveCodexScript(mkdtempSync(join(tmpdir(), "trio-noshim-"))), null);
});

test("resolveCodexScript ignores a shim with no sibling entry point", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-badshim-"));
  writeFileSync(join(dir, "codex.cmd"), "@echo off\n");
  assert.equal(resolveCodexScript(dir), null);
});

// On win32 the Codex process Trio spawns is a JS shim whose native child
// would survive a plain kill(); the whole tree has to go.
test("killTreeCommand takes the tree on win32 and defers to kill() elsewhere", () => {
  const cmd = killTreeCommand(4321);
  if (process.platform === "win32") {
    assert.equal(cmd.file, "taskkill");
    assert.deepEqual(cmd.args, ["/pid", "4321", "/t", "/f"]);
  } else {
    assert.equal(cmd, null);
  }
});

test("killTreeCommand refuses a process with no pid", () => {
  assert.equal(killTreeCommand(undefined), null);
  assert.equal(killTreeCommand(0), null);
});

test("codexCommand never asks for a shell", () => {
  let cmd;
  try {
    cmd = codexCommand(["exec", "--json"]);
  } catch (err) {
    // win32 with no resolvable entry point: fails closed rather than
    // composing a cmd.exe command line.
    assert.equal(process.platform, "win32");
    assert.match(err.message, /codex\.cmd/);
    return;
  }
  assert.deepEqual(cmd.opts, {});
  if (process.platform === "win32") {
    assert.equal(cmd.file, process.execPath);
    assert.match(cmd.args[0], /codex\.js$/);
    assert.deepEqual(cmd.args.slice(1), ["exec", "--json"]);
  } else {
    assert.equal(cmd.file, "codex");
    assert.deepEqual(cmd.args, ["exec", "--json"]);
  }
});

test("openUrlCommand returns the OS default-browser launcher for a URL", () => {
  const url = "http://localhost:4319";
  const cmd = openUrlCommand(url);
  assert.ok(cmd.file);
  assert.equal(cmd.args.at(-1), url);
  if (process.platform === "win32") {
    assert.equal(cmd.file, "cmd.exe");
    assert.deepEqual(cmd.args, ["/c", "start", "", url]);
  }
});
