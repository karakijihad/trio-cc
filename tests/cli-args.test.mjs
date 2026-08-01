// Argument handling, tested directly rather than by spawning a CLI. These
// guards exist because an unrecognised flag used to fall through to a
// five-lens Codex run, so they are worth exercising exhaustively and cheaply.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUN_FLAGS,
  asksForHelp,
  unknownFlags,
  valuelessFlags,
  lensSelection,
  parseLensArgs,
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
