import { readFileSync } from "node:fs";
import { join } from "node:path";
import { passDir } from "./paths.mjs";
import { locationOf } from "./findings.mjs";
import { scrub } from "./scrub.mjs";

// The decline ledger: what this run has already settled, across every pass.
//
// Run memory used to be exactly one pass deep in both places that matter —
// buildLensPrompt saw only prevRecord, and diffPasses only diffed against
// pass N-1. A finding refuted in pass 1 and raised again in pass 3 was
// therefore invisible to both: absent from pass 2, so no matcher could catch
// it, and unmentioned in the pass-3 prompt. It came back as though nobody had
// ever considered it, and the reconciler paid to refute it a second time.
//
// Read from reconcile.json rather than verdicts.json: applyAdjudication has
// already folded the verdicts into the pass record by the time the next pass
// is built, and the record is the only place the verdict sits beside the
// finding's file, line, title and lens.

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const matches = (entry, f) =>
  entry.id === f.id || entry.key === locationOf(f);

// Verdicts that affirm a defect exists, and so overturn an earlier
// settlement. Every one of them is a reconciler saying "this is real" —
// `downgrade` included, which only disputes how big it is.
const OVERTURNS = new Set(["confirm", "escalate", "downgrade"]);

// Folds passes 1..uptoPass in order, later passes winning. Every read is
// tolerant: a missing or malformed pass record contributes nothing and
// overturns nothing, because silence is not a decision.
export function buildSettled(root, runId, uptoPass) {
  const last = Number.isSafeInteger(uptoPass) ? uptoPass : 0;
  let entries = [];

  for (let pass = 1; pass <= last; pass++) {
    const dir = passDir(root, runId, pass);
    const record = readJson(join(dir, "reconcile.json"));
    const findings = Array.isArray(record?.findings) ? record.findings : [];
    const reply = readJson(join(dir, "response.json"));
    const replies = Array.isArray(reply?.findings) ? reply.findings : [];

    const drop = (f) => {
      entries = entries.filter((e) => !matches(e, f));
    };
    // Scrubbed here, at the one boundary every entry passes through, rather
    // than at each of the two sources. A refuted basis arrives from
    // reconcile.json already scrubbed, but a declined one comes from
    // response.json, which nothing scrubs — and renderSettledSection replays
    // it into every later pass's brief. Doing it per-source would leave the
    // next kind of entry to remember; doing it here means an entry cannot
    // exist unscrubbed.
    const settle = (f, kind, priorVerdict, basis) => {
      drop(f);
      entries.push({
        id: f.id,
        key: locationOf(f),
        file: f.file,
        line: f.line ?? null,
        title: f.title,
        lens: f.lens ?? null,
        kind,
        priorVerdict,
        pass,
        basis: scrub(basis),
      });
    };

    // Adjudication first, then Claude's reply — the order the two actually
    // happen in, so a finding refuted and then declined in the same pass ends
    // up labelled `declined` while keeping `refute` as its prior verdict.
    //
    // `downgrade` overturns alongside confirm and escalate. It is an
    // affirmative disposition, not a soft dismissal: reconcile.mjs groups it
    // with the other two as a disagreement, and applyVerdicts shifts the
    // severity toward `info` rather than discarding the finding. Leaving it out
    // let a stale refutation survive a later "real, just smaller" ruling, and a
    // further re-raise at that location was then carried as a past non-issue.
    // `refute` is the only verdict that settles; silence settles nothing.
    //
    // An entry that is not an object is skipped rather than dereferenced.
    // `Array.isArray` above only proves the container; a `{"findings":[null]}`
    // still reaches `f.verdict` here, and locationOf and the byId map below
    // would each throw on it too. This function's own contract is that a
    // malformed record contributes nothing and overturns nothing — a throw
    // escaping into runPass would instead fail the whole run, which is the
    // opposite of tolerant.
    const usable = findings.filter((f) => f && typeof f === "object");

    for (const f of usable) {
      if (f.verdict === "refute") settle(f, "refuted", "refute", f.basis ?? "");
      else if (OVERTURNS.has(f.verdict)) drop(f);
    }

    const byId = new Map(usable.map((f) => [f.id, f]));
    for (const r of replies) {
      if (!r || typeof r !== "object") continue;
      const f = byId.get(r.id);
      if (!f) continue;
      const action = String(r.action ?? "").trim().toLowerCase();
      if (action === "fixed") {
        drop(f);
        continue;
      }
      if (action !== "declined") continue;
      // response.json is read tolerantly everywhere else and is not a
      // validated contract. An unexplained decline is not evidence that
      // anyone decided anything, so it settles nothing — and neither is a
      // reason that is not text. String() would turn an object into
      // "[object Object]", which is truthy, and settle a finding on it.
      const raw = r.reason ?? r.note;
      const reason = typeof raw === "string" ? raw.trim() : "";
      if (!reason) continue;
      settle(f, "declined", f.verdict ?? "unreviewed", reason);
    }
  }

  return entries;
}

