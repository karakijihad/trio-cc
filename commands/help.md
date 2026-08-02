---
description: What every Trio command and concept means
argument-hint: [topic]
---

Explain Trio to the operator using the reference below. Answer from this
file — do not read the source to answer a help request. Prefer showing the
exact command that does what the operator wants over describing it
abstractly.

## No `$ARGUMENTS` — compact orientation

Give, in a few lines:

- Trio drives OpenAI's Codex CLI as a read-only second opinion — your own
  Codex, your own account, no credentials Trio ships, no cost Trio adds.
- The five lenses, one line each: `auditor` (defects, wiring), `security`
  (exploitable paths, source to sink), `tester` (untested paths, rotten
  tests), `simplifier` (duplication, dead code, oversized files),
  `consistency` (drift between what things claim and what they do). All five
  ship enabled; omitting `--lenses` runs all five.
- The four everyday commands: `/trio` (control panel), `/trio:loop` (run the
  audit), `/trio:consult <question>` (ask both, compare), `/trio:on`/`off`
  (enable or disable).
- Where next: `/trio` for state, `/trio:doctor` if something behaves oddly.

## With a `$ARGUMENTS` topic

Explain that one thing in depth, in Trio's own terms, using the reference
below. Topics include a command name, a concept (`lens`, `finding`, `pass`,
`reconciler`, `convergence`, `verdict`, `promotion`, `model`, `view`), a lens
name (`auditor`, `security`, `tester`, `simplifier`, `consistency`), or a
config key (`enabled`, `maxIterations`, `codex.parallel`, `artifacts.offerToCreate`,
`codex.lenses`, `view.mode`, `view.port`, `view.autoOpen`,
`converge.blockOn`, `converge.requireNoNewFindings`,
`artifacts.promoteTo`). If the topic doesn't match anything below, say so and
name the closest match.

---

## Reference

### Concepts

- **Codex** — OpenAI's CLI coding agent, a separate product on the
  operator's own OpenAI/ChatGPT account. Trio drives it; ships no
  credentials, bills nothing itself.
- **Read-only** — Codex runs with `--sandbox read-only`, hardcoded, not a
  setting. It reads and reports; it never edits code. Claude does all the
  writing.
- **Lens** — one reviewer perspective, sent to Codex as a role brief. Each is
  a separate Codex process — running all five costs five times one. Briefs
  live in `lenses/*.md`; a project can override any in `.trio/lenses/`.
- **Finding** — one reported defect: severity, file, line, evidence, impact,
  correction. Severities: `critical` (breaks the system), `major`
  (significant risk), `minor` (improvement), `info` (note). Only `critical`
  and `major` block convergence by default.
- **Pass** — one full round: selected lenses audit, findings come back,
  Claude reconciles and fixes. `maxIterations` (default 2) caps how many.
- **Reconciler** — the Claude agent `trio-reconciler`. Rules on each finding:
  `confirm`, `refute` (must cite evidence), `downgrade` (real but
  overstated), `escalate` (worse than reported, or composes with another
  finding into one bigger defect). Codex being confident is not evidence.
- **The conversation** — pass 2 differs from a second opinion: Codex sees
  its own prior findings, the diff of what Claude changed, and which
  findings Claude declined and why. It then agrees, pushes back, or reports
  what the change broke.
- **Convergence** — the loop stops clean when nothing open is
  `critical`/`major` **and** nothing new appeared this pass.
- **Verdict** — how a run ended: `clean` (converged), `ceiling_reached` (hit
  the pass limit with findings open — never reported as success), `failed`
  (something broke), `cancelled` (`/trio:cancel`). A crashed or unparseable
  lens can never be `clean`.
