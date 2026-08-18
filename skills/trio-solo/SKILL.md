---
name: trio-solo
description: Use when Codex is unavailable and an audit still needs to happen - the account is out of usage, its credentials were refused, or the operator asks to "audit with subagents" or "run Trio without Codex". Runs the same lenses as Claude subagents, spawned blind, and adjudicates them in session.
---

# Trio audit without Codex

The lenses are prompt files. Nothing in them is Codex-specific — they work as
subagent briefs unchanged. So when Codex cannot be reached, the audit does not
have to stop; it changes lanes.

Be honest about what that costs. Trio exists because two different models miss
different things. This mode keeps the *procedure* — independent lenses, formed
apart, adjudicated against the code — and gives up the *model diversity*. It
is a real audit and it is better than one pass of self-review. It is not a
second opinion, and a blind spot Claude has as a model survives it intact.

Say that once, up front. Never report the result in the vocabulary a Codex run
uses.

## When this runs

Either the operator asked for it directly, or a `trio run` came back with
`codexUnavailable` on the result:

```json
{"verdict": "failed", "codexUnavailable": {"kind": "usage", "message": "...", "fix": ""}}
```

`kind` is `usage` (no credit left), `auth` (credentials refused), or
`rate_limit` (still limited after a retry). Transient faults — server errors,
dropped connections — never reach here; the lens retries those itself.

**Ask once, with `AskUserQuestion`.** Name the reason from `message`, and the
fix from `fix` when there is one. Two options:

- **Yes** → continue below.
- **No** → stop. Say the raw run is under `.trio/runs/<runId>/` and that
  `/trio:doctor` re-probes Codex when they want to try again.

Never start spawning without asking. Five subagents at high effort is the
operator's usage too, and they may simply want to wait an hour.

## Choosing lenses

The same five, and the same rule as a Codex run: **choose deliberately, state
which and why before you start.**

| The change | Lenses |
| ---------- | ------ |
| Logic or feature work | `auditor` |
| Input, auth, secrets, files | `+ security` |
| Test-heavy or test-touching | `+ tester` |
| Refactors | `+ simplifier` |
| Cross-module or wiring changes | `+ consistency` |
| Unfamiliar code, or "full audit" | all five |

Small change, no scope given → `auditor` and `security`, and say so.

## Audit it yourself first

**Before you spawn anything.** This is the same rule the Codex loop holds to
and it matters more here, not less: if you read the lenses' findings first you
will anchor on them, and the whole exercise collapses into one opinion with
four echoes.

Audit the scope yourself, through the lenses you chose. Write your findings
down — in the scratchpad, not the project — in the shape the lenses use:

```json
{"findings": [{"severity": "major", "file": "src/x.mjs", "line": 12,
  "title": "short claim", "evidence": "what you observed, with file:line",
  "impact": "what breaks", "correction": "the specific fix, or null"}]}
```

Hold yourself to what you hold them to: cite the line that proves it, or leave
it out.

## Spawn the lenses

One `trio-lens` subagent per chosen lens, **all in a single message** so they
run concurrently and none of them can see another's work. Sequential spawning
is how this mode quietly becomes worthless.

Each prompt carries three things and nothing else:

1. The lens brief, read verbatim from `${CLAUDE_PLUGIN_ROOT}/lenses/<name>.md`
   (or `.trio/lenses/<name>.md` when the project overrides it — check there
   first, same as the engine does).
2. The scope: which files, and what changed.
3. The instruction to end with the findings block.

Do not paste your own findings into their prompts. Do not tell one lens what
another is looking at.

**Models.** `trio-lens` is pinned to Sonnet at high effort. That is the
default and you do not ask about it. Only if the operator names a model do you
override it — pass `model` on the Agent call; effort comes from the definition
and cannot be set per call.

## Merge, then adjudicate

Collect each subagent's findings block. Merge by hand the way the engine does:
**two findings at the same `file:line`, or making the same claim, are one
finding carrying both lens names.** Corroboration is the signal worth having —
but it only counts when the lanes were genuinely apart, which is what the
blind spawn above bought.

Your own findings from earlier merge in as another lane, named `claude`.

Then dispatch `trio-reconciler` with the merged array. Your own findings are
adjudicated too — being yours earns them nothing. Fix what comes back
confirmed. A refuted finding needs cited evidence, not a shrug.

## Report

One table, then the summary:

| Severity | Where | Finding | Raised by | Verdict |
| -------- | ----- | ------- | --------- | ------- |
| major | `src/x.mjs:12` | short claim | auditor, security | confirmed — fixed |
| minor | `src/y.mjs:88` | short claim | claude | refuted — evidence |

**Raised by** is the column that carries the weight. Two lens names means two
lenses found it independently. `claude` alone means every lens missed what you
caught; one lens alone means you missed what it caught. Both are worth saying
out loud.

Close with what was fixed, what was declined and why, and this, plainly:

> Audited with Claude subagents because Codex was unavailable. No second model
> reviewed this code.

Do not write `clean`. Do not write `ceiling_reached`. Those are verdicts about
a two-model run and this was not one.

## What this mode does not do

No run directory, no `events.jsonl`, no viewer, no promotion to `Docs/Audit`,
no convergence check, no settled ledger. It is one pass, in session, and it
ends with the table.

If the operator wants another round after the fixes, run it the same way —
fresh subagents, and tell them in the prompt which findings were already
declined and why, or they will raise them again. The engine carries that
ledger between passes; here you carry it by hand.

When Codex comes back, `/trio:loop` is the full thing again.
