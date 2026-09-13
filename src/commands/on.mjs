import { loadConfig, saveConfig, configErrors, unknownKeys } from "../config.mjs";
import { renderPanel } from "../panel.mjs";

// `trio on`
export default function onCommand({ root, out, gatherState, ensureGitignore }) {
  const config = { ...loadConfig(root), enabled: true };
  saveConfig(root, config);
  ensureGitignore();
  out(
    renderPanel({
      ...gatherState(),
      config,
      configErrors: configErrors(config),
      unknownKeys: unknownKeys(config),
    }),
  );
}
