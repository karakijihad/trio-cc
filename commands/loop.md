---
description: Run the Codex audit loop
argument-hint: [--max N]
---

Use the `trio-audit` skill to run the loop. Pass through any `--max` or
`--target` arguments the operator supplied: $ARGUMENTS

`--lenses <name[,name...]|all>` is also accepted and passed through to
restrict which lenses run this pass. `/trio:lenses` picks the set
interactively if the operator would rather not type it by hand.
