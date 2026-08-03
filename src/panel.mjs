const pad = (s, n) => String(s).padEnd(n);

// How a lens's model reads wherever one is displayed. An unpinned lens is not
// a broken lens, and printing `null` would say it was. It lives here, with the
// other rendering, rather than in capabilities.mjs: this module formats
// strings and imports nothing, and pulling in a module that reads the
// filesystem to probe Codex — for one expression — points the dependency the
// wrong way round.
export const modelLabel = (model) => model || "codex default";
const RULE = "─".repeat(74);

const ago = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  const hours = Math.round(ms / 3_600_000);
  return hours < 1 ? "less than 1h ago" : `${hours}h ago`;
};

export function renderPanel({
  installed,
  config,
  caps,
  drift,
  pre,
  cached,
  probedAt,
}) {
  const lines = [];

  if (!installed || pre.state === "not_installed") {
    return [
      "TRIO  ○ codex not found",
      RULE,
      pre.message,
      "",
      `  ${pre.fix}`,
      RULE,
      "Trio drives your own Codex CLI on your own account. It ships no credentials.",
    ].join("\n");
  }

  const state = config.enabled ? "● enabled" : "○ disabled";
  lines.push(
    `TRIO  ${state}${pad("", 8)}codex-cli ${caps?.cliVersion ?? "?"} · auth ${caps?.authMode ?? "?"}`,
  );
  lines.push(RULE);

  if (cached && probedAt) {
    lines.push(`ⓘ cached probe from ${ago(probedAt)} · /trio:doctor to re-probe`);
  }

  if (!drift.ok) {
    lines.push("⚠ DRIFT — Trio will not start a run until this is resolved:");
    for (const w of drift.warnings) lines.push(`    ${w}`);
    lines.push("");
  } else if (drift.warnings.length) {
    for (const w of drift.warnings) lines.push(`ⓘ ${w}`);
    lines.push("");
  }

  if (pre.state === "api_key_mode") {
    lines.push(`⚠ ${pre.message}`);
    lines.push("");
  }
  if (pre.state === "not_logged_in") {
    lines.push(`⚠ ${pre.message}   →  ${pre.fix}`);
    lines.push("");
  }

  lines.push(
    `${pad("Loop", 11)}max iterations  ${config.maxIterations}${pad("", 6)}stop on  ${config.converge.blockOn.join(", ")}`,
  );
  lines.push("");
  config.codex.lenses.forEach((l, i) => {
    lines.push(
      `${pad(i === 0 ? "Lenses" : "", 11)}${pad(l.name, 12)}${pad(modelLabel(l.model), 16)}${pad(l.effort, 9)}${l.on ? "● on" : "○ off"}`,
    );
  });
  lines.push("");
  lines.push(
    `${pad("View", 11)}mode  ${pad(config.view.mode, 10)}port ${config.view.port}${pad("", 3)}autoOpen ${config.view.autoOpen ? "✓" : "✗"}`,
  );
  lines.push(
    `${pad("Artifacts", 11)}raw .trio/runs  →  promote ${config.artifacts.promoteTo}/<agent>/YYYY-MM-DD/`,
  );
  lines.push(RULE);
  lines.push(
    config.enabled
      ? "/trio:off   /trio:loop --max 3   /trio:doctor"
      : "/trio:on   to enable",
  );
  lines.push(
    "/trio:lens security model <slug> effort high     /trio:config set view.mode pane",
  );
  lines.push("/trio:help   full command and concept reference");
  return lines.join("\n");
}

const gutter = (s, n) => {
  const str = String(s);
  return str.length >= n ? `${str}  ` : str.padEnd(n);
};

export function renderModelsTable({ models, lenses }) {
  const lines = [
    `${pad("MODEL", 18)}${pad("DISPLAY NAME", 20)}${pad("DEFAULT", 10)}${gutter("EFFORTS", 34)}LENSES`,
  ];
  for (const m of models) {
    const usedBy =
      lenses
        .filter((l) => l.model === m.slug)
        .map((l) => l.name)
        .join(", ") || "—";
    lines.push(
      `${pad(m.slug, 18)}${pad(m.displayName, 20)}${pad(m.defaultEffort, 10)}${gutter(m.efforts.join(","), 34)}${usedBy}`,
    );
  }
  // Rows come from the catalogue, so a lens matching no slug appears in none
  // of them. This table's whole job is saying which lens runs on which model,
  // and an unpinned lens silently missing from it is the one answer it must
  // not give.
  const unpinned = lenses
    .filter((l) => !l.model)
    .map((l) => l.name)
    .join(", ");
  if (unpinned) {
    lines.push(
      `${pad(modelLabel(null), 18)}${pad("—", 20)}${pad("—", 10)}${gutter("—", 34)}${unpinned}`,
    );
  }
  return lines.join("\n");
}
