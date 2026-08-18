// Builds a fake `codex` on PATH so the CLI's real run path — argument
// parsing, preflight, drift check, startRun, runLens, finalize, promote — can
// be exercised in the default test suite with no network and no OpenAI
// account. It answers the three probes Trio makes (--version, login status,
// exec --help) and emits a JSONL audit stream for `exec`.
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const VERSION = "0.146.0";

const SCRIPT = `#!/usr/bin/env node
const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");

// Lets a test prove Codex was never invoked at all: any invocation, for any
// subcommand, leaves this behind.
if (process.env.FAKE_CODEX_TOUCH) {
  require("node:fs").appendFileSync(
    process.env.FAKE_CODEX_TOUCH,
    args.join(" ") + "\\n",
  );
}

if (args[0] === "--version") {
  process.stdout.write("codex-cli ${VERSION}\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
if (args[0] === "exec" && args.includes("--help")) {
  process.stdout.write(
    "Usage: codex exec [OPTIONS] [PROMPT]\\n" +
      "  --json  --sandbox <MODE>  --skip-git-repo-check  --cd <DIR>" +
      "  --model <MODEL>  --config <KEY=VALUE>\\n",
  );
  process.exit(0);
}

// The audit itself. Read the brief so the pipe drains, then answer with
// whatever findings the test asked for.
let brief = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (brief += d));
process.stdin.on("end", () => {
  // Trio never persists the brief it sent, so this is the only way a test can
  // assert on what actually reached a lens — scope, prior findings, all of it.
  if (process.env.FAKE_CODEX_BRIEF_LOG) {
    require("node:fs").appendFileSync(
      process.env.FAKE_CODEX_BRIEF_LOG,
      "\\n===BRIEF===\\n" + brief,
    );
  }
  if (process.env.FAKE_CODEX_EXIT) process.exit(Number(process.env.FAKE_CODEX_EXIT));
  const findings = process.env.FAKE_CODEX_FINDINGS || "[]";
  emit({ type: "thread.started", thread_id: "thread-fake" });
  emit({
    type: "item.completed",
    item: { type: "command_execution", command: "rg -n TODO", exit_code: 0 },
  });
  emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "Reviewed " + brief.length + " bytes of brief.\\n\\n" +
        "\\u0060\\u0060\\u0060json\\n{\\"findings\\": " + findings + "}\\n\\u0060\\u0060\\u0060",
    },
  });
  emit({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 2 } });
  process.exit(0);
});
`;

// Trio resolves the npm layout on win32 (codex.cmd plus its sibling JS entry
// point) and a plain executable elsewhere — the fake has to match both.
export function installFakeCodex(dir) {
  const binDir = join(dir, "node_modules", "@openai", "codex", "bin");
  mkdirSync(binDir, { recursive: true });
  const js = join(binDir, "codex.js");
  writeFileSync(js, SCRIPT);

  if (process.platform === "win32") {
    writeFileSync(
      join(dir, "codex.cmd"),
      `@echo off\r\nnode "${js}" %*\r\n`,
    );
  } else {
    const shim = join(dir, "codex");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return js;
}

export function fakeCodexHome(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt" }),
  );
  writeFileSync(
    join(dir, "models_cache.json"),
    JSON.stringify({
      client_version: VERSION,
      models: [
        {
          slug: "fake-model",
          display_name: "Fake Model",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
          ],
        },
      ],
    }),
  );
  return dir;
}

// The environment a CLI child needs to find the fake and nothing else.
export function fakeEnv({ pathDir, codexHome, project, extra = {} }) {
  return {
    ...process.env,
    PATH: `${pathDir}${delimiter}${process.env.PATH ?? ""}`,
    Path: `${pathDir}${delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
    CODEX_HOME: codexHome,
    CLAUDE_PROJECT_DIR: project,
    ...extra,
  };
}

export const CLI = fileURLToPath(new URL("../../bin/trio.mjs", import.meta.url));
export const FAKE_VERSION = VERSION;

// Unit tests that inject a spawnFn still go through codexCommand to build the
// command, and on win32 that refuses unless it can find codex.cmd on PATH with
// its sibling JS entry point beside it. On a developer machine the real Codex
// install satisfies that by accident, so the tests passed locally and failed
// the first time CI ran them on a Windows runner with no Codex on it.
//
// Prepending a fake to this process's PATH makes them hermetic: they stop
// depending on whether the person running them happens to have Codex
// installed. node:test runs each file in its own process, so this cannot
// leak into another file's environment.
export function fakeCodexOnPath() {
  const dir = mkdtempSync(join(tmpdir(), "trio-path-"));
  installFakeCodex(dir);
  const next = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.PATH = next;
  process.env.Path = next;
  return dir;
}
