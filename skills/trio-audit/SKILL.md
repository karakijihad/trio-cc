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
  and the one command that fixes it. Do not attempt a run.
- **Panel says enabled and healthy** → continue.

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

## The loop

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" run` with any `--max` or
   `--target` the operator gave. The viewer opens itself when configured
   (`window` mode is the default; `pane` users open the printed URL with
   VS Code's Simple Browser: the server is already running).
2. Read the JSON the command prints. `status: "finished"` → go to Reporting.
   `status: "awaiting_response"` → for pass N:
   a. Read `.trio/runs/<runId>/pass-N/reconcile.json`. If it has findings,
   dispatch the `trio-reconciler` agent with the findings array; write
   its verdicts block to `.trio/runs/<runId>/pass-N/verdicts.json`.
   b. Fix what the verdicts confirm. Do not accept a finding because Codex
   is confident — verify against the code; a refuted finding needs cited
   evidence.
   c. Write `.trio/runs/<runId>/pass-N/response.json` (D17):
   `{"findings": [{"id", "action": "fixed"|"declined", "note"/"reason"}], "summary"}`
   — every finding gets an entry; `reason` is required when declining.
   d. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" continue` and loop from
   step 2.
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
- Any lens marked `failed` or `unparseable` — say coverage was partial and name the lens.

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
