---
name: trio-audit
description: Use when the operator asks for a Codex audit or second review of code - "have Codex audit this", "run the loop", "get Codex to check my work", "audit this with Trio" - or when a code-modifying task has just finished and Trio's auto setting calls for an independent review. Runs a bounded audit loop where Codex reviews read-only through parallel lenses and Claude adjudicates the findings.
---

# Trio audit loop

## First: is Trio available?

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" status`.

- **Panel says disabled** → do not run the loop. Tell the operator Trio is off,
  that `/trio:on` enables it, and then do the review yourself. Never silently skip.
- **Panel reports a drift warning or a preflight failure** → state the problem
  and the one command that fixes it. Do not attempt a run.
- **Panel says enabled and healthy** → continue.

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

   | Mode         | What to do                                                            |
   | ------------ | ---------------------------------------------------------------------- |
   | `window`     | Default — nothing to do, a browser window opened; close it when done. |
   | `pane`       | URL + Simple Browser.                                                 |
   | `html`       | Render after the run.                                                 |
   | `transcript` | Digest each pass into chat.                                           |
   | `off`        | Verdict only.                                                         |

## Reporting

Report exactly what `verdict.json` says:

- `clean` — converged. Say so, and name what was fixed.
- `ceiling_reached` — say so plainly and list the open findings. **This is not success.**
- Any lens marked `failed` or `unparseable` — say coverage was partial and name the lens.

Never round a partial or ceiling-limited run up to "clean".