// Same identity rule as `matcher` in findings.mjs, and for the same reason:
// same id OR same place. Deliberately not file-level — one settled finding in
// src/driver.mjs once coexisted with six unrelated new defects in that file,
// and matching on the filename would have suppressed all six.
//
// Returns the matched entry plus how it matched, or null. `matchedBy` is
// carried into the record so a suppression is always auditable.
export function settledMatcher(entries) {
  const list = entries ?? [];
  return (f) => {
    if (!f) return null;
    const byId = list.find((e) => e.id === f.id);
    if (byId) return { ...byId, matchedBy: "id" };
    const place = locationOf(f);
    const byPlace = list.find((e) => e.key === place);
    return byPlace ? { ...byPlace, matchedBy: "location" } : null;
  };
}

// Attaches an earlier pass's decision to a finding raised again in this one.
//
// `verdict` is deliberately left alone. It means "this pass's reconciler
// outcome" everywhere else — applyVerdicts sets it to `unreviewed` precisely
// when nobody has looked, and renderDisagreementTable publishes `refute` as a
// disagreement. Writing a synthetic `refute` here would put a disagreement
// nobody voiced into the permanent record. History goes in `carried`.
export function carrySettled(findings, entries) {
  if (!entries?.length) return findings;
  const match = settledMatcher(entries);
  return findings.map((f) => {
    const e = match(f);
    if (!e) return f;
    return {
      ...f,
      carried: {
        fromPass: e.pass,
        kind: e.kind,
        priorVerdict: e.priorVerdict,
        basis: e.basis,
        matchedBy: e.matchedBy,
      },
    };
  });
}

// The primary mechanism, because the mechanical one cannot be the whole story:
// across every recorded boomerang the lens reworded its title completely, so
// `id` matched none of them. Only prose reaches a lens that is about to write
// a new title for an old claim.
//
// Framed as history rather than as a list of candidates. A run-wide list shown
// to every lens can prime one into reporting a defect it would not otherwise
// have raised, and the framing is the mitigation.
export function renderSettledSection(entries) {
  if (!entries?.length) return null;

  const lines = entries.map((e) => {
    const where = e.line ? `${e.file}:${e.line}` : e.file;
    const label = e.kind === "refuted" ? "REFUTED" : "DECLINED";
    const who = e.lens ? `, raised by ${e.lens}` : "";
    return `- ${where} — "${e.title}" (pass ${e.pass}${who})\n  ${label}: ${e.basis}`;
  });

  return [
    "## Already settled this run",
    "",
    "These were raised earlier in this run and settled — either adjudication",
    "found no defect, or the decision was to carry it deliberately. This is",
    "history, not a list of defects to look for: do not report something",
    "because it appears here. Report it only if you independently reproduce it",
    "in the code as it stands now, and if you do, say in `evidence` what is new",
    "since it was settled — engage the stated basis rather than restating the",
    "original claim.",
    "",
    "Where a basis says the behaviour is pinned by a test, that test is the",
    "decision being enforced, and citing it back is not new evidence. Showing",
    "that the test itself encodes a defect is.",
    "",
    ...lines,
  ].join("\n");
}
