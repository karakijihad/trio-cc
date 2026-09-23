import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { codexHome, capabilitiesPath } from "./paths.mjs";
import { preflight } from "./preflight.mjs";
import { consultSettings } from "./config.mjs";

const TTL_MS = 86_400_000;
const FUTURE_SKEW_MS = 60_000;

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
      // OpenAI marks a model on its way out with the one that replaces it.
      upgrade: m.upgrade?.model ?? null,
      retiresAt: m.upgrade?.retirement_at ?? null,
    }));
}

// The model Codex runs when none is passed: the top-level `model` key of its
// config.toml. Read line by line rather than parsed — only the keys before
// the first [table] are top level, and that is all this needs.
export function parseCodexDefault(toml) {
  const top = String(toml ?? "").split(/^\s*\[/m)[0];
  const key = (k) =>
    (top.match(new RegExp(`^[ \\t]*${k}[ \\t]*=[ \\t]*"([^"]+)"`, "m")) ?? [])[1] ?? null;
  return { model: key("model"), effort: key("model_reasoning_effort") };
}

// Every slot that runs Codex — the lenses and consult — whose model should be
// swapped: unpinned (so nobody can say which model answered), gone from the
// catalogue, or marked for retirement. The replacement is the retiring
// model's named upgrade, else Codex's own default, else the catalogue's first
// entry. Effort is kept where the new model supports it. Nothing is written
// here; `trio models --apply` is what applies these.
//
// Every value here ends up in SessionStart context Claude reads as guidance,
// and both sources are project-local files anyone with the checkout can
// edit — so a name, slug or effort that is not a plain token drops out
// rather than carrying a newline and an instruction into that text.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const isToken = (v) => typeof v === "string" && TOKEN.test(v);

export function modelProposals(caps, config) {
  const models = (caps?.models ?? []).filter(
    (m) => isToken(m?.slug) && (m.efforts ?? []).every(isToken) && isToken(m.defaultEffort),
  );
  if (!models.length) return [];
  const find = (slug) => models.find((m) => m.slug === slug);
  const fallback = find(caps.defaultModel) ?? models[0];
  const slots = [
    ...(config.codex?.lenses ?? []).map((l) => ({ name: l.name, ...l })),
    { name: "consult", ...config.codex?.consult },
  ];
  const out = [];
  for (const { name, model, effort } of slots) {
    if (!isToken(name) || (model != null && !isToken(model))) continue;
    if (effort != null && !isToken(effort)) continue;
    const current = model ? find(model) : null;
    let why;
    let to = fallback;
    if (!model) why = "unpinned";
    else if (!current) why = "not in the Codex catalogue";
    else if (current.upgrade) {
      const date = String(current.retiresAt ?? "").slice(0, 10);
      why = `retires ${/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "soon"}`;
      to = find(current.upgrade) ?? fallback;
    } else continue;
    if (to.slug === model) continue;
    const want = effort ?? (isToken(caps.defaultEffort) ? caps.defaultEffort : null);
    out.push({
      name,
      from: model ?? null,
      to: to.slug,
      effort: to.efforts.includes(want) ? want : to.defaultEffort,
      why,
    });
  }
  return out;
}

// Writes the proposals into a config copy. Returns the new config.
export function applyProposals(config, proposals) {
  const next = JSON.parse(JSON.stringify(config));
  for (const p of proposals) {
    const slot =
      p.name === "consult"
        ? next.codex.consult
        : next.codex.lenses.find((l) => l.name === p.name);
    if (!slot) continue;
    slot.model = p.to;
    slot.effort = p.effort;
  }
  return next;
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
  // An unpinned lens defers to the CLI, so there is no slug to look up. The
  // effort still gets checked — against every effort the catalogue knows,
  // since which model will answer is exactly what is unknown here. That
  // accepts a value the chosen model happens not to support, but it refuses
  // the typo, and refusing a typo synchronously is worth a wave of Codex
  // processes discovering it.
  if (!lens.model) {
    const known = [...new Set((caps.models ?? []).flatMap((m) => m.efforts))];
    if (known.length && !known.includes(lens.effort)) {
      return {
        ok: false,
        error: `no model supports effort "${lens.effort}". valid: ${known.join(", ")}`,
      };
    }
    return { ok: true };
  }
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

// A model named inline on a consult is typed from memory, not picked off a
// list: "astra" for gpt-6-astra. Matched against the live catalogue rather
// than a table kept here, so it keeps working as OpenAI renames things. An
// exact slug wins outright — a full slug can never be the ambiguous one —
// and a prefix of two models is refused rather than guessed, because the
// wrong guess is spent credit.
export function resolveModel(models, name) {
  const list = models ?? [];
  const want = String(name ?? "").trim().toLowerCase();
  const known = list.map((m) => m.slug).join(", ");
  if (!want) return { ok: false, error: `--model needs a value. known: ${known}` };
  const exact = list.find((m) => m.slug.toLowerCase() === want);
  if (exact) return { ok: true, slug: exact.slug };
  const hits = list.filter((m) => m.slug.toLowerCase().includes(want));
  if (hits.length === 1) return { ok: true, slug: hits[0].slug };
  if (hits.length > 1)
    return {
      ok: false,
      error: `ambiguous model: "${name}" matches ${hits.map((m) => m.slug).join(", ")}`,
    };
  return { ok: false, error: `unknown model: ${name}. known: ${known}` };
}

// Pure projection for `trio models` / `/trio:model` / `/trio:lenses`: the
// live model catalogue plus which lens currently uses which model.
export function modelsReport(caps, config) {
  return {
    models: (caps?.models ?? []).map(
      ({ slug, displayName, defaultEffort, efforts }) => ({
        slug,
        displayName,
        defaultEffort,
        efforts,
      }),
    ),
    lenses: config.codex.lenses.map(({ name, model, effort, on }) => ({
      name,
      model,
      effort,
      on,
    })),
    consult: consultSettings(config),
  };
}

// `cliVersion`, when given (even as null, meaning "asked, no version-looking
// string came back"), is preflight's own answer to `codex --version` —
// probeState always calls preflight first, and asking the same question of
// the same process a second time bought nothing but another Codex spawn.
export function probe({ run, cliVersion }) {
  if (cliVersion === undefined) {
    const version = run("codex", ["--version"]);
    cliVersion = (version.stdout.match(/\d+\.\d+\.\d+/) ?? [null])[0];
  }
  cliVersion = cliVersion ?? "unknown";

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

  let codexDefault = { model: null, effort: null };
  try {
    codexDefault = parseCodexDefault(
      readFileSync(join(codexHome(), "config.toml"), "utf8"),
    );
  } catch {
    /* absent */
  }

  const help = run("codex", ["exec", "--help"]);

  return {
    cliVersion,
    defaultModel: codexDefault.model,
    defaultEffort: codexDefault.effort,
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

export function loadCapabilities(root) {
  try {
    return JSON.parse(readFileSync(capabilitiesPath(root), "utf8"));
  } catch {
    return null;
  }
}

export function isFresh(caps, { ttlMs = TTL_MS, now = Date.now() } = {}) {
  if (!caps) return false;
  const probedAt = Date.parse(caps.probedAt);
  if (!Number.isFinite(probedAt)) return false;
  if (probedAt - now > FUTURE_SKEW_MS) return false;
  if (now - probedAt > ttlMs) return false;
  return true;
}

// Spec (DESIGN §4): the capability probe is cached for 24h and forced fresh
// only by /trio:doctor. A fresh cache short-circuits before `run` is ever
// invoked — that is the whole point, so this must never spawn Codex in that
// path. A probe failure still yields a usable `pre` for the not-installed /
// not-logged-in messaging callers depend on.
export function probeState({ root, run, force = false, now = Date.now() }) {
  if (!force) {
    const cached = loadCapabilities(root);
    // A cache entry with no `preflight` key predates this feature (v0.1.0
    // wrote capabilities.json with no such key) and was never actually
    // checked for install/login state — using it would fabricate a "ready"
    // the panel would present as a live check. Treat it as not fresh.
    if (isFresh(cached, { now }) && cached.preflight) {
      return {
        caps: cached,
        pre: cached.preflight,
        cached: true,
        probedAt: cached.probedAt,
      };
    }
  }

  let pre;
  try {
    pre = preflight({ run });
  } catch {
    pre = {
      state: "not_installed",
      message: "Trio could not check the Codex install.",
      fix: "npm i -g @openai/codex, then: codex login",
    };
  }

  let caps = null;
  if (pre.state !== "not_installed") {
    try {
      caps = probe({ run, cliVersion: pre.cliVersion });
    } catch {
      caps = null;
    }
  }

  if (caps) {
    saveCapabilities(root, {
      ...caps,
      preflight: { state: pre.state, message: pre.message, fix: pre.fix },
    });
  }

  return { caps, pre, cached: false, probedAt: caps?.probedAt ?? null };
}
