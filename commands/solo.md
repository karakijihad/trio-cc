---
description: Audit with Claude subagents when Codex is unavailable
argument-hint: "[--lenses a,b|all] [--scope TEXT]"
---

Use the `trio-solo` skill. Pass through any `--lenses` or `--scope` the
operator supplied: $ARGUMENTS

This is the fallback lane, not a second way to run Trio. It exists for when
Codex cannot be reached — no usage left, credentials refused, or a rate limit
that survived its retry. The same five lens briefs run, but as Claude
subagents rather than Codex processes.

What it keeps: independent lenses formed apart, your own audit written before
theirs is read, and adjudication against the actual code.

What it gives up: the second model. A blind spot Claude has as a model
survives this intact, and the report must say so rather than borrowing the
vocabulary of a two-model run.

There is no run directory, no viewer, and no promotion — it is one pass, in
session, ending in a table. When Codex is reachable again, `/trio:loop` is the
full thing.
