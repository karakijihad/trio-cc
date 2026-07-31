import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexBin,
  shellQuote,
  resolveCodexScript,
  codexCommand,
  openUrlCommand,
} from "../src/paths.mjs";

test("codexBin resolves to the npm shim name on win32, plain name elsewhere", () => {
  if (process.platform === "win32") {
    assert.equal(codexBin(), "codex.cmd");
  } else {
    assert.equal(codexBin(), "codex");
  }
});

test("shellQuote quotes an argument containing a space", () => {
  const out = shellQuote(["--cd", "/repo with space"]);
  if (process.platform === "win32") {
    assert.equal(out[1], '"/repo with space"');
  } else {
    assert.equal(out[1], "/repo with space");
  }
});

test("shellQuote leaves an argument without a space untouched", () => {
  const out = shellQuote(["--cd", "/repo"]);
  assert.equal(out[1], "/repo");
});

test("shellQuote is identity off win32", () => {
  const args = ["--cd", "/repo with space"];
  if (process.platform !== "win32") {
    assert.deepEqual(shellQuote(args), args);
  } else {
    assert.notDeepEqual(shellQuote(args), args);
  }
});

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

test("codexCommand never asks for a shell unless it has to", () => {
  const cmd = codexCommand(["exec", "--json"]);
  if (process.platform === "win32") {
    // npm layout → node + script, no shell. Other layouts → documented fallback.
    if (cmd.file === process.execPath) {
      assert.deepEqual(cmd.opts, {});
      assert.match(cmd.args[0], /codex\.js$/);
      assert.deepEqual(cmd.args.slice(1), ["exec", "--json"]);
    } else {
      assert.equal(cmd.file, "codex.cmd");
      assert.equal(cmd.opts.shell, true);
    }
  } else {
    assert.equal(cmd.file, "codex");
    assert.deepEqual(cmd.args, ["exec", "--json"]);
    assert.deepEqual(cmd.opts, {});
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
