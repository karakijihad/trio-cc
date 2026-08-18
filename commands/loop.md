---
description: Run the Codex audit loop
argument-hint: "[--max N] [--scope TEXT]"
---

Use the `trio-audit` skill to run the loop. Pass through any `--max`,
`--target`, or `--scope` arguments the operator supplied: $ARGUMENTS

`--scope "<free text>"` names what the lenses should concentrate on — the
files or the change under review. Without it every lens re-reads the whole
target from scratch on every pass, which is right for a full audit and
wasteful when reviewing work that just happened. It only narrows attention:
a lens still reads callers, tests, and config to judge what is in scope, and
still reports an outside defect when it explains one inside. Like `--lenses`
it is snapshotted into the run at pass 1 and inherited by `trio continue`, so
every pass compares like with like.

`--lenses <name[,name...]|all>` is also accepted and passed through to
restrict which lenses run. The selection is snapshotted into the run at
pass 1 and holds for every later pass — `trio continue` inherits it and
takes no `--lenses` of its own. It does not change the saved project
configuration. `/trio:lenses` picks the set interactively if the operator
would rather not type it by hand.
