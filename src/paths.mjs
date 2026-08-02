import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { existsSync } from "node:fs";

export const codexHome = () =>
  process.env.CODEX_HOME ?? join(homedir(), ".codex");
export const trioDir = (root) => join(root, ".trio");
export const runsDir = (root) => join(trioDir(root), "runs");
export const runDir = (root, runId) => join(runsDir(root), runId);

// Run ids are minted by newRunId: an ISO timestamp to the second with the
// colons replaced, optionally suffixed for a same-second collision and
// optionally prefixed for a consult. Anything else did not come from Trio,
// and a runId reaches path.join — `../../..` is how a crafted one escapes
// .trio/runs and writes live.html wherever it likes.
const RUN_ID = /^(?:consult-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;
export const isRunId = (v) => typeof v === "string" && RUN_ID.test(v);
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

// Stopping a lens means stopping the tree, not the process Trio spawned.
// On win32 codexCommand spawns node.exe running Codex's JS shim, and that
// shim spawns the native binary as its own child, forwarding SIGTERM to it
// from a JS handler. Node's kill() on Windows is TerminateProcess, which no
// handler survives — so killing the shim orphans the native process, still
// working and still spending. taskkill /t takes the whole tree. On POSIX the
// shim receives a real signal and forwards it itself, so kill() is enough.
export function killTreeCommand(pid) {
  if (process.platform !== "win32" || !pid) return null;
  return { file: "taskkill", args: ["/pid", String(pid), "/t", "/f"] };
}

// Is this pid plausibly a Trio worker? `.trio/active` is an ordinary file in
// the project, so its pid is attacker-influencable and `cancel` signals it.
//
// Deliberately three-valued and fail-open on "cannot tell": returning false
// on a lookup that simply was not available would break cancelling a real
// run, and a run whose signal is withheld keeps its lenses spending until it
// notices the cancel token — up to a lens deadline. Only a positive
// identification of something that is *not* ours stops the signal.
//
// That policy is only ever as good as the identification behind it, and on
// win32 the identification was `tasklist`, which reports the image name and
// nothing more. Every node.exe on the machine answered to "is this Trio", so
// a forged marker naming any live node pid got that pid's whole tree killed
// by `trio cancel` — fail-open was never reached, because the weak check
// returned a confident, wrong `true`. The command line is what actually
// separates one node process from another, and CIM is how win32 gives it up.
//
// A lookup that fails still reads as "cannot tell" rather than falling back
// to the image name: that fallback is the hole, not a safety net.
export function processIsTrio(pid, run) {
  // This is interpolated into a CIM filter string below, so it has to be a
  // number before it goes anywhere near one. A pid that is not one identifies
  // nothing, and nothing is what should be killed on its say-so.
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const cmd =
    process.platform === "win32"
      ? {
          file: "powershell",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ],
        }
      : { file: "ps", args: ["-o", "args=", "-p", String(pid)] };
  let out;
  try {
    const r = run(cmd.file, cmd.args);
    if (!r || r.status !== 0) return null;
    out = String(r.stdout ?? "").trim();
  } catch {
    return null;
  }
  // CIM prints nothing for a pid it cannot find — a process that exited
  // between the marker being read and this lookup reads as "cannot tell".
  if (!out || /^INFO:/i.test(out)) return null;
  // One test on both platforms now, because both are finally looking at the
  // same thing: the command line the process was started with.
  return /trio(\.mjs)?\b/.test(out);
}

// The OS default-browser launcher for a URL. cmd.exe here follows the D2a
// precedent: Node has no built-in opener and this is the platform mechanism.
export function openUrlCommand(url) {
  if (process.platform === "win32")
    return { file: "cmd.exe", args: ["/c", "start", "", url] };
  if (process.platform === "darwin") return { file: "open", args: [url] };
  return { file: "xdg-open", args: [url] };
}