- **Promotion** — on finish, audits render to
  `Docs/Audit/codex/YYYY-MM-DD/audit-N.md` (Codex's findings) and
  `Docs/Audit/claude/YYYY-MM-DD/audit-N.md` (the reconciliation and
  disagreement table). `N` increments; nothing overwritten. Needs
  `Docs/Audit` to exist — Trio never creates it uninvited, so a finished run
  in a project without one **offers once** to create it and promote that run;
  declining sets `artifacts.offerToCreate` false and it never asks again. Raw
  runs always live in `.trio/runs/<runId>/`, per project, gitignored.
- **The event log** — both agents append to `.trio/runs/<runId>/events.jsonl`.
  The viewer tails it; kill the viewer and the audit continues — the log is
  the source of truth. Secrets are scrubbed before anything is written.
- **Model and effort** — each lens has its own Codex model and reasoning
  effort, read live from Codex's own catalogue — a new model appears without
  a Trio update.
- **Preflight and the drift guard** — before a run, Trio checks Codex is
  installed, logged in, and still accepts the flags Trio depends on. It
  refuses to start with a clear message rather than failing mid-run.

### Commands

| Command                                                                | What it does                                                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/trio`                                                                | Control panel: install/auth state, Codex version, drift, loop settings, every lens, view mode, artifact paths.        |
| `/trio:on` / `/trio:off`                                               | Enable/disable Trio for this project. `off` stays loaded but dormant — Claude names what it would have sent to Codex. |
| `/trio:loop [--max N] [--target PATH] [--lenses a,b\|all] [--scope TEXT]` | Run the audit loop. Omit `--lenses` for all five; `--scope` names what the lenses concentrate on.                    |
| `/trio:consult <question>`                                             | Ask Claude and Codex the same question independently; compare, disagreements named.                                   |
| `/trio:cancel`                                                         | Stop the active run: cancellation token, run process stopped, `cancelled` recorded.                                   |
| `/trio:lenses [preset\|list]`                                          | Interactive picker for which lenses run — preset or custom, this run or saved.                                        |
| `/trio:model [lens] [model] [effort]`                                  | Interactive picker for a lens's model and reasoning effort, from the live catalogue.                                  |
| `/trio:auditor` / `security` / `tester` / `simplifier` / `consistency` | Run the loop through that one lens only.                                                                              |
| `/trio:config get` / `set <key> <value>`                               | Read or change any setting; `set` rejects invalid values with the valid list.                                         |
| `/trio:lens <name> [on\|off] [model <slug>] [effort <level>]`          | Direct, non-interactive lens change.                                                                                  |
| `/trio:doctor`                                                         | Re-probe Codex now (bypasses the 24h cache); reports version, auth, drift. Run this first when something's off.       |
| `/trio:help [topic]`                                                   | This reference.                                                                                                       |

Two skills fire without a slash command: `trio-audit` when the operator says
things like "have Codex audit this," and `trio-consult` for "ask Codex what
it thinks."

### Settings (`.trio/config.json`)

| Key                             | Default                | Meaning                                        |
| ------------------------------- | ---------------------- | ---------------------------------------------- |
| `enabled`                       | `true`                 | Whether Trio runs at all here; `/trio:off` opts this project out for good. |
| `maxIterations`                 | `2`                    | Pass ceiling.                                  |
| `codex.parallel`                | `5`                    | Lenses run at once. Wall-clock only, not cost. |
| `codex.timeoutMinutes`          | `15`                   | How long one lens may run before it is stopped and marked degraded. |
| `codex.lenses[]`                | 5 entries, all `on`    | `{name, model, effort, on}` per lens.          |
| `view.mode`                     | `window`               | `window` opens a browser · `pane` prints the viewer URL to open yourself · `off`. |
| `view.port`                     | `4319`                 | Viewer's local port.                           |
| `view.autoOpen`                 | `true`                 | Auto-open the browser in `window` mode.        |
| `converge.blockOn`              | `["critical","major"]` | Severities that must be all-clear to converge. |
| `converge.requireNoNewFindings` | `true`                 | A new finding blocks convergence too.          |
| `artifacts.offerToCreate`       | `true`                 | Offer to create the promote directory once.    |
| `artifacts.promoteTo`           | `Docs/Audit`           | Where finished audits are promoted.            |
