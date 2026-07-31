const RULES = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "<redacted:private-key>",
  ],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    "<redacted:token>",
  ],
  [
    /\b(?:sk|gho|ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{12,}/g,
    "<redacted:token>",
  ],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer <redacted:token>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted:email>"],
  [
    /\b([A-Za-z0-9_-]*(?:key|token|secret|password|passwd|pwd)[A-Za-z0-9_-]*)(\s*[:=]\s*)(["']?)([A-Za-z0-9/+_.-]{12,})\3/gi,
    (_m, key, sep, q) => `${key}${sep}${q}<redacted:secret>${q}`,
  ],
];

export function scrub(text) {
  if (typeof text !== "string") return "";
  return RULES.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}

export const scrubDeep = (v) =>
  typeof v === "string"
    ? scrub(v)
    : Array.isArray(v)
      ? v.map(scrubDeep)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]),
          )
        : v;
