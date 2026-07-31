---
name: trio-consult
description: Use when the operator wants a second opinion from Codex on a design or technical question - "ask Codex", "what does Codex think", "get a second opinion on this", "check this with Codex". Asks the same question independently of both models and lays the two answers side by side with the disagreements named.
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

Then run `node "${CLAUDE_PLUGIN_ROOT}/bin/trio.mjs" consult <question>`.

## Presenting

Show both answers under `## Claude` and `## Codex`, then a short section naming
where they disagree and which you find better supported — with your reasoning.

If Codex failed to answer, say so. Do not present one opinion as two.

Where you disagree, say plainly that one of you is wrong and which evidence
would settle it. That gap is the most useful output of a consult.
