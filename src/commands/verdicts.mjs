import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { passDir, isRunId } from "../paths.mjs";
import { readMarker } from "../marker.mjs";
import { parseVerdictsInput, validateVerdicts } from "../reconcile.mjs";
import { flagValue } from "../cli-args.mjs";
import { isLive } from "../findings.mjs";

// The write boundary for adjudication. verdicts.json used to be written by
// hand from a subagent's reply — and a reply that came back as prose, with
// uppercase labels and an invented fifth verdict, was transcribed straight
// to disk. Nothing checked it until the next pass read it, by which point
// the only honest thing left to do was discard it. This refuses the whole
// submission and writes nothing, because the caller still has the data.
export default function verdictsCommand({ root, rest, out, activeRun }) {
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--file") i++;
    else if (!rest[i].startsWith("-")) positional.push(rest[i]);
  }
  const runId = positional[0] ?? activeRun();
  if (!runId) {
    out("No active run — pass a run id.");
    process.exitCode = 1;
    return;
  }
  if (!isRunId(runId)) {
    out(`Not a run id: ${runId}`);
    process.exitCode = 2;
    return;
  }
  const held = readMarker(root);
  const pass = Number(positional[1] ?? held?.pass);
  if (!Number.isSafeInteger(pass) || pass < 1) {
    out(
      `usage: trio verdicts [runId] [pass] [--file PATH]   (pass: ${positional[1] ?? "(none, and no active pass)"})`,
    );
    process.exitCode = 2;
    return;
  }
  const dir = passDir(root, runId, pass);
  let findings;
  try {
    findings = JSON.parse(
      readFileSync(join(dir, "reconcile.json"), "utf8"),
    ).findings;
  } catch {
    out(`No pass ${pass} to adjudicate in ${runId}.`);
    process.exitCode = 1;
    return;
  }

  const source = flagValue(rest, "--file", 0);
  let text;
  try {
    text = readFileSync(source, "utf8");
  } catch (err) {
    out(`could not read the verdicts: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const input = parseVerdictsInput(text);
  const checked = input.ok
    ? validateVerdicts(input.parsed, {
        knownIds: findings.map((f) => f.id),
      })
    : { ok: false, problems: input.problems, warnings: [], renamed: [] };

  if (!checked.ok) {
    // Nothing is written, so a previous good file survives a bad resubmit.
    out(
      `Refusing ${checked.problems.length} problem(s) — verdicts.json not written:\n  ${checked.problems.join("\n  ")}`,
    );
    process.exitCode = 2;
    return;
  }

  // Atomic: a reader between passes never sees a half-written file.
  const tmp = join(dir, "verdicts.json.tmp");
  writeFileSync(
    tmp,
    JSON.stringify({ verdicts: checked.verdicts }, null, 2) + "\n",
  );
  renameSync(tmp, join(dir, "verdicts.json"));

  for (const r of checked.renamed)
    process.stderr.write(`  normalized ${r.id}: ${r.from} → ${r.to}\n`);
  for (const w of checked.warnings) process.stderr.write(`  ⚠ ${w}\n`);
  // A partial set is written — it is still adjudication — but `continue` and
  // `extend` refuse a pass whose live findings are not all covered, so say
  // which now rather than at that refusal.
  const judged = new Set(checked.verdicts.map((v) => v.id));
  const missing = findings.filter((f) => isLive(f) && !judged.has(f.id));
  if (missing.length)
    process.stderr.write(
      `  ⚠ ${missing.length} live finding(s) still have no verdict: ${missing.map((f) => f.id).join(", ")} — continue will refuse until they do\n`,
    );
  out(
    `Accepted ${checked.verdicts.length} verdict(s) for ${runId} pass ${pass}.`,
  );
}
