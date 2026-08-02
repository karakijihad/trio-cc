import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatic, writeStatic } from "../src/render-html.mjs";
import { appendEvent, makeEvent } from "../src/bus.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-html-"));
const seed = (dir, lane, kind, payload) =>
  appendEvent(
    dir,
    makeEvent({ run: "r", pass: 1, lane, actor: "codex", kind, payload }),
  );

test("renders a self-contained document with no external references", () => {
  const dir = tmp();
  seed(dir, "codex:auditor", "agent_message", { text: "looking" });
  const html = renderStatic(dir);
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /src=["']http/i);
  assert.doesNotMatch(html, /href=["']http/i);
});

test("includes a meta refresh so the file updates itself", () => {
  const html = renderStatic(tmp());
  assert.match(html, /http-equiv=["']refresh["']/i);
});

// The meta refresh above puts every scroll box back at the top, so the tail
// has to be re-pinned on each load or the view shows only the oldest events.
test("each lane column is its own scroll box, pinned to the newest event", () => {
  const dir = tmp();
  seed(dir, "codex:auditor", "agent_message", { text: "alpha" });
  const html = renderStatic(dir);
  assert.match(html, /section\{[^}]*overflow-y:\s*auto/);
  assert.match(html, /data-lane="codex:auditor"/);
  assert.match(html, /scrollTop\s*=[\s\S]*scrollHeight/);
});

test("the scroll offset is keyed by lane, not by column position", () => {
  const dir = tmp();
  seed(dir, "codex:auditor", "agent_message", { text: "alpha" });
  seed(dir, "claude:main", "agent_message", { text: "beta" });
  const html = renderStatic(dir);
  assert.match(html, /"trio-scroll-"\s*\+\s*\(?s\.dataset\.lane/);
});

test("groups events into one section per lane", () => {
  const dir = tmp();
  seed(dir, "codex:auditor", "agent_message", { text: "alpha" });
  seed(dir, "claude:main", "agent_message", { text: "beta" });
  const html = renderStatic(dir);
  assert.match(html, /codex:auditor/);
  assert.match(html, /claude:main/);
  assert.match(html, /alpha/);
  assert.match(html, /beta/);
});

test("escapes html in event payloads", () => {
  const dir = tmp();
  seed(dir, "claude:main", "agent_message", {
    text: '<img src=x onerror="alert(1)">',
  });
  const html = renderStatic(dir);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test("renders an empty log without throwing", () => {
  assert.match(renderStatic(tmp()), /<!doctype html>/i);
});

test("writeStatic puts live.html inside the run directory", () => {
  const dir = tmp();
  seed(dir, "claude:main", "agent_message", { text: "x" });
  const p = writeStatic(dir);
  assert.equal(p, join(dir, "live.html"));
  assert.ok(existsSync(p));
  assert.match(readFileSync(p, "utf8"), /<!doctype html>/i);
});

test("escapes the usage branch like every other kind", () => {
  const dir = tmp();
  seed(dir, "codex:auditor", "usage", { input_tokens: "<img src=x>", output_tokens: 2 });
  const html = renderStatic(dir);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test("claude file_change renders as a file line without diff body", () => {
  const dir = tmp();
  appendEvent(
    dir,
    makeEvent({
      run: "r",
      pass: 1,
      lane: "claude:main",
      actor: "claude",
      kind: "file_change",
      payload: {
        file: "src/a.js",
        diff: "@@ -1,2 +1,2 @@\n-old line\n+new line",
      },
    }),
  );
  const html = renderStatic(dir);
  assert.match(html, /src\/a\.js/);
  assert.doesNotMatch(html, /old line/);
  assert.doesNotMatch(html, /new line/);
});

test("non-claude file_change still renders the diff body", () => {
  const dir = tmp();
  appendEvent(
    dir,
    makeEvent({
      run: "r",
      pass: 1,
      lane: "codex:auditor",
      actor: "codex",
      kind: "file_change",
      payload: { file: "src/b.js", diff: "+new line" },
    }),
  );
  const html = renderStatic(dir);
  assert.match(html, /src\/b\.js/);
  assert.match(html, /new line/);
});

// Which time round the loop an event belongs to changes what it means: a
// finding in pass 3 is one that survived two fix waves.
test("marks where each pass begins, once per lane", () => {
  const dir = tmp();
  const at = (lane, pass, text) =>
    appendEvent(
      dir,
      makeEvent({ run: "r", pass, lane, actor: "codex", kind: "agent_message", payload: { text } }),
    );
  at("codex:auditor", 1, "first look");
  at("codex:auditor", 1, "still looking");
  at("codex:auditor", 2, "second look");
  const html = renderStatic(dir);
  assert.equal(html.match(/class="pass">pass 1</g).length, 1);
  assert.equal(html.match(/class="pass">pass 2</g).length, 1);
  assert.ok(html.indexOf("pass 1") < html.indexOf("first look"));
  assert.ok(html.indexOf("second look") > html.indexOf("pass 2"));
});

// The hook stamps events with pass 0 while a start holds the lock but has not
// numbered its first pass. Real, but not a pass to label.
test("pass 0 gets no rule", () => {
  const dir = tmp();
  appendEvent(
    dir,
    makeEvent({ run: "r", pass: 0, lane: "claude:main", actor: "claude", kind: "agent_message", payload: { text: "early" } }),
  );
  const html = renderStatic(dir);
  assert.doesNotMatch(html, /class="pass">pass 0</);
  assert.match(html, /early/);
});
