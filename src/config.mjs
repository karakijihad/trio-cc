import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  // On by default: a reviewer you have to remember to switch on is a reviewer
  // that does not run. `/trio:off` writes false here, per project, and that
  // opt-out persists — nothing turns it back on but `/trio:on`.
  enabled: true,
  maxIterations: 2,
  codex: {
    parallel: 2,
    // A lens that has stopped producing output is indistinguishable from one
    // that is still thinking, and nothing else bounds a Codex process. Ten
    // times the observed per-lens time, so it only fires on a real hang.
    timeoutMinutes: 15,
    lenses: [
      { name: "auditor", model: "gpt-5.6-terra", effort: "medium", on: true },
      { name: "security", model: "gpt-5.6-terra", effort: "medium", on: true },
      { name: "tester", model: "gpt-5.6-terra", effort: "medium", on: true },
      {
        name: "simplifier",
        model: "gpt-5.6-terra",
        effort: "medium",
        on: true,
      },
      {
        name: "consistency",
        model: "gpt-5.6-terra",
        effort: "medium",
        on: true,
      },
    ],
  },
  view: { mode: "window", port: 4319, autoOpen: true },
  converge: { blockOn: ["critical", "major"], requireNoNewFindings: true },
  // offerToCreate: promotion needs artifacts.promoteTo to exist, and Trio does
  // not create directory trees in a project uninvited. When it is missing, a
  // finished run says so and Claude offers to create it once; answering no
  // sets this false and the offer never comes back.
  artifacts: { promoteTo: "Docs/Audit", offerToCreate: true },
});

// Only modes with a production handler are offered. Raw runs always live under
// .trio/runs — that path is not configurable, so it is not a setting.
const ENUMS = {
  "view.mode": ["pane", "window", "off"],
};

const POSITIVE_INTEGERS = new Set([
  "maxIterations",
  "codex.parallel",
  "codex.timeoutMinutes",
  "view.port",
]);

const MAX_PORT = 65535;

const clone = (v) => JSON.parse(JSON.stringify(v));

const at = (obj, dotted) =>
  dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

// A config.json edited by hand bypasses setConfigValue entirely, and its
// values reach real command lines — view.port is interpolated into the URL
// handed to the OS browser launcher. Every caller that acts on config checks
// this first, so a malformed file is refused rather than executed.
export function configErrors(cfg) {
  const errors = [];
  for (const key of POSITIVE_INTEGERS) {
    const v = at(cfg, key);
    if (!Number.isSafeInteger(v) || v < 1)
      errors.push(
        `${key} must be a positive whole number, got: ${JSON.stringify(v)}`,
      );
  }
  const port = at(cfg, "view.port");
  if (Number.isSafeInteger(port) && port > MAX_PORT)
    errors.push(`view.port must be between 1 and ${MAX_PORT}, got: ${port}`);

  const mode = at(cfg, "view.mode");
  if (!ENUMS["view.mode"].includes(mode))
    errors.push(
      `view.mode must be one of: ${ENUMS["view.mode"].join(", ")}, got: ${JSON.stringify(mode)}`,
    );
  return errors;
}

const merge = (base, over) => {
  const out = clone(base);
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? merge(out[k] ?? {}, v)
        : v;
  }
  return out;
};

export function loadConfig(root) {
  try {
    return merge(
      DEFAULT_CONFIG,
      JSON.parse(readFileSync(configPath(root), "utf8")),
    );
  } catch {
    return clone(DEFAULT_CONFIG);
  }
}

export function saveConfig(root, cfg) {
  const p = configPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

export function setConfigValue(cfg, dottedKey, raw) {
  const next = clone(cfg);
  const parts = dottedKey.split(".");
  let cursor = next;
  let template = DEFAULT_CONFIG;
  for (const part of parts.slice(0, -1)) {
    if (template?.[part] === undefined)
      throw new Error(`unknown key: ${dottedKey}`);
    template = template[part];
    cursor = cursor[part];
  }
  const leaf = parts.at(-1);
  if (template?.[leaf] === undefined)
    throw new Error(`unknown key: ${dottedKey}`);

  const allowed = ENUMS[dottedKey];
  if (allowed && !allowed.includes(raw)) {
    throw new Error(
      `invalid value for ${dottedKey}: ${raw}. valid: ${allowed.join(", ")}`,
    );
  }

  const current = template[leaf];
  if (typeof current === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n))
      throw new Error(`${dottedKey} expects a number, got: ${raw}`);
    // Counts the loop and the viewer depend on must be whole and positive, or
    // `trio run` would refuse a value this setter had accepted.
    if (POSITIVE_INTEGERS.has(dottedKey) && (!Number.isSafeInteger(n) || n < 1))
      throw new Error(
        `${dottedKey} expects a positive whole number, got: ${raw}`,
      );
    if (dottedKey === "view.port" && n > MAX_PORT)
      throw new Error(`view.port expects 1-${MAX_PORT}, got: ${raw}`);
    cursor[leaf] = n;
  } else if (typeof current === "boolean") {
    if (!["true", "false"].includes(raw))
      throw new Error(`${dottedKey} expects true or false, got: ${raw}`);
    cursor[leaf] = raw === "true";
  } else {
    cursor[leaf] = raw;
  }
  return next;
}
