# Log

What went wrong, and what was done about it. One line each, newest first.

---

## 2026-09-18 — naming the model at the call

- **A consult could only run on the model its project had configured.** Changing it meant `/trio:model consult` first, which then stuck. `trio consult` takes `--model NAME` (any part of a slug, resolved against the live catalogue) and `--effort LEVEL` for one call, saving neither.
- **The Claude half of a consult reported `model = null` and nobody could see why.** `claude.consultModel` is per project and ships null, so a value set in one repo says nothing about the next. The answer's JSON now carries the `model` and `effort` that produced it, and the skill names them in the headings.
- **The first cut of the flag guard would have refused a question containing `-1`.** Only a long flag is refused wherever it stands; a leading dash of any shape is still a mistyped flag.
- **A question containing the literal `--model` lost the word after it.** `consult explain what --model does in trio` read `does` as the model and dropped it; a question is free text, so no guard can tell a flag from a word about one. A bare `--` now ends flag parsing. Found by the auditor lens in a solo audit.
- **A flag given twice applied the first and said nothing**, so correcting a typo by retyping `--model` spent the consult on the model being replaced. Refused now, as `trio lens` has always refused it.
- **The refusal was documented as unconditional and is not.** With no model catalogue yet — a Codex install that has never written one — the name goes through unresolved, the same way `trio run` passes a pinned lens model through rather than blocking a first run. The claim carries the condition now.

## 2026-09-15 — auditing the release that fixed the review

- **The viewer's own resume fix could skip events.** One SSE `id` per flushed batch meant a client that dropped after the first event already held the batch's end, and reconnected past events it never received. Each event carries its own byte offset now; the test that shipped green seeded a single event, which cannot tell the two apart.
- **The 64 KB changes cap wasn't one.** It always kept the first diff whole, and diff.mjs bounds line count, not line length; the omitted-names tail and a long file name were unbounded too.
- **`artifacts.promoteTo` went into every lens brief verbatim and onto the filesystem unchecked.** A repository-writable config could smuggle instructions into Codex's prompt or point promotion outside the project. Only a single-line relative path inside the project is accepted.
- **The capture scope check compared lexical paths**, so a symlink inside the target pointing into `.trio/` counted as inside the target. Real paths now.
- **A hand-written `duplicate` verdict with no real survivor hid its finding.** `trio verdicts` refused it, but a verdicts.json nobody validated was applied as written. It is ignored now and the finding stays unreviewed.
- **The atomic verdict write needed hard links**, which FAT/exFAT and some network folders lack; it falls back to an exclusive create.
- **Promotion could still leave the project** — through a directory link inside it, or from a run's stored `run.json`, which finalize reads without ever passing through config validation. One containment check now sits inside promotion itself, on real paths, so every caller gets it.
- **The "single line" check let U+2028 and friends through**, and its regex had been written into the source as raw control characters by an escape that decoded on the way in. It is a code-point check now, with nothing raw in the file.
- **The containment fix could crash `trio promote`.** The new leaf check inside promotion threw for a linked `codex/` or `claude/` directory, and the command had no catch, so a correct refusal arrived as a stack trace. It refuses with a message now. Found by a solo audit — Claude lenses, no Codex.
- **A refused promotion was reported as a missing directory**, which invited `--create` for a path that could never be written. It is reported as refused, with the reason and no offer.
- **The promotion-path rule existed twice, and the copies disagreed** about a leading backslash on POSIX. One predicate now serves both.

## 2026-09-13 — what an independent review of Trio found

- **A new claim on a line an earlier finding was refuted at stopped blocking, unreviewed.** A settled refutation was matched by id or location, so it excused a different defect that happened to sit on the same line. Only the same finding (same id) is excused now.
- **`downgrade` was the reconciler's word for "real, but out of scope".** A true major became a minor and stopped blocking, turning "we won't fix this" into a lower risk rating. `downgrade` now means only overstated; an out-of-scope finding keeps its severity and is reported under "Outside this change".
- **Fixes made after the last pass were never re-audited**, and nothing said so. They are reported as `fixedUnverified`.
- **`converge.requireNoNewFindings` had stopped doing anything**, and `config set converge.blockOn critical,major` stored a string where convergence expected a list. The key is gone; blockOn is parsed and validated.
- **The viewer could not auto-exit with a browser attached**, and every reconnect replayed the whole log. Codex lenses were never told to keep out of `.trio/` and promoted audits. The real-Codex smoke test still expected the pre-parking flow, and CI never ran the Node 18 that package.json promises.

