// The second lock (marker.mjs): held for as long as a process is actually
// executing lenses or finalizing, distinct from `.trio/active` which merely
// names the run. Unit-level here because the interesting behavior —
// uncontended acquire, refusing a live holder, reclaiming a stale one, and
// ownership-scoped release — needs neither a real pass nor a real Codex.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { trioDir } from "../src/paths.mjs";
import {
  acquireWorkerLock,
  releaseWorkerLock,
  readWorkerLock,
  workerLockPath,
} from "../src/marker.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "trio-worker-lock-"));

test("acquireWorkerLock: takes an uncontended lock and records who holds it", () => {
  const root = tmp();
  const r = acquireWorkerLock({ root, runId: "2026-01-01T00-00-00", pass: 1 });
  assert.equal(r.ok, true);
  const held = readWorkerLock(root);
  assert.equal(held.run, "2026-01-01T00-00-00");
  assert.equal(held.pass, 1);
  assert.equal(held.pid, process.pid);
  assert.equal(typeof held.since, "string");
});

// No `run` is injected here, which is the production default when a caller
// omits it. processIsTrio then fails to identify the pid at all (it has
// nothing to shell out with) and reads as "cannot tell" — which must fail
// open as still-held, the same stance isAbandonedClaim takes everywhere else
// in this codebase: reclaiming a lock a live worker still holds corrupts
// that worker's run.
test("acquireWorkerLock: refuses while held by a live pid it cannot positively rule out", () => {
  const root = tmp();
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    workerLockPath(root),
    JSON.stringify({ pid: process.pid, run: "r1", pass: 2, since: "t" }),
  );
  const r = acquireWorkerLock({ root, runId: "r2", pass: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.status, "worker_busy");
  assert.equal(r.holder.run, "r1");
  assert.equal(r.holder.pass, 2);
  // Refused, so nothing was overwritten.
  assert.equal(readWorkerLock(root).run, "r1");
});

// A harness timeout, a crash, or a reboot leaves this lock behind with
// nothing left to release it — on win32 nothing ever will, because no signal
// handler runs. The next acquire has to notice and take it over rather than
// wedging the project forever.
test("acquireWorkerLock: reclaims a stale lock left by a dead pid", () => {
  const root = tmp();
  mkdirSync(trioDir(root), { recursive: true });
  // A fresh child's pid is guaranteed dead the moment it has exited and
  // reaped — unlike a hardcoded number, which a recycled pid could collide
  // with.
  const corpse = spawnSync(process.execPath, ["-e", ""]);
  const dead = corpse.pid;
  writeFileSync(
    workerLockPath(root),
    JSON.stringify({ pid: dead, run: "r1", pass: 3, since: "t" }),
  );

  const r = acquireWorkerLock({ root, runId: "r2", pass: 1 });
  assert.equal(r.ok, true);
  const held = readWorkerLock(root);
  assert.equal(held.run, "r2");
  assert.equal(held.pid, process.pid);
});

test("releaseWorkerLock: releases only the caller's own lock", () => {
  const root = tmp();
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(
    workerLockPath(root),
    JSON.stringify({ pid: process.pid + 1, run: "r1", pass: 1, since: "t" }),
  );
  assert.equal(releaseWorkerLock(root, process.pid), false);
  assert.ok(existsSync(workerLockPath(root)), "released a lock that was not ours");

  writeFileSync(
    workerLockPath(root),
    JSON.stringify({ pid: process.pid, run: "r1", pass: 1, since: "t" }),
  );
  assert.equal(releaseWorkerLock(root, process.pid), true);
  assert.equal(existsSync(workerLockPath(root)), false);
});

test("readWorkerLock: absent or corrupt both read as null, not a throw", () => {
  const root = tmp();
  assert.equal(readWorkerLock(root), null);
  mkdirSync(trioDir(root), { recursive: true });
  writeFileSync(workerLockPath(root), "{ not json");
  assert.equal(readWorkerLock(root), null);
});

// Mirrors claimActiveRun's own ownership-scoped reclaim: two callers racing
// the same stale lock must not have the second one delete the first's fresh
// replacement.
test("acquireWorkerLock: a second racer's stale-reclaim never deletes the winner's fresh claim", () => {
  const root = tmp();
  mkdirSync(trioDir(root), { recursive: true });
  const corpse = spawnSync(process.execPath, ["-e", ""]);
  const dead = corpse.pid;
  writeFileSync(
    workerLockPath(root),
    JSON.stringify({ pid: dead, run: "r1", pass: 1, since: "stale-since" }),
  );

  // First racer reclaims and wins outright.
  const first = acquireWorkerLock({ root, runId: "winner", pass: 1 });
  assert.equal(first.ok, true);

  // A second racer that had already read the *original* stale snapshot
  // before the first one reclaimed it must not blindly delete whatever is
  // there now — it has to compare against that original snapshot first.
  const staleSnapshot = { pid: dead, run: "r1", pass: 1, since: "stale-since" };
  const held = readWorkerLock(root);
  assert.notDeepEqual(held, staleSnapshot, "the winner's claim replaced it");
  assert.equal(held.run, "winner");
});
