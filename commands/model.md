---
description: Pick a lens's model and reasoning effort interactively
argument-hint: [lens] [model] [effort]
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" models --json` to read the
live model catalogue and current lens assignments.

If `$ARGUMENTS` already name a lens and/or a model and effort, skip straight
to applying them (step 4) — the picker below is for when they did not.

Otherwise ask with `AskUserQuestion`, one question at a time. Each option is
labelled with the lens's or model's current value where relevant.
`AskUserQuestion` allows at most 4 options plus its own "Other" — never list
more than four:

1. **Which lens?** There are five; present the four most likely given the
   conversation (e.g. the lenses the operator has been discussing), each
   labelled with its current model and effort. Note that "Other" accepts any
   of the five lens names.
2. **Which model?** Present at most four model slugs from the JSON `models`
   array, each described with its supported efforts. "Other" accepts any
   slug in the catalogue.
3. **Which effort?** Options come from **that model's** `efforts` array from
   the JSON — never a hardcoded list — but that array can itself hold more
   than four levels (e.g. `low, medium, high, xhigh, max, ultra`). When it
   does, present at most four: the model's `defaultEffort`, the highest
   level in `efforts`, and up to two more spread across the remaining range.
   Say that "Other" accepts any effort the model supports.

Apply with:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" lens <name> model <slug> effort <level>
```

and show the resulting lens line. If the CLI rejects the value, show its
error verbatim — it already lists what is valid.

If `AskUserQuestion` is unavailable (e.g. a headless run), fall back to
printing the options and asking in prose.
