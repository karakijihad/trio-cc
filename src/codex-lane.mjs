import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { makeEvent, appendEvent } from "./bus.mjs";
import { extractFindings } from "./findings.mjs";
import { classifyFailure } from "./failure.mjs";
import { codexCommand, killTreeCommand } from "./paths.mjs";

export const SANDBOX = "read-only";

const STRICTER =
  '\n\nYour previous reply omitted or malformed the required block. Reply again and end your message with exactly one fenced ```json block of the shape {"findings":[...]}, and nothing after it.';

// The single place any Codex invocation is assembled — audit lenses and
// consults alike. Two copies of this list drifted apart once already.
export function buildArgs({ target, model, effort }) {
  return [
    "exec",
    "--json",
    "--sandbox",
    SANDBOX,
    "--skip-git-repo-check",
    "--cd",
    target,
    // Long forms deliberately: these are the flags the drift guard probes for
    // in `codex exec --help`, and guard and invocation must not diverge.
    //
    // No model means no `--model`, so Codex picks its own current default.
    // Passing the flag with an empty value is not the same thing — it is an
    // argument error, and it would turn "the operator never chose a model"
    // into a failed lens.
    ...(model ? ["--model", model] : []),
    "--config",
    `model_reasoning_effort=${effort}`,
  ];
}

export function mapEvent(ev) {
  if (ev.type === "turn.completed")
    return { kind: "usage", payload: ev.usage ?? {} };
  if (ev.type === "error")
    return { kind: "error", payload: { error: ev.message ?? "codex error" } };
  if (ev.type !== "item.completed" && ev.type !== "item.started") return null;

  const item = ev.item ?? {};
  if (item.type === "agent_message")
    return { kind: "agent_message", payload: { text: item.text ?? "" } };
  if (item.type === "reasoning")
    return { kind: "reasoning", payload: { text: item.text ?? "" } };
  if (item.type === "command_execution") {
    return {
      kind: "command_execution",
      payload: {
        command: item.command ?? "",
        output: item.aggregated_output ?? "",
        exit_code: item.exit_code ?? null,
        status: item.status ?? "",
      },
    };
  }
  if (item.type === "file_change")
    return {
      kind: "file_change",
      payload: { file: item.path ?? "", diff: item.diff ?? "" },
    };
  return null;
}

// Mirrors DEFAULT_CONFIG.codex.timeoutMinutes, for callers that reach runLens
// without a config in hand. runPass always passes the operator's value.
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;

// Lenses currently running in this process. `trio cancel` signals the worker,
// and off win32 that signal reaches the worker alone: killTreeCommand is a
// no-op there, Node installs no default cascade, and lens children are not in
// their own process group. Without this registry a cancelled run on macOS or
// Linux leaves every Codex child alive and spending.
const live = new Set();

export function stopAllLenses() {
  for (const proc of live) killTree(proc);
}

// Falls back to kill() whenever the tree-killer is unavailable or refuses to
// launch: a lens that will not die is worse than one killed imprecisely, and
// either way the settle promise below needs the pipes to close.
export function killTree(proc, spawnFn = nodeSpawn) {
  const cmd = killTreeCommand(proc.pid);
  const direct = () => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  };
  if (!cmd) return direct();
  try {
    spawnFn(cmd.file, cmd.args, { stdio: "ignore" }).on("error", direct);
  } catch {
    direct();
  }
}

