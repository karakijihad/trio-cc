// The write boundary for adjudication, through the real binary: the stdin path
// and the exit status a shell sees. Everything else about `trio verdicts` is
// tested in-process in tests/integration/verdicts-cli.test.mjs; the pure
// validation lives in tests/unit/reconcile.test.mjs.
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
import { fileURLToPath } from "node:url";

const RUN = "2026-08-03T10-00-00";
const CLI = fileURLToPath(new URL("../../bin/trio.mjs", import.meta.url));

const finding = (id) => ({
  id,
  severity: "major",
  file: "a.rs",
  title: `t-${id}`,
  evidence: "",
  impact: "",
  correction: "",
  lens: "auditor",
  verdict: "unreviewed",
  basis: "",
  bounds: "",
});

const project = (ids = ["a1", "a2"]) => {
  const root = mkdtempSync(join(tmpdir(), "trio-verdicts-"));
  const dir = join(root, ".trio", "runs", RUN, "pass-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "reconcile.json"),
    JSON.stringify({ findings: ids.map(finding) }),
  );
  return { root, dir };
};

const submit = (root, body, args = [RUN, "1"]) =>
  spawnSync("node", [CLI, "verdicts", ...args], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
    input: body,
  });

const verdict = (id, over = {}) => ({
  id,
  verdict: "confirm",
  basis: "reproduced: input x hits the branch at a.rs:4",
  bounds: "nowhere else",
  ...over,
});

const ok = (over = {}) => ({
  verdicts: [verdict("a1", over), verdict("a2")],
});

test("a clean submission is accepted and written canonically", () => {
  const { root, dir } = project();
  const r = submit(root, JSON.stringify(ok()));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const written = JSON.parse(readFileSync(join(dir, "verdicts.json"), "utf8"));
  assert.equal(written.verdicts.length, 2);
  assert.equal(written.verdicts[0].verdict, "confirm");
});

// The incident, refused at the boundary this time.
test("an invented verdict is refused and nothing is written", () => {
  const { root, dir } = project();
  const r = submit(
    root,
    JSON.stringify({
      verdicts: [verdict("a1", { verdict: "OUT_OF_SCOPE" }), verdict("a2")],
    }),
  );
  assert.equal(r.status, 2);
  assert.match(r.stdout, /OUT_OF_SCOPE/);
  assert.match(r.stdout, /not written/);
  assert.equal(existsSync(join(dir, "verdicts.json")), false);
});
