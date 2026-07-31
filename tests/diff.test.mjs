import { test } from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff } from "../src/diff.mjs";

test("marks removed and added lines", () => {
  const out = unifiedDiff(
    "a.js",
    "let x = 1;\nlet y = 2;\n",
    "let x = 1;\nlet y = 3;\n",
  );
  assert.match(out, /^--- a\/a\.js$/m);
  assert.match(out, /^\+\+\+ b\/a\.js$/m);
  assert.match(out, /^-let y = 2;$/m);
  assert.match(out, /^\+let y = 3;$/m);
});

test("keeps context lines with a leading space", () => {
  const out = unifiedDiff("a.js", "a\nb\n", "a\nc\n");
  assert.match(out, /^ a$/m);
});

test("a pure addition has no removal lines", () => {
  const out = unifiedDiff("new.js", "", "hello\n");
  assert.match(out, /^\+hello$/m);
  assert.doesNotMatch(out, /^-[^-]/m); // was /^-/m — the `--- a/…` header matches that
});

test("identical input yields no +/- lines", () => {
  const out = unifiedDiff("a.js", "same\n", "same\n");
  assert.doesNotMatch(out, /^[+-][^+-]/m);
});
