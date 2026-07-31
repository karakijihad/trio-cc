import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { codexHome, capabilitiesPath } from "./paths.mjs";

export const REQUIRED_FLAGS = [
  "--json",
  "--sandbox",
  "--skip-git-repo-check",
  "--cd",
  "--model",
  "--config",
];

export function parseModelsCache(cache) {
  return (cache?.models ?? [])
    .filter((m) => m.visibility !== "hide")
    .map((m) => ({
      slug: m.slug,
      displayName: m.display_name ?? m.slug,
      defaultEffort: m.default_reasoning_level ?? "medium",
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
    }));
}

export function parseFlags(helpText) {
  return [...new Set(String(helpText).match(/--[a-z][a-z0-9-]*/g) ?? [])];
}

export function checkDrift(caps) {
  const warnings = [];
  let ok = true;

  const missing = REQUIRED_FLAGS.filter((f) => !(caps.flags ?? []).includes(f));
  if (missing.length) {
    ok = false;
    warnings.push(
      `codex exec no longer accepts: ${missing.join(", ")} — Trio cannot run safely.`,
    );
  }

  const major = (v) => String(v ?? "").split(".")[0];
  if (caps.cliVersion && caps.cacheClientVersion) {
    if (major(caps.cliVersion) !== major(caps.cacheClientVersion)) {
      ok = false;
      warnings.push(
        `codex CLI ${caps.cliVersion} vs model cache ${caps.cacheClientVersion} — major version mismatch.`,
      );
    } else if (caps.cliVersion !== caps.cacheClientVersion) {
      warnings.push(
        `model cache reports ${caps.cacheClientVersion}, CLI is ${caps.cliVersion} — an update is likely available.`,
      );
    }
  } else {
    warnings.push(
      `version drift unverified — ${caps.cliVersion ? "model cache" : "codex CLI"} version unavailable.`,
    );
  }
  return { ok, warnings };
}

export function validateLens(caps, lens) {
  const model = (caps.models ?? []).find((m) => m.slug === lens.model);
  if (!model) {
    const known = (caps.models ?? []).map((m) => m.slug).join(", ");
    return {
      ok: false,
      error: `unknown model: ${lens.model}. known: ${known}`,
    };
  }
  if (!model.efforts.includes(lens.effort)) {
    return {
      ok: false,
      error: `${lens.model} does not support effort "${lens.effort}". valid: ${model.efforts.join(", ")}`,
    };
  }
  return { ok: true };
}

export function probe({ run }) {
  const version = run("codex", ["--version"]);
  const cliVersion = (version.stdout.match(/\d+\.\d+\.\d+/) ?? ["unknown"])[0];

  let cache = {};
  try {
    cache = JSON.parse(
      readFileSync(join(codexHome(), "models_cache.json"), "utf8"),
    );
  } catch {
    /* absent */
  }

  let authMode = "unknown";
  try {
    authMode =
      JSON.parse(readFileSync(join(codexHome(), "auth.json"), "utf8"))
        .auth_mode ?? "unknown";
  } catch {
    /* absent */
  }

  const help = run("codex", ["exec", "--help"]);

  return {
    cliVersion,
    cacheClientVersion: cache.client_version ?? null,
    models: parseModelsCache(cache),
    flags: parseFlags(help.stdout),
    authMode,
    probedAt: new Date().toISOString(),
  };
}

export function saveCapabilities(root, caps) {
  const p = capabilitiesPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(caps, null, 2) + "\n");
}
