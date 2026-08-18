---
name: trio-audit
description: Use when the operator asks for a Codex audit or second review of code - "have Codex audit this", "run the loop", "get Codex to check my work", "audit this with Trio" - or when a code-modifying task has just finished and an independent review is called for. Runs a bounded audit loop where Codex reviews read-only through parallel lenses and Claude adjudicates the findings.
---

# Trio audit loop

## First: is Trio available?

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" status`.

- **Panel says disabled** → do not run the loop. Tell the operator Trio is off,
  that `/trio:on` enables it, and then do the review yourself. Never silently skip.
- **Panel reports a drift warning or a preflight failure** → state the problem
  and the one command that fixes it. Do not attempt a run. When the failure is
  `not_logged_in` or the operator says they are out of Codex usage, offer the
  `trio-solo` skill — the same lenses, run as Claude subagents.
- **Panel says enabled and healthy** → continue.

## Second: is the project already busy?

The lock is one per project directory, not one per session — a second Claude
session on the same repo cannot start a run while the first one's is live, and
it is held for the **whole loop**, every pass, including the stretches where
the run is parked waiting for the other session to adjudicate.

`node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" status --json` answers it cheaply
(no Codex probe): `{"busy": true, "activeRun": "...", "pass": N}`.

- **`busy: false`** → start.
- **`busy: true`** → tell the operator which run and pass holds it, then poll
  `status --json` a few times over a couple of minutes. If it clears, start.
- **Still busy after that** → stop and say so. Do not cancel another session's
  run to make room; offer `/trio:cancel` as the operator's choice, and note it
  ends that audit. A parked run holds the lock with no process running, so it
  can stay held indefinitely if the other session was abandoned.

`run` exits **3** when it loses this race, distinct from every other refusal
(exit 1 — Trio off, Codex not logged in, drift) where waiting never helps.

## Running the command without it being killed

A run is every enabled lens in parallel, each allowed `codex.timeoutMinutes`
(15 by default). It routinely outlives a foreground shell call, and a killed
call reports exit 124.

**Always start `run` and `continue` in the background** (`run_in_background`),
then read the JSON from its output when it completes. Do not wrap it in a
foreground call with a raised timeout — the ceiling is still below what one
pass can legitimately take.

If you do see exit 124, the run was killed mid-pass. It releases its own lock
on the way out, so the repo is not stuck; re-read `status --json` before
starting again.

## Choosing lenses

