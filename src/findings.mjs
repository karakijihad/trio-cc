import { createHash } from "node:crypto";

export const SEVERITIES = ["critical", "major", "minor", "info"];

const normalize = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const normalizeFile = (s) => normalize(s).replace(/\\/g, "/").replace(/^\.\//, "");

export function findingId(file, title) {
  return createHash("sha1")
    .update(`${normalizeFile(file)}::${normalize(title)}`)
    .digest("hex")
    .slice(0, 8);
}

// The findings contract itself, independent of how the JSON arrived. Codex
// wraps it in a fenced block at the end of a message; Claude hands over a
// file. One shape, one validator — a second copy would drift, and the two
// lanes' findings have to be mergeable to be comparable at all.
// A rejected value gets quoted back to the operator, and the file it came
// from may have been written by something other than the operator. Control
// characters are what turn an error message into a terminal escape sequence,
// and an unbounded one turns it into a screenful — neither belongs in a line
// whose only job is to name the field that was wrong.
const quoteForTerminal = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  const flat = [...s]
    .map((ch) => {
      const c = ch.codePointAt(0);
      return c < 0x20 || (c >= 0x7f && c <= 0x9f) ? "?" : ch;
    })
    .join("");
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
};

export function validateFindings(parsed) {
  if (!Array.isArray(parsed?.findings))
    return { ok: false, reason: "no findings array" };

  for (const item of parsed.findings) {
    if (!item || typeof item !== "object") {
      return { ok: false, reason: "every finding must be an object" };
    }
    if (!SEVERITIES.includes(item.severity)) {
      return {
        ok: false,
        reason: `unknown severity "${quoteForTerminal(item.severity)}". valid: ${SEVERITIES.join(", ")}`,
      };
    }
    if (!item.file || !item.title)
      return { ok: false, reason: "every finding needs a file and a title" };
  }
  return {
    ok: true,
    // `lens` is stripped, never trusted. mergeFindings resolves provenance as
    // `f.lens ?? r.lens`, so a finding that arrives carrying its own lens wins
    // over the lane that actually produced it — and this validator is the
    // boundary where findings authored outside Trio come in. A handover file
    // claiming `"lens": "auditor, security"` would otherwise read as
    // corroborated by two Codex lenses that never saw it, which is the one
    // claim in the whole report that has to be earned.
    findings: parsed.findings.map(({ lens: _ignored, ...x }) => ({
      ...x,
      id: findingId(x.file, x.title),
    })),
  };
}

export function extractFindings(text) {
  const blocks = [...String(text ?? "").matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length)
    return { ok: false, reason: "no json block in the final message" };

  let parsed;
  try {
    parsed = JSON.parse(blocks.at(-1)[1]);
  } catch (e) {
    return {
      ok: false,
      reason: `could not parse the json block: ${e.message}`,
    };
  }
  const checked = validateFindings(parsed);
  return checked.ok
    ? checked
    : { ok: false, reason: `json block has ${checked.reason}` };
}

// Where a finding points, independent of how it is worded. A finding with no
// line falls back to its id rather than to the bare filename: collapsing every
// line-less finding in a file to one key would merge defects that have nothing
// to do with each other, which is the one error this must not make.
export const locationOf = (f) =>
  f.line === undefined || f.line === null || f.line === ""
    ? `${normalizeFile(f.file)}#${f.id ?? ""}`
    : `${normalizeFile(f.file)}:${f.line}`;

// Two lenses reporting one defect is corroboration, not two defects. Keep the
// most severe reading and carry every lens that raised it — provenance the
// promoted report renders.
//
// Same rule as `matcher` below, and for the same reason: same id OR same
// place. Merging on id alone made wording the test of identity, so the two
// lanes describing one defect in their own words promoted as two findings —
// which reads as two independent problems when it is the single strongest
// signal the two-lane design produces. Run 2026-08-03T10-06-14 promoted
// `bin/trio.mjs:356` twice, once per lane, for exactly this.
//
// The cost is the mirror of the benefit: two genuinely different defects
// reported at one file:line by different lenses now collapse into one, and
// the later title is lost. That is the same trade `matcher` already makes,
// pointed the same way — a place is treated as a defect. It is bounded by
// requiring a line: findings without one fall back to `file#id` (locationOf),
// so a line-less finding can only ever merge by id.
export function mergeFindings(results) {
  // Both keys address the same entry, so this cannot be the return value —
  // every merged finding is registered twice.
  const byKey = new Map();
  const merged = [];
  for (const r of results ?? []) {
    for (const f of r.findings ?? []) {
      const place = locationOf(f);
      const seen = byKey.get(f.id) ?? byKey.get(place);
      if (!seen) {
        const entry = { ...f, lens: f.lens ?? r.lens };
        byKey.set(f.id, entry);
        byKey.set(place, entry);
        merged.push(entry);
        continue;
      }
      if (SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(seen.severity))
        seen.severity = f.severity;
      const lenses = String(seen.lens ?? "").split(", ").filter(Boolean);
      if (r.lens && !lenses.includes(r.lens))
        seen.lens = [...lenses, r.lens].join(", ");
      // Alias both of the absorbed finding's keys onto the survivor, or a
      // third lens matching only the key that lost would start a new entry
      // and the merge would stop being transitive.
      if (!byKey.has(f.id)) byKey.set(f.id, seen);
      if (!byKey.has(place)) byKey.set(place, seen);
    }
  }
  return merged;
}

// Two findings describe the same defect when they share an id or point at the
// same place. Wording is not part of it, and that is the whole point: keyed on
// the id alone, a lens rephrasing its own title between passes made one defect
// read as one closed and one new at the same time. Run 2026-08-01T12-27-09
// closed 21 of 21 and opened 0 that way, while 14 of those defects were still
// sitting in the code — a "closed" column claiming fixes that never happened.
const matcher = (findings) => {
  const ids = new Set(findings.map((x) => x.id));
  const places = new Set(findings.map(locationOf));
  return (f) => ids.has(f.id) || places.has(locationOf(f));
};

// Both directions are deliberately conservative, and they point opposite ways:
// slower to call something new (so a rewrite cannot block convergence for
// ever) and slower to call something closed (so nothing is reported fixed on
// the strength of a rewrite). Severity blocking reads the current pass
// directly and is unaffected by either.
export function diffPasses(prev, curr) {
  const seenBefore = matcher(prev);
  const seenNow = matcher(curr);
  return {
    new: curr.filter((x) => !seenBefore(x)),
    open: curr.filter(seenBefore),
    closed: prev.filter((x) => !seenNow(x)),
  };
}

export function isConverged(curr, diff, converge) {
  const live = curr.filter((x) => x.verdict !== "refute");
  const blocking = live.some((x) => (converge.blockOn ?? []).includes(x.severity));
  if (blocking) return false;
  if (
    converge.requireNoNewFindings &&
    diff.new.some((x) => x.verdict !== "refute")
  )
    return false;
  return true;
}
