---
description: Turn Trio on for this project
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" on` and show the resulting panel.

Trio is on by default, so this command matters when a project was opted out
with `/trio:off` — say so in one line if the panel already said enabled.

If this is the first time Trio has been enabled here, state plainly before
anything else: Codex runs strictly read-only, all Codex traffic goes to OpenAI
on the operator's own credentials, artifacts are written to `.trio/` and
promoted to `Docs/Audit/`, and `.trio/` has been added to `.gitignore` (in a
git checkout — elsewhere there is nothing to add it to).
