import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
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
