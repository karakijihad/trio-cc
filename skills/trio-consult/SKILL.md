---
name: trio-consult
description: Use when the operator wants a second opinion from Codex on a design or technical question - "ask Codex", "what does Codex think", "get a second opinion on this", "check this with Codex". For ideas, design questions and choosing between approaches before a decision is made - not for reviewing work already done, which is trio-audit. Asks the same question independently of both models and lays the two answers side by side with the disagreements named.
---

# Trio consult

## First: is Trio available?

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" status`.

If the panel says disabled, answer the question yourself and add one sentence:
Trio is off, so this is one opinion rather than two; `/trio:on` enables it.

## The order matters

**Form your own answer first, before reading Codex's.** Write it down. If you
read Codex first you will anchor on it, and two anchored answers are worth less
than one independent one.

**A model named in the request holds for that call only.** The operator can
say who should answer inside the question itself — “use fable”, “astra”,
“ask terra” — before the question or after it. Lift those words out of the
question and route them:

| Named | Where it goes |
| --- | --- |
| `sonnet`, `opus`, `haiku`, `fable` | the Claude half: the alias to dispatch on, overriding `claude.consultModel` |
| anything else named as a model (`astra`, `terra`, `gpt-6-astra`) | the Codex half: passed as `--model <name>` |

Only lift a name when the operator is saying *who should answer*. A model that
is the subject of the question — “is astra better than terra here?” — is part
of the question and stays in it. Ask when you cannot tell which was meant.

A `--model` or `--effort` the operator typed themselves is already in the
shape the CLI takes: pass it through as typed rather than reading it as part
of the question.

Neither half is saved: the next consult is back on the configured pair, and
`/trio:model consult` is how a choice is made to stick.

**Who answers for Claude.** The alias named in the request, else
`claude.consultModel` from `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" config get`
— a per-project setting that ships null. With neither, you answer, in session.
With one, dispatch one `general-purpose` Agent with `model` set to it, the
question, and the context it needs to answer — and its reply is the Claude
answer, presented as is. That agent gives advice only; it writes no code.

**Who answers for Codex.** Then run

```
node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" consult [--model <name>] -- <question>
```

Flags first, then `--`, then the question. Everything after `--` is question
text, dashes and all — and a question is free text, so without the separator
one that happens to mention `--model` loses the word after it to the flag
parser.

`--model` takes any part of a slug, resolved against the live catalogue, so
`astra` is enough. A name matching nothing — or two models, or the same flag
given twice — is refused with exit 2 before Codex is spawned; show that error
as it stands, since it already names what is valid. That check needs a
catalogue: on a Codex install that has never written one, the name goes
through unresolved and Codex itself is what rejects it.

A `⚠ consult: unknown model` on stderr is the other case: the *configured*
consult model has left the catalogue — say so and offer
`/trio:model consult`. The result JSON carries the `model` that answered;
`null` there means Trio pinned nothing and the Codex CLI chose.

## Presenting

Show both answers under `## Claude` and `## Codex`, then a short section naming
where they disagree and which you find better supported — with your reasoning.

Name the model in each heading — `## Claude (fable)`, `## Codex (gpt-6-astra)`
— taking the Codex one from the result JSON's `model` and writing `codex
default` where it is null. Which model answered is the first thing anyone asks
of a second opinion.

If Codex failed to answer, say so, and say why: the result carries `error`, and
`codexUnavailable` when the account is out of usage or its credentials were
refused. Report that reason as given — never guess one — and do not retry a
`codexUnavailable`. Do not present one opinion as two.

Where you disagree, say plainly that one of you is wrong and which evidence
would settle it. That gap is the most useful output of a consult.
