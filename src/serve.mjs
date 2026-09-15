import { createServer as httpServer } from "node:http";
import { readFileSync, watch, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readEventsFrom, eventsFile } from "./bus.mjs";

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

// Byte offset a client last confirmed seeing, from the standard
// "Last-Event-ID" request header EventSource sends on an automatic
// reconnect. Any value that isn't a clean non-negative integer is treated as
// absent — readEventsFrom already recovers from an offset past EOF or before
// it, so refusing to trust a mangled header here just avoids passing it a
// value that means nothing, not a data-loss risk.
function lastEventOffset(req) {
  const raw = req.headers["last-event-id"];
  if (raw == null) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function createServer({ runDirPath }) {
  // Every open /events connection, so a shutdown can force them closed
  // instead of waiting on them: an SSE response never ends on its own, and
  // its poll interval and fs.watch watcher keep running (and keep the
  // process alive) for as long as the response stays open. server.close()
  // only stops accepting new connections and resolves once every existing
  // one has ended — with a browser tab left attached, that is never, which
  // is what made auto-exit hang. Wrapping close() below is what breaks that:
  // every caller of it, not just armAutoExit, gets the forced cleanup.
  const sseClients = new Set();

  const server = httpServer((req, res) => {
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
      let offset = lastEventOffset(req);
      const flush = () => {
        const { events, ends, offset: next } = readEventsFrom(runDirPath, offset);
        offset = next;
        // One id per event, the byte offset just past that event's line. A
        // single id for the whole batch made every event in it carry the
        // batch's end, so a client that dropped after the first event resumed
        // past the ones it never received.
        events.forEach((ev, i) =>
          res.write(`id: ${ends[i]}\ndata: ${JSON.stringify(ev)}\n\n`),
        );
      };
      flush();
      let watcher;
      try {
        watcher = watch(eventsFile(runDirPath), flush);
      } catch {
        watcher = null; // no log yet; the poll below covers it
      }
      const poll = setInterval(flush, 1000);
      const client = { res, poll, watcher };
      sseClients.add(client);
      req.on("close", () => {
        clearInterval(poll);
        watcher?.close();
        sseClients.delete(client);
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    for (const client of sseClients) {
      clearInterval(client.poll);
      client.watcher?.close();
      try {
        client.res.end();
      } catch {
        /* already ending */
      }
      try {
        client.res.socket?.destroy();
      } catch {
        /* already gone */
      }
    }
    sseClients.clear();
    return originalClose(callback);
  };

  return server;
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
