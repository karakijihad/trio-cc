const pad = (s, n) => String(s).padEnd(n);
const RULE = "─".repeat(74);

export function renderPanel({ installed, config, caps, drift, pre }) {
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
  lines.push(
    `${pad("Auto", 11)}${config.auto}${pad("", 14)}(off | ask | always)`,
  );
  lines.push("");
  config.codex.lenses.forEach((l, i) => {
    lines.push(
      `${pad(i === 0 ? "Lenses" : "", 11)}${pad(l.name, 12)}${pad(l.model, 16)}${pad(l.effort, 9)}${l.on ? "● on" : "○ off"}`,
    );
  });
  lines.push("");
  lines.push(
    `${pad("View", 11)}mode  ${pad(config.view.mode, 10)}port ${config.view.port}${pad("", 3)}autoOpen ${config.view.autoOpen ? "✓" : "✗"}`,
  );
  lines.push(
    `${pad("Artifacts", 11)}raw ${config.artifacts.raw}  →  promote ${config.artifacts.promoteTo}/<agent>/YYYY-MM-DD/`,
  );
  lines.push(RULE);
  lines.push(
    config.enabled
      ? "/trio:off   /trio:loop --max 3   /trio:doctor"
      : "/trio:on   to enable",
  );
  lines.push(
    "/trio:lens security model gpt-5.6-terra effort ultra     /trio:config set view.mode html",
  );
  return lines.join("\n");
}
