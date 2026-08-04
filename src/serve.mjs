import { createServer as httpServer } from "node:http";
import { readFileSync, watch, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readEvents, eventsFile } from "./bus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "view", "index.html");
const MANIFEST = join(HERE, "..", ".claude-plugin", "plugin.json");

// The manifest is the one place the version already lives — package.json is
// kept in sync with it, but the plugin manifest is what an installed copy is
// actually running as.
function pluginVersion() {
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

export function createServer({ runDirPath }) {
  return httpServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(PAGE, "utf8"));
      return;
    }
    if (req.url === "/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: pluginVersion() }));
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.flushHeaders();
      let sent = 0;
      const flush = () => {
        const all = readEvents(runDirPath);
        for (const ev of all.slice(sent))
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        sent = all.length;
      };
      flush();
      let watcher;
      try {
        watcher = watch(eventsFile(runDirPath), flush);
      } catch {
        watcher = null; // no log yet; the poll below covers it
      }
      const poll = setInterval(flush, 1000);
      req.on("close", () => {
        clearInterval(poll);
        watcher?.close();
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

// Polls for the run's verdict.json and closes the server lingerMs after it
// appears, giving the operator time to see the final state. Both timers are
// unref()'d so a lingering viewer never keeps the process alive on its own,
// and both are cleared on close so a manual close() doesn't leave a stray
// timer behind.
function armAutoExit({ server, runDirPath, pollMs, lingerMs }) {
  const verdictPath = join(runDirPath, "verdict.json");
  let lingerTimer = null;
  const poll = setInterval(() => {
    if (!existsSync(verdictPath)) return;
    clearInterval(poll);
    lingerTimer = setTimeout(() => server.close(), lingerMs);
    lingerTimer.unref?.();
  }, pollMs);
  poll.unref?.();
  server.on("close", () => {
    clearInterval(poll);
    if (lingerTimer) clearTimeout(lingerTimer);
  });
}

export function start({
  runDirPath,
  port = 4319,
  autoExit = false,
  pollMs = 10_000,
  lingerMs = 600_000,
}) {
  return new Promise((resolve, reject) => {
    const server = createServer({ runDirPath });
    const attempt = (p, remaining) => {
      server.removeAllListeners("error");
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && remaining > 0)
          return attempt(p + 1, remaining - 1);
        reject(err);
      });
      server.listen(p, "127.0.0.1", () => {
        const actual = server.address().port;
        if (autoExit) armAutoExit({ server, runDirPath, pollMs, lingerMs });
        resolve({ server, port: actual, url: `http://127.0.0.1:${actual}` });
      });
    };
    attempt(port, 20);
  });
}
