import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Real-Codex smoke tests. These deliberately invoke the operator's installed,
// logged-in Codex CLI, so they cost real tokens and cannot run on a clean
// checkout — they stay opt-in behind TRIO_E2E=1. Deterministic coverage of the
// same CLI paths, against a fake Codex, lives in tests/cli-run.test.mjs and
// runs by default.
const ENABLED = process.env.TRIO_E2E === "1";
const CLI = fileURLToPath(new URL("../bin/trio.mjs", import.meta.url));

test(
  "smoke (real Codex): one lens audits a tiny repo and produces a verdict",
  { skip: !ENABLED && "set TRIO_E2E=1 to run" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "trio-e2e-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "Docs", "Audit"), { recursive: true });
    writeFileSync(
      join(root, "src", "app.js"),
      "export function add(a, b) { return a - b; }\n",
    );

    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    spawnSync("node", [CLI, "on"], { env, encoding: "utf8" });
    spawnSync("node", [CLI, "config", "set", "view.mode", "off"], {
      env,
      encoding: "utf8",
    });
    spawnSync("node", [CLI, "config", "set", "maxIterations", "1"], {
      env,
      encoding: "utf8",
    });
    // Pin the lens set rather than relying on which lenses ship enabled:
    // every extra lens is another real Codex process on the operator's
    // account, and a smoke test only needs one to prove the loop closes.
    const res = spawnSync("node", [CLI, "run", "--lenses", "auditor"], {
      env,
      encoding: "utf8",
      timeout: 600000,
    });
    assert.equal(res.status, 0, res.stderr);

    const { runId, verdict, promoted } = JSON.parse(res.stdout);
    assert.ok(["clean", "ceiling_reached"].includes(verdict));
    assert.ok(existsSync(join(root, ".trio", "runs", runId, "events.jsonl")));
    assert.ok(existsSync(join(root, ".trio", "runs", runId, "verdict.json")));
    assert.ok(promoted && existsSync(promoted.codexPath));
    assert.match(readFileSync(promoted.codexPath, "utf8"), /## Findings/);
  },
);

test(
  "smoke (real Codex): the active marker is always removed after a run",
  { skip: !ENABLED && "set TRIO_E2E=1 to run" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "trio-e2e2-"));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    spawnSync("node", [CLI, "on"], { env, encoding: "utf8" });
    spawnSync("node", [CLI, "config", "set", "view.mode", "off"], {
      env,
      encoding: "utf8",
    });
    spawnSync("node", [CLI, "config", "set", "maxIterations", "1"], {
      env,
      encoding: "utf8",
    });
    // The run has to actually happen for the assertion below to mean
    // anything: a run that never started leaves no marker either, which used
    // to pass this test while proving nothing.
    const res = spawnSync("node", [CLI, "run", "--lenses", "auditor"], {
      env,
      encoding: "utf8",
      timeout: 600000,
    });
    assert.equal(res.status, 0, res.stderr);
    const { runId } = JSON.parse(res.stdout);
    assert.ok(existsSync(join(root, ".trio", "runs", runId, "verdict.json")));
    assert.equal(existsSync(join(root, ".trio", "active")), false);
  },
);
