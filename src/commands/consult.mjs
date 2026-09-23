import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, configErrors } from "../config.mjs";
import { validateLens, resolveModel } from "../capabilities.mjs";
import {
  CONSULT_FLAGS,
  CONSULT_USAGE,
  consultArgs,
  consultQuestion,
  flagValue,
  repeatedFlags,
  unknownFlags,
  valuelessFlags,
} from "../cli-args.mjs";
import { runDir, runsDir } from "../paths.mjs";
import { newRunId } from "../orchestrator.mjs";

// Resolved relative to this module, not cwd — `trio` runs from whatever
// directory the operator is in, and package.json lives beside this install,
// two levels up from src/commands/.
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = join(HERE, "..", "..", "package.json");

function trioVersion() {
  try {
    return JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

// A consult used to persist nothing on disk but events.jsonl — no record of
// which model or effort answered, or whether it ever finished, once the
// stdout JSON scrolled off the terminal. run.json is written the moment the
// run dir exists, so even a consult that crashes before askCodex returns
// leaves behind what was asked and of whom; finishRunJson below fills in how
// it ended. Best-effort: this file is a record for later reading, and losing
// it must never turn a real answer into a failed consult.
function writeStartedRunJson(path, fields) {
  try {
    writeFileSync(path, JSON.stringify(fields, null, 2) + "\n");
  } catch {
    /* stdout's JSON is the actual contract; this is a bonus record */
  }
}

function finishRunJson(path, failed) {
  try {
    const started = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify(
        { ...started, finishedAt: new Date().toISOString(), failed },
        null,
        2,
      ) + "\n",
    );
  } catch {
    /* same */
  }
}

// Run ids have second precision, and two consults in one second (two
// sessions, or one asking twice) would share a directory and overwrite each
// other's run.json. The non-recursive mkdir is the claim: EEXIST means taken,
// so try the next suffix — the same -N shape uniqueRunId gives an audit run.
export function claimConsultDir(root, base) {
  mkdirSync(runsDir(root), { recursive: true });
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    try {
      mkdirSync(runDir(root, id));
      return id;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

// `trio consult <question>`
export default async function consultCommand({ root, rest, out, gatherState, codexRefusal, unavailable, ensureGitignore }) {
  // Usage before probing, for the same reason as `run`. An unrecognised dash
  // is a mistyped flag, not part of the question — asking Codex "--help"
  // costs real money, and so does a question with a dropped flag in it.
  // Only a long flag is refused wherever it stands: a question can carry a
  // "-1" and that is not a typo, but a "--model" swallowed into one asks the
  // wrong model a question the operator paid for. A leading dash of any
  // shape stays a mistyped flag, which is what this guard caught before.
  const { flags, tail } = consultArgs(rest);
  const badFlags = unknownFlags(flags, CONSULT_FLAGS).filter(
    (f) => f.startsWith("--") || f === flags[0],
  );
  const emptyFlags = valuelessFlags(flags, CONSULT_FLAGS);
  const twice = repeatedFlags(flags, CONSULT_FLAGS);
  if (badFlags.length || emptyFlags.length || twice.length) {
    const why = badFlags.length
      ? `unrecognised flag: ${badFlags.join(", ")}`
      : emptyFlags.length
        ? `${emptyFlags.join(", ")} needs a value`
        : `${twice.join(", ")} given twice`;
    out(`${why}\n${CONSULT_USAGE}`);
    process.exitCode = 2;
    return;
  }
  const question = [consultQuestion(flags), ...tail].join(" ").trim();
  if (!question) {
    out(CONSULT_USAGE);
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
  // A model or effort named on the command line holds for this call alone:
  // nothing is written, so the next consult is back on the configured pair.
  // Resolving a part of a slug needs the catalogue; without one the name goes
  // through as typed, which is what an unprobed Codex would do with it anyway.
  const chosen = { ...consult };
  const modelArg = flagValue(flags, "--model");
  const effortArg = flagValue(flags, "--effort");
  if (effortArg) chosen.effort = effortArg;
  if (modelArg) chosen.model = modelArg;
  if (modelArg && (caps?.models ?? []).length) {
    const picked = resolveModel(caps.models, modelArg);
    if (!picked.ok) {
      out(picked.error);
      process.exitCode = 2;
      return;
    }
    chosen.model = picked.slug;
  }
  if ((caps?.models ?? []).length) {
    const check = validateLens(caps, chosen);
    // A configured pair that has drifted out of the catalogue is a warning
    // the operator cannot act on mid-question, on the same stream as a run's
    // lens check since stdout is the JSON. A pair named in this very command
    // is a typo, and refusing a typo before it is spent costs nothing.
    if (!check.ok && (modelArg || effortArg)) {
      out(check.error);
      process.exitCode = 2;
      return;
    }
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

  // run.json below keeps the question verbatim, and a question can carry
  // anything the operator pasted — so .trio/ is ignored first, as run does.
  ensureGitignore?.();
  const runId = claimConsultDir(root, `consult-${newRunId()}`);
  const runJsonPath = join(runDir(root, runId), "run.json");
  writeStartedRunJson(runJsonPath, {
    runId,
    kind: "consult",
    question,
    model: chosen.model,
    effort: chosen.effort,
    startedAt: new Date().toISOString(),
    trioVersion: trioVersion(),
  });
  const { askCodex } = await import("../consult.mjs");
  let r;
  try {
    r = await askCodex({
      question,
      target: root,
      model: chosen.model,
      effort: chosen.effort,
      runDirPath: runDir(root, runId),
      run: runId,
      timeoutMs: config.codex.timeoutMinutes * 60_000,
    });
  } catch (err) {
    // Codex being uninvokable is a failed consult, not a crashed CLI —
    // a cached-fresh preflight can report "ready" for an install that has
    // broken since it was probed.
    finishRunJson(runJsonPath, true);
    out(
      JSON.stringify(
        {
          runId,
          model: chosen.model,
          effort: chosen.effort,
          answer: "",
          failed: true,
          error: err.message,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  finishRunJson(runJsonPath, r.failed);
  // A failed consult says why, and exits non-zero so a caller cannot read
  // an empty answer as one.
  const result = {
    runId,
    model: chosen.model,
    effort: chosen.effort,
    answer: r.answer,
    failed: r.failed,
  };
  if (r.failed) {
    result.error = r.error ?? r.failure?.message;
    if (r.failure?.offer) result.codexUnavailable = unavailable(r.failure);
    process.exitCode = 1;
  }
  out(JSON.stringify(result, null, 2));
}
