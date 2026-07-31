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

export function diffPasses(prev, curr) {
  const prevIds = new Set(prev.map((x) => x.id));
  const currIds = new Set(curr.map((x) => x.id));
  return {
    new: curr.filter((x) => !prevIds.has(x.id)),
    open: curr.filter((x) => prevIds.has(x.id)),
    closed: prev.filter((x) => !currIds.has(x.id)),
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
