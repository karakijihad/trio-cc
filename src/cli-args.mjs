// Argument handling for bin/trio.mjs, kept apart from the command bodies so
// it can be tested without spawning a CLI. Everything here is a pure function
// of its arguments — no disk, no config, no Codex.

export const USAGE = `trio — Codex as a read-only second reviewer.

  trio [status] [--json]            the control panel (default); --json
                                    reports the lock without probing Codex
  trio on | off                     enable or disable Trio for this project
  trio doctor                       re-probe Codex and report health
  trio run [--max N] [--target PATH] [--lenses a,b|all] [--scope TEXT]
                 [--claude-findings PATH]   Claude's own audit of the same scope
  trio continue [--claude-findings PATH]  run the next pass of the active run
  trio verdicts [runId] [pass] [--file PATH]   validate adjudication and write
                                    pass-N/verdicts.json; reads stdin by
                                    default, and writes nothing if anything
                                    is wrong
  trio extend [runId]               one more pass on a ceiling-reached run
  trio cancel                       cancel the active run
  trio consult [--model NAME] [--effort LEVEL] <question>
                                    ask Codex one question; --model takes any
                                    part of a slug ("astra") and holds for
                                    this call only
  trio config get | set <key> <value>
  trio lens <name> [on|off] [model <slug>] [effort <level>]
  trio models [--json] [--apply]    Codex models, which lens uses each, and swaps to apply
  trio promote [runId] [--create]   copy a finished run into artifacts.promoteTo
  trio serve [runId] [--auto-exit]  start the viewer
  trio render [runId]               write a static HTML report

Exit codes: 0 did what was asked (a run that found defects still exits 0 —
the verdict is in the JSON, not the code), 1 refused or nothing to do, 2 you
called it wrong, 3 another run holds this project's lock (retry later).

A run spends the operator's own OpenAI credit, so an unrecognised flag is
refused rather than ignored.

A consult holds no lock — there is nothing for /trio:cancel to find — and
cannot be cancelled once started; it runs until it answers or its own
timeout ends it.`;

export const RUN_FLAGS = new Set([
  "--max",
  "--target",
  "--lenses",
  "--scope",
  "--claude-findings",
]);

// `continue` and `extend` take neither the target, the scope, nor the lens
// selection: all three are snapshotted into run.json at pass 1 and inherited.
// Accepting them anyway would let `trio continue --lenses security` look like
// it narrowed the run while the old set kept running — the silent no-op the
// unknown-flag guard exists to prevent.
export const CONTINUE_FLAGS = new Set(["--claude-findings"]);
export const EXTEND_FLAGS = new Set(["--claude-findings"]);

// Named on the command line, both hold for one consult and are never saved:
// the configured pair is what the next consult runs on. A consult takes no
// other flag, so anything else is a typo — and a typo that reached Codex
// would be spent credit on a question with a stray word in it.
export const CONSULT_FLAGS = new Set(["--model", "--effort"]);

export const CONSULT_USAGE =
  "usage: trio consult [--model NAME] [--effort LEVEL] [--] <question>";

// A bare `--` ends flag parsing: everything after it is question text,
// dashes and all. Without it there is no way to ask about `--model` itself —
// the word after it would be read as the model and lost from the question,
// and a question is free text, so no guard can tell the two apart.
export const consultArgs = (args) => {
  const at = args.indexOf("--");
  return at === -1
    ? { flags: args, tail: [] }
    : { flags: args.slice(0, at), tail: args.slice(at + 1) };
};

// `--model a --model b` took the first and said nothing, which is how an
// operator correcting a typo pays for the model they meant to replace. Each
// flag's value is stepped over, so a value that is itself a flag name is not
// a repeat — valuelessFlags is what refuses that one.
export const repeatedFlags = (args, known) => {
  const seen = new Set();
  const twice = new Set();
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) continue;
    if (seen.has(args[i])) twice.add(args[i]);
    seen.add(args[i]);
    i++;
  }
  return [...twice];
};

// The question is whatever is left once the flags and their values are taken
// out, so a model can be named before the question or after it.
export const consultQuestion = (args) => {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (CONSULT_FLAGS.has(args[i])) i++;
    else words.push(args[i]);
  }
  return words.join(" ").trim();
};

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

// The value following a flag, or `fallback` when the flag is absent. Every
// call site that reads one flag's value used to repeat
// `args.includes(x) ? args[args.indexOf(x)+1] : fallback` by hand.
export const flagValue = (args, flag, fallback = null) => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : args[at + 1];
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
