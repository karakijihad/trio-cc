import { readdirSync, statSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runsDir, trioDir } from "./paths.mjs";
import { readMarker } from "./marker.mjs";

const DAY_MS = 86_400_000;

export const archiveDir = (root) => join(trioDir(root), "archive");

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
      mkdirSync(week, { recursive: true });
      renameSync(from, join(week, id));
      moved.push(id);
    } catch {
      /* a locked or vanished run stays where it is */
    }
  }
  return moved;
}
