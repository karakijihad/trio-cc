import { test } from "node:test";
import assert from "node:assert/strict";
import { ping, PING_PROMPT, PING_TIMEOUT_MS } from "../src/ping.mjs";

const fake = (result) => {
  const calls = [];
  const runSync = (file, args, opts) => {
    calls.push({ file, args, opts });
    return result;
  };
  return { runSync, calls };
};

test("a Codex that answers lets the run proceed", () => {
  const { runSync } = fake({ status: 0, stdout: "ok", stderr: "" });
  assert.deepEqual(ping({ target: "/repo", runSync }), { ok: true });
});

test("a spent quota refuses the run before anything is committed to", () => {
  const { runSync } = fake({
    status: 1,
    stdout: "",
    stderr: "You've hit your usage limit.",
  });
  const r = ping({ target: "/repo", runSync });
  assert.equal(r.ok, false);
  assert.equal(r.failure.kind, "usage");
});

// The reason lands on stdout as a JSON error event about as often as it lands
// on stderr, depending how far Codex got before it gave up.
test("the reason is found on either stream", () => {
  const { runSync } = fake({
    status: 1,
    stdout: '{"type":"error","message":"You have exceeded your current quota"}',
    stderr: "",
  });
  assert.equal(ping({ target: "/repo", runSync }).failure.kind, "usage");
});

// A ping is a convenience, not a gate. Refusing on evidence it could not
// read would let this probe veto every audit in a project.
test("an unreadable failure proceeds rather than vetoing the run", () => {
  const { runSync } = fake({ status: 7, stdout: "", stderr: "Segmentation fault" });
  const r = ping({ target: "/repo", runSync });
  assert.equal(r.ok, "unknown");
  assert.equal(r.failure.kind, "unknown");
});

// Offerable but retryable. The lens layer already retries this once before
// giving up; refusing here would kill a run a second attempt would finish.
test("a rate limit proceeds and is left to the lens layer's retry", () => {
  const { runSync } = fake({ status: 1, stdout: "", stderr: "429 rate limit" });
  const r = ping({ target: "/repo", runSync });
  assert.equal(r.ok, "unknown");
  assert.equal(r.failure.kind, "rate_limit");
});

test("a spawn that throws proceeds rather than taking the run down", () => {
  const runSync = () => {
    throw new Error("spawn EPERM");
  };
  assert.equal(ping({ target: "/repo", runSync }).ok, "unknown");
});

test("a spawn error object proceeds too", () => {
  const { runSync } = fake({ error: new Error("ENOENT"), status: null });
  assert.equal(ping({ target: "/repo", runSync }).ok, "unknown");
});

// Read-only, scoped to the target, and bounded. A ping that can hang for a
// lens timeout is worse than none — it delays the failure it exists to find.
test("the probe is read-only, scoped to the target, and time-bounded", () => {
  const { runSync, calls } = fake({ status: 0, stdout: "", stderr: "" });
  ping({ target: "/repo", runSync });
  const { args, opts } = calls[0];
  assert.ok(args.includes("--sandbox"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("--cd") + 1], "/repo");
  assert.equal(opts.input, PING_PROMPT);
  assert.equal(opts.timeout, PING_TIMEOUT_MS);
  assert.ok(PING_TIMEOUT_MS <= 60_000, "the ping must not wait like a lens");
});

// No --model. The ping asks whether the account can be used at all, and
// pinning a slug would turn a model that has moved into a false outage.
test("the probe pins no model", () => {
  const { runSync, calls } = fake({ status: 0, stdout: "", stderr: "" });
  ping({ target: "/repo", runSync });
  assert.equal(calls[0].args.includes("--model"), false);
});
