/**
 * Edge transcoder core (DESIGN.md, architecture 3): fetch a URL, downconvert
 * the HTML to canonical hdm for agents, keep the original for humans. The
 * HTTP shell lives in serve.ts; this module is transport-free so it is
 * unit-testable with an injected fetcher.
 */
import { canonicalize, print, toJSON } from "./canonical.js";
import { renderReactive } from "./react.js";
import { htmlToDoc } from "./html2hdm.js";
import type { Doc } from "./types.js";

export type EdgeErrorCode =
  | "E_EDGE_URL" // not a valid absolute URL
  | "E_EDGE_SCHEME" // not http(s)
  | "E_EDGE_PRIVATE" // private/loopback target (SSRF guard)
  | "E_EDGE_FETCH" // network error, non-2xx, or non-HTML content type
  | "E_EDGE_TIMEOUT" // upstream did not answer in time
  | "E_EDGE_SIZE"; // upstream body exceeded maxBytes

export class EdgeError extends Error {
  readonly code: EdgeErrorCode;
  readonly status: number;

  constructor(code: EdgeErrorCode, message: string, status = 400) {
    super(message);
    this.name = "EdgeError";
    this.code = code;
    this.status = status;
  }
}

export interface EdgeOptions {
  /**
   * SSRF guard: by default hosts that resolve literally private (loopback,
   * RFC1918, link-local, unique-local) are refused. Loopback deployments and
   * tests set this true. DNS-rebinding is out of scope; the guard checks
   * literal hosts and the post-redirect URL, see isPrivateHost.
   */
  allowPrivate?: boolean;
  /** Upstream timeout, default 10s. */
  fetchTimeoutMs?: number;
  /** Max upstream body bytes, default 5 MB. */
  maxBytes?: number;
  /** Injectable fetch (tests). Signature matches global fetch. */
  fetcher?: typeof fetch;
  /** User agent sent upstream. */
  userAgent?: string;
}

const DEFAULTS = {
  fetchTimeoutMs: 10_000,
  maxBytes: 5 * 1024 * 1024,
  userAgent: "htmldown-edge/0.1 (+https://github.com/htmldown)",
};

/**
 * Literal-host SSRF guard: loopback, RFC1918, CGNAT, link-local (v4+v6),
 * unique-local IPv6, and localhost names. Hostnames are resolved by DNS at
 * fetch time; a hostname that RESOLVES private is not caught here (documented
 * limitation for a dev-tool grade transcoder).
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 !== null) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return true; // malformed -> refuse
    const [a, b] = [o[0]!, o[1]!];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (h.includes(":")) {
    const v6 = h.replace(/^\[|\]$/g, "");
    if (v6 === "::" || v6 === "::1") return true;
    if (/^f[cd]/.test(v6)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 link local
    return false;
  }
  return false;
}

function isHtmlType(contentType: string | null): boolean {
  if (contentType === null) return true; // no header: let the parser try
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  return ct === "text/html" || ct === "application/xhtml+xml" || ct.startsWith("text/");
}

/** Read a body with a hard byte cap; aborts the stream past the cap. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      throw new EdgeError("E_EDGE_SIZE", `upstream body exceeds ${maxBytes} bytes`, 413);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export interface TranscodeResult {
  /** The final URL after redirects. */
  source: string;
  /** Canonical hdm text (DOW-3). */
  canonical: string;
  doc: Doc;
  /** Audit notes from the downconverter (DOW-2). */
  notes: string[];
  /** Raw upstream HTML (for the human pane / raw passthrough). */
  html: string;
}

/**
 * Fetch a page and downconvert it to canonical hdm. Checks response.ok
 * (upstream errors are data, not success), enforces the byte cap and
 * timeout, and re-checks the SSRF guard after redirects.
 */
export async function transcodeUrl(url: string, opts: EdgeOptions = {}): Promise<TranscodeResult> {
  const cfg = { ...DEFAULTS, ...opts };
  const fetcher = opts.fetcher ?? fetch;

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new EdgeError("E_EDGE_URL", `not a valid URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new EdgeError("E_EDGE_SCHEME", `only http/https is supported, got ${u.protocol}`);
  }
  if (!opts.allowPrivate && isPrivateHost(u.hostname)) {
    throw new EdgeError("E_EDGE_PRIVATE", `refusing private host: ${u.hostname}`, 403);
  }

  let resp: Response;
  try {
    resp = await fetcher(u.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
      headers: { "user-agent": cfg.userAgent, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
    });
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new EdgeError("E_EDGE_TIMEOUT", `upstream timed out after ${cfg.fetchTimeoutMs}ms`, 504);
    }
    throw new EdgeError("E_EDGE_FETCH", `fetch failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  }

  if (!resp.ok) {
    throw new EdgeError("E_EDGE_FETCH", `upstream returned ${resp.status} ${resp.statusText}`, 502);
  }
  if (!opts.allowPrivate && resp.url !== "" && isPrivateHost(new URL(resp.url).hostname)) {
    // A redirect smuggled us to a private host.
    throw new EdgeError("E_EDGE_PRIVATE", `redirect landed on a private host: ${resp.url}`, 403);
  }
  const contentType = resp.headers.get("content-type");
  if (!isHtmlType(contentType)) {
    throw new EdgeError("E_EDGE_FETCH", `unsupported content type: ${contentType ?? "(none)"}`, 415);
  }

  const bytes = await readCapped(resp.body, cfg.maxBytes);
  const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const source = resp.url === "" ? u.toString() : resp.url;
  const { doc, notes } = htmlToDoc(html, { source });
  const canonical = print(canonicalize(doc));
  return { source, canonical, doc, notes, html };
}

/** Serve formats: the machine surfaces of one conversion. */
export type EdgeFormat = "canonical" | "ast" | "html" | "raw";

export function formatConversion(result: TranscodeResult, format: EdgeFormat): {
  body: string;
  contentType: string;
} {
  switch (format) {
    case "ast":
      return { body: toJSON(result.doc), contentType: "application/json; charset=utf-8" };
    case "html":
      return { body: renderReactive(result.doc), contentType: "text/html; charset=utf-8" };
    case "raw":
      return { body: result.html, contentType: "text/html; charset=utf-8" };
    case "canonical":
    default:
      return { body: result.canonical, contentType: "text/x-hdm; charset=utf-8" };
  }
}
