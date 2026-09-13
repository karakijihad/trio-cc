import { mkdirSync } from "node:fs";
import { loadConfig, configErrors } from "../config.mjs";
import { validateLens } from "../capabilities.mjs";
import { runDir } from "../paths.mjs";
import { newRunId } from "../orchestrator.mjs";

// `trio consult <question>`
export default async function consultCommand({ root, rest, out, gatherState, codexRefusal, unavailable }) {
  // Usage before probing, for the same reason as `run`. A leading dash is a
  // mistyped flag, not a question — asking Codex "--help" costs real money.
  const question = rest.join(" ");
  if (!question || rest[0].startsWith("-")) {
    out("usage: trio consult <question>");
    process.exitCode = 2;
    return;
  }
  // consult spends the operator's credit exactly as a run does, so the
  // project opt-out has to hold here too — and hold before the probe.
  const config = loadConfig(root);
  if (!config.enabled) {
    out("Trio is off. Run /trio:on first.");
    process.exitCode = 1;
    return;
  }
  const bad = configErrors(config);
  if (bad.length) {
    out(`Refusing to consult — .trio/config.json is invalid:\n  ${bad.join("\n  ")}`);
    process.exitCode = 2;
    return;
  }
  const { pre, caps, consult } = gatherState();
  if (pre.state === "not_installed" || pre.state === "not_logged_in") {
    out(`${pre.message}\n  ${pre.fix}`);
    process.exitCode = 1;
    return;
  }
  // Same warning, same stream, as a run's lens check: stdout is the JSON.
  if ((caps?.models ?? []).length) {
    const check = validateLens(caps, consult);
    if (!check.ok) process.stderr.write(`⚠ consult: ${check.error}\n`);
  }
  // Without this a consult on a spent account launched, read the repo for
  // minutes, and came back `failed: true` with the reason unread in its log.
  const refused = codexRefusal(root);
  if (refused) {
    out(
      JSON.stringify(
        {
          answer: "",
          failed: true,
          error: refused.message,
          codexUnavailable: refused,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const runId = `consult-${newRunId()}`;
  mkdirSync(runDir(root, runId), { recursive: true });
  const { askCodex } = await import("../consult.mjs");
  let r;
  try {
    r = await askCodex({
      question,
      target: root,
      model: consult.model,
      effort: consult.effort,
      runDirPath: runDir(root, runId),
      run: runId,
      timeoutMs: config.codex.timeoutMinutes * 60_000,
    });
  } catch (err) {
    // Codex being uninvokable is a failed consult, not a crashed CLI —
    // a cached-fresh preflight can report "ready" for an install that has
    // broken since it was probed.
    out(
      JSON.stringify(
        { runId, answer: "", failed: true, error: err.message },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  // A failed consult says why, and exits non-zero so a caller cannot read
  // an empty answer as one.
  const result = { runId, answer: r.answer, failed: r.failed };
  if (r.failed) {
    result.error = r.error ?? r.failure?.message;
    if (r.failure?.offer) result.codexUnavailable = unavailable(r.failure);
    process.exitCode = 1;
  }
  out(JSON.stringify(result, null, 2));
}
