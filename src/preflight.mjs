import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./paths.mjs";
import { scrub } from "./scrub.mjs";

const INSTALL = "npm i -g @openai/codex, then: codex login";
const LOGIN =
  "codex login   (no browser on this machine? codex login --device-auth)";

export function preflight({ run, codexHomeDir = codexHome() }) {
  let version;
  try {
    version = run("codex", ["--version"]);
  } catch {
    return {
      state: "not_installed",
      message:
        "Trio drives OpenAI's Codex CLI, a separate product. It is not installed.",
      fix: INSTALL,
    };
  }
  if (version.status !== 0) {
    return {
      state: "not_installed",
      message: "The codex binary is present but did not run.",
      fix: INSTALL,
    };
  }

  const status = run("codex", ["login", "status"]);
  const out = scrub(status.stdout ?? "");
  if (status.status !== 0 || /not logged in/i.test(out)) {
    return {
      state: "not_logged_in",
      message: "Codex is installed but not logged in.",
      fix: LOGIN,
    };
  }

  let authMode = "unknown";
  try {
    authMode =
      JSON.parse(readFileSync(join(codexHomeDir, "auth.json"), "utf8"))
        .auth_mode ?? "unknown";
  } catch {
    /* absent */
  }

  if (/api key/i.test(out) || authMode === "apikey") {
    return {
      state: "api_key_mode",
      message:
        "Codex is logged in with an API key — usage is billed per token. Trio runs lenses in parallel, so a pass costs roughly (lenses x audit). Lower codex.parallel or log in with a ChatGPT plan.",
      fix: "codex login   (to switch to a subscription)",
    };
  }
  return {
    state: "ready",
    message: out.trim() || "Codex is logged in.",
    fix: "",
  };
}
