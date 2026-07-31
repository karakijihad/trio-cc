import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  maxIterations: 2,
  auto: "ask",
  codex: {
    parallel: 2,
    lenses: [
      { name: "auditor", model: "gpt-5.6-luna", effort: "xhigh", on: true },
      { name: "security", model: "gpt-5.6-sol", effort: "max", on: true },
      { name: "tester", model: "gpt-5.4", effort: "high", on: false },
      {
        name: "simplifier",
        model: "gpt-5.4-mini",
        effort: "medium",
        on: false,
      },
      { name: "consistency", model: "gpt-5.4", effort: "high", on: false },
    ],
  },
  view: { mode: "window", port: 4319, autoOpen: true },
  converge: { blockOn: ["critical", "major"], requireNoNewFindings: true },
  artifacts: { raw: ".trio/runs", promoteTo: "Docs/Audit" },
});

const ENUMS = {
  auto: ["off", "ask", "always"],
  "view.mode": ["pane", "window", "html", "transcript", "off"],
};

const clone = (v) => JSON.parse(JSON.stringify(v));

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
