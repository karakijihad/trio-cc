// Argument handling for bin/trio.mjs, kept apart from the command bodies so
// it can be tested without spawning a CLI. Everything here is a pure function
// of its arguments — no disk, no config, no Codex.

export const USAGE = `trio — Codex as a read-only second reviewer.

  trio [status]                     the control panel (default)
  trio on | off                     enable or disable Trio for this project
  trio doctor                       re-probe Codex and report health
  trio run [--max N] [--target PATH] [--lenses a,b|all]
  trio continue                     run the next pass of the active run
  trio cancel                       cancel the active run
  trio consult <question>           ask Codex one question
  trio config get | set <key> <value>
  trio lens <name> [on|off] [model <slug>] [effort <level>]
  trio models [--json]              Codex models and which lens uses each
  trio promote [runId] [--create]   copy a finished run into artifacts.promoteTo
  trio serve [runId] [--auto-exit]  start the viewer
  trio render [runId]               write a static HTML report

A run spends the operator's own OpenAI credit, so an unrecognised flag is
refused rather than ignored.`;

export const RUN_FLAGS = new Set(["--max", "--target", "--lenses"]);

export const LENS_USAGE =
  "usage: trio lens <name> [on|off] [model <slug>] [effort <level>]";

export const asksForHelp = (args) =>
  args.includes("--help") || args.includes("-h");

// Flags Trio does not know are a refusal, not a no-op: silently dropping one
// means `trio run --help` reads as "run everything", and every lens that
// starts is money spent. Values of known flags are stepped over so a value
// that happens to begin with "-" is not mistaken for a flag of its own.
export const unknownFlags = (args, known) => {
  const bad = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("-")) continue;
    if (known.has(args[i])) i++;
    else bad.push(args[i]);
  }
  return bad;
};

// Every flag `run` knows takes a value. Left unchecked, `--target --lenses x`
// reads "--lenses" as the audit target and the unknown-flag walk above steps
// straight over it, so the two guards have to be read together.
//
// "Flag-like" is deliberately narrower than "starts with a dash": a target
// path or a negative --max is a value, badly chosen, and belongs to the check
// that can say why. Only a long flag, a flag this command knows, or a value
// that is nothing but whitespace is a value that never was.
export const valuelessFlags = (args, known) =>
  args.filter(
    (a, i) =>
      known.has(a) &&
      (i + 1 >= args.length ||
        known.has(args[i + 1]) ||
        args[i + 1].startsWith("--") ||
        args[i + 1].trim() === ""),
  );

// A `--lenses` value can be present and still name nothing: `--lenses ,`
// parses to an empty list, which applyLensSelection reads as "no selection
// given" and answers by running every lens. Returns null when the flag is
// absent, so "not asked for" stays distinguishable from "asked for nothing".
export const lensSelection = (args) => {
  const at = args.indexOf("--lenses");
  if (at === -1) return null;
  return (args[at + 1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

// The old parser stepped in twos from index 0, so `lens auditor on model x`
// read "on" as a key, skipped it, and dropped the model silently — then
// reported success. A command that changed nothing must not look like one
// that worked, and an unknown token is a typo, not a no-op.
export const parseLensArgs = (args) => {
  const changes = {};
  let i = 0;
  if (args[i] === "on" || args[i] === "off") {
    changes.on = args[i] === "on";
    i++;
  }
  for (; i < args.length; i += 2) {
    const key = args[i];
    if (key !== "model" && key !== "effort")
      return { error: `unexpected argument: ${key}\n${LENS_USAGE}` };
    if (key in changes) return { error: `${key} given twice\n${LENS_USAGE}` };
    if (args[i + 1] === undefined || args[i + 1].trim() === "")
      return { error: `${key} needs a value\n${LENS_USAGE}` };
    changes[key] = args[i + 1];
  }
  return { changes };
};
