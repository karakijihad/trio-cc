import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseModelsCache,
  parseFlags,
  checkDrift,
  validateLens,
  probe,
  saveCapabilities,
  REQUIRED_FLAGS,
} from "../src/capabilities.mjs";
import { capabilitiesPath } from "../src/paths.mjs";

const CACHE = {
  client_version: "0.145.0",
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      default_reasoning_level: "low",
      visibility: "list",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "high" },
        { effort: "max" },
        { effort: "ultra" },
      ],
    },
    {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      default_reasoning_level: "medium",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "xhigh" }],
    },
    {
      slug: "codex-auto-review",
      display_name: "Hidden",
      default_reasoning_level: "medium",
      visibility: "hide",
      supported_reasoning_levels: [{ effort: "medium" }],
    },
  ],
};

test("parseModelsCache lifts slug, efforts and default", () => {
  const models = parseModelsCache(CACHE);
  const sol = models.find((m) => m.slug === "gpt-5.6-sol");
  assert.deepEqual(sol.efforts, ["low", "high", "max", "ultra"]);
  assert.equal(sol.defaultEffort, "low");
});

test("parseModelsCache omits hidden models", () => {
  assert.equal(
    parseModelsCache(CACHE).some((m) => m.slug === "codex-auto-review"),
    false,
  );
});

test("parseModelsCache tolerates a missing models array", () => {
  assert.deepEqual(parseModelsCache({}), []);
});

test("parseFlags extracts long flags from help text", () => {
  const help =
    "  -s, --sandbox <MODE>\n      --skip-git-repo-check\n  -C, --cd <DIR>\n      --json\n";
  const flags = parseFlags(help);
  assert.ok(flags.includes("--sandbox"));
  assert.ok(flags.includes("--skip-git-repo-check"));
  assert.ok(flags.includes("--cd"));
});

test("checkDrift passes when every required flag is present and versions agree", () => {
  const r = checkDrift({
    cliVersion: "0.145.0",
    cacheClientVersion: "0.145.0",
    flags: REQUIRED_FLAGS,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test("checkDrift fails and names a missing flag", () => {
  const r = checkDrift({
    cliVersion: "0.145.0",
    cacheClientVersion: "0.145.0",
    flags: REQUIRED_FLAGS.filter((f) => f !== "--json"),
  });
  assert.equal(r.ok, false);
  assert.match(r.warnings.join(" "), /--json/);
});

test("checkDrift warns but stays ok on a minor version skew", () => {
  const r = checkDrift({
    cliVersion: "0.145.0",
    cacheClientVersion: "0.146.0",
    flags: REQUIRED_FLAGS,
  });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(" "), /0\.146\.0/);
});

test("checkDrift fails on a major version jump", () => {
  const r = checkDrift({
    cliVersion: "1.0.0",
    cacheClientVersion: "0.145.0",
    flags: REQUIRED_FLAGS,
  });
  assert.equal(r.ok, false);
});

test("validateLens accepts a supported model and effort", () => {
  const caps = { models: parseModelsCache(CACHE) };
  assert.equal(
    validateLens(caps, { model: "gpt-5.6-sol", effort: "ultra" }).ok,
    true,
  );
});

test("validateLens rejects an unsupported effort and lists the valid ones", () => {
  const caps = { models: parseModelsCache(CACHE) };
  const r = validateLens(caps, { model: "gpt-5.6-luna", effort: "ultra" });
  assert.equal(r.ok, false);
  assert.match(r.error, /medium.*xhigh/s);
});

test("validateLens rejects an unknown model", () => {
  const caps = { models: parseModelsCache(CACHE) };
  assert.match(
    validateLens(caps, { model: "gpt-9", effort: "low" }).error,
    /unknown model/i,
  );
});

test("checkDrift reports that it could not compare versions, without failing", () => {
  const r = checkDrift({
    cliVersion: "0.145.0",
    cacheClientVersion: null,
    flags: REQUIRED_FLAGS,
  });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(" "), /unverified/i);
});

test("probe reads only auth_mode from auth.json, never tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-probe-"));
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access: "SHOULD-NEVER-BE-READ" },
    }),
  );
  writeFileSync(join(dir, "models_cache.json"), JSON.stringify(CACHE));

  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    const caps = probe({
      run: (_cmd, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: "codex-cli 0.145.0" }
          : { status: 0, stdout: "  --json\n  --sandbox <MODE>\n" },
    });
    assert.equal(caps.authMode, "chatgpt");
    assert.equal(caps.cliVersion, "0.145.0");
    assert.equal(caps.cacheClientVersion, "0.145.0");
    assert.doesNotMatch(JSON.stringify(caps), /SHOULD-NEVER-BE-READ/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test("saveCapabilities writes the probe result where the panel can find it", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-caps-"));
  saveCapabilities(root, { cliVersion: "0.145.0", models: [] });
  const written = JSON.parse(readFileSync(capabilitiesPath(root), "utf8"));
  assert.equal(written.cliVersion, "0.145.0");
});
