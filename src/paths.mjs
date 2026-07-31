import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { existsSync } from "node:fs";

export const codexHome = () =>
  process.env.CODEX_HOME ?? join(homedir(), ".codex");
export const trioDir = (root) => join(root, ".trio");
export const runsDir = (root) => join(trioDir(root), "runs");
export const runDir = (root, runId) => join(runsDir(root), runId);
export const passDir = (root, runId, pass) =>
  join(runDir(root, runId), `pass-${pass}`);
export const activeMarker = (root) => join(trioDir(root), "active");
export const configPath = (root) => join(trioDir(root), "config.json");
export const capabilitiesPath = (root) =>
  join(trioDir(root), "capabilities.json");

// npm installs the CLI as `codex.cmd`, a batch file Node will not spawn without
// a shell. Its sibling JS entry point can be spawned directly.
export function resolveCodexScript(pathEnv = process.env.PATH ?? "") {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    if (!existsSync(join(dir, "codex.cmd"))) continue;
    const js = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(js)) return js;
  }
  return null;
}

// One place that decides how Codex is invoked. Every caller spawns
// `file` with `args` and spreads `opts` — nothing else branches on platform.
//
// Fails closed on win32 rather than falling back to `shell: true`: that
// fallback ran the arguments through cmd.exe, where an audit target carrying
// `&` or `|` would have been read as a command separator.
export function codexCommand(args) {
  if (process.platform !== "win32") return { file: "codex", args, opts: {} };
  const js = resolveCodexScript();
  if (js) return { file: process.execPath, args: [js, ...args], opts: {} };
  throw new Error(
    "cannot locate the Codex JavaScript entry point beside codex.cmd on PATH — " +
      "reinstall with `npm i -g @openai/codex`",
  );
}

// The OS default-browser launcher for a URL. cmd.exe here follows the D2a
// precedent: Node has no built-in opener and this is the platform mechanism.
export function openUrlCommand(url) {
  if (process.platform === "win32")
    return { file: "cmd.exe", args: ["/c", "start", "", url] };
  if (process.platform === "darwin") return { file: "open", args: [url] };
  return { file: "xdg-open", args: [url] };
}
