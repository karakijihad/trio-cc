import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "../src/preflight.mjs";

const home = (authMode) => {
  const d = mkdtempSync(join(tmpdir(), "trio-codex-"));
  if (authMode)
    writeFileSync(
      join(d, "auth.json"),
      JSON.stringify({
        auth_mode: authMode,
        tokens: { access: "SHOULD-NEVER-BE-READ" },
      }),
    );
  return d;
};

const runner = (map) => (cmd, args) =>
  map[`${cmd} ${args.join(" ")}`] ?? {
    status: 127,
    stdout: "",
    stderr: "not found",
  };

test("not_installed when the binary is missing", () => {
  const r = preflight({
    run: () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    },
    codexHomeDir: home(),
  });
  assert.equal(r.state, "not_installed");
  assert.match(r.fix, /npm i -g @openai\/codex/);
});

test("not_logged_in when login status exits non-zero", () => {
  const r = preflight({
    run: runner({
      "codex --version": { status: 0, stdout: "codex-cli 0.145.0" },
      "codex login status": { status: 1, stdout: "Not logged in" },
    }),
    codexHomeDir: home(),
  });
  assert.equal(r.state, "not_logged_in");
  assert.match(r.fix, /codex login/);
  assert.match(r.fix, /--device-auth/);
});

test("ready on a ChatGPT login", () => {
  const r = preflight({
    run: runner({
      "codex --version": { status: 0, stdout: "codex-cli 0.145.0" },
      "codex login status": { status: 0, stdout: "Logged in using ChatGPT" },
    }),
    codexHomeDir: home("chatgpt"),
  });
  assert.equal(r.state, "ready");
});

test("api_key_mode warns about per-token billing", () => {
  const r = preflight({
    run: runner({
      "codex --version": { status: 0, stdout: "codex-cli 0.145.0" },
      "codex login status": { status: 0, stdout: "Logged in using an API key" },
    }),
    codexHomeDir: home("apikey"),
  });
  assert.equal(r.state, "api_key_mode");
  assert.match(r.message, /billed per token/i);
});

test("preflight output never contains anything from the tokens field", () => {
  const r = preflight({
    run: runner({
      "codex --version": { status: 0, stdout: "codex-cli 0.145.0" },
      "codex login status": { status: 0, stdout: "Logged in using ChatGPT" },
    }),
    codexHomeDir: home("chatgpt"),
  });
  assert.doesNotMatch(JSON.stringify(r), /SHOULD-NEVER-BE-READ/);
});

test("login status output is scrubbed before it reaches the message", () => {
  const r = preflight({
    run: runner({
      "codex --version": { status: 0, stdout: "codex-cli 0.145.0" },
      "codex login status": {
        status: 0,
        stdout: "Logged in using ChatGPT as alice@example.com",
      },
    }),
    codexHomeDir: home("chatgpt"),
  });
  assert.doesNotMatch(r.message, /alice@example\.com/);
});
