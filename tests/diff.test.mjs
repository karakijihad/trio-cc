import { test } from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff, MAX_DIFF_LINES } from "../src/diff.mjs";

// lcsTable is a full (n+1)x(m+1) matrix and this runs inside the PostToolUse
// hook on every Edit and Write, so one generated file could hang the tool
// call it was supposed to be observing.
test("a huge edit is summarised rather than diffed", () => {
  const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `l${i}`).join(
    "\n",
  );
  const started = Date.now();
  const out = unifiedDiff("big.txt", big, big + "\nmore");
  assert.ok(Date.now() - started < 2000, "the cap did not short-circuit");
  assert.match(out, /diff not computed/);
  assert.match(out, new RegExp(`${MAX_DIFF_LINES}-line cap`));
  assert.match(out, /--- a\/big\.txt/);
});

test("an edit at the cap is still diffed in full", () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
  const out = unifiedDiff("ok.txt", lines(MAX_DIFF_LINES), lines(MAX_DIFF_LINES - 1));
  assert.doesNotMatch(out, /diff not computed/);
  assert.match(out, /^-l\d+$/m);
});

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
