---
description: Ask Claude and Codex the same question
argument-hint: "[--model NAME] [--effort LEVEL] [--] <question>"
---

Use the `trio-consult` skill to answer: $ARGUMENTS

`--model NAME` and `--effort LEVEL`, anywhere among `$ARGUMENTS`, run this one
consult on a different pair than `codex.consult`. `NAME` is matched
case-insensitively against any part of a slug in the live Codex catalogue
(`trio models`) — `astra` finds `gpt-6-astra`. An exact slug always wins; a
fragment matching more than one model, or matching none, is refused by name
before Codex is spawned — but only once that catalogue already has models in
it; with none cached yet (a fresh Codex install) the value passes through as
typed, the same rule a first `trio run` already gives a pinned lens model.
Giving either flag twice is refused outright (`--model given twice`), not
quietly resolved to the first. A bare `--` ends flag parsing — everything
after it, dashes included, is question text, so
`trio consult -- explain what --model does in trio` asks that whole sentence
instead of losing a word to the parser. Neither flag is saved — the next
consult is back on the configured pair — so change it for good with
`/trio:model consult`.
