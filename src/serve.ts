/**
 * The edge gateway (DESIGN.md, architecture 3). Agents get canonical ad;
 * humans get the original. Endpoints:
 *
 *   GET /                     dual-pane UI (form -> /view)
 *   GET /view?url=...         dual-pane page: rendered ad + canonical text
 *   GET /transcode?url=...    machine surface: ?format=canonical|ast|html|raw
 *   GET /healthz              liveness probe (plain "ok")
 *
 * Limits (ServeOptions / env in main()): per-IP request rate (429
 * E_EDGE_RATE), in-flight transcode cap (503 E_EDGE_BUSY), inbound body cap
 * (413 E_EDGE_TOO_LARGE). Errors are JSON: { code, message }. Zero
 * dependencies: node:http + fetch.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { EdgeError, formatConversion, transcodeUrl, type EdgeFormat, type EdgeOptions } from "./edge.js";

const FORMATS: readonly EdgeFormat[] = ["canonical", "ast", "html", "raw"];

const UI_STYLE = `
:root { color-scheme: light dark; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 0; }
header { padding: 0.75rem 1rem; border-bottom: 1px solid #8884; display: flex; gap: 0.5rem; align-items: center; }
header input { flex: 1; padding: 0.4rem 0.6rem; }
main { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; padding: 1rem; }
main h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.7; margin: 0 0 0.5rem; }
iframe, pre { border: 1px solid #8884; border-radius: 6px; margin: 0; }
iframe { width: 100%; height: 80vh; background: #fff; }
pre { padding: 1rem; white-space: pre-wrap; word-break: break-word; height: 80vh; overflow: auto; }
.intro { padding: 3rem 1rem; max-width: 42rem; margin: 0 auto; }
@media (max-width: 60rem) { main { grid-template-columns: 1fr; } }
`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The dual-pane transcoder view (DESIGN.md UX sketch 3). */
function viewPage(url: string | null): string {
  const form = `<form method="get" action="/view">
    <label for="url">URL</label>
    <input id="url" name="url" type="url" placeholder="https://example.com" value="${url === null ? "" : esc(url)}" required>
    <button>Transcode</button>
  </form>`;
  const header = `<header><strong>actdown edge</strong>${form}</header>`;
  if (url === null) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>actdown edge</title>
<style>${UI_STYLE}</style></head><body>${header}
<div class="intro">
<h1>HTML in, ad out</h1>
<p>Paste a URL above. Agents read <code>/transcode?url=&hellip;</code> as canonical
actdown; the left pane shows how the downconverted document renders, the right
pane shows the canonical text.</p>
<p>Formats: <code>?format=canonical</code> (default), <code>ast</code>,
<code>html</code>, <code>raw</code>.</p>
</div></body></html>`;
  }
  const src = `/transcode?url=${encodeURIComponent(url)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>actdown edge: ${esc(url)}</title>
<style>${UI_STYLE}</style></head><body>${header}
<main>
  <section><h2>Downconverted (rendered)</h2><iframe src="${src}&amp;format=html" sandbox=""></iframe></section>
  <section><h2>Canonical ad</h2><iframe src="${src}&amp;format=canonical"></iframe></section>
</main></body></html>`;
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  const headers: Record<string, string> = {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  };
  if (contentType.startsWith("text/html")) {
    // Transcoded content is untrusted: it must never run script on this origin.
    headers["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendJsonError(res: ServerResponse, err: unknown): void {
  if (err instanceof EdgeError) {
    send(res, err.status, JSON.stringify({ code: err.code, message: err.message }), "application/json; charset=utf-8");
    return;
  }
  send(res, 500, JSON.stringify({ code: "E_EDGE_INTERNAL", message: "internal error" }), "application/json; charset=utf-8");
}

function parseFormat(q: URLSearchParams): EdgeFormat {
  const f = q.get("format") ?? "canonical";
  return (FORMATS as readonly string[]).includes(f) ? (f as EdgeFormat) : "canonical";
}

export interface ServeOptions extends EdgeOptions {
  /** Called per request for logging; default: silent. */
  onRequest?: (line: string) => void;
  /**
   * Max inbound request body bytes. The gateway is GET/HEAD only, so this is
   * defensive (against oversized bodies on the shared origin). Default 1 MB.
   */
  maxRequestBodyBytes?: number;
  /**
   * Requests per minute per client IP (fixed window, socket address only,
   * never X-Forwarded-For: behind a proxy all clients would share one
   * bucket). 0 disables. Default 120.
   */
  rateLimit?: number;
  /**
   * Max in-flight upstream transcodes; excess requests get 503 E_EDGE_BUSY.
   * Default 8.
   */
  maxConcurrent?: number;
}

/** Fixed-window per-IP rate limiter (dev-grade; a proxy makes all clients one IP). */
function rateLimiter(limit: number): (ip: string) => boolean {
  const WINDOW_MS = 60_000;
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (ip: string): boolean => {
    if (limit <= 0) return false;
    const now = Date.now();
    const entry = hits.get(ip);
    if (entry === undefined || now - entry.windowStart >= WINDOW_MS) {
      // Opportunistic pruning keeps the map bounded under IP churn.
      if (hits.size > 1024) {
        for (const [k, v] of hits) {
          if (now - v.windowStart >= WINDOW_MS) hits.delete(k);
        }
      }
      hits.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > limit;
  };
}

export function createEdgeServer(opts: ServeOptions = {}): Server {
  const log = opts.onRequest ?? (() => {});
  const maxBody = opts.maxRequestBodyBytes ?? 1024 * 1024;
  const tooManyRequests = rateLimiter(opts.rateLimit ?? 120);
  let inFlight = 0;
  const maxConcurrent = opts.maxConcurrent ?? 8;
  /** Acquire a concurrency slot for an upstream transcode. */
  const slot = (): boolean => {
    if (inFlight >= maxConcurrent) return false;
    inFlight += 1;
    return true;
  };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    res.on("finish", () => {
      log(`${new Date().toISOString()} ${req.method} ${u.pathname}${u.search} -> ${res.statusCode}`);
    });
    void (async () => {
      // Inbound size cap: GET/HEAD should not carry a body; reject any that
      // declares one larger than allowed (defensive, before any routing work).
      const declared = Number(req.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > maxBody) {
        send(res, 413, JSON.stringify({ code: "E_EDGE_TOO_LARGE", message: `request body exceeds ${maxBody} bytes` }), "application/json; charset=utf-8");
        return;
      }
      const ip = req.socket.remoteAddress ?? "unknown";
      if (tooManyRequests(ip)) {
        send(res, 429, JSON.stringify({ code: "E_EDGE_RATE", message: "rate limit exceeded, slow down" }), "application/json; charset=utf-8");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        send(res, 405, JSON.stringify({ code: "E_EDGE_METHOD", message: "GET/HEAD only" }), "application/json; charset=utf-8");
        return;
      }
      if (u.pathname === "/" && u.searchParams.has("url")) u.pathname = "/view";
      switch (u.pathname) {
        case "/healthz": {
          send(res, 200, "ok", "text/plain; charset=utf-8");
          return;
        }
        case "/": {
          send(res, 200, viewPage(null), "text/html; charset=utf-8");
          return;
        }
        case "/view": {
          const target = u.searchParams.get("url");
          // The canonical pane is fetched server-side so failures surface as
          // a readable error page, not a broken iframe.
          if (target !== null) {
            if (!slot()) {
              send(res, 503, JSON.stringify({ code: "E_EDGE_BUSY", message: "too many concurrent transcodes" }), "application/json; charset=utf-8");
              return;
            }
            try {
              await transcodeUrl(target, opts);
            } catch (err: unknown) {
              const code = err instanceof EdgeError ? err.code : "E_EDGE_INTERNAL";
              const msg = err instanceof Error ? esc(err.message) : "error";
              send(res, err instanceof EdgeError ? err.status : 500, `<!doctype html><html><head><meta charset="utf-8"><title>edge error</title></head>
<body style="font:15px/1.5 system-ui,sans-serif;padding:2rem"><h1>${esc(code)}</h1><p>${msg}</p><p><a href="/">back</a></p></body></html>`, "text/html; charset=utf-8");
              return;
            } finally {
              inFlight -= 1;
            }
          }
          send(res, 200, viewPage(target), "text/html; charset=utf-8");
          return;
        }
        case "/transcode": {
          const target = u.searchParams.get("url");
          if (target === null || target === "") {
            send(res, 400, JSON.stringify({ code: "E_EDGE_URL", message: "missing ?url=" }), "application/json; charset=utf-8");
            return;
          }
          const format = parseFormat(u.searchParams);
          if (!slot()) {
            send(res, 503, JSON.stringify({ code: "E_EDGE_BUSY", message: "too many concurrent transcodes" }), "application/json; charset=utf-8");
            return;
          }
          try {
            const result = await transcodeUrl(target, opts);
            const { body, contentType } = formatConversion(result, format);
            log(`${new Date().toISOString()} format=${format} source=${result.source}`);
            send(res, 200, body, contentType);
          } finally {
            inFlight -= 1;
          }
          return;
        }
        default: {
          send(res, 404, JSON.stringify({ code: "E_EDGE_NOT_FOUND", message: `no route: ${u.pathname}` }), "application/json; charset=utf-8");
        }
      }
    })().catch((err: unknown) => sendJsonError(res, err));
  });
}

/** Entry point: node dist/serve.js (PORT env or 8787, HOST env or 127.0.0.1). */
function main(): void {
  const port = Number(process.env.PORT ?? 8787);
  // Explicit listen address, loopback by default: a dev tool must not expose
  // itself on all interfaces unless the operator asks for it (HOST=0.0.0.0).
  // Loopback doubles as the trusted-client boundary; anything wider needs the
  // auth story in README (status).
  const host = process.env.HOST ?? "127.0.0.1";
  const rateLimit = process.env.EDGE_RATE_LIMIT === undefined ? undefined : Number(process.env.EDGE_RATE_LIMIT);
  const server = createEdgeServer({
    allowPrivate: process.env.EDGE_ALLOW_PRIVATE === "1",
    rateLimit: Number.isFinite(rateLimit) ? rateLimit : undefined,
    onRequest: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
  server.listen(port, host, () => {
    const addr = server.address();
    const shown = addr !== null && typeof addr === "object" ? `${addr.address}:${addr.port}` : `${host}:${port}`;
    process.stdout.write(`actdown edge listening on http://${shown} (health: /healthz)\n`);
  });
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) main();
