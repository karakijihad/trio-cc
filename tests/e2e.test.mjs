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

const run = (env, args) =>
  spawnSync("node", [CLI, ...args], { env, encoding: "utf8", timeout: 600000 });

// The last pass a run's budget allows parks for adjudication like every other
// pass (D17/D18) — `run --max 1` (set here via maxIterations) no longer
// finalizes inside the first invocation. It comes back `awaiting_response`
// with `final: true`, and settling it is a separate, explicit hand-off:
// adjudicate with `trio verdicts`, hand back Claude's reply as response.json,
// then `continue`. Mirrors what tests/cli-run.test.mjs does against the fake
// Codex (see its `settle` helper and the verdicts-cli.test.mjs flow), just
// against the real CLI's own child process instead of an in-process call.
function settle(env, root, first) {
  if (first.status === "finished") return first;
  assert.equal(first.final, true, "a parked last pass must say so");
  assert.equal(first.status, "awaiting_response");

  // The seeded defect (add() subtracts) is real, so the honest adjudication
  // is to confirm every finding this pass raised — not to fabricate a fix.
  const verdicts = {
    verdicts: first.findings.map((f) => ({
      id: f.id,
      verdict: "confirm",
      basis: "add() returns a - b, not a + b — reproduced by inspection",
      bounds: "",
    })),
  };
  const vres = spawnSync("node", [CLI, "verdicts", first.runId, "1"], {
    env,
    encoding: "utf8",
    input: JSON.stringify(verdicts),
  });
  assert.equal(vres.status, 0, vres.stdout + vres.stderr);

  writeFileSync(
    join(root, ".trio", "runs", first.runId, "pass-1", "response.json"),
    JSON.stringify({
      findings: first.findings.map((f) => ({
        id: f.id,
        action: "acknowledged",
        reason: "confirmed defect; this smoke test applies no fix",
      })),
      summary: "smoke test: defect confirmed, no fix applied",
    }),
  );

  const res = run(env, ["continue"]);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

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
    run(env, ["on"]);
    run(env, ["config", "set", "view.mode", "off"]);
    run(env, ["config", "set", "maxIterations", "1"]);
    // Pin the lens set rather than relying on which lenses ship enabled:
    // every extra lens is another real Codex process on the operator's
    // account, and a smoke test only needs one to prove the loop closes.
    const res = run(env, ["run", "--lenses", "auditor"]);
    assert.equal(res.status, 0, res.stderr);

    const final = settle(env, root, JSON.parse(res.stdout));
    const { runId, verdict, promoted } = final;
    assert.equal(final.status, "finished");
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
    run(env, ["on"]);
    run(env, ["config", "set", "view.mode", "off"]);
    run(env, ["config", "set", "maxIterations", "1"]);
    // The run has to actually happen for the assertion below to mean
    // anything: a run that never started leaves no marker either, which used
    // to pass this test while proving nothing.
    const res = run(env, ["run", "--lenses", "auditor"]);
    assert.equal(res.status, 0, res.stderr);

    // This repo is empty, so a clean, unparked finish is the expected path —
    // but nothing here promises Codex reports zero findings on an empty
    // tree, so the parking flow is handled the same way as the other test.
    const final = settle(env, root, JSON.parse(res.stdout));
    assert.equal(final.status, "finished");
    assert.ok(existsSync(join(root, ".trio", "runs", final.runId, "verdict.json")));
    assert.equal(existsSync(join(root, ".trio", "active")), false);
  },
);
