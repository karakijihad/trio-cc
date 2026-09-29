import { claudeDispatch, loadConfig, saveConfig, setConfigValue, unknownKeys } from "../config.mjs";

// `trio config get | trio config dispatch | trio config set <key> <value>`
export default function configCommand({ root, rest, out }) {
  const [action, key, value] = rest;
  if (action === "get") {
    const cfg = loadConfig(root);
    const unknown = unknownKeys(cfg);
    if (unknown.length)
      process.stderr.write(
        `⚠ unknown config key(s), ignored: ${unknown.join(", ")}\n`,
      );
    out(JSON.stringify(cfg, null, 2));
    return;
  }
  // Resolved here because the env var is visible to this process and not to
  // the skill reading its output.
  if (action === "dispatch") {
    out(JSON.stringify(claudeDispatch(loadConfig(root)), null, 2));
    return;
  }
  if (action !== "set" || !key) {
    out("usage: trio config get | trio config dispatch | trio config set <key> <value>");
    process.exitCode = 2;
    return;
  }
  try {
    saveConfig(root, setConfigValue(loadConfig(root), key, value));
    out(`${key} = ${value}`);
  } catch (e) {
    out(e.message);
    process.exitCode = 2;
  }
}
