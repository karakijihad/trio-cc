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

// Where a finding points, independent of how it is worded. `findingId` hashes
// the title, so a lens that rephrases itself mints a new id for a defect it
// already reported — deliberately, since two findings at one line are often
// two real defects and a false merge would hide one. Location is the coarser
// key convergence needs, and only convergence uses it.
export const locationOf = (f) => `${normalizeFile(f.file)}:${f.line ?? ""}`;

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

export function diffPasses(prev, curr) {
  const prevIds = new Set(prev.map((x) => x.id));
  const currIds = new Set(curr.map((x) => x.id));
  const prevLocations = new Set(prev.map(locationOf));
  return {
    new: curr.filter((x) => !prevIds.has(x.id)),
    open: curr.filter((x) => prevIds.has(x.id)),
    closed: prev.filter((x) => !currIds.has(x.id)),
    // What `requireNoNewFindings` actually means: a defect that is new by id
    // *and* points somewhere the previous pass never reported. Keyed on id
    // alone, a lens rewording its own title manufactured a "new" finding and
    // blocked convergence for ever on the rewrite; keyed on location alone, a
    // finding whose line merely shifted — because an earlier fix moved it —
    // did the same. Severity blocking is untouched by either.
    newHere: curr.filter(
      (x) => !prevIds.has(x.id) && !prevLocations.has(locationOf(x)),
    ),
  };
}

export function isConverged(curr, diff, converge) {
  const live = curr.filter((x) => x.verdict !== "refute");
  const blocking = live.some((x) => (converge.blockOn ?? []).includes(x.severity));
  if (blocking) return false;
  if (
    converge.requireNoNewFindings &&
    (diff.newHere ?? diff.new).some((x) => x.verdict !== "refute")
  )
    return false;
  return true;
}
