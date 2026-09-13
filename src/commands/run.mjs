import { loadConfig, configErrors } from "../config.mjs";
import { validateLens } from "../capabilities.mjs";
import { startRun } from "../driver.mjs";
import { runLens } from "../codex-lane.mjs";
import {
  USAGE,
  RUN_FLAGS,
  asksForHelp,
  unknownFlags,
  valuelessFlags,
  lensSelection,
  flagValue,
} from "../cli-args.mjs";

// `trio run [--max N] [--target PATH] [--lenses a,b|all] [--scope TEXT] [--claude-findings PATH]`
export default async function runCommand({
  root,
  rest,
  out,
  gatherState,
  codexRefusal,
  ensureGitignore,
  stopLensesOnSignal,
  beforeFirstPass,
}) {
  if (asksForHelp(rest)) {
    out(USAGE);
    return;
  }
  const strays = unknownFlags(rest, RUN_FLAGS);
  if (strays.length) {
    out(
      `unknown flag${strays.length > 1 ? "s" : ""}: ${strays.join(", ")}\n\n${USAGE}`,
    );
    process.exitCode = 2;
    return;
  }
  const bare = valuelessFlags(rest, RUN_FLAGS);
  if (bare.length) {
    out(`${bare.join(", ")} needs a value\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  // A value can be present and still name nothing: `--lenses ,` parses to an
  // empty list, which applyLensSelection reads as "no selection given" and
  // runs every lens. What has to be non-empty is the parsed list.
  const lensNames = lensSelection(rest);
  if (lensNames && !lensNames.length) {
    out(`--lenses needs at least one lens name\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  // Arguments and stored config are validated before Codex is probed or
  // anything is spawned — gatherState() can still shell out to the real CLI
  // when its cache has aged out, so validating after it would mean a
  // malformed flag still ran a process. An unvalidated --max is not
  // cosmetic either: NaN compares false against every pass number, removing
  // the ceiling the loop needs.
  const config = loadConfig(root);
  const maxFlag = rest.indexOf("--max");
  if (maxFlag !== -1) {
    const n = Number(rest[maxFlag + 1]);
    if (!Number.isSafeInteger(n) || n < 1) {
      out(
        `--max takes a positive whole number, got: ${rest[maxFlag + 1] ?? "(nothing)"}`,
      );
      process.exitCode = 2;
      return;
    }
    config.maxIterations = n;
  }
  const bad = configErrors(config);
  if (bad.length) {
    out(`Refusing to start — .trio/config.json is invalid:\n  ${bad.join("\n  ")}`);
    process.exitCode = 2;
    return;
  }

  // Before the probe, not after: gatherState() can still shell out to the
  // real Codex CLI when its cache has aged out, and an opted-out project
  // must reach Codex not at all.
  if (!config.enabled) {
    out("Trio is off. Run /trio:on first.");
    process.exitCode = 1;
    return;
  }

  // Not forced: the capability cache is good for 24h (DESIGN §4), and only
  // /trio:doctor pays to refresh it early. Reusing a fresh cache here is
  // what cuts a run's own Codex traffic to just the ping below — the wave
  // of lenses is the thing actually being paid for. The gap this leaves
  // (Codex uninstalled in the last 24h) is caught late and generically
  // rather than with the friendly not-installed message doctor would give,
  // but that trade is the cache's whole point, not a new one.
  const { drift, pre, caps } = gatherState();
  if (pre.state === "not_installed" || pre.state === "not_logged_in") {
    out(`${pre.message}\n  ${pre.fix}`);
    process.exitCode = 1;
    return;
  }
  if (!drift.ok) {
    out(`Refusing to start:\n  ${drift.warnings.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }

  const target = flagValue(rest, "--target", root);
  // Reaches Codex inside the brief, which is written to the child's stdin —
  // never a command line — so this needs no shell quoting. It is trimmed
  // because an all-whitespace scope would print an empty "concentrate on".
  const scope = flagValue(rest, "--scope")?.trim() || null;
  const claudeFindingsPath = flagValue(rest, "--claude-findings");
  const lenses =
    lensNames?.length === 1 && lensNames[0] === "all"
      ? "all"
      : (lensNames ?? undefined);

  // A model slug only ever reached Codex as `--model` and was only rejected
  // there — after the lock was claimed and a wave of processes had been
  // spawned — so a slug that moved cost a whole degraded pass to discover.
  // The catalogue is already in hand from the probe above. Only the lenses
  // this run will actually spawn are checked: validating a lens the
  // selection turned off would refuse a run over a model nothing was going
  // to ask for. An empty catalogue checks nothing, because a first run
  // before Codex has ever been probed must still be possible.
  // Warned, not refused, and the distinction is the whole design. The
  // catalogue is Codex's own models_cache.json: it can lag a release, or
  // omit a slug that works perfectly well. Refusing on a mismatch would let
  // a stale cache block every run in the project — turning the pinned
  // default into a hard expiry date rather than a soft one. Saying it out
  // loud before the wave spawns closes the real gap, which was that a slug
  // that had moved cost a degraded pass to discover. Only the lenses this
  // run will actually spawn are checked; an empty catalogue checks nothing,
  // so a first run before Codex has ever been probed still works.
  const selected = !lenses || lenses === "all" ? null : new Set(lenses);
  if ((caps?.models ?? []).length) {
    for (const lens of config.codex.lenses) {
      if (!lens.on || (selected && !selected.has(lens.name))) continue;
      // stderr, like the viewer URL: this command's stdout is the run's JSON
      // result and every caller parses it, so a warning there would be a
      // breaking change dressed as a courtesy.
      const check = validateLens(caps, lens);
      if (!check.ok)
        process.stderr.write(`⚠ lens ${lens.name}: ${check.error}\n`);
    }
  }

  // The last check before anything is committed to, and it has to sit here
  // rather than beside the preflight above because it needs `target`.
  //
  // preflight asks whether Codex is installed and logged in. Neither
  // question can see a spent quota — the account is installed, logged in,
  // and looks perfectly healthy right up until a lens tries to use it.
  // Without this, an out-of-usage run still claimed the project lock, minted
  // a run directory, opened a browser window, and spawned every lens, to
  // discover in parallel what one trivial call answers in about a second.
  //
  // Only permanent refusals stop the run. Anything this cannot read plainly
  // proceeds — the lens wave is the authority, and a probe that could veto
  // every audit in a project on evidence it did not understand would be a
  // worse failure than the one it prevents.
  const refused = codexRefusal(target);
  if (refused) {
    out(
      JSON.stringify(
        {
          status: "refused",
          reason: "codex_unavailable",
          codexUnavailable: refused,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  // Trio is on by default, so a first run can be the first thing that ever
  // writes to .trio/ — /trio:on is no longer the guaranteed first touch.
  ensureGitignore();

  stopLensesOnSignal();

  const r = await startRun({
    root,
    config,
    target,
    runLensFn: runLens,
    beforeFirstPass,
    lenses,
    scope,
    claudeFindingsPath,
  });
  if (r.status === "invalid_findings") {
    out(`--claude-findings: ${r.error}`);
    process.exitCode = 2;
    return;
  }
  if (r.status === "invalid_lenses" || r.status === "no_lenses") {
    out(r.error);
    process.exitCode = 2;
    return;
  }
  // Exit 3, not 1: "the lock is held, try later" is the one refusal where
  // waiting is the right response, and every other exit-1 refusal (Trio
  // off, not logged in, drift) is one where waiting never helps. A caller
  // that polls has to be able to tell them apart without parsing prose.
  if (r.status === "run_in_progress") {
    out(
      `A run is already in progress: ${r.runId}${r.pass ? ` (pass ${r.pass})` : ""}.\n  Wait for it to finish, or /trio:cancel to end it.`,
    );
    process.exitCode = 3;
    return;
  }
  out(JSON.stringify(r, null, 2));
}
