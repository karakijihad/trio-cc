---
description: Turn Trio off for this project
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" off` and report the result in one line.

Trio ships on. This writes `enabled: false` into this project's
`.trio/config.json`, so the opt-out is per-project and permanent until
`/trio:on`.

From this point on, when a task would have used Trio, do the work yourself and
add one sentence naming what Trio would have added. Do not silently skip it.
