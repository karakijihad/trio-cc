import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";

// SessionStart context: makes Claude aware Trio is here without making it a
// gate. The skill descriptions already say when each skill applies; what they
// cannot do is remind Claude to weigh an audit after work the operator never
// framed as "audit this". This nudge is advisory on purpose — the judgement
// about whether a task warrants a second reviewer stays with Claude and the
// operator, not with a hook.
//
// Silent when the project has opted out (`/trio:off`), and silent when the
// config is unreadable — loadConfig fails closed in that case, and a corrupt
// file must not re-introduce Trio to a project that had said no.
export function main(root) {
  if (loadConfig(root).enabled !== true) return null;
  return [
    "Trio is enabled for this project. It is not required for every task — judge by the work:",
    "- After finishing a substantive code-writing or code-modifying task, consider an independent Codex audit (the trio:trio-audit skill), and offer it rather than assuming.",
    "- Run it without being re-asked whenever the operator requests it (\"have Codex audit this\", \"run the loop\").",
    "- For a design or technical question where a second model's answer helps, trio:trio-consult.",
    "- Trivial edits, docs-only changes, and pure questions need no audit.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = main(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (text) process.stdout.write(text + "\n");
  process.exit(0);
}