All five lenses ship enabled. Passing nothing to `--lenses` audits through
**all five — five Codex processes per pass** on the operator's account. The
config default no longer withholds any lens; the decision of what to run is
yours (or the operator's), made fresh each time.

**Always choose deliberately: state which lenses you are running and why
before starting.** Map the task to a lens: logic or feature work → auditor;
anything touching input, auth, secrets, or files → security; test-heavy or
test-touching change → add tester; refactors → add simplifier; cross-module
or wiring changes → add consistency; unfamiliar code or an explicit "full
audit" → all five (`--lenses all`).

When the operator has not indicated scope and the change is small, prefer
`--lenses auditor,security` and say so. When in doubt about cost, ask.

## Naming the scope

Without `--scope`, every lens reviews the whole target from scratch on every
pass — correct for "audit this project", wasteful and noisy when auditing work
that just happened, because most of what comes back is about code nobody
touched.

**When the run is reviewing a change you just made, pass `--scope` naming it.**
You know what you touched; Codex does not. Free text, quote it:
`--scope "src/driver.mjs and src/marker.mjs — the run-lock lifecycle"`. It
narrows attention only — the lens still reads callers, tests, and config to
judge those files, and still reports an outside defect when it explains one
inside. It rides every pass of the run, so the convergence check compares like
with like.

Leave it off for a full audit, an unfamiliar codebase, or when the operator
asked for the whole project.

## Audit it yourself first — before Codex

**This is not optional, and the order is the whole point.** Two opinions are
only worth two opinions if they were formed apart. If you read Codex's
findings first you will anchor on them, and Trio becomes one auditor with a
proofreader.

Before starting the run, audit the scope yourself, through the same lenses you
chose. Write your findings to a JSON file — the scratchpad is the right place,
not the project — in exactly the shape the lenses use:

```json
{"findings": [{"severity": "major", "file": "src/x.mjs", "line": 12,
  "title": "short claim", "evidence": "what you observed, with file:line",
  "impact": "what breaks", "correction": "the specific fix, or null"}]}
```

Hold yourself to what the lenses are held to: cite the line that proves it, or
leave it out. `{"findings": []}` is a real answer and an honest one — but
reaching it in ten seconds is not an audit, it is a shrug.

Pass the file with `--claude-findings`. Trio merges it as a lane beside the
Codex lenses, so a defect both lanes raised carries both names and a defect
only one raised is visible as exactly that. The promoted report gets a **Two
Lanes** section splitting them: both, Codex only, Claude only.

Skip this only if the operator explicitly asks for a Codex-only run.

## The loop

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" run` **in the background**,
   with the `--lenses` you chose above, the `--scope` you named, the
   `--claude-findings` file you just wrote, and any `--max` or `--target` the
   operator gave. The viewer opens itself when
   configured (`window` mode is the default; `pane` users open the printed
   URL with VS Code's Simple Browser: the server is already running).
2. Read the JSON the command prints.

   **`codexUnavailable` on the result** → Codex cannot be used, for a reason
   waiting will not fix. Do not retry it. Hand off to the **`trio-solo`**
   skill, which asks the operator whether to audit with Claude subagents
   instead. It arrives two ways, and both carry the same
   `codexUnavailable: {kind, message, fix}`:

   - `status: "refused"` (exit 1) — the ping caught it *before* the run
     started. No lock was taken, no run directory was made, no viewer opened,
     and nothing was spent. This is the usual one.
   - `status: "finished"`, `verdict: "failed"` — the account went out
     mid-wave, after the ping passed. The run is finalized, the lock is
     released, and nothing was promoted (`promotion.reason` says why).

   Transient faults never reach you: the ping lets them through and the lens
   retries them itself.

   `status: "finished"` → go to Reporting.
   `status: "awaiting_response"` → for pass N:
   a. Read `.trio/runs/<runId>/pass-N/reconcile.json` — **now**, not earlier.
   Findings carry a `lens` naming every lane that raised them; one reading
   `claude` alone is yours and Codex's lenses all missed it. If there are
   findings, dispatch the `trio-reconciler` agent with the findings array.
   Your own findings are adjudicated too — being yours earns them nothing.

   Do not write `verdicts.json` yourself. Pipe the reconciler's reply to
   `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" verdicts <runId> N`, which
   validates it and writes the file only if it is sound — it takes the whole
   reply, so a fenced block inside prose is fine. It exits 2 and writes
   **nothing** when something is wrong, listing every problem at once: fix
   them and resubmit. A pass was once lost to a hand-written file nobody
   checked until it was too late to recover.
   b. Fix what the verdicts confirm. Do not accept a finding because Codex
   is confident — verify against the code; a refuted finding needs cited
   evidence.
   c. Write `.trio/runs/<runId>/pass-N/response.json` (D17):
   `{"findings": [{"id", "action": "fixed"|"declined", "note"/"reason"}], "summary"}`
   — every finding gets an entry; `reason` is required when declining.
   d. **Audit the changed code again yourself**, the same way you did before
   pass 1, and write a fresh findings file. Then run
   `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" continue --claude-findings <path>`
   in the background and loop from step 2.

   This is required, not optional: `continue` refuses when the previous pass
   carried a Claude audit and this one does not. Without it, every finding
   only your lane raised would be diffed as **closed** — reported fixed
   because nobody re-checked it, which is the one mistake this loop must
   never make.

   **Unless the result carried `final: true`.** That is the last pass the
   budget allows, so there is no next pass and no fresh audit to write. Do
   a, b and c exactly as above, then run
   `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" continue` with **no**
   `--claude-findings` — it applies your verdicts and settles the run. Only
   then does a verdict exist: `clean` if nothing blocking survived
   adjudication, `ceiling_reached` if it did. Go to Reporting with what that
   call returns.

   A run never reaches its verdict on findings nobody has looked at. The
   final pass is adjudicated on the same terms as every pass before it —
   that call is how.
3. View-mode table:

   | Mode     | What to do                                                            |
   | -------- | --------------------------------------------------------------------- |
   | `window` | Default — nothing to do, a browser window opened; close it when done. |
   | `pane`   | URL + Simple Browser.                                                 |
   | `off`    | Verdict only.                                                         |

## Reporting

Report exactly what `verdict.json` says:

- `clean` — converged. Say so, and name what was fixed.
- `ceiling_reached` — say so plainly and list the open findings. **This is not success.**
  It is the **run's** verdict, never the final pass's: the last pass completed
  normally — the run stopped because its pass budget is spent with findings
  still open. Phrase it that way ("the run used both passes; N findings remain
  open"), never "pass N came back ceiling_reached" or anything implying the
  pass itself was cut short.
  When the result carries `extension: {offer: true, ...}`, the run stopped on
  budget with blocking findings still live. Report the verdict first, then ask
  once with `AskUserQuestion`, **showing `closed` and `new` in the question** —
  those two numbers are the whole basis for the answer. A pass that closed
  many and opened a few was still converging and is worth one more; a pass
  that closed nothing is thrashing and another pass buys only spend.
  **Yes** → audit the scope yourself again first, exactly as before, then
  `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" extend <runId> --claude-findings <path>`,
  which runs one more pass on the same run. Loop from step 2 as normal.
  `extend` refuses without the file for the same reason `continue` does, and
  refuses **before** reopening the run, so a missing lane costs nothing.
  **No** → report `ceiling_reached` as final. Never extend without asking, and
  never extend more than once without asking again.
- Any lens marked `failed` or `unparseable` — say coverage was partial and name the lens.
- **Every** lens failed — that is not partial coverage, it is none. Nothing is
  promoted (`promotion.reason` says so) and the verdict is `failed`. Never
  describe it as an audit that found nothing.

Never round a partial or ceiling-limited run up to "clean".

## If nothing was promoted

A finished run carries `promotion: {skipped, path, offer}` when there was
nowhere to promote to — the project has no `Docs/Audit/` (or whatever
`artifacts.promoteTo` names). Trio never creates directories in a project on
its own, so this is the one time to ask.

When `promotion.offer` is true, report the verdict first, then ask once with
`AskUserQuestion` — a single question, two options:

- **Yes** → run
  `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" promote <runId> --create`.
  That creates the directory _and_ promotes the run you just finished, so the
  audit in front of them is written out, not only future ones. Show both
  paths it prints.
- **No** → run
  `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" config set artifacts.offerToCreate false`
  so the offer never comes back, and carry on. The raw run is still under
  `.trio/runs/<runId>/` either way.

When `promotion.offer` is false the operator has already declined. Say
nothing about it — one line noting the raw run path is enough.

Both sides are promoted: `codex/YYYY-MM-DD/audit-N.md` is Codex's findings as
reported, and `claude/YYYY-MM-DD/audit-N.md` is your adjudication — the
verdict per finding, the disagreement table, and what stayed open.
