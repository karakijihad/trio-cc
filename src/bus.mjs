import {
  appendFileSync,
  readFileSync,
  mkdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { scrubDeep } from "./scrub.mjs";

export const eventsFile = (dir) => join(dir, "events.jsonl");

export function makeEvent({ run, pass, lane, actor, kind, payload = {} }) {
  return {
    ts: new Date().toISOString(),
    run,
    pass,
    lane,
    actor,
    kind,
    payload: scrubDeep(payload),
  };
}

export function appendEvent(dir, event) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(eventsFile(dir), JSON.stringify(event) + "\n");
}

export function readEvents(dir) {
  let raw;
  try {
    raw = readFileSync(eventsFile(dir), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// Incremental counterpart to readEvents, for a viewer that re-reads on a
// timer or an fs.watch tick: a 469-event, 3.2 MB log re-read and re-parsed
// whole on every tick, per client, is the churn this exists to avoid. Reads
// only the bytes appended since `offset` (a positional read, not a seek from
// the start) and parses only complete lines — a line with no trailing "\n"
// yet is a write in progress and is held back untouched, to be completed and
// parsed on a later call. Returns the byte offset to pass in next time.
//
// A file shorter than `offset` was truncated or replaced out from under the
// reader (a new run reusing the path, or a rotation) — there is no offset
// into it that means anything, so this restarts from byte 0 rather than
// throwing or returning nothing forever.
export function readEventsFrom(dir, offset = 0) {
  const file = eventsFile(dir);
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return { events: [], offset: 0 };
  }
  if (size < offset) offset = 0;
  if (size === offset) return { events: [], offset };

  const length = size - offset;
  const buf = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, length, offset);
  } finally {
    closeSync(fd);
  }

  const text = buf.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { events: [], offset }; // partial line only

  const complete = text.slice(0, lastNewline);
  const consumed = Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
  // `ends[i]` is the byte offset just past events[i]'s line. A stream that
  // tags each event with one shared batch offset lets a client that dropped
  // mid-batch resume past events it never received; per-event ends do not.
  const events = [];
  const ends = [];
  let pos = offset;
  for (const line of complete.split("\n")) {
    pos += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
      ends.push(pos);
    } catch {
      /* skip malformed */
    }
  }
  return { events, ends, offset: offset + consumed };
}
