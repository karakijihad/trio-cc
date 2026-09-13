// Helpers shared by every bin/trio.mjs command module. Each command receives
// a context object built from these in bin/trio.mjs; nothing here is command
// specific.
import { spawnSync, spawn } from "node:child_process";
import { existsSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, consultSettings } from "../config.mjs";
import { checkDrift, probeState } from "../capabilities.mjs";
import { releaseOwnClaim } from "../driver.mjs";
import { stopAllLenses } from "../codex-lane.mjs";
import { ping } from "../ping.mjs";
import { runDir, codexCommand, openUrlCommand, isRunId } from "../paths.mjs";
import { readMarker } from "../marker.mjs";

// codexCommand throws when Codex cannot be invoked safely (win32 with no
// resolvable entry point). That is a "Codex is not usable here" answer, not a
// crash: every caller of this helper already reads a spawnSync-shaped result
// and treats a non-zero status as not-installed, so shape it that way.
export const run = (bin, args) => {
  if (bin === "codex") {
    let c;
    try {
      c = codexCommand(args);
    } catch (err) {
      return { status: 127, stdout: "", stderr: err.message, error: err };
    }
    return spawnSync(c.file, c.args, { encoding: "utf8", ...c.opts });
  }
  return spawnSync(bin, args, { encoding: "utf8" });
};

export const out = (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");

// The one "can Codex be used right now" check, shared by run and consult.
// preflight sees installed and logged in; only a real call sees a spent quota.
// Returns the codexUnavailable block when Codex refused for a reason that will
// not clear, and null otherwise — anything the ping cannot read proceeds.
export const unavailable = (failure) => ({
  available: false,
  kind: failure.kind,
  message: failure.message,
  fix: failure.fix,
});
export const codexRefusal = (target) => {
  const probe = ping({ target });
  return probe.ok === false ? unavailable(probe.failure) : null;
};

export const gatherState = (root, { force = false } = {}) => {
  const config = loadConfig(root);
  const { caps, pre, cached, probedAt } = probeState({ root, run, force });
  const installed = pre.state !== "not_installed";
  const drift = caps ? checkDrift(caps) : { ok: true, warnings: [] };
  return {
    config,
    consult: consultSettings(config),
    pre,
    installed,
    caps,
    drift,
    cached,
    probedAt,
  };
};

// D16: spawns the viewer once, at the start of the run, when the operator's
// view mode calls for one. Runs detached and with stdio ignored so a failure
// here can never block or fail the run; the "error" handlers below stop an
// unreachable spawn target from surfacing as an unhandled event later.
// Resolves with the viewer's first line of stdout — the URL it actually
// bound — or null if it does not arrive in time. The server silently walks
// forward from the configured port when one is taken, so the configured port
// is a request, not an answer, and only the server knows which it got.
export const firstLine = (stream, ms) =>
  new Promise((resolve) => {
    let buf = "";
    const finish = (v) => {
      clearTimeout(timer);
      stream.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), ms);
    timer.unref?.();
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) finish(buf.slice(0, nl).trim() || null);
    });
    stream.on("error", () => finish(null));
    stream.on("end", () => finish(buf.trim() || null));
  });

// `bin` is bin/trio.mjs's own path (`fileURLToPath(import.meta.url)` taken
// there, where import.meta.url still points at bin/trio.mjs) — the viewer
// child must launch through that same entry point, not this module's.
export const beforeFirstPass = async (root, bin, { runId }) => {
  try {
    const { view } = loadConfig(root);
    if (view.mode !== "pane" && view.mode !== "window") return;

    const wantsBrowser = view.mode === "window" && view.autoOpen;
    // Always piped now. The server walks forward from the configured port
    // when it is taken, so only the server knows which one it got — and in
    // pane mode nothing opened it and nothing printed it, leaving a viewer
    // running on a port the operator had no way to discover.
    const viewer = spawn(
      process.execPath,
      [bin, "serve", runId, "--auto-exit"],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    viewer.on("error", () => {});
    viewer.unref();

    const url = await firstLine(viewer.stdout, 10_000);
    if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) return;

    // stderr, not stdout: `run` prints a JSON result its callers parse.
    if (!wantsBrowser) {
      process.stderr.write(`Viewer: ${url}\n`);
      return;
    }

    const o = openUrlCommand(url);
    const opener = spawn(o.file, o.args, {
      detached: true,
      stdio: "ignore",
      ...o.opts,
    });
    opener.on("error", () => {});
    opener.unref();
  } catch {
    /* a viewer must never block or fail a run */
  }
};

// The run named by .trio/active, or null. Every reader of that file goes
// through here: it is operator-writable state, so `run` is only returned when
// it is shaped like an id Trio actually minted.
export const activeRun = (root) => {
  const held = readMarker(root);
  return held && isRunId(held.run) ? held.run : null;
};

// Newest run directory that reached a verdict — what `trio promote` defaults
// to once the marker is gone, which it always is after a run finishes.
export const latestFinishedRun = (root) => {
  try {
    return (
      readdirSync(join(root, ".trio", "runs"))
        .filter((id) =>
          existsSync(join(runDir(root, id), "verdict.json")),
        )
        .sort()
        .pop() ?? null
    );
  } catch {
    return null;
  }
};

// .trio/ holds raw event streams that quote source and command output, so it
// belongs in .gitignore — but only where there is a checkout to ignore it in.
// Trio's root is wherever it was invoked, which is not always a repo.
// `trio cancel` stops the worker process. Node does not cascade a signal to
// children, and off win32 the tree-killer is a no-op, so without this the
// lenses a worker spawned outlive the run that owns them. Every command that
// spawns lenses needs it — `continue` runs them exactly as `run` does.
export const stopLensesOnSignal = (root) => {
  const stop = () => {
    stopAllLenses();
    try {
      releaseOwnClaim({ root });
    } catch {
      /* best effort — a signal must still stop the process */
    }
    process.exit(1);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
};

export const ensureGitignore = (root) => {
  if (!existsSync(join(root, ".git"))) return;
  const gi = join(root, ".gitignore");
  const body = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!/^\.trio\/$/m.test(body))
    appendFileSync(gi, `${body && !body.endsWith("\n") ? "\n" : ""}.trio/\n`);
};
