---
description: Change a Codex lens — its model, reasoning effort, or on/off state
argument-hint: <name> [on|off] [model <slug>] [effort <level>]
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" lens $ARGUMENTS` and report the
resulting lens line.

Values are validated against the live Codex model catalogue. If the command
rejects the value, show its error verbatim — it lists what is valid.
