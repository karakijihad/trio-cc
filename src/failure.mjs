// Why a Codex lens died, and what that means for the run.
//
// Every failure used to read the same: `codex exited 1`. A quota that will
// not clear for a week and a connection that dropped for a second produced
// the same message, so the operator had to guess which one they were looking
// at — and the only way to find out was to spend another five lenses.
//
// Three questions, and they are not the same question:
//   retryable — is trying again the right response, right now?
//   offer     — is Codex out in a way waiting will not fix, so that Claude
//               should ask whether to audit with its own subagents instead?
//   fix       — the one command that resolves it, when one exists.
//
// A failure can be neither: an unrecognised error is not retried (a retry
// that cannot help is money) and does not trigger the offer (a fallback
// proposed on a guess is worse than an error message).

// A bare three-digit number proves nothing. The text being searched is a
// lens's stderr and error events — line numbers, byte counts, token counts,
// durations — so `\b5\d\d\b` on its own matches "read 512 bytes" and turns an
// unrecognised failure into a retry. A status code has to look like one: the
// word before it is what makes it a claim about HTTP rather than a number.
const status = (codes) =>
  new RegExp(`(?:https?|status|code|error|response|returned)\\D{0,12}\\b(?:${codes})\\b`, "i");

// Order matters. Every rule below is tested against the same text, and the
// first match wins — so the specific claims ("usage limit") come before the
// generic ones (a bare 429) that would otherwise swallow them.
const RULES = [
  {
    kind: "usage",
    test: /usage limit|quota|insufficient_quota|out of credit|credit balance|billing|plan limit|exceeded your current/i,
    retryable: false,
    offer: true,
    message: "Codex has no usage left on this account.",
    fix: "",
  },
  {
    kind: "auth",
    test: /unauthori[sz]ed|invalid[_ ]api[_ ]key|not logged in|authentication failed|re-?authenticate/i,
    codes: "401|403",
    retryable: false,
    offer: true,
    message: "Codex rejected the credentials for this account.",
    fix: "codex login",
  },
  {
    kind: "rate_limit",
    test: /rate[_ ]?limit|too many requests|slow down/i,
    codes: "429",
    // Retryable, but only once and only here: a rate limit that survives a
    // second attempt is indistinguishable from a spent quota to everyone
    // except the person paying, so it becomes an offer rather than a loop.
    retryable: true,
    offer: true,
    message: "Codex is rate limiting this account.",
    fix: "",
  },
  {
    kind: "server",
    test: /internal server error|bad gateway|service unavailable|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|stream (?:error|disconnected|closed)/i,
    codes: "5\\d\\d",
    retryable: true,
    offer: false,
    message: "Codex could not be reached.",
    fix: "",
  },
];

// `text` is everything the lens produced that could name a cause: the JSON
// error events, whatever reached stderr, and the final message. Any of the
// three can carry it and none of them reliably does, so they are searched
// together rather than in some assumed order.
export function classifyFailure(text) {
  const haystack = String(text ?? "");
  for (const rule of RULES) {
    const matched =
      rule.test.test(haystack) ||
      (rule.codes ? status(rule.codes).test(haystack) : false);
    if (matched) {
      const { test: _t, codes: _c, ...rest } = rule;
      return { ...rest };
    }
  }
  return {
    kind: "unknown",
    retryable: false,
    offer: false,
    message: "Codex failed for a reason Trio does not recognise.",
    fix: "",
  };
}

// The run-level reading of a pass: is Codex simply not usable right now?
//
// Deliberately strict — every enabled lens has to have failed. One lens
// dying while four returned findings is a degraded pass, which the run
// already reports; it is not grounds for telling the operator that Codex is
// unavailable and offering to replace it. A partial audit and no audit are
// different claims.
//
// Timeouts are not counted as evidence either way, and "either way" is the
// load-bearing half: they are skipped before the check, not failed by it. A
// lens that hung was reached, so it is no evidence Codex is unavailable — but
// it is no evidence to the contrary either, and counting it as a lens that
// did not fail would let one hang suppress the offer while four lenses were
// telling the operator the account is out.
export function codexUnavailable(lenses) {
  const results = (lenses ?? []).filter((r) => r.status !== "timeout");
  if (!results.length) return null;
  if (!results.every((r) => r.status === "failed")) return null;
  const offerable = results.find((r) => r.failure?.offer);
  if (!offerable) return null;
  return {
    available: false,
    kind: offerable.failure.kind,
    message: offerable.failure.message,
    fix: offerable.failure.fix,
    lenses: results.map((r) => r.lens),
  };
}
