import { SEVERITIES, UNREVIEWED } from "./findings.mjs";

// `duplicate` was added after two lenses reported one defect under different
// titles and there was nothing to write but `escalate` — which reads as "this
// is worse than reported" when it means "this is the same finding, counted
// twice". A duplicate carries `of`, the id of the finding it duplicates; see
// validateVerdicts and applyVerdicts below for what that requires and does.
export const VERDICTS = ["confirm", "refute", "downgrade", "escalate", "duplicate"];

// The absence of a verdict is not agreement. Every finding used to default to
// "confirm", so a pass nobody had adjudicated reported sixteen confirmed
// findings and an empty disagreement table — which reads as "the two agree"
// when it means "nobody has looked yet".
//
// It lives in findings.mjs now, because isLive there has to test for it and
// this module already imports SEVERITIES from that one. Re-exported so the
// callers that know it by this name keep working.
export { UNREVIEWED };

// Only these are disagreements. "confirm" is agreement and "unreviewed" is
// silence; neither belongs in a table of where the two models differ.
const DISAGREEMENTS = ["refute", "downgrade", "escalate"];

// LABEL below renders `refute` as REFUTED, so Trio's own reports teach the
// past tense back to whatever writes the next verdicts file — and a verdict
// file is written by hand between passes, by a model that has read one. The
// spelling is the only thing wrong with CONFIRMED; the meaning is not in
// doubt, and rejecting on spelling cost a whole pass of real adjudication.
// Aliases stop at these four. Anything else is a verdict Trio does not have.
const ALIASES = {
  confirmed: "confirm",
  refuted: "refute",
  downgraded: "downgrade",
  escalated: "escalate",
  duplicated: "duplicate",
};

const canonicalVerdict = (raw) => {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  const canonical = ALIASES[v] ?? v;
  return VERDICTS.includes(canonical) ? canonical : null;
};

// What a model actually hands back. A bare JSON object is the contract, but
// the reply that started all of this was fourteen thousand characters of
// prose, and a human — or an agent with a heredoc — then retyped it into the
// file by hand. Pulling the block out is strictly better than transcribing it.
export function parseVerdictsInput(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, problems: ["no input"] };

  const candidates = [raw];
  const blocks = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (blocks.length) candidates.push(blocks.at(-1)[1]);

  let lastError = null;
  for (const c of candidates) {
    try {
      return { ok: true, parsed: JSON.parse(c) };
    } catch (err) {
      lastError = err;
    }
  }
  return {
    ok: false,
    problems: [
      `not JSON, and no fenced json block to fall back on: ${lastError.message}`,
    ],
  };
}

