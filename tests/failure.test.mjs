import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, codexUnavailable } from "../src/failure.mjs";

const failed = (lens, failure) => ({ lens, status: "failed", findings: [], failure });

test("a spent quota is not retryable and does trigger the offer", () => {
  const f = classifyFailure("You have hit your usage limit for this month.");
  assert.equal(f.kind, "usage");
  assert.equal(f.retryable, false);
  assert.equal(f.offer, true);
});

test("refused credentials name the command that fixes them", () => {
  const f = classifyFailure("stream error: 401 Unauthorized");
  assert.equal(f.kind, "auth");
  assert.equal(f.retryable, false);
  assert.equal(f.offer, true);
  assert.equal(f.fix, "codex login");
});

// Retryable and offerable at once: worth one more attempt, and if that fails
// the operator is looking at the same wall as a spent quota.
test("a rate limit is retried once and offered if it survives", () => {
  const f = classifyFailure("429 Too Many Requests");
  assert.equal(f.kind, "rate_limit");
  assert.equal(f.retryable, true);
  assert.equal(f.offer, true);
});

test("a transient fault is retried and never offered", () => {
  for (const text of [
    "503 Service Unavailable",
    "ECONNRESET",
    "socket hang up",
    "internal server error",
  ]) {
    const f = classifyFailure(text);
    assert.equal(f.retryable, true, text);
    assert.equal(f.offer, false, text);
  }
});

// The whole point of classifying: proposing a fallback on a guess is worse
// than saying "this failed and here is what it said".
test("an unrecognised failure is neither retried nor offered", () => {
  const f = classifyFailure("Segmentation fault");
  assert.equal(f.kind, "unknown");
  assert.equal(f.retryable, false);
  assert.equal(f.offer, false);
});

test("classification survives null and empty input", () => {
  assert.equal(classifyFailure(null).kind, "unknown");
  assert.equal(classifyFailure("").kind, "unknown");
});

// "usage limit" and a bare 429 both look like rate limiting to a loose
// regex. The specific claim has to win, or a spent quota gets retried.
test("a usage limit reported with a 429 is read as usage, not rate limiting", () => {
  const f = classifyFailure("429: You have exceeded your current quota");
  assert.equal(f.kind, "usage");
  assert.equal(f.retryable, false);
});

test("codexUnavailable: one lens failing is a degraded pass, not an outage", () => {
  const out = codexUnavailable([
    failed("auditor", classifyFailure("usage limit reached")),
    { lens: "security", status: "ok", findings: [] },
  ]);
  assert.equal(out, null);
});

test("codexUnavailable: every lens down for an offerable reason is an outage", () => {
  const out = codexUnavailable([
    failed("auditor", classifyFailure("usage limit reached")),
    failed("security", classifyFailure("usage limit reached")),
  ]);
  assert.equal(out.available, false);
  assert.equal(out.kind, "usage");
  assert.deepEqual(out.lenses, ["auditor", "security"]);
});

// A whole run that died of something nobody recognises is still a failed run.
// It is not evidence that Codex is unreachable, and offering to replace Codex
// on the strength of it would be a guess dressed as a diagnosis.
test("codexUnavailable: every lens down for an unknown reason is not an outage", () => {
  const out = codexUnavailable([
    failed("auditor", classifyFailure("Segmentation fault")),
    failed("security", classifyFailure("Segmentation fault")),
  ]);
  assert.equal(out, null);
});

// A lens that hung was reached. Whatever went wrong, it was not that Codex
// could not be spoken to.
test("codexUnavailable: timeouts are not evidence of an outage", () => {
  const out = codexUnavailable([
    { lens: "auditor", status: "timeout", findings: [] },
    { lens: "security", status: "timeout", findings: [] },
  ]);
  assert.equal(out, null);
});

test("codexUnavailable: an empty lens list decides nothing", () => {
  assert.equal(codexUnavailable([]), null);
  assert.equal(codexUnavailable(undefined), null);
});

// The haystack is a lens's stderr and error events: line numbers, byte
// counts, token counts, durations. A bare three-digit number in any of them
// used to read as an HTTP status and buy a retry that could not help.
test("a bare three-digit number is not a status code", () => {
  for (const text of [
    "panic at line 503",
    "read 512 bytes before EOF",
    "completed in 429 ms",
    "wrote 401 tokens",
  ]) {
    assert.equal(classifyFailure(text).kind, "unknown", text);
  }
});

test("a status code in context is still recognised", () => {
  assert.equal(classifyFailure("error: HTTP 503").kind, "server");
  assert.equal(classifyFailure("server returned 429").kind, "rate_limit");
  assert.equal(classifyFailure("response status 401").kind, "auth");
});

// One lens hanging must not suppress an offer four other lenses are making.
// A timeout is skipped, not counted as a lens that did not fail.
test("codexUnavailable: a timeout alongside real outages does not veto the offer", () => {
  const out = codexUnavailable([
    { lens: "auditor", status: "timeout", findings: [] },
    failed("security", classifyFailure("usage limit reached")),
    failed("tester", classifyFailure("usage limit reached")),
  ]);
  assert.equal(out.kind, "usage");
  assert.deepEqual(out.lenses, ["security", "tester"], "the hung lens is not evidence");
});

// But a lens that actually returned findings still means Codex was reachable.
test("codexUnavailable: a timeout plus a working lens is still no outage", () => {
  const out = codexUnavailable([
    { lens: "auditor", status: "timeout", findings: [] },
    { lens: "security", status: "ok", findings: [] },
  ]);
  assert.equal(out, null);
});