export async function runLens({
  lens,
  target,
  brief,
  runDirPath,
  run,
  pass,
  spawnFn = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retried = false,
  retriedFailure = false,
}) {
  const lane = `codex:${lens.name}`;
  const cmd = codexCommand(
    buildArgs({ target, model: lens.model, effort: lens.effort }),
  );
  const proc = spawnFn(cmd.file, cmd.args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...cmd.opts,
  });

  // A launch failure (ENOENT, EACCES) arrives as an 'error' event, which Node
  // throws as an uncaught exception if nothing is listening — killing the whole
  // audit process. Record it and let this lens settle as failed instead.
  live.add(proc);
  let launchError = null;
  proc.on("error", (err) => {
    launchError = err;
  });

  // Nothing else bounds a Codex process: the settle promise below waits on
  // 'close', so a lens that stops producing output waits forever and the run
  // with it. Not unref'd — the timer has to survive to fire, and it is
  // cleared the moment the process settles on its own.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    killTree(proc);
  }, timeoutMs);
  proc.stdin?.on?.("error", () => {
    /* the child never started; the close handler reports it */
  });

  try {
    proc.stdin.write(retried ? brief + STRICTER : brief);
    proc.stdin.end();
  } catch {
    /* same */
  }

  let threadId = null;
  const messages = [];

  // Why a failure happened is never in `messages`: a lens that dies has no
  // final message. It is in the JSON error events, or on stderr, and which
  // one carries it depends on how far Codex got — so both are kept, and
  // capped, because this is diagnostic text of unbounded length that only
  // ever gets pattern-matched.
  const DIAGNOSTIC_CAP = 16_384;
  let diagnostics = "";
  const note = (text) => {
    if (diagnostics.length >= DIAGNOSTIC_CAP) return;
    diagnostics += String(text ?? "").slice(0, DIAGNOSTIC_CAP - diagnostics.length);
  };
  // stderr was piped and never read. Beyond losing the one place the cause is
  // reliably written, an unread pipe is a pipe that can fill: a lens failing
  // verbosely could block on a full buffer and then be killed by the deadline
  // as though it had hung.
  proc.stderr?.on?.("data", (chunk) => note(`\n${chunk}`));
  proc.stderr?.on?.("error", () => {
    /* the close handler reports it */
  });

  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "thread.started") threadId = ev.thread_id;

    const mapped = mapEvent(ev);
    if (!mapped) return;
    if (mapped.kind === "agent_message") messages.push(mapped.payload.text);
    if (mapped.kind === "error") note(`\n${mapped.payload.error}`);
    appendEvent(
      runDirPath,
      makeEvent({ run, pass, lane, actor: "codex", ...mapped }),
    );
  });

  // Settles on whichever comes first: a normal close, or a launch that never
  // produced a process at all.
  const code = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    proc.on("close", done);
    proc.on("error", () => done(null));
  });
  clearTimeout(deadline);
  live.delete(proc);
  const raw = messages.join("\n");

  // Before the exit-code check, and before the retry: killing the process is
  // what made the code non-zero, so reporting "codex exited null" here would
  // bury the only fact that matters, and a hang must not be retried into a
  // second hang.
  if (timedOut) {
    appendEvent(
      runDirPath,
      makeEvent({
        run,
        pass,
        lane,
        actor: "codex",
        kind: "error",
        payload: {
          error: `codex timed out after ${Math.round(timeoutMs / 60_000)}m and was stopped — raise codex.timeoutMinutes if this lens legitimately needs longer`,
        },
      }),
    );
    return { lens: lens.name, status: "timeout", findings: [], threadId, raw };
  }

  if (launchError) {
    appendEvent(
      runDirPath,
      makeEvent({
        run,
        pass,
        lane,
        actor: "codex",
        kind: "error",
        payload: { error: `codex failed to start: ${launchError.message}` },
      }),
    );
    return {
      lens: lens.name,
      status: "failed",
      findings: [],
      threadId,
      raw,
      failure: classifyFailure(`${launchError.message}\n${diagnostics}`),
    };
  }

  if (code !== 0) {
    const failure = classifyFailure(diagnostics);

    // A transient fault is worth one more attempt and nothing more. The
    // second attempt is not "stricter" — that retry is for a lens that
    // answered badly, and this one never answered at all, so the brief goes
    // out unchanged.
    if (failure.retryable && !retriedFailure) {
      appendEvent(
        runDirPath,
        makeEvent({
          run,
          pass,
          lane,
          actor: "codex",
          kind: "lens_retry",
          payload: {
            error: `${failure.message} (${failure.kind}) — running this lens once more`,
          },
        }),
      );
      return runLens({
        lens,
        target,
        brief,
        runDirPath,
        run,
        pass,
        spawnFn,
        timeoutMs,
        retried,
        retriedFailure: true,
      });
    }

    appendEvent(
      runDirPath,
      makeEvent({
        run,
        pass,
        lane,
        actor: "codex",
        kind: "error",
        // The exit code alone was the whole message for every failure there
        // is. It stays — it is the fact — but it no longer stands alone.
        payload: {
          error: `codex exited ${code}: ${failure.message}`,
          kind: failure.kind,
        },
      }),
    );
    return {
      lens: lens.name,
      status: "failed",
      findings: [],
      threadId,
      raw,
      failure,
    };
  }

  const parsed = extractFindings(raw);
  if (parsed.ok)
    return {
      lens: lens.name,
      status: "ok",
      findings: parsed.findings,
      threadId,
      raw,
    };

  // The retry is a second full Codex session — the single largest thing that
  // can double a lens's wall-clock time. It used to happen silently, so a
  // three-minute lens was indistinguishable from a slow one. Say so.
  if (!retried) {
    appendEvent(
      runDirPath,
      makeEvent({
        run,
        pass,
        lane,
        actor: "codex",
        kind: "lens_retry",
        payload: {
          error: `findings block ${parsed.reason} — running this lens once more`,
        },
      }),
    );
    return runLens({
      lens,
      target,
      brief,
      runDirPath,
      run,
      pass,
      spawnFn,
      timeoutMs,
      retried: true,
      // Carried, not reset: the two retries answer different faults and a
      // lens must not earn a fresh transient retry by failing a second way.
      retriedFailure,
    });
  }
  appendEvent(
    runDirPath,
    makeEvent({
      run,
      pass,
      lane,
      actor: "codex",
      kind: "error",
      payload: { error: `unparseable: ${parsed.reason}` },
    }),
  );
  return {
    lens: lens.name,
    status: "unparseable",
    findings: [],
    threadId,
    raw,
  };
}
