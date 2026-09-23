// Argument handling, tested directly rather than by spawning a CLI. These
// guards exist because an unrecognised flag used to fall through to a
// five-lens Codex run, so they are worth exercising exhaustively and cheaply.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUN_FLAGS,
  CONSULT_FLAGS,
  CONTINUE_FLAGS,
  EXTEND_FLAGS,
  UNADJUDICATED_FLAG,
  USAGE,
  asksForHelp,
  unknownFlags,
  valuelessFlags,
  lensSelection,
  parseLensArgs,
  flagValue,
  consultQuestion,
  consultArgs,
  repeatedFlags,
} from "../src/cli-args.mjs";

test("asksForHelp recognises both spellings, anywhere", () => {
  assert.equal(asksForHelp(["--help"]), true);
  assert.equal(asksForHelp(["--max", "2", "-h"]), true);
  assert.equal(asksForHelp(["--max", "2"]), false);
});

test("unknownFlags steps over the value of a flag it knows", () => {
  assert.deepEqual(unknownFlags(["--max", "3"], RUN_FLAGS), []);
  assert.deepEqual(unknownFlags(["--target", "-x"], RUN_FLAGS), []);
  assert.deepEqual(unknownFlags(["--frob"], RUN_FLAGS), ["--frob"]);
  assert.deepEqual(unknownFlags(["--max", "3", "--frob"], RUN_FLAGS), [
    "--frob",
  ]);
  assert.deepEqual(unknownFlags(["audit", "--frob", "-q"], RUN_FLAGS), [
    "--frob",
    "-q",
  ]);
});

test("valuelessFlags catches a flag swallowed as another's value", () => {
  assert.deepEqual(valuelessFlags(["--target"], RUN_FLAGS), ["--target"]);
  assert.deepEqual(valuelessFlags(["--target", "--lenses", "a"], RUN_FLAGS), [
    "--target",
  ]);
  assert.deepEqual(valuelessFlags(["--lenses", "  "], RUN_FLAGS), ["--lenses"]);
});

// A dashed value is a badly chosen value, not a missing one: it has to reach
// the check that can explain itself.
test("valuelessFlags lets a dashed value through to its own validator", () => {
  assert.deepEqual(valuelessFlags(["--max", "-1"], RUN_FLAGS), []);
  assert.deepEqual(valuelessFlags(["--target", "-weird-dir"], RUN_FLAGS), []);
});

test("lensSelection separates 'not asked' from 'asked for nothing'", () => {
  assert.equal(lensSelection(["--max", "2"]), null);
  assert.deepEqual(lensSelection(["--lenses", ","]), []);
  assert.deepEqual(lensSelection(["--lenses", ",,,"]), []);
  assert.deepEqual(lensSelection(["--lenses", ""]), []);
  assert.deepEqual(lensSelection(["--lenses"]), []);
  assert.deepEqual(lensSelection(["--lenses", "auditor"]), ["auditor"]);
  assert.deepEqual(lensSelection(["--lenses", " auditor , security "]), [
    "auditor",
    "security",
  ]);
  assert.deepEqual(lensSelection(["--lenses", "all"]), ["all"]);
});

test("flagValue reads the value following a flag, or falls back", () => {
  assert.equal(flagValue(["--target", "/repo"], "--target"), "/repo");
  assert.equal(flagValue(["--max", "2"], "--target"), null);
  assert.equal(flagValue(["--max", "2"], "--target", "."), ".");
  // The value at the end of argv, or another flag's own name, is handed back
  // as-is — the caller decides whether that is a value worth having.
  assert.equal(flagValue(["--target"], "--target"), undefined);
  assert.equal(
    flagValue(["--file"], "--file", 0),
    undefined,
    "a flag with nothing after it still overrides the fallback",
  );
});

test("parseLensArgs reads the whole grammar", () => {
  assert.deepEqual(parseLensArgs([]).changes, {});
  assert.deepEqual(parseLensArgs(["on"]).changes, { on: true });
  assert.deepEqual(parseLensArgs(["off"]).changes, { on: false });
  assert.deepEqual(parseLensArgs(["model", "m1"]).changes, { model: "m1" });
  assert.deepEqual(parseLensArgs(["effort", "high"]).changes, {
    effort: "high",
  });
});

// The defect this replaced: stepping in twos from index 0 meant the "on"
// token shifted everything after it, and the model was dropped in silence.
test("parseLensArgs does not lose a value that follows on/off", () => {
  assert.deepEqual(parseLensArgs(["on", "model", "m1"]).changes, {
    on: true,
    model: "m1",
  });
  assert.deepEqual(
    parseLensArgs(["off", "model", "m1", "effort", "low"]).changes,
    { on: false, model: "m1", effort: "low" },
  );
});

