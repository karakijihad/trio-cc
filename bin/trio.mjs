#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import {
  rmSync,
  existsSync,
  appendFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, setConfigValue } from "../src/config.mjs";
import {
  checkDrift,
  validateLens,
  probeState,
  modelsReport,
} from "../src/capabilities.mjs";
import { renderPanel, renderModelsTable } from "../src/panel.mjs";
import { startRun, continueRun } from "../src/driver.mjs";
import { finalizeRun, newRunId } from "../src/orchestrator.mjs";
import { runLens } from "../src/codex-lane.mjs";
import { start } from "../src/serve.mjs";
import {
  activeMarker,
  runDir,
  passDir,
  codexCommand,
  openUrlCommand,
} from "../src/paths.mjs";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const [cmd, ...rest] = process.argv.slice(2);
const run = (bin, args) => {
  if (bin === "codex") {
    const c = codexCommand(args);
    return spawnSync(c.file, c.args, { encoding: "utf8", ...c.opts });
  }
  return spawnSync(bin, args, { encoding: "utf8" });
};
const out = (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");

const gatherState = ({ force = false } = {}) => {
  const config = loadConfig(root);
  const { caps, pre, cached, probedAt } = probeState({ root, run, force });
  const installed = pre.state !== "not_installed";
  const drift = caps ? checkDrift(caps) : { ok: true, warnings: [] };
  return { config, pre, installed, caps, drift, cached, probedAt };
};

// D16: spawns the viewer once, at the start of the run, when the operator's
// view mode calls for one. Runs detached and with stdio ignored so a failure
// here can never block or fail the run; the "error" handlers below stop an
// unreachable spawn target from surfacing as an unhandled event later.
const beforeFirstPass = ({ runId }) => {
  try {
    const { view } = loadConfig(root);
    if (view.mode !== "pane" && view.mode !== "window") return;

    const bin = fileURLToPath(import.meta.url);
    const viewer = spawn(
      process.execPath,
      [bin, "serve", runId, "--auto-exit"],
      { detached: true, stdio: "ignore" },
    );
    viewer.on("error", () => {});
    viewer.unref();

    if (view.mode === "window" && view.autoOpen) {
      const url = `http://127.0.0.1:${view.port}/`;
      const o = openUrlCommand(url);
      const opener = spawn(o.file, o.args, {
        detached: true,
        stdio: "ignore",
        ...o.opts,
      });
      opener.on("error", () => {});
      opener.unref();
    }
  } catch {
    /* a viewer must never block or fail a run */
  }
};

const ensureGitignore = () => {
  const gi = join(root, ".gitignore");
  const body = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!/^\.trio\/$/m.test(body))
    appendFileSync(gi, `${body && !body.endsWith("\n") ? "\n" : ""}.trio/\n`);
};

