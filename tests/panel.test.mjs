import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPanel } from "../src/panel.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";

const CAPS = {
  cliVersion: "0.145.0",
  authMode: "chatgpt",
  models: [{ slug: "gpt-5.6-luna", efforts: ["xhigh"] }],
};
const OK_DRIFT = { ok: true, warnings: [] };
const READY = { state: "ready", message: "Logged in using ChatGPT", fix: "" };

test("shows the not-installed path with the install command", () => {
  const out = renderPanel({
    installed: false,
    config: DEFAULT_CONFIG,
    caps: null,
    drift: OK_DRIFT,
    pre: {
      state: "not_installed",
      message: "missing",
      fix: "npm i -g @openai/codex",
    },
  });
  assert.match(out, /npm i -g @openai\/codex/);
});

test("shows disabled state and how to enable", () => {
  const out = renderPanel({
    installed: true,
    config: { ...DEFAULT_CONFIG, enabled: false },
    caps: CAPS,
    drift: OK_DRIFT,
    pre: READY,
  });
  assert.match(out, /disabled/i);
  assert.match(out, /\/trio:on/);
});

test("shows enabled state with the iteration ceiling", () => {
  const out = renderPanel({
    installed: true,
    config: { ...DEFAULT_CONFIG, enabled: true },
    caps: CAPS,
    drift: OK_DRIFT,
    pre: READY,
  });
  assert.match(out, /enabled/i);
  assert.match(out, /max iterations\s+2/);
});

test("lists every lens with model, effort and on/off", () => {
  const out = renderPanel({
    installed: true,
    config: { ...DEFAULT_CONFIG, enabled: true },
    caps: CAPS,
    drift: OK_DRIFT,
    pre: READY,
  });
  for (const l of DEFAULT_CONFIG.codex.lenses) {
    assert.match(out, new RegExp(l.name));
    assert.match(out, new RegExp(l.model.replace(/\./g, "\\.")));
  }
});

test("surfaces drift warnings", () => {
  const out = renderPanel({
    installed: true,
    config: DEFAULT_CONFIG,
    caps: CAPS,
    drift: { ok: false, warnings: ["codex exec no longer accepts: --json"] },
    pre: READY,
  });
  assert.match(out, /--json/);
});

test("surfaces the API-key billing warning", () => {
  const out = renderPanel({
    installed: true,
    config: DEFAULT_CONFIG,
    caps: { ...CAPS, authMode: "apikey" },
    drift: OK_DRIFT,
    pre: { state: "api_key_mode", message: "billed per token", fix: "" },
  });
  assert.match(out, /billed per token/i);
});

test("never prints anything token-shaped", () => {
  const out = renderPanel({
    installed: true,
    config: DEFAULT_CONFIG,
    caps: CAPS,
    drift: OK_DRIFT,
    pre: READY,
  });
  assert.doesNotMatch(out, /sk-|eyJ|Bearer /);
});