// A model can be named before the question or after it — the operator
// reaches for --model wherever they happen to be typing.
test("consultQuestion takes the flag and its value out, wherever it stands", () => {
  assert.equal(
    consultQuestion(["--model", "astra", "is", "x", "ok?"]),
    "is x ok?",
  );
  assert.equal(
    consultQuestion(["is", "x", "ok?", "--model", "astra"]),
    "is x ok?",
  );
});

test("consultQuestion takes out both flags at once", () => {
  assert.equal(
    consultQuestion(["--model", "astra", "--effort", "high", "is", "x", "ok?"]),
    "is x ok?",
  );
});

test("consultQuestion with no flags is the whole argv, joined", () => {
  assert.equal(consultQuestion(["is", "x", "ok?"]), "is x ok?");
});

// No question at all — just a flag and its value — is the empty string, not
// undefined or a stray space, so the caller's `!question` check catches it.
test("consultQuestion is empty when only a flag and its value were given", () => {
  assert.equal(consultQuestion(["--model", "astra"]), "");
});

// A bare `--` ends flag parsing: everything before it is flags, everything
// after is question text verbatim, and the separator itself is dropped.
test("consultArgs splits at the first bare --", () => {
  assert.deepEqual(consultArgs(["--model", "astra", "--", "is", "x", "ok?"]), {
    flags: ["--model", "astra"],
    tail: ["is", "x", "ok?"],
  });
});

test("consultArgs with no -- at all puts everything in flags", () => {
  assert.deepEqual(consultArgs(["--model", "astra", "is", "x", "ok?"]), {
    flags: ["--model", "astra", "is", "x", "ok?"],
    tail: [],
  });
});

// Only the first `--` matters: a question that itself contains `--` is
// still free text once flag parsing has ended.
test("consultArgs stops at the first of several --", () => {
  assert.deepEqual(consultArgs(["--", "explain", "--", "this"]), {
    flags: [],
    tail: ["explain", "--", "this"],
  });
});

test("consultArgs with nothing after -- has an empty tail", () => {
  assert.deepEqual(consultArgs(["--model", "astra", "--"]), {
    flags: ["--model", "astra"],
    tail: [],
  });
});

// `--model a --model b` took the first silently. A flag given twice is now a
// refusal, in the style of parseLensArgs's own "given twice" check.
test("repeatedFlags catches a flag given twice", () => {
  assert.deepEqual(
    repeatedFlags(["--model", "astra", "--model", "nope"], CONSULT_FLAGS),
    ["--model"],
  );
  assert.deepEqual(
    repeatedFlags(["--model", "astra", "--effort", "high"], CONSULT_FLAGS),
    [],
  );
  assert.deepEqual(repeatedFlags([], CONSULT_FLAGS), []);
});

// Each flag's value is stepped over, so a value that happens to equal a flag
// name is not mistaken for a repeat of that flag — valuelessFlags is what
// refuses a value-less flag, this only catches the flag token itself twice.
test("repeatedFlags does not mistake a value equal to a flag name for a repeat", () => {
  assert.deepEqual(
    repeatedFlags(["--model", "--model", "is", "x", "ok?"], CONSULT_FLAGS),
    [],
  );
});

// D-adjudication-gate's own flag: deliberately a bare word, not part of
// CONTINUE_FLAGS/EXTEND_FLAGS — both call sets assume every flag they list
// takes a value, and unknownFlags would otherwise swallow whatever token
// follows --unadjudicated as if it belonged to it.
test("--unadjudicated is a bare flag, kept out of the value-taking flag sets", () => {
  assert.equal(UNADJUDICATED_FLAG, "--unadjudicated");
  assert.equal(CONTINUE_FLAGS.has(UNADJUDICATED_FLAG), false);
  assert.equal(EXTEND_FLAGS.has(UNADJUDICATED_FLAG), false);
  // unknownFlags is what commands/continue.mjs and extend.mjs run once the
  // flag itself has been filtered out of argv — it must not itself know
  // about --unadjudicated, or a stray copy left in argv would silently pass.
  assert.deepEqual(unknownFlags([UNADJUDICATED_FLAG], CONTINUE_FLAGS), [
    UNADJUDICATED_FLAG,
  ]);
});

test("USAGE documents --unadjudicated for both continue and extend", () => {
  assert.match(USAGE, /trio continue.*--unadjudicated/);
  assert.match(USAGE, /trio extend.*--unadjudicated/);
});

test("parseLensArgs refuses what it cannot fully parse", () => {
  for (const [args, expected] of [
    [["model"], /model needs a value/],
    [["effort"], /effort needs a value/],
    [["model", "  "], /model needs a value/],
    [["frobnicate", "x"], /unexpected argument: frobnicate/],
    [["on", "wat"], /unexpected argument: wat/],
    [["model", "a", "model", "b"], /model given twice/],
    [["model", "a", "on"], /unexpected argument: on/],
  ]) {
    const r = parseLensArgs(args);
    assert.match(r.error ?? "", expected, args.join(" "));
    assert.equal(r.changes, undefined, args.join(" "));
  }
});
