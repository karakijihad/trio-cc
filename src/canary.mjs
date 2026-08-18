import { spawnSync } from "node:child_process";
import { codexCommand } from "./paths.mjs";
import { classifyFailure } from "./failure.mjs";
import { SANDBOX } from "./codex-lane.mjs";

// One trivial Codex call, before anything is committed to.
//
// `preflight` answers "is Codex installed, and is it logged in". Neither
// question touches usage: an account with no credit left is installed and
// logged in and looks perfectly healthy, and the first thing that knows
// otherwise is a lens that has already been spawned. By then the run has a
// directory, the project has a lock, the viewer has opened a browser window,
// and — until this existed — a report had been promoted for an audit that
// never ran.
//
// So the account is asked the cheapest question there is. When usage is spent
// this comes back in about a second and nothing else has happened yet.
export const CANARY_PROMPT =
  "Reply with the single word: ok. Do not read any files.";

// Short on purpose. This is not doing work, it is finding out whether work is
// possible, and a canary that can hang for the lens timeout is worse than no
// canary — it delays the very failure it exists to surface.
export const CANARY_TIMEOUT_MS = 60_000;

// Three outcomes, and the third is the one that matters most:
//
//   {ok: true}                   — Codex answered. Proceed.
//   {ok: false, failure}         — Codex refused for a reason that will not
//                                  clear (usage, auth). Refuse the run.
//   {ok: "unknown", failure}     — something went wrong that this cannot
//                                  interpret. PROCEED ANYWAY.
//
// The third exists because a canary is a convenience, not a gate. If it fails
// for a reason nobody recognises — a slow network, an odd exit code, a
// sandbox quirk on one machine — blocking the run would mean this probe can
// veto every audit in a project on evidence it could not read. The real lens
// wave is the authority; this only ever short-circuits the cases it is sure
// about.
export function canary({ target, runSync = spawnSync, timeoutMs = CANARY_TIMEOUT_MS }) {
  let cmd;
  try {
    cmd = codexCommand([
      "exec",
      "--json",
      "--sandbox",
      SANDBOX,
      "--skip-git-repo-check",
      "--cd",
      target,
    ]);
  } catch (err) {
    // codexCommand throws on win32 when it cannot find the JS entry point.
    // That is a real, permanent problem, but it is not a usage or auth
    // refusal and the run's own launch will report it in its own words.
    return { ok: "unknown", failure: classifyFailure(err.message) };
  }

  let r;
  try {
    r = runSync(cmd.file, cmd.args, {
      input: CANARY_PROMPT,
      encoding: "utf8",
      timeout: timeoutMs,
      ...cmd.opts,
    });
  } catch (err) {
    return { ok: "unknown", failure: classifyFailure(err.message) };
  }

  if (r?.error) return { ok: "unknown", failure: classifyFailure(r.error.message) };
  if (r?.status === 0) return { ok: true };

  // Both streams: the JSON error event lands on stdout and the plain text on
  // stderr, and which one carries the reason depends on how far Codex got.
  const failure = classifyFailure(`${r?.stdout ?? ""}\n${r?.stderr ?? ""}`);

  // Only the permanent refusals stop a run here. A rate limit is offerable
  // but retryable, and the lens layer already knows how to retry it once
  // before giving up — duplicating that here would either refuse a run that
  // a second attempt would have completed, or grow a second copy of retry
  // logic for the two to disagree about.
  return failure.offer && !failure.retryable
    ? { ok: false, failure }
    : { ok: "unknown", failure };
}