switch (cmd) {
  case undefined:
  case "status":
  case "panel": {
    const s = gatherState();
    out(renderPanel(s));
    break;
  }

  case "on": {
    const config = { ...loadConfig(root), enabled: true };
    saveConfig(root, config);
    ensureGitignore();
    out(renderPanel({ ...gatherState(), config }));
    break;
  }

  case "off": {
    saveConfig(root, { ...loadConfig(root), enabled: false });
    try {
      rmSync(activeMarker(root));
    } catch {
      /* not active */
    }
    out(
      "Trio is off. It stays loaded, so I will tell you when something would have used it.",
    );
    break;
  }

  case "doctor": {
    const s = gatherState({ force: true });
    out(renderPanel(s));
    out("");
    out(run("codex", ["doctor"]).stdout ?? "");
    break;
  }

  case "config": {
    const [action, key, value] = rest;
    if (action === "get") {
      out(JSON.stringify(loadConfig(root), null, 2));
      break;
    }
    if (action !== "set" || !key) {
      out("usage: trio config get | trio config set <key> <value>");
      process.exitCode = 2;
      break;
    }
    try {
      saveConfig(root, setConfigValue(loadConfig(root), key, value));
      out(`${key} = ${value}`);
    } catch (e) {
      out(e.message);
      process.exitCode = 2;
    }
    break;
  }

  case "lens": {
    const [name, ...pairs] = rest;
    const config = loadConfig(root);
    const lens = config.codex.lenses.find((l) => l.name === name);
    if (!lens) {
      out(
        `unknown lens: ${name}. known: ${config.codex.lenses.map((l) => l.name).join(", ")}`,
      );
      process.exitCode = 2;
      break;
    }
    if (pairs[0] === "on" || pairs[0] === "off") lens.on = pairs[0] === "on";
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      if (pairs[i] === "model") lens.model = pairs[i + 1];
      if (pairs[i] === "effort") lens.effort = pairs[i + 1];
    }
    const { caps, pre } = gatherState();
    if (!caps) {
      out(`${pre.message}\n  ${pre.fix}`);
      process.exitCode = 1;
      break;
    }
    const check = validateLens(caps, lens);
    if (!check.ok) {
      out(check.error);
      process.exitCode = 2;
      break;
    }
    saveConfig(root, config);
    out(
      `${lens.name}  ${lens.model}  ${lens.effort}  ${lens.on ? "on" : "off"}`,
    );
    break;
  }

  case "models": {
    const asJson = rest.includes("--json");
    const { config, caps } = gatherState();
    const { models, lenses } = modelsReport(caps, config);
    if (!models.length) {
      out("No Codex models known yet — run /trio:doctor to probe.");
      if (asJson) process.exitCode = 1;
      break;
    }
    out(
      asJson
        ? JSON.stringify({ models, lenses }, null, 2)
        : renderModelsTable({ models, lenses }),
    );
    break;
  }

  case "serve": {
    const config = loadConfig(root);
    const runId =
      rest[0] ??
      (existsSync(activeMarker(root))
        ? JSON.parse(readFileSync(activeMarker(root), "utf8")).run
        : null);
    if (!runId) {
      out("No active run — pass a run id.");
      process.exitCode = 1;
      break;
    }
    const { url } = await start({
      runDirPath: runDir(root, runId),
      port: config.view.port,
      autoExit: rest.includes("--auto-exit"),
    });
    out(url);
    break;
  }

  case "render": {
    const runId =
      rest[0] ?? JSON.parse(readFileSync(activeMarker(root), "utf8")).run;
    const { writeStatic } = await import("../src/render-html.mjs");
    out(writeStatic(runDir(root, runId)));
    break;
  }

  case "cancel": {
    let marker = null;
    try {
      marker = JSON.parse(readFileSync(activeMarker(root), "utf8"));
    } catch {
      /* no active run */
    }
    if (!marker) {
      out("No active run.");
      break;
    }
    const runId = marker.run;
    if (!existsSync(join(runDir(root, runId), "verdict.json"))) {
      let passCount = 0;
      while (
        existsSync(join(passDir(root, runId, passCount + 1), "reconcile.json"))
      )
        passCount++;
      finalizeRun({ root, runId, verdict: "cancelled", passCount });
    }
    try {
      rmSync(activeMarker(root));
    } catch {
      /* already gone */
    }
    out("Run cancelled.");
    break;
  }

  case "run": {
    const { config, drift, pre } = gatherState({ force: true });
    if (!config.enabled) {
      out("Trio is off. Run /trio:on first.");
      process.exitCode = 1;
      break;
    }
    if (pre.state === "not_installed" || pre.state === "not_logged_in") {
      out(`${pre.message}\n  ${pre.fix}`);
      process.exitCode = 1;
      break;
    }
    if (!drift.ok) {
      out(`Refusing to start:\n  ${drift.warnings.join("\n  ")}`);
      process.exitCode = 1;
      break;
    }

    const maxFlag = rest.indexOf("--max");
    if (maxFlag !== -1) config.maxIterations = Number(rest[maxFlag + 1]);
    const target = rest.includes("--target")
      ? rest[rest.indexOf("--target") + 1]
      : root;
    const lensesFlag = rest.indexOf("--lenses");
    const lensesArg = lensesFlag !== -1 ? rest[lensesFlag + 1] : undefined;
    const lenses =
      lensesArg === "all" ? "all" : lensesArg?.split(",").filter(Boolean);

    const r = await startRun({
      root,
      config,
      target,
      runLensFn: runLens,
      beforeFirstPass,
      lenses,
    });
    if (r.status === "invalid_lenses") {
      out(r.error);
      process.exitCode = 2;
      break;
    }
    out(JSON.stringify(r, null, 2));
    break;
  }

  case "continue": {
    const r = await continueRun({ root, runLensFn: runLens });
    out(JSON.stringify(r, null, 2));
    if (r.status === "no_active_run") process.exitCode = 1;
    break;
  }

  case "consult": {
    const { config, pre } = gatherState();
    if (pre.state === "not_installed" || pre.state === "not_logged_in") {
      out(`${pre.message}\n  ${pre.fix}`);
      process.exitCode = 1;
      break;
    }
    const question = rest.join(" ");
    if (!question) {
      out("usage: trio consult <question>");
      process.exitCode = 2;
      break;
    }

    const runId = `consult-${newRunId()}`;
    const lens =
      config.codex.lenses.find((l) => l.on) ?? config.codex.lenses[0];
    mkdirSync(runDir(root, runId), { recursive: true });
    const { askCodex } = await import("../src/consult.mjs");
    const r = await askCodex({
      question,
      target: root,
      model: lens.model,
      effort: lens.effort,
      runDirPath: runDir(root, runId),
      run: runId,
    });
    out(JSON.stringify({ runId, answer: r.answer, failed: r.failed }, null, 2));
    break;
  }

  default:
    out(`unknown command: ${cmd}`);
    process.exitCode = 2;
}