- **An extended run applied every severity shift twice.** Verdicts were applied from the stored severity, and extending a run re-applied them, so a `downgrade` moved `major` to `info`. A downgraded `critical` could have stopped blocking. Verdicts now shift from the severity the lens reported, recorded once.
- **`clean` was unreachable in practice: 0 of 9 runs.** Any new finding blocked convergence, down to `info`. Now only a live finding at a `blockOn` severity does.
- **One defect from two lenses counted as two blocking majors**, a line apart. The reconciler has a `duplicate` verdict now.
- **Codex read Claude's findings before writing its own.** Every Edit/Write was recorded, so the scratchpad findings file and `response.json` went into the next pass's brief as "what Claude changed". Only changes inside the target and outside `.trio/` are recorded, and that section is capped.
- **Every tool call was recorded twice**, from PreToolUse and PostToolUse — two Node starts per call in every session.
- **The viewer re-read the whole event log every second**, most of it uncapped command output. It reads only what was appended, and output is capped at 8 KB.
- **A broken `codex.lenses` crashed `trio`, `on`, `doctor` and `models`**, and `run` re-probed Codex every time despite a 24-hour cache. The CLI tests probed the developer's real Codex; they use the fake now and run in a quarter of the time.

## 2026-09-13 — who picks the model

- **Trio shipped a model slug that would expire.** All five lenses pinned `gpt-5.6-terra`, so every project that never edited its config would one day start every run on a model OpenAI had retired. Lenses now ship `model: null` (the Codex CLI decides); a slug someone pins and later loses is flagged at run start with an offer to re-pick.
- **Consult ran on whichever lens happened to be first.** It borrowed the first enabled lens's model, so it could not run heavier than an audit, and switching `auditor` off silently changed it. `codex.consult` is its own setting now, with the old borrowing as the fallback.
- **A consult on a spent account read the repo, then reported only `failed: true`, and exited 0.** The ping that guards a run never ran for a consult, and askCodex discarded the error event naming the usage limit. Consult now pings first, classifies a failure the way a lens does, returns the reason, and exits 1; its effort ships `high`.
- **A solo audit could be reviewed by a weaker model than the one that wrote the code** — `trio-lens` and `trio-reconciler` hardcode Sonnet. `claude.agentModel` overrides both, and `claude.consultModel` picks the Claude half of a consult.

## 2026-08-18 — the last pass, and what happens when Codex is out

- **A run could reach `ceiling_reached` over findings nobody had reviewed.** The final pass was judged on raw lens output, where every finding is `unreviewed` and therefore live, so one unreviewed `major` closed the run. Every earlier pass was judged *after* adjudication — the last one was held to a different standard purely because the loop had run out of passes. It now parks like any other pass (`final: true`), and `continue` settles it once the verdicts are in.
- **The extension offer's counts were counts of unreviewed claims** — the `closed`/`new` numbers that are the whole basis for spending another pass. They are adjudicated now, because the offer is made after the settling call.
- **Every Codex failure read the same: `codex exited 1`.** A spent quota and a dropped connection were indistinguishable, so the only way to tell them apart was to spend five more lenses. `src/failure.mjs` classifies them: transient faults retry themselves once, and a spent quota or refused credentials end the run and say so.
- **Nothing asked whether the account could be used before a run committed to everything.** preflight checks installed and logged in, and neither can see a spent quota — so an out-of-usage run still took the lock, minted a run directory, opened a browser window, and spawned every lens. One trivial read-only call now goes first (`src/ping.mjs`), and only permanent refusals stop a run: a probe that could veto every audit in a project on evidence it could not read would be the worse failure.
- **stderr was piped and never read** — the one place a cause is reliably written, discarded. Worse, an unread pipe can fill: a lens failing verbosely could block on a full buffer and then be killed by the deadline as though it had hung.
- **A run that audited nothing kept holding the project's lock.** When every lens fails for a reason waiting will not fix, there is nothing to adjudicate — it finalizes instead of parking, so the fallback is not blocked by the run that failed.
- **`continue` refused the settling call for not carrying a Claude lane**, a fresh audit for a pass that was never going to run. The guard moved to after the finalize decision, where a pass N+1 actually exists.
- **Codex being unavailable meant no audit at all** — `trio-solo` runs the same lens briefs as blind Claude subagents. It is honest about being one model wearing two hats, and never reports in a two-model run's vocabulary.

## 2026-08-05 — the decline ledger

- **Refuted and declined findings came back pass after pass**, because run memory was one pass deep — a run-level ledger (`src/settled.mjs`) now folds every pass's settlements and shows them to every lens.
- **A decline is not a refutation.** Four of nine recorded declines were defects the reconciler had *confirmed*, so only a prior `refute` excuses a finding from blocking convergence — a run can never report `clean` over a known defect.
- **Marking a re-raise `refute` would have faked a verdict nobody gave** — history goes in a separate `carried` field, the verdict stays `unreviewed`, and the reconciler keeps the last word.
- **`downgrade` didn't overturn a settlement**, so a stale refutation outlived a ruling that the defect was real. It means "real, just smaller", and now overturns alongside `confirm` and `escalate`.
- **The report never said why a carried finding didn't block** — it now prints the carry and asks `isLive` rather than restating the rule, so the two can't drift apart.
- **Decline reasons reached Codex unscrubbed** — scrubbed now at the one boundary every ledger entry passes through, and in the reply section too.
- **A malformed handover file failed the whole run** instead of costing its own section — both readers skip entries that aren't objects.
- **An unreadable reply then reported itself as an empty one**, because dropping every malformed entry left nothing to show — it now says how many entries couldn't be read, and says it even when some survived.

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
