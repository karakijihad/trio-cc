import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseModelsCache,
  parseFlags,
  checkDrift,
  validateLens,
  probe,
  saveCapabilities,
  loadCapabilities,
  isFresh,
  probeState,
  modelsReport,
  REQUIRED_FLAGS,
} from "../src/capabilities.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
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

// A lens with no model defers to the CLI, so there is no slug to look up and
// no per-model effort list to check against. Refusing it would make a valid
// config unrunnable.
test("validateLens accepts a lens with no model pinned", () => {
  const caps = { models: parseModelsCache(CACHE) };
  assert.equal(validateLens(caps, { model: null, effort: "medium" }).ok, true);
});

// Unpinned means the model is unknown, not that anything goes: a typo is
// still refusable against the union of efforts the catalogue knows.
test("an unpinned lens still refuses an effort no model supports", () => {
  const caps = { models: parseModelsCache(CACHE) };
  const r = validateLens(caps, { model: null, effort: "nonsense" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no model supports effort/);
});

test("an unpinned lens accepts an effort some known model supports", () => {
  const caps = { models: parseModelsCache(CACHE) };
  assert.equal(validateLens(caps, { model: "", effort: "ultra" }).ok, true);
});

// With no catalogue there is nothing to check against, and refusing every
// effort would make a first run impossible before the first probe.
test("an unpinned lens is accepted when the catalogue is empty", () => {
  assert.equal(validateLens({ models: [] }, { model: null, effort: "x" }).ok, true);
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

// --- Capability cache (24h TTL) ---

const runStub = (extra = {}) => (bin, args) => {
  if (args[0] === "--version") return { status: 0, stdout: "codex-cli 0.145.0" };
  if (args[0] === "login") return { status: 0, stdout: "Logged in using ChatGPT" };
  return { status: 0, stdout: "  --json\n" };
};

test("isFresh is true just inside the TTL", () => {
  const now = Date.now();
  const caps = { probedAt: new Date(now - 86_400_000 + 1_000).toISOString() };
  assert.equal(isFresh(caps, { now }), true);
});

test("isFresh is false just outside the TTL", () => {
  const now = Date.now();
  const caps = { probedAt: new Date(now - 86_400_000 - 1_000).toISOString() };
  assert.equal(isFresh(caps, { now }), false);
});

test("isFresh is false for null caps", () => {
  assert.equal(isFresh(null), false);
});

test("isFresh is false for a missing probedAt", () => {
  assert.equal(isFresh({}), false);
});

test("isFresh is false for a garbage probedAt", () => {
  assert.equal(isFresh({ probedAt: "not-a-date" }), false);
});

test("isFresh is false when probedAt is more than a minute in the future", () => {
  const now = Date.now();
  const caps = { probedAt: new Date(now + 120_000).toISOString() };
  assert.equal(isFresh(caps, { now }), false);
});

test("loadCapabilities returns null for a missing file", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-loadcaps-"));
  assert.equal(loadCapabilities(root), null);
});

test("loadCapabilities returns null for an unparseable file", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-loadcaps-"));
  mkdirSync(join(root, ".trio"), { recursive: true });
  writeFileSync(capabilitiesPath(root), "{ not json");
  assert.equal(loadCapabilities(root), null);
});

test("loadCapabilities round-trips a written file", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-loadcaps-"));
  saveCapabilities(root, { cliVersion: "0.145.0", models: [] });
  assert.equal(loadCapabilities(root).cliVersion, "0.145.0");
});

test("probeState with a fresh cache calls run zero times", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-probestate-"));
  saveCapabilities(root, {
    cliVersion: "0.145.0",
    models: [],
    probedAt: new Date().toISOString(),
    preflight: { state: "ready", message: "ok", fix: "" },
  });
  let calls = 0;
  const r = probeState({
    root,
    run: (...a) => {
      calls++;
      return runStub()(...a);
    },
  });
  assert.equal(calls, 0);
  assert.equal(r.cached, true);
  assert.equal(r.caps.cliVersion, "0.145.0");
  assert.equal(r.pre.state, "ready");
});

test("probeState re-probes a fresh-by-timestamp cache with no preflight key, rather than fabricating one", () => {
  // v0.1.0 wrote capabilities.json with no `preflight` key. A user logged
  // out at their last probe must not be told "ready" for up to 24h just
  // because the file happens to be fresh by timestamp.
  const root = mkdtempSync(join(tmpdir(), "trio-probestate-"));
  saveCapabilities(root, {
    cliVersion: "0.145.0",
    models: [],
    probedAt: new Date().toISOString(),
  });
  let calls = 0;
  const r = probeState({
    root,
    run: (...a) => {
      calls++;
      return runStub()(...a);
    },
  });
  assert.ok(calls > 0);
  assert.equal(r.cached, false);
});

test("probeState with force:true calls run and refreshes probedAt", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-probestate-"));
  const staleAt = new Date().toISOString();
  saveCapabilities(root, {
    cliVersion: "0.144.0",
    models: [],
    probedAt: staleAt,
    preflight: { state: "ready", message: "ok", fix: "" },
  });
  let calls = 0;
  const r = probeState({
    root,
    force: true,
    run: (...a) => {
      calls++;
      return runStub()(...a);
    },
  });
  assert.ok(calls > 0);
  assert.equal(r.cached, false);
  assert.notEqual(r.probedAt, staleAt);
});

test("probeState re-probes a stale cache without force", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-probestate-"));
  const staleAt = new Date(Date.now() - 90_000_000).toISOString();
  saveCapabilities(root, {
    cliVersion: "0.144.0",
    models: [],
    probedAt: staleAt,
    preflight: { state: "ready", message: "ok", fix: "" },
  });
  let calls = 0;
  const r = probeState({
    root,
    run: (...a) => {
      calls++;
      return runStub()(...a);
    },
  });
  assert.ok(calls > 0);
  assert.equal(r.cached, false);
});

test("probeState never throws when the probe fails, and still yields a usable pre", () => {
  const root = mkdtempSync(join(tmpdir(), "trio-probestate-"));
  const r = probeState({
    root,
    run: () => {
      throw new Error("codex not found");
    },
  });
  assert.equal(r.caps, null);
  assert.equal(r.cached, false);
  assert.ok(r.pre && typeof r.pre.state === "string");
});

// --- modelsReport (for `trio models`, /trio:model, /trio:lenses) ---

test("modelsReport lists known models and which lens uses each", () => {
  const caps = { models: parseModelsCache(CACHE) };
  const config = {
    codex: {
      lenses: [
        { name: "auditor", model: "gpt-5.6-luna", effort: "xhigh", on: true },
        { name: "security", model: "gpt-5.6-sol", effort: "max", on: true },
      ],
    },
  };
  const r = modelsReport(caps, config);
  assert.equal(r.models.length, 2);
  assert.deepEqual(
    r.lenses.map((l) => l.name),
    ["auditor", "security"],
  );
});

test("modelsReport tolerates null caps (probe never succeeded)", () => {
  const r = modelsReport(null, DEFAULT_CONFIG);
  assert.deepEqual(r.models, []);
  assert.equal(r.lenses.length, DEFAULT_CONFIG.codex.lenses.length);
});
