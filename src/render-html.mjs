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
    .map(([lane, list]) => {
      // Where one pass ends and the next begins. Pass 0 is the window where a
      // start holds the lock but has not numbered its first pass yet — real,
      // but not a pass to label.
      let seen = null;
      const body = list
        .map((e) => {
          const p = Number.isFinite(e.pass) && e.pass > 0 ? e.pass : null;
          const rule =
            p !== null && p !== seen ? `<p class="pass">pass ${p}</p>` : "";
          if (p !== null) seen = p;
          return `${rule}<pre>${line(e)}</pre>`;
        })
        .join("");
      return `<section data-lane="${esc(lane)}"><h2>${esc(lane)}</h2>${body}</section>`;
    })
    .join("");

  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${refreshSeconds}">
<title>Trio</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:13px/1.5 ui-monospace,Menlo,monospace;height:100vh;overflow:hidden}
#l{display:flex;gap:1px;background:#8883;height:100vh}
section{flex:1;min-width:320px;background:Canvas;padding:0 10px;overflow-y:auto;overflow-anchor:none}
h2{font-size:12px;opacity:.6;position:sticky;top:0;background:Canvas;margin:0;padding:6px 0}
pre{margin:0 0 8px;white-space:pre-wrap;word-break:break-word}
p.pass{margin:14px 0 10px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;opacity:.5;border-bottom:1px solid #8883;padding-bottom:4px}
</style>
<div id="l">${columns || "<section><h2>no events yet</h2></section>"}</div>
<script>
// This page reloads itself every few seconds, and a reload puts every scroll
// box back at the top — so without this the static view is pinned to the
// oldest events for the whole run. Each column re-pins to its newest event on
// load. The one thing that has to survive a refresh is a reader who scrolled
// up deliberately, which is why the offset rides in sessionStorage, keyed by
// lane rather than position: lanes appear as agents start, and an index would
// hand column 2's offset to whatever lane later took that slot.
(function () {
  var mem = null;
  try {
    mem = window.sessionStorage;
  } catch (e) {
    /* file:// with storage denied — follow the tail and forget nothing */
  }
  var END = "end";
  var sections = document.querySelectorAll("#l section");
  for (var i = 0; i < sections.length; i++)
    (function (s) {
      var key = "trio-scroll-" + (s.dataset.lane || "");
      var saved = mem && mem.getItem(key);
      s.scrollTop =
        saved === null || saved === undefined || saved === END
          ? s.scrollHeight
          : Number(saved);
      s.addEventListener("scroll", function () {
        if (!mem) return;
        var atEnd = s.scrollHeight - s.scrollTop - s.clientHeight < 40;
        try {
          mem.setItem(key, atEnd ? END : String(s.scrollTop));
        } catch (e) {
          /* quota or denial — the tail is still the default next load */
        }
      });
    })(sections[i]);
})();
</script>
`;
}

export function writeStatic(runDirPath, opts) {
  const target = join(runDirPath, "live.html");
  writeFileSync(target, renderStatic(runDirPath, opts));
  return target;
}