// The write boundary, and the opposite policy to applyVerdicts on purpose.
// Reading is tolerant because a rejected verdict there destroys adjudication
// nobody can recreate; writing is all-or-nothing because the writer still has
// the data in hand and can simply resubmit. Nothing is lost by refusing here,
// and refusing here is the only place a bad file can still be stopped.
//
// Every problem is collected, never just the first: the writer is a model that
// will resubmit, and one error per round trip turns a three-line fix into
// three passes.
export function validateVerdicts(parsed, { knownIds } = {}) {
  if (!Array.isArray(parsed?.verdicts))
    return {
      ok: false,
      problems: ["no verdicts array"],
      warnings: [],
      verdicts: [],
      renamed: [],
    };

  const known = knownIds ? new Set(knownIds) : null;
  const problems = [];
  const warnings = [];
  const renamed = [];
  const seen = new Set();
  const verdicts = [];

  for (const [i, v] of parsed.verdicts.entries()) {
    const at = `verdicts[${i}]`;
    if (!v || typeof v !== "object") {
      problems.push(`${at}: not an object`);
      continue;
    }
    const id = typeof v.id === "string" ? v.id.trim() : "";
    if (!id) {
      problems.push(`${at}: no id`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${at}: a second verdict for ${id}`);
      continue;
    }
    seen.add(id);

    // An id matching no finding is silently dropped at read time, so this is
    // the only place it can be caught — and it usually means a transcription
    // slip, which is exactly the failure this command exists to stop.
    if (known && !known.has(id)) {
      problems.push(`${at}: no finding ${id} in this pass`);
      continue;
    }

    const verdict = canonicalVerdict(v.verdict);
    if (!verdict) {
      problems.push(
        `${at} (${id}): unknown verdict ${JSON.stringify(v.verdict ?? null)}. valid: ${VERDICTS.join(", ")}`,
      );
      continue;
    }
    if (typeof v.verdict === "string" && v.verdict.trim() !== verdict)
      renamed.push({ id, from: v.verdict.trim(), to: verdict });

    // Coerced silently, these become an empty string and the verdict looks
    // merely unevidenced rather than malformed. Say which it was.
    if (v.basis != null && typeof v.basis !== "string")
      problems.push(`${at} (${id}): basis must be a string`);
    if (v.bounds != null && typeof v.bounds !== "string")
      problems.push(`${at} (${id}): bounds must be a string`);

    const basis = typeof v.basis === "string" ? v.basis.trim() : "";
    const bounds = typeof v.bounds === "string" ? v.bounds.trim() : "";

    // `duplicate` carries `of`, the id of the finding it duplicates — the
    // survivor. It must name a real finding in this pass, name something
    // other than itself, and not be checked for chaining onto another
    // duplicate here: that needs every verdict in the batch decided first,
    // so it is a second pass below, after this loop has finished.
    let of;
    if (verdict === "duplicate") {
      of = typeof v.of === "string" ? v.of.trim() : "";
      if (!of)
        problems.push(
          `${at} (${id}): duplicate needs "of" naming the finding it duplicates`,
        );
      else if (of === id)
        problems.push(`${at} (${id}): duplicate cannot name itself as "of"`);
      else if (known && !known.has(of))
        problems.push(`${at} (${id}): duplicate of unknown finding ${of}`);
    } else if (v.of != null) {
      problems.push(`${at} (${id}): "of" is only valid on a duplicate verdict`);
    }

    // `outOfScope` says a confirmed or escalated finding is real, at the
    // severity shown, but outside the change under audit — it warrants no
    // change here. `downgrade` used to be overloaded for this ("real but
    // small" and "real but not mine to fix" read identically once severity
    // is lowered), which silently stopped a genuine major from blocking. This
    // is the explicit, recorded alternative: severity is untouched, and the
    // report names it in its own section rather than dropping it (see
    // isConverged in findings.mjs and the "Outside this change" section in
    // promote.mjs). Valid only on confirm/escalate — refute already says
    // there is no defect, duplicate and downgrade already have their own
    // meaning, and stacking this onto either would just invent a sixth verdict
    // under a different name.
    let outOfScope;
    if (v.outOfScope != null) {
      if (typeof v.outOfScope !== "boolean")
        problems.push(`${at} (${id}): outOfScope must be true or false`);
      else if (verdict !== "confirm" && verdict !== "escalate")
        problems.push(
          `${at} (${id}): outOfScope is only valid on confirm or escalate`,
        );
      else outOfScope = v.outOfScope;
    }

    // Every verdict, not only the disagreements. A refute without cited
    // evidence is refused by the reconciler's own rules, and a confirm is
    // required to state the failure path — "if you cannot write the path, the
    // verdict is downgrade". A bare confirm is the one that costs most: it is
    // what the next pass goes and fixes.
    if (!basis)
      problems.push(
        verdict === "confirm"
          ? `${at} (${id}): confirm needs a basis stating the failure path`
          : `${at} (${id}): ${verdict} needs a basis citing what proves it`,
      );

    // A warning, not a refusal — the contract permits leaving bounds out, but
    // only when the reviewer did not look, and an unbounded confirm is what
    // gets over-fixed.
    if (verdict === "confirm" && !bounds)
      warnings.push(`${id}: confirmed with no bounds — the fix has no edges`);

    verdicts.push({
      id,
      verdict,
      basis,
      ...(bounds ? { bounds } : {}),
      ...(verdict === "duplicate" ? { of } : {}),
      ...(outOfScope ? { outOfScope: true } : {}),
    });
  }

  // A duplicate cannot name another duplicate as its survivor — that would
  // ask a later reader to chase a chain instead of reading one id off the
  // finding. Only checkable now that every verdict in the batch is known.
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  for (const v of verdicts) {
    if (v.verdict !== "duplicate") continue;
    if (byId.get(v.of)?.verdict === "duplicate")
      problems.push(
        `verdict for ${v.id}: "of" finding ${v.of} is itself marked duplicate — duplicates cannot chain`,
      );
  }

  // Silence at the write boundary is the whole defect in miniature. Here the
  // author is still holding the data, so an omission is a mistake to fix, not
  // a state to record — leaving it to land on `unreviewed` would recreate
  // exactly the "nobody looked" outcome this command exists to prevent.
  if (known)
    for (const id of known)
      if (!seen.has(id)) problems.push(`no verdict for finding ${id}`);

  return { ok: problems.length === 0, problems, warnings, verdicts, renamed };
}

const shift = (severity, by) => {
  const i = SEVERITIES.indexOf(severity);
  if (i === -1) return severity;
  return SEVERITIES[Math.min(SEVERITIES.length - 1, Math.max(0, i + by))];
};

// `bounds` is where a confirmed defect stops: the other call sites the pattern
// reaches, and the ones it demonstrably does not. It is separate from `basis`
// because the two have different readers — `basis` answers "why this verdict"
// and only reaches the report when the verdict was a disagreement, while
// `bounds` answers "how wide is the fix" and belongs in the permanent record
// of every finding that stayed open. A confirmed defect whose blast radius
// nobody wrote down gets over-fixed.
// An unrecognized verdict rejects its own entry and nothing else. Throwing on
// the first one discarded the whole batch: a single invented category at the
// head of the array cost thirteen sound adjudications and their `bounds`.
// Skipping is the conservative direction because the finding falls through to
// `unreviewed` — never to agreement — and `onInvalid` hands the caller every
// rejected entry at once, so a malformed file is reported in full rather than
// one entry at a time. It is not a silent pass, though: `unreviewed` keeps a
// finding live, but only `converge.blockOn` decides whether live blocks, so a
// rejected verdict that should have been an `escalate` can leave a finding
// below the blocking bar. The report is what has to say so.
// A `downgrade`/`escalate` shifts severity from `reported` — the severity a
// lens actually reported, fixed the first time a finding is adjudicated and
// then carried on the finding unchanged — never from `f.severity`, which is
// this function's own output and would already hold last time's shift.
//
// That distinction is the whole fix for a run extended past its ceiling.
// reopenRun (src/driver.mjs) points the marker back at the pass that already
// converged or hit the ceiling, and continueRun runs applyAdjudication on it
// again with the same pass-N/verdicts.json — so this runs a second time over
// its own output. Shifting from `f.severity` there moved a `downgrade` two
// steps (critical -> major -> minor) though nothing new was ever decided.
// Shifting from `reported` instead makes a second application produce
// exactly what the first one did: applying adjudication twice equals once.
//
// A record written before this field existed has no `reported` — the `??`
// falls back to `f.severity`, which on an unadjudicated finding is the
// reported severity anyway, so an old reconcile.json loads and adjudicates
// exactly as it always did.
export function applyVerdicts(findings, verdicts, { onInvalid } = {}) {
  const byId = new Map();
  const rejected = [];
  for (const v of verdicts ?? []) {
    const verdict = canonicalVerdict(v?.verdict);
    if (!verdict) {
      rejected.push({
        id: v?.id ?? null,
        verdict: v?.verdict ?? null,
        reason: "unrecognised verdict",
      });
      continue;
    }
    byId.set(v.id, { ...v, verdict });
  }
  // A duplicate stops a finding counting as live, so it is only honoured when
  // it names a survivor that exists in this pass and is not itself a
  // duplicate. `trio verdicts` already refuses the rest; this is the read
  // side, for a verdicts.json nobody validated.
  const findingIds = new Set(findings.map((f) => f.id));
  // Judged against the verdicts as submitted, not as this loop removes them:
  // otherwise the second of two duplicates naming each other would survive.
  const duplicateIds = new Set(
    [...byId].filter(([, v]) => v.verdict === "duplicate").map(([id]) => id),
  );
  for (const [id, v] of byId) {
    if (v.verdict !== "duplicate") continue;
    const of = typeof v.of === "string" ? v.of.trim() : "";
    if (
      !of ||
      of === id ||
      !findingIds.has(of) ||
      duplicateIds.has(of)
    ) {
      byId.delete(id);
      rejected.push({
        id,
        verdict: "duplicate",
        reason: `"of" must name another, non-duplicate finding in this pass`,
      });
    }
  }
  if (rejected.length) onInvalid?.(rejected);

  const updated = findings.map((f) => {
    const reported = f.reported ?? f.severity;
    const v = byId.get(f.id);
    // `outOfScope` is reset here too, the same as `basis`/`bounds`: it is a
    // claim about this pass's adjudication, not a permanent fact, and an
    // unreviewed finding must not go on silently reading as out of scope on
    // the strength of a verdict nobody repeated.
    if (!v)
      return {
        ...f,
        verdict: UNREVIEWED,
        basis: "",
        bounds: "",
        reported,
        outOfScope: false,
      };

    // `duplicate` never shifts severity — the survivor already carries its
    // own, and this finding is about to stop counting as live at all (see
    // isLive in findings.mjs). `of` is folded onto the record so the report
    // can say what this duplicated, and so the fold below can find its
    // survivor.
    if (v.verdict === "duplicate") {
      const of = typeof v.of === "string" ? v.of.trim() : "";
      return {
        ...f,
        verdict: v.verdict,
        basis: v.basis ?? "",
        bounds: v.bounds ?? "",
        severity: reported,
        reported,
        ...(of ? { of } : {}),
      };
    }

    const severity =
      v.verdict === "downgrade"
        ? shift(reported, 1)
        : v.verdict === "escalate"
          ? shift(reported, -1)
          : reported;
    // `outOfScope` is written only when this verdict actually carries it —
    // never re-derived from the finding's own prior value — so a finding
    // that was out of scope last time this ran (the reopenRun/extend replay
    // in applyAdjudication's own comment above) and is adjudicated afresh
    // without it here simply stops being flagged, rather than the flag
    // surviving on stale say-so from `...f`.
    return {
      ...f,
      verdict: v.verdict,
      basis: v.basis ?? "",
      bounds: v.bounds ?? "",
      severity,
      reported,
      outOfScope: v.outOfScope === true,
    };
  });

  // Fold each duplicate's lens(es) into its survivor, the same join
  // mergeFindings uses, so the report still credits every lens that raised
  // the defect even though only the survivor stays open for it. Re-running
  // this over its own output (the extend case above) folds nothing new in,
  // because the survivor already carries every lens name it would add.
  const byIdAfter = new Map(updated.map((x) => [x.id, x]));
  for (const dup of updated) {
    if (dup.verdict !== "duplicate" || !dup.of) continue;
    const survivor = byIdAfter.get(dup.of);
    if (!survivor) continue;
    const lenses = String(survivor.lens ?? "").split(", ").filter(Boolean);
    for (const l of String(dup.lens ?? "").split(", ").filter(Boolean))
      if (!lenses.includes(l)) lenses.push(l);
    survivor.lens = lenses.join(", ");
  }

  return updated;
}

const LABEL = {
  refute: "REFUTED",
  downgrade: "DOWNGRADED",
  escalate: "ESCALATED",
};

export function renderDisagreementTable(findings) {
  const rows = findings.filter((f) => DISAGREEMENTS.includes(f.verdict));
  if (!rows.length) {
    // "No disagreements" and "nobody has looked" are different reports, and
    // this line claimed the first while meaning the second.
    const pending = findings.filter((f) => f.verdict === UNREVIEWED).length;
    return pending
      ? `_No disagreements recorded — ${pending} finding(s) not yet adjudicated._\n`
      : "_No disagreements — every finding was confirmed as reported._\n";
  }
  const lines = [
    "| Finding | Lens | Verdict | Basis |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (f) =>
        `| ${f.title} (${f.file}) | ${f.lens ?? "—"} | **${LABEL[f.verdict]}** | ${f.basis || "—"} |`,
    ),
  ];
  return lines.join("\n") + "\n";
}
