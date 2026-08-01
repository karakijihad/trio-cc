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
  if (!Array.isArray(parsed?.findings))
    return { ok: false, reason: "json block has no findings array" };

  for (const item of parsed.findings) {
    if (!item || typeof item !== "object") {
      return { ok: false, reason: "every finding must be an object" };
    }
    if (!SEVERITIES.includes(item.severity)) {
      return {
        ok: false,
        reason: `unknown severity "${item.severity}". valid: ${SEVERITIES.join(", ")}`,
      };
    }
    if (!item.file || !item.title)
      return { ok: false, reason: "every finding needs a file and a title" };
  }
  return {
    ok: true,
    findings: parsed.findings.map((x) => ({
      ...x,
      id: findingId(x.file, x.title),
    })),
  };
}

// Where a finding points, independent of how it is worded. A finding with no
// line falls back to its id rather than to the bare filename: collapsing every
// line-less finding in a file to one key would merge defects that have nothing
// to do with each other, which is the one error this must not make.
export const locationOf = (f) =>
  f.line === undefined || f.line === null || f.line === ""
    ? `${normalizeFile(f.file)}#${f.id ?? ""}`
    : `${normalizeFile(f.file)}:${f.line}`;

// Two lenses reporting one defect is corroboration, not two defects. Merge on
// id, keep the most severe reading, and carry every lens that raised it —
// provenance the promoted report renders and, until now, dropped on the floor.
export function mergeFindings(results) {
  const byId = new Map();
  for (const r of results ?? []) {
    for (const f of r.findings ?? []) {
      const seen = byId.get(f.id);
      if (!seen) {
        byId.set(f.id, { ...f, lens: f.lens ?? r.lens });
        continue;
      }
      if (SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(seen.severity))
        seen.severity = f.severity;
      const lenses = String(seen.lens ?? "").split(", ").filter(Boolean);
      if (r.lens && !lenses.includes(r.lens))
        seen.lens = [...lenses, r.lens].join(", ");
    }
  }
  return [...byId.values()];
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
