# Trio

**Claude, Codex, and you — reviewing each other's work.**

Trio is a Claude Code plugin that lets Claude consult OpenAI's Codex as a
read-only second opinion, run a bounded audit loop between the two, and show
both agents working side by side in a live browser window.

Three participants, and the third one is you. Trio automates the handoff, not
the judgement.

> **Status: v0.3.0.** Install: `/plugin marketplace add karakijihad/trio-cc` then
> `/plugin install trio@trio-cc`, `/reload-plugins`, `/trio`.
> Verified against Codex CLI 0.146.0.

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

Five lenses ship, all enabled: auditor, security, tester, simplifier,
consistency (drift between what things claim and what they do). Omit
`--lenses` and all five run — five Codex processes per pass — so Claude (or
you) should narrow the set deliberately per run with
`--lenses <name[,name...]|all>` on `/trio:loop` (or its per-lens shorthand —
`/trio:auditor`, `/trio:security`, `/trio:tester`, `/trio:simplifier`,
`/trio:consistency`). `/trio:lenses` offers that choice as clickable presets;
`/trio:model` picks a lens's model and reasoning effort the same way.

**Watch it happen** — Codex's stream (every process, the commands it runs, their
exit codes) on one lane, and the Claude ↔ Codex handover (findings out,
Claude's reply back — no Claude diff bodies) on the other. By default an OS
browser window opens itself when the run starts; no setup needed.

![The Trio viewer: a run strip across the top, then one column per lens with
severity-tagged findings](media/viewer-dark.png)

<sub>An example run — five lenses auditing in parallel, Claude's adjudication
in the last column.</sub>

One column per working agent; the run's own events sit in the strip under the
header rather than taking a column, so five or six lenses fit without a sideways
scroll. Dark by default, with a light toggle in the corner that remembers.

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

## Concepts

What the words mean, each building on the last.

**Codex** — OpenAI's CLI coding agent (`codex`), a separate product on your own
OpenAI or ChatGPT account. Trio drives it as a second reviewer; Trio itself
ships no credentials and bills you nothing — any cost is your own Codex usage.

**Read-only** — every Codex process Trio starts runs with `--sandbox
read-only`, hardcoded into Trio, not a setting you can change. Codex reads
your code and reports on it; it never edits a file. Claude does all the
writing.

**Lens** — one reviewer perspective, sent to Codex as a role brief (a short
instruction file under `lenses/`). Five ship, all enabled by default:

- `auditor` — defects, logic errors, missing or mismatched wiring.
- `security` — exploitable paths, traced from an untrusted source to where it
  lands, not just "this looks risky."
- `tester` — untested critical paths, tests that assert nothing or pass for
  the wrong reason, fixtures that have rotted.
- `simplifier` — duplication, dead code, oversized files and functions
  (production lines only — test code doesn't count against a file).
- `consistency` — drift: two places defining the same thing differently, docs
  or config that contradict the code, half-migrated paths.

Each lens is its own Codex process, so running all five costs five times the
quota and time of one. A project can override any lens's brief in
`.trio/lenses/<name>.md`.

**Finding** — one reported defect: a severity, a file and line, the evidence,
what it would break, and the fix. Severities: `critical` (breaks the system
now), `major` (significant risk), `minor` (a worthwhile improvement, not
blocking), `info` (a note). Only `critical` and `major` block convergence by
default.

**Pass** — one full round of the loop: every selected lens audits, findings
come back, Claude reconciles and fixes. `maxIterations` (default 2) caps how
many passes a run takes before Trio stops it and reports what's still open.

**Reconciler** — the one Claude agent Trio adds, `trio-reconciler`. It reads
the real code and rules on each Codex finding: `confirm` (reproduced as
reported), `refute` (wrong — must cite what disproves it), `downgrade` (real
but overstated; severity drops one step), `escalate` (worse than reported, or
it composes with another finding into one bigger defect; severity rises one
step). Codex sounding confident is not evidence — the reconciler has to show
its work too.

**The conversation** — what makes pass 2 different from asking twice: Codex
sees its own prior findings for that lens, a diff of what Claude actually
changed since, and which findings Claude declined and why. It then agrees,
pushes back, or reports what the change broke.

**Convergence** — the loop stops clean when nothing open is `critical` or
`major`, **and** no finding that appeared this pass is new. Both conditions
have to hold.

**Verdict** — how a run ended: `clean` (converged), `ceiling_reached` (hit the
pass limit with findings still open — reported plainly, never as success),
`failed` (something broke before a verdict could be reached), `cancelled`
(you ran `/trio:cancel`). A pass where any lens crashed or returned
unparseable output can never resolve `clean`.

**Promotion** — once a run finishes, its audits are written to
`Docs/Audit/codex/YYYY-MM-DD/audit-N.md` (Codex's findings, as reported) and
`Docs/Audit/claude/YYYY-MM-DD/audit-N.md` (the reconciliation, the
disagreement table, the open findings). `N` counts up per day; nothing is
overwritten. If `Docs/Audit` doesn't exist in the project, promotion is
skipped — the raw run still sits under `.trio/runs/`.

**The event log** — both agents append every step to one file,
`.trio/runs/<runId>/events.jsonl`. The viewer just tails it; killing the
viewer doesn't touch the run, because the log — not the viewer — is what the
loop depends on. Secrets (keys, tokens, private-key blocks, email addresses)
are scrubbed before anything is written, in the log and in promoted audits
alike.

**Model and effort** — each lens has its own Codex model and reasoning
effort, both read live from Codex's own model catalogue, so a model OpenAI
ships tomorrow shows up in `/trio` without a Trio update. Use a heavier model
on `security`, a cheaper one on `simplifier` — whatever the run calls for.

**Preflight and the drift guard** — before any run, Trio checks that Codex is
installed, that you're logged in, and that the CLI flags Trio depends on
still exist. If any of that is off, Trio refuses to start and names the one
command to fix it, instead of failing partway through a run.

---

## Commands

**Everyday**

- `/trio` — the control panel: install and auth state, Codex version and
  drift warnings, the loop ceiling, every lens with its model/effort/on-off,
  view mode, artifact paths. Start here.
- `/trio:on` / `/trio:off` — enable or disable Trio for this project. `off`
  leaves the plugin loaded but dormant: Claude still tells you when something
  _would_ have gone to Codex, instead of silently skipping it.
- `/trio:loop [--max N] [--target PATH] [--lenses a,b|all]` — run the audit
  loop on the current work. Omitting `--lenses` runs all five.
- `/trio:consult <question>` — ask Claude and Codex the same question
  independently and compare the answers, disagreements named. Claude answers
  first, so it doesn't anchor on Codex.
- `/trio:cancel` — stop the active run and record it as `cancelled`.

**Choosing what runs**

- `/trio:lenses [preset name | lens list]` — interactive picker: which lenses
  run, as a preset (all five / auditor+security / +consistency / custom), for
  this run only or saved as the default.
- `/trio:model [lens] [model] [effort]` — interactive picker: pick a lens,
  pick its model from the live catalogue, pick an effort from the levels that
  model actually supports.
- `/trio:auditor`, `/trio:security`, `/trio:tester`, `/trio:simplifier`,
  `/trio:consistency [--max N] [--target PATH]` — run the loop through that
  one lens only. Fastest, cheapest, most focused.

**Settings**

- `/trio:config get` — print the effective configuration.
- `/trio:config set <key> <value>` — change any setting; rejects invalid
  values with the valid list (see Settings below for every key).
- `/trio:lens <name> [on|off] [model <slug>] [effort <level>]` — the direct,
  non-interactive form of `/trio:model` and `/trio:lenses`, for one lens.

**Health**

- `/trio:doctor` — re-probe Codex now, bypassing the 24-hour cache, and
  report version, auth mode, and any flag drift. The first thing to run when
  something behaves oddly.

**Learn**

- `/trio:help [topic]` — this reference, without leaving the session. No
  topic gives a compact orientation; a topic (a command, `lens`, `verdict`, a
  lens name, a config key…) explains that one thing in depth.

Claude can also reach for two skills on its own, without a slash command —
`trio-audit` when you say things like "have Codex audit this," and
`trio-consult` for "ask Codex what it thinks." The commands above are the
explicit, same-behavior path.

---

## Settings

Every key in `.trio/config.json`, with its default:

| Key                             | Default                | Meaning                                                                                                                                                                |
| ------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                       | `false`                | Whether Trio runs at all for this project. `/trio:on` sets it.                                                                                                         |
| `maxIterations`                 | `2`                    | Pass ceiling. Hitting it without convergence ends the run `ceiling_reached`.                                                                                           |
| `codex.parallel`                | `2`                    | How many lenses run at once. Affects wall-clock time only — every enabled lens still runs, so this does not change cost. To spend less, run fewer lenses (`--lenses`). |
| `codex.lenses[]`                | five entries, all `on` | Each entry: `name`, `model`, `effort`, `on`. All five default to gpt-5.6-terra/medium; change any with `/trio:model` or `/trio:lens`.                                  |
| `view.mode`                     | `window`               | `window` (OS browser window, opens itself) · `pane` (VS Code Simple Browser) · `off`. A static file is available on demand via `trio render`.                          |
| `view.port`                     | `4319`                 | Local port the viewer binds.                                                                                                                                           |
| `view.autoOpen`                 | `true`                 | Whether `window` mode opens the browser automatically.                                                                                                                 |
| `converge.blockOn`              | `["critical","major"]` | Severities that must have zero open findings before a run can converge.                                                                                                |
| `converge.requireNoNewFindings` | `true`                 | A pass with a brand-new finding can't converge either, even with nothing blocking open.                                                                                |
| `artifacts.promoteTo`           | `Docs/Audit`           | Where finished audits are promoted on completion, if the directory exists.                                                                                             |

Config lives at `.trio/config.json` in the project root — change it with
`/trio:config set <key> <value>` or by editing the file directly. `.trio/` is
added to `.gitignore` the first time you run `/trio:on`.

### Where the audits end up

Everything is per-project, under the repo you ran the audit in — Trio writes
nothing to your home directory and nothing outside the project.

- **`.trio/runs/<runId>/`** — every run's raw record: `events.jsonl` (the
  append-only stream both agents write and the viewer tails), each pass's
  `reconcile.json`, each lens's own JSON, and the final `verdict.json`. This
  is gitignored, because raw event streams can carry command output.
- **`Docs/Audit/codex/YYYY-MM-DD/audit-N.md`** and
  **`Docs/Audit/claude/YYYY-MM-DD/audit-N.md`** — the readable pair promoted
  when a run finishes: Codex's findings, and Claude's adjudication with the
  disagreements. `N` increments; nothing is ever overwritten.

**Promotion is skipped silently when `Docs/Audit/` does not exist.** That is
deliberate — Trio does not create directory trees in your repo uninvited. If
you finished a run and found no promoted files, that is why: run
`mkdir -p Docs/Audit` once, and every later run lands there. Point it
somewhere else with `/trio:config set artifacts.promoteTo <path>`.

---

## A worked example

```
/plugin marketplace add karakijihad/trio-cc
/plugin install trio@trio-cc
/reload-plugins
/trio:on
  → confirms: read-only, artifacts under .trio/ and Docs/Audit/, .trio/ gitignored

you: "add rate limiting to the login endpoint"
  Claude implements the change.

/trio:loop --lenses auditor,security
  → a browser window opens; Codex's two lenses stream on one lane,
    the Claude ↔ Codex handover on the other
  → pass 1: findings come back
  → Claude runs trio-reconciler: some confirmed, some refuted or downgraded
  → Claude fixes what's confirmed, declines the rest with reasons
  → pass 2: Codex sees the diff and the declines, reports nothing new
  → verdict: clean

Docs/Audit/codex/<date>/audit-1.md   — Codex's findings, as reported
Docs/Audit/claude/<date>/audit-1.md  — the reconciliation and disagreements
```

Hit the pass ceiling instead, and Trio says `ceiling_reached` and lists what's
still open — never rounded up to "clean."

---

## Why Trio

**You already have two of the best coding models in the world. Trio is what
makes the second one useful.**

A model is a poor reviewer of its own work and a good reviewer of somebody
else's. Claude reviewing Claude shares a training set, a house style, and a set
of blind spots — it re-derives the reasoning that produced the bug and calls it
verified. Codex fails differently. Point it at the same code and it finds what
Claude cannot see, because the two miss different things.

The catch has always been the friction: a second terminal, re-explaining the
task, pasting findings back, deciding which of them are actually true. Trio
removes exactly that friction — and nothing else. One command, five reviewer
perspectives in parallel, every finding adjudicated against the code, and a
verdict you can trust because it refuses to round itself up.

What you get for it:

- **Bugs a self-review does not catch.** A different vendor's model with
  uncorrelated blind spots — the single highest-yield reviewer you can add.
- **No coordination cost.** Codex is read-only by construction. No worktrees,
  no merge conflicts, no diff-approval queue. Adding a reviewer costs the
  review and nothing more.
- **No false comfort.** A run that hits the pass ceiling with findings open
  reports `ceiling_reached`, and a crashed lens makes the run partial. Green
  means green.
- **No new bill, no new account, no telemetry.** Your Codex, your OpenAI plan,
  your rate limits. Trio ships no credentials and phones nowhere.
- **A record you can hand to somebody.** Every run promotes both sides —
  Codex's findings and Claude's adjudication, disagreements included — to dated
  files in `Docs/Audit/`.

Against the alternatives:

| Instead of…                                    | What you get there                                                                            | What Trio does differently                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A self-review pass or a reviewer subagent      | Fast and free, but correlated blind spots — the reviewer rationalises what the author decided | A different vendor's model, uncorrelated failure modes                                                                  |
| Multi-agent setups where every agent can write | Competing edits, worktrees, merge conflicts, diff-approval fatigue                            | Exactly one writer. Codex is `--sandbox read-only`, hardcoded — no coordination problem to solve                        |
| Linters, type checkers, SAST in CI             | Deterministic and cheap, but bounded by their rule set                                        | Findings a rule set cannot express — "the README promises this flag and the code ignores it"                            |
| Running Codex yourself in a second terminal    | The same second opinion, if you carry the context by hand each time                           | The handoff is automated: scoped briefs, parallel lenses, a pass-2 conversation that shows Codex its own prior findings |
| One-shot "LLM as judge" review                 | A verdict, with no standard for accepting it                                                  | Every finding is adjudicated — confirm · refute · downgrade · escalate — and a refutation must cite code                |

Two things make the difference in practice.

**Confidence is not evidence.** A raw second opinion is noisy — plausible,
confident, and sometimes wrong. Trio never hands you that. Claude rules on
every finding against the actual code, and refuting one requires citing what
disproves it. Findings come back confirmed, downgraded, refuted, or merged as
duplicates, so what reaches you is the part that survived scrutiny — not a
list to triage yourself.

**Pass 2 is a conversation, not a re-run.** Codex sees its own prior findings,
the diff of what changed, and which findings were declined and why. It can
agree, push back, or tell you what the fix broke. That is the pass where the
subtle regressions surface, and it is the one you cannot get by asking a fresh
reviewer the same question twice.

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

**One run at a time, and cancel means cancel.** A run claims `.trio/active` by
exclusive creation, so two starts cannot race into the same directory — the
second is told which run is already in flight. `/trio:cancel` writes a
cancellation token, stops the run process, and records the `cancelled`
verdict; the first verdict written wins, so a worker finishing late can never
overwrite it.

---

## Credits

Trio is glue. The intelligence belongs to two other teams:

- **[OpenAI Codex CLI](https://github.com/openai/codex)** — the reviewer.
  Every lens is a `codex exec` process
  ([docs](https://learn.chatgpt.com/docs/codex/cli)), on your own account.
- **[Claude Code](https://claude.com/claude-code)** by
  [Anthropic](https://www.anthropic.com) — the author, the adjudicator, and
  the host Trio plugs into
  ([installing plugins](https://code.claude.com/docs/en/discover-plugins)).

Neither project is affiliated with Trio, and Trio ships no credentials for
either. If something here misrepresents what Codex or Claude Code does, that
is a bug — please open an issue.

---

## Licence

MIT — see [LICENSE](LICENSE).
