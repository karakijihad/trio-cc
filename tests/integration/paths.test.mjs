import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCodexScript,
  resolveCodexExe,
  codexCommand,
  killTreeCommand,
  openUrlCommand,
  isRunId,
  processIsTrio,
} from "../../src/paths.mjs";

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

// A runId reaches path.join, so anything that did not come from newRunId is
// refused before it can become a directory.
test("isRunId accepts only ids Trio mints", () => {
  for (const good of [
    "2026-08-01T12-27-09",
    "2026-08-01T12-27-09-2",
    "consult-2026-08-01T12-27-09",
  ])
    assert.equal(isRunId(good), true, good);

  for (const bad of [
    "../../../etc",
    "..\\..\\windows",
    "2026-08-01T12-27-09/../..",
    "r1",
    "",
    null,
    undefined,
    42,
    "2026-08-01T12-27-09\u0000",
  ])
    assert.equal(isRunId(bad), false, JSON.stringify(bad));
});

test("processIsTrio reports unknown rather than guessing", () => {
  assert.equal(processIsTrio(1234, () => ({ status: 1, stdout: "" })), null);
  assert.equal(processIsTrio(1234, () => ({ status: 0, stdout: "  " })), null);
  assert.equal(
    processIsTrio(1234, () => {
      throw new Error("no such tool");
    }),
    null,
  );
});

test("processIsTrio identifies a process that is not ours", () => {
  const alien = "/usr/bin/some-other-daemon --serve";
  assert.equal(processIsTrio(1234, () => ({ status: 0, stdout: alien })), false);

  const ours = "node /home/me/.claude/plugins/trio/bin/trio.mjs run";
  assert.equal(processIsTrio(1234, () => ({ status: 0, stdout: ours })), true);
});

// The defect this closes: on win32 the lookup was `tasklist`, which reports
// the image name and nothing else, so every node.exe on the machine answered
// "yes, I am Trio" — and `trio cancel` kills what this identifies. A command
// line is what separates one node process from another.
test("processIsTrio does not mistake an unrelated node process for a worker", () => {
  const bystander = '"C:\\Program Files\\nodejs\\node.exe" server.js --port 3000';
  assert.equal(
    processIsTrio(1234, () => ({ status: 0, stdout: bystander })),
    false,
  );
  const worker = '"C:\\Program Files\\nodejs\\node.exe" C:\\plugins\\trio\\bin\\trio.mjs continue';
  assert.equal(
    processIsTrio(1234, () => ({ status: 0, stdout: worker })),
    true,
  );
});

// The pid reaches a CIM filter string on win32, so it is validated before it
// gets there. Anything that is not a real pid identifies nothing.
test("processIsTrio refuses a pid that is not a pid", () => {
  const never = () => {
    throw new Error("lookup must not be reached");
  };
  for (const bad of ["1234; Stop-Process -Name node", -1, 0, 1.5, null, undefined, NaN])
    assert.equal(processIsTrio(bad, never), false);
});

// On win32 the query has to be one that returns a command line at all.
test("processIsTrio asks win32 for the command line, not the image name", (t) => {
  if (process.platform !== "win32") return t.skip("win32-only query shape");
  let asked = null;
  processIsTrio(1234, (file, args) => {
    asked = { file, args };
    return { status: 0, stdout: "" };
  });
  assert.match(asked.file, /powershell/i);
  assert.match(asked.args.join(" "), /CommandLine/);
  assert.match(asked.args.join(" "), /ProcessId=1234/);
  assert.doesNotMatch(asked.file, /tasklist/i);
});

test("resolveCodexExe finds a bare codex.exe on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-exe-"));
  writeFileSync(join(dir, "codex.exe"), "");
  assert.equal(resolveCodexExe(dir), join(dir, "codex.exe"));
});

test("resolveCodexExe returns null when no codex.exe is on PATH", () => {
  assert.equal(resolveCodexExe(mkdtempSync(join(tmpdir(), "trio-noexe-"))), null);
});

// codexCommand accepts platform/pathEnv overrides precisely so its win32
// branches — otherwise unreachable in CI on Linux/macOS — can be exercised
// deterministically from any host OS, with a fake PATH instead of the real
// one.
test("codexCommand spawns a bare codex.exe directly, without a shell, when that is all PATH has", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-exe-only-"));
  const exe = join(dir, "codex.exe");
  writeFileSync(exe, "");
  const cmd = codexCommand(["exec", "--json"], { platform: "win32", pathEnv: dir });
  assert.equal(cmd.file, exe);
  assert.deepEqual(cmd.args, ["exec", "--json"]);
  assert.deepEqual(cmd.opts, {});
});

test("codexCommand prefers the npm shim's JS entry point over a coexisting codex.exe", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-both-"));
  writeFileSync(join(dir, "codex.cmd"), "@echo off\n");
  writeFileSync(join(dir, "codex.exe"), "");
  const binDir = join(dir, "node_modules", "@openai", "codex", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "codex.js"), "");
  const cmd = codexCommand(["exec"], { platform: "win32", pathEnv: dir });
  assert.equal(cmd.file, process.execPath);
  assert.match(cmd.args[0], /codex\.js$/);
});

// The refusal this guards: spawning codex.cmd itself would mean going
// through cmd.exe, where an audit target carrying `&` or `|` is read as a
// command separator. A coexisting bare .exe does not rescue that case — the
// operator has a broken npm install and reinstalling is the honest answer.
test("codexCommand still throws for a codex.cmd with no JS entry point, even with a bare codex.exe also on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-broken-cmd-"));
  writeFileSync(join(dir, "codex.cmd"), "@echo off\n");
  writeFileSync(join(dir, "codex.exe"), "");
  assert.throws(
    () => codexCommand(["exec"], { platform: "win32", pathEnv: dir }),
    /codex\.cmd/,
  );
});

test("codexCommand throws when win32 PATH has neither the npm shim nor a bare exe", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-nothing-"));
  assert.throws(
    () => codexCommand(["exec"], { platform: "win32", pathEnv: dir }),
    /codex\.cmd/,
  );
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
