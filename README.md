# Trio

**Claude, Codex, and you — reviewing each other's work.**

Trio is a Claude Code plugin that lets Claude consult OpenAI's Codex as a
read-only second opinion, run a bounded audit loop between the two, and show
both agents working side by side in a live browser window.

Three participants, and the third one is you. Trio automates the handoff, not
the judgement.

> **Status: v0.1.0.** Install: `/plugin marketplace add karakijihad/trio-cc` then
> `/plugin install trio@trio-cc`, `/reload-plugins`, `/trio`.
> Verified against Codex CLI 0.145.0.

---

## What it does

**Consult** — ask one question, get both answers.

```
you: "ask Codex whether this locking scheme is sound"
```

Claude answers, Codex answers independently, and Trio lays the two side by side
with a table of where they disagree.

**Audit loop** — bounded, converging, and honest about it.

```
you: "add feature X"
  Claude implements
    ├─ pass 1 — Codex audits through parallel lenses
    │   └─ Claude reconciles: confirm · refute · downgrade · escalate → fixes
    └─ pass 2 — Codex re-audits
        ├─ clean → audits promoted to Docs/Audit/ → done
        └─ ceiling reached → open findings reported plainly, never as success
```

Two passes by default. Convergence means no open Critical or Major **and** no
findings that were not there last pass.

Five lenses ship: auditor, security, tester, simplifier, consistency (drift
between what things claim and what they do). Auditor and security run by
default; `--lenses <name[,name...]|all>` on `/trio:loop` (or its per-lens
shorthand — `/trio:auditor`, `/trio:security`, `/trio:tester`,
`/trio:simplifier`, `/trio:consistency`) picks the set for that run.

**Watch it happen** — Codex's stream (every process, the commands it runs, their
exit codes) on one lane, and the Claude ↔ Codex handover (findings out,
Claude's reply back — no Claude diff bodies) on the other. By default an OS
browser window opens itself when the run starts; no setup needed.

---

## Requirements

Trio ships **no credentials and bills nothing**. It drives your own Codex CLI on
your own OpenAI account.

- [Claude Code](https://claude.com/claude-code)
- [OpenAI Codex CLI](https://github.com/openai/codex) — `npm i -g @openai/codex`
- A Codex login: `codex login` (ChatGPT plan) or an API key
- Node 18.18+

A ChatGPT subscription is the intended path. An API key works, but Trio runs
lenses in parallel, so a pass costs roughly `lenses × audit` — Trio warns you
when it detects API-key mode.

If Codex is missing or logged out, Trio says exactly that and gives you the one
command to fix it. It never fails silently mid-run, and Claude keeps working
without it.

---

## Design notes

**Codex is strictly read-only.** `--sandbox read-only`, hardcoded, not a
setting. Codex reads, reasons, and reports; Trio does all writing. Which means
no worktrees, no merge conflicts, and no diff-approval gate to get wrong.

**Nothing about Codex is hardcoded.** Models and reasoning efforts are read from
Codex's own `models_cache.json`, which Codex refreshes from OpenAI. A new model
appears in your control panel without a Trio release. A drift guard checks that
every flag Trio relies on still exists, and refuses to start with a clear warning
rather than failing three minutes into an audit.

**The loop never talks to the view.** Both agents write to one append-only event
log; the pane tails it. Kill the viewer mid-run and the audit carries on.

**No network calls of its own.** The viewer binds `127.0.0.1` only. Codex talks
to OpenAI on your credentials; Claude talks to Anthropic on yours. Trio talks to
nobody, and there is no telemetry.

---

## Control

`/trio` opens the panel: install and auth state, Codex version and drift
warnings, iteration ceiling, the lens table with per-lens model and reasoning
effort, view mode, artifact paths.

```
/trio:on   /trio:off
/trio:loop --max 3
/trio:consult <question>
/trio:lens security model gpt-5.6-terra effort ultra
/trio:config set view.mode html
/trio:doctor
```

`/trio:off` leaves Trio loaded but dormant — so when something would have used
it, Claude tells you instead of quietly skipping it.

Views: `window` (default — OS browser window, opens itself) · `pane` (VS Code
Simple Browser) · `html` (standalone file) · `transcript` (digest in chat) ·
`off`.

---

## Licence

MIT — see [LICENSE](LICENSE).
