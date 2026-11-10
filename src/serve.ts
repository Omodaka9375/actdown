/**
 * The edge gateway (DESIGN.md, architecture 3). Agents get canonical ad;
 * humans get the original. Endpoints:
 *
 *   GET /                     dual-pane UI (form -> /view)
 *   GET /view?url=...         dual-pane page: rendered ad + canonical text
 *   GET /transcode?url=...    machine surface: ?format=canonical|ast|html|raw
 *
 * Errors are JSON: { code, message }. Zero dependencies: node:http + fetch.
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
}

export function createEdgeServer(opts: ServeOptions = {}): Server {
  const log = opts.onRequest ?? (() => {});
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    void (async () => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        send(res, 405, JSON.stringify({ code: "E_EDGE_METHOD", message: "GET/HEAD only" }), "application/json; charset=utf-8");
        return;
      }
      if (u.pathname === "/" && u.searchParams.has("url")) u.pathname = "/view";
      switch (u.pathname) {
        case "/": {
          send(res, 200, viewPage(null), "text/html; charset=utf-8");
          return;
        }
        case "/view": {
          const target = u.searchParams.get("url");
          // The canonical pane is fetched server-side so failures surface as
          // a readable error page, not a broken iframe.
          if (target !== null) {
            try {
              await transcodeUrl(target, opts);
            } catch (err: unknown) {
              const code = err instanceof EdgeError ? err.code : "E_EDGE_INTERNAL";
              const msg = err instanceof Error ? esc(err.message) : "error";
              send(res, err instanceof EdgeError ? err.status : 500, `<!doctype html><html><head><meta charset="utf-8"><title>edge error</title></head>
<body style="font:15px/1.5 system-ui,sans-serif;padding:2rem"><h1>${esc(code)}</h1><p>${msg}</p><p><a href="/">back</a></p></body></html>`, "text/html; charset=utf-8");
              return;
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
          const result = await transcodeUrl(target, opts);
          const { body, contentType } = formatConversion(result, format);
          log(`${new Date().toISOString()} ${format} ${result.source}`);
          send(res, 200, body, contentType);
          return;
        }
        default: {
          send(res, 404, JSON.stringify({ code: "E_EDGE_NOT_FOUND", message: `no route: ${u.pathname}` }), "application/json; charset=utf-8");
        }
      }
    })().catch((err: unknown) => sendJsonError(res, err));
  });
}

/** Entry point: node dist/serve.js (PORT env or 8787). */
function main(): void {
  const port = Number(process.env.PORT ?? 8787);
  const server = createEdgeServer({ allowPrivate: process.env.EDGE_ALLOW_PRIVATE === "1" });
  server.listen(port, () => {
    process.stdout.write(`actdown edge listening on http://localhost:${port}\n`);
  });
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) main();
