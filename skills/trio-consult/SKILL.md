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

**Who answers for Claude.** Run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" config get`
and read `claude.consultModel`. When it is null, you answer, in session. When it
names an alias, dispatch one `general-purpose` Agent with `model` set to it, the
question, and the context it needs to answer — and its reply is the Claude
answer, presented as is. That agent gives advice only; it writes no code.

Then run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" consult <question>`. If it
prints `⚠ consult: unknown model` on stderr, the pinned consult model has left
the Codex catalogue — say so and offer `/trio:model consult`.

## Presenting

Show both answers under `## Claude` and `## Codex`, then a short section naming
where they disagree and which you find better supported — with your reasoning.

If Codex failed to answer, say so, and say why: the result carries `error`, and
`codexUnavailable` when the account is out of usage or its credentials were
refused. Report that reason as given — never guess one — and do not retry a
`codexUnavailable`. Do not present one opinion as two.

Where you disagree, say plainly that one of you is wrong and which evidence
would settle it. That gap is the most useful output of a consult.
