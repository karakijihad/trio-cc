import {
  readdirSync,
  statSync,
  renameSync,
  mkdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import { runsDir, trioDir } from "./paths.mjs";
import { readMarker } from "./marker.mjs";

const DAY_MS = 86_400_000;

export const archiveDir = (root) => join(trioDir(root), "archive");

// A symlink or junction planted at .trio/archive (or a week folder under it)
// would carry every archived run — raw event streams that quote source and
// command output — wherever it points, on a hook that runs unasked. The same
// real-path containment promote.mjs applies to promoteTo.
function insideTrio(root, dir) {
  try {
    const base = realpathSync.native(trioDir(root));
    return realpathSync.native(dir).startsWith(base + sep);
  } catch {
    return false;
  }
}

// Where an archived run went, or null. Every command that takes a run id
// resolves it under .trio/runs only, so each says this when it comes up empty
// rather than reporting a run that merely moved as one that never existed.
export function archivedRunDir(root, runId) {
  try {
    for (const week of readdirSync(archiveDir(root))) {
      const dir = join(archiveDir(root), week, runId);
      if (existsSync(dir)) return dir;
    }
  } catch {
    /* no archive yet */
  }
  return null;
}

export const archivedHint = (root, runId) => {
  const dir = archivedRunDir(root, runId);
  return dir
    ? ` It was archived to ${dir} — move it back into .trio/runs to use it.`
    : "";
};

// ISO 8601 week, e.g. 2026-W38 — the folder a run is filed under.
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Moves every run untouched for `days` into .trio/archive/<week>/. A move,
// never a delete: an archived run is one `mv` from back. Age is the run
// directory's mtime — its last new entry — so a continued run stays put, and
// the run .trio/active names is never touched however old it is.
export function archiveOldRuns(root, { days, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(days) || days < 1) return [];
  // The source is checked as well as the destination: a .trio/runs that is
  // itself a link would have this hook move whatever it points at.
  if (!insideTrio(root, runsDir(root))) return [];
  let ids;
  try {
    ids = readdirSync(runsDir(root));
  } catch {
    return [];
  }
  const active = readMarker(root)?.run ?? null;
  const moved = [];
  for (const id of ids) {
    if (id === active) continue;
    try {
      const from = join(runsDir(root), id);
      const st = statSync(from);
      if (!st.isDirectory() || now - st.mtimeMs < days * DAY_MS) continue;
      const week = join(archiveDir(root), isoWeek(st.mtime));
      if (existsSync(join(week, id))) continue;
      // Checked before the mkdir too, so a redirected archive gets nothing —
      // not even an empty week folder — and again after, for the week level.
      if (existsSync(archiveDir(root)) && !insideTrio(root, archiveDir(root)))
        return moved;
      mkdirSync(week, { recursive: true });
      if (!insideTrio(root, week)) return moved;
      renameSync(from, join(week, id));
      moved.push(id);
    } catch {
      /* a locked or vanished run stays where it is */
    }
  }
  return moved;
}
