import { configErrors, unknownKeys } from "../config.mjs";
import { renderPanel } from "../panel.mjs";

// `trio doctor`
export default function doctorCommand({ out, run, gatherState }) {
  const s = gatherState({ force: true });
  out(renderPanel({ ...s, configErrors: configErrors(s.config), unknownKeys: unknownKeys(s.config) }));
  out("");
  // Doctor is the command you run when Codex is broken, so it has to
  // survive Codex being broken and say what it found.
  const d = run("codex", ["doctor"]);
  out(d.stdout || d.stderr || "codex doctor produced no output.");
}
