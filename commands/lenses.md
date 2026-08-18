---
description: Pick which audit lenses run
argument-hint: "[preset]"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" models --json` to read which
lenses are currently on.

If `$ARGUMENTS` already state a preset or a lens list, skip the picker and go
straight to step 2.

Otherwise ask with `AskUserQuestion` (`AskUserQuestion` allows at most 4
options plus its own "Other" — five on/off toggles will not fit, so offer
presets instead of checkboxes):

- **All five** — full coverage, 5 Codex processes per pass
- **auditor + security** — the lean pair for a small, well-scoped change
- **auditor + security + consistency** — adds drift/wiring coverage
- **Custom** — ask which lens names, or let the operator type them into
  "Other"

Then state plainly whether this choice applies:

- **for this run only** — report the `--lenses a,b,c` argument to pass to
  `/trio:loop`, or run it directly if the operator asked to run now; or
- **persisted** — flip each lens with `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" lens <name> on|off`.

Ask which the operator wants, unless they already said.

If `AskUserQuestion` is unavailable (e.g. a headless run), fall back to
printing the presets and asking in prose.
