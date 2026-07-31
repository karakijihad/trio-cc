import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "./bus.mjs";

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function line(ev) {
  const p = ev.payload ?? {};
  if (ev.kind === "agent_message" || ev.kind === "reasoning")
    return esc(p.text);
  if (ev.kind === "command_execution") {
    const code =
      p.exit_code === null || p.exit_code === undefined
        ? ""
        : `  exit ${p.exit_code}`;
    return `$ ${esc(p.command)}${esc(code)}`;
  }
  if (ev.kind === "file_change")
    return ev.actor === "claude"
      ? `✎ ${esc(p.file)}`
      : `${esc(p.file)}\n${esc(p.diff)}`;
  if (ev.kind === "usage")
    return `${esc(p.input_tokens ?? 0)} in / ${esc(p.output_tokens ?? 0)} out`;
  return `${esc(ev.kind)} ${esc(p.error ?? p.tool ?? p.agent_type ?? "")}`;
}

export function renderStatic(runDirPath, { refreshSeconds = 2 } = {}) {
  const events = readEvents(runDirPath);
  const lanes = new Map();
  for (const ev of events) {
    if (!lanes.has(ev.lane)) lanes.set(ev.lane, []);
    lanes.get(ev.lane).push(ev);
  }
  const columns = [...lanes.entries()]
    .map(
      ([lane, list]) =>
        `<section><h2>${esc(lane)}</h2>${list.map((e) => `<pre>${line(e)}</pre>`).join("")}</section>`,
    )
    .join("");

  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${refreshSeconds}">
<title>Trio</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:13px/1.5 ui-monospace,Menlo,monospace}
#l{display:flex;gap:1px;background:#8883;min-height:100vh}
section{flex:1;min-width:320px;background:Canvas;padding:0 10px}
h2{font-size:12px;opacity:.6;position:sticky;top:0;background:Canvas;margin:0;padding:6px 0}
pre{margin:0 0 8px;white-space:pre-wrap;word-break:break-word}
</style>
<div id="l">${columns || "<section><h2>no events yet</h2></section>"}</div>
`;
}

export function writeStatic(runDirPath, opts) {
  const target = join(runDirPath, "live.html");
  writeFileSync(target, renderStatic(runDirPath, opts));
  return target;
}
