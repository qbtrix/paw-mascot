// dev-server.mjs — the pet in a browser tab, before there is a window.
//
// Serves web/ and the avatar effect, and tails ~/.paw/events.jsonl over
// SSE at /events, which is exactly what the Tauri side will do over its own
// channel. Run it, open the tab, run Claude Code in another terminal, and
// watch the mapping against a real session. That is the whole point of P1:
// the mapping is the part that can be wrong, and a tab is the cheapest place
// to find out.
//
//   bun web/dev-server.mjs [--port 8799] [--file ~/.paw/events.jsonl]
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, watch } from "node:fs";
import { join, extname, resolve } from "node:path";
import { homedir } from "node:os";

const ROOT = new URL(".", import.meta.url).pathname;
// The effect is served straight out of the sibling checkout while developing;
// the app bundles a copy (see sync-fx). Same path either way: /_fx/...
const FX = resolve(ROOT, "../../paw-fx/effects");
const argv = process.argv;
const port = Number(argv[argv.indexOf("--port") + 1]) || 8799;
const file = argv.includes("--file") ? argv[argv.indexOf("--file") + 1] : join(homedir(), ".paw/events.jsonl");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const serve = (p) => {
  if (!existsSync(p) || statSync(p).isDirectory()) return null;
  return new Response(readFileSync(p), { headers: { "Content-Type": `${TYPES[extname(p)] ?? "application/octet-stream"}; charset=utf-8` } });
};

/** The last `n` lines of the file, for catching up a session in flight. */
function tail(n = 200) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-n);
}

Bun.serve({
  port,
  // An SSE connection is idle by design. Bun closes idle requests after ten
  // seconds by default, which took the stream down with a chunked-encoding
  // error before the first real event ever arrived.
  idleTimeout: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;

    if (path === "/events") {
      let offset = existsSync(file) ? statSync(file).size : 0;
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(ctrl) {
          const send = (line) => ctrl.enqueue(enc.encode(`data: ${line}\n\n`));
          for (const l of tail()) send(l);
          // Append-only file: read from the last offset forward on each change.
          const w = watch(file.replace(/\/[^/]+$/, ""), (_, name) => {
            if (name && !file.endsWith(name)) return;
            if (!existsSync(file)) return;
            const size = statSync(file).size;
            if (size < offset) offset = 0; // truncated: start over
            if (size === offset) return;
            const fd = openSync(file, "r");
            const buf = Buffer.alloc(size - offset);
            readSync(fd, buf, 0, buf.length, offset);
            closeSync(fd);
            offset = size;
            for (const l of buf.toString("utf8").split("\n")) if (l.trim()) send(l);
          });
          // A comment line every 20s: nothing to the page, but a proxy or a
          // browser that drops silent streams sees traffic.
          const beat = setInterval(() => ctrl.enqueue(enc.encode(": beat\n\n")), 20000);
          req.signal.addEventListener("abort", () => { clearInterval(beat); w.close(); ctrl.close(); });
        }
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    }

    if (path.startsWith("/_fx/effects/")) return serve(join(FX, path.slice("/_fx/effects/".length))) ?? new Response("not found", { status: 404 });
    if (path === "/") return serve(join(ROOT, "index.html"));
    return serve(join(ROOT, path)) ?? new Response("not found", { status: 404 });
  }
});

console.log(`pet on http://localhost:${port}  tailing ${file}`);
