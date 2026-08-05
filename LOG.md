# Log

What went wrong, and what was done about it. One line each, newest first.

---

## 2026-08-05 — the decline ledger

- **Refuted and declined findings came back pass after pass**, because run memory was one pass deep — a run-level ledger (`src/settled.mjs`) now folds every pass's settlements and shows them to every lens.
- **A decline is not a refutation.** Four of nine recorded declines were defects the reconciler had *confirmed*, so only a prior `refute` excuses a finding from blocking convergence — a run can never report `clean` over a known defect.
- **Marking a re-raise `refute` would have faked a verdict nobody gave** — history goes in a separate `carried` field, the verdict stays `unreviewed`, and the reconciler keeps the last word.
- **`downgrade` didn't overturn a settlement**, so a stale refutation outlived a ruling that the defect was real. It means "real, just smaller", and now overturns alongside `confirm` and `escalate`.
- **The report never said why a carried finding didn't block** — it now prints the carry and asks `isLive` rather than restating the rule, so the two can't drift apart.
- **Decline reasons reached Codex unscrubbed** — scrubbed now at the one boundary every ledger entry passes through, and in the reply section too.
- **A malformed handover file failed the whole run** instead of costing its own section — both readers skip entries that aren't objects.

## 2026-08-01 — spending and safety

- **Turning every lens off produced a `clean` verdict on the strength of no audit** — a run with no lenses is refused, and the enabled check happens before any Codex process starts.
- **`trio run --help` started a five-lens run on the operator's credit** — an unknown flag is now refused with exit 2, before config load or any probe.
- **A hung lens burned ~25 minutes, indistinguishable from one still thinking** — every lens gets a deadline (15 min), is killed at it, recorded `timeout`, and never retried.
- **Killing a lens on Windows orphaned the native Codex process, still working and still spending** — `taskkill /t` takes the whole tree; POSIX keeps `kill()`, where the shim forwards the signal itself.
- **`trio cancel` would kill any `node.exe` named by a forged marker** — identity is checked by command line, and a lookup that fails reads as "cannot tell", never as "yes".

## 2026-07-31 — shipping

- **A config default silently withheld lenses** — all five ship enabled, and the run picks the subset with `--lenses`.

## 2026-07-30 — the loop

- **A blocking multi-pass CLI left no room to fix code between passes** — `run` does pass 1 and exits, `continue` adjudicates and runs the next.
- **Nothing captured why a finding was declined** — that reply is now written to disk between passes, and the next pass's lenses read it.

## Adjudication rules, learned the hard way

- **Every finding defaulted to `confirm`**, so a pass nobody had adjudicated reported sixteen confirmed findings and an empty disagreement table. The absence of a verdict is now `unreviewed`, which is not agreement.
- **Matching findings by id alone made wording the test of identity** — one pass closed 21 of 21 while 14 were still in the code. Identity is now the same id *or* the same `file:line`.
- **Two lenses describing one defect promoted as two findings**, which reads as two problems when it is the strongest signal a two-lane review produces — they merge, and keep both lens names.
- **One invented verdict at the head of a file discarded thirteen sound adjudications** — a bad verdict now rejects only its own entry, and every problem is reported at once.
- **A confirmed defect's blast radius went unrecorded and got over-fixed** — every `confirm` states where the fix stops, and that ships with the report.
