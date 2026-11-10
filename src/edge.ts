/**
 * Edge transcoder core (DESIGN.md, architecture 3): fetch a URL, downconvert
 * the HTML to canonical ad for agents, keep the original for humans. The
 * HTTP shell lives in serve.ts; this module is transport-free so it is
 * unit-testable with an injected fetcher.
 */
import { canonicalize, print, toJSON } from "./canonical.js";
import { renderReactive } from "./react.js";
import { htmlToDoc } from "./html2ad.js";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
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
   * SSRF guard: by default hosts that are literally private (loopback,
   * RFC1918, link-local, unique-local) AND hostnames that RESOLVE private
   * are refused. The literal check runs first; every hostname (initial and
   * each redirect hop) is then resolved via DNS and every resolved address
   * must be public. Loopback deployments and tests set this true.
   * Residual TOCTOU: the fetch itself re-resolves at connect time, so a
   * full DNS-rebinding defense still needs restricted network egress
   * (README, status) or an allowPrivate deployment on a trusted network.
   */
  allowPrivate?: boolean;
  /** Upstream timeout, default 10s. */
  fetchTimeoutMs?: number;
  /** Max upstream body bytes, default 5 MB. */
  maxBytes?: number;
  /** Injectable fetch (tests). Signature matches global fetch. */
  fetcher?: typeof fetch;
  /**
   * Injectable DNS resolver (tests and policy). Default: `dns.lookup` with
   * `all: true`, which matches what the fetch will connect through (the OS
   * resolver, including /etc/hosts). Only called when allowPrivate is false.
   */
  resolver?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** User agent sent upstream. */
  userAgent?: string;
}

const DEFAULTS = {
  fetchTimeoutMs: 10_000,
  maxBytes: 5 * 1024 * 1024,
  userAgent: "actdown-edge/0.1",
};

/**
 * Literal-host SSRF guard: loopback, RFC1918, CGNAT, link-local (v4+v6),
 * unique-local IPv6, and localhost names. Hostnames are additionally resolved
 * by DNS before every fetch (see resolveChecked); a hostname that resolves
 * private is refused there.
 */
function isPrivateV4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/** Expand an IPv6 literal to eight 16-bit groups; null when malformed. */
function expandV6(addr: string): number[] | null {
  const s = addr.replace(/^\[|\]$/g, "");
  // A trailing IPv4 dotted quad folds into the last two groups.
  const last = s.split(":").pop() ?? "";
  let groupsText = s;
  if (last.includes(".")) {
    const o = last.split(".");
    if (o.length !== 4 || o.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
    const hi = (Number(o[0]) << 8) | Number(o[1]);
    const lo = (Number(o[2]) << 8) | Number(o[3]);
    groupsText = s.slice(0, s.length - last.length) + hi.toString(16) + ":" + lo.toString(16);
  }
  const double = groupsText.split("::");
  if (double.length > 2) return null;
  const head = double[0] === "" ? [] : double[0]!.split(":");
  const tail = double.length === 2 && double[1] !== "" ? double[1]!.split(":") : [];
  if ([...head, ...tail].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  if (double.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    return [...head, ...Array<string>(missing).fill("0"), ...tail].map((g) => parseInt(g, 16));
  }
  if (head.length !== 8) return null;
  return head.map((g) => parseInt(g, 16));
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 !== null) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return true; // malformed -> refuse
    return isPrivateV4(o[0]!, o[1]!);
  }
  if (h.includes(":")) {
    const g = expandV6(h);
    if (g === null) return true; // malformed address -> refuse
    const [w0, w1, w2, w3, w4, w5, w6, w7] = g as [number, number, number, number, number, number, number, number];
    if (g.every((w) => w === 0)) return true; // :: unspecified
    if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((w0 & 0xff80) === 0xfe80 || (w0 & 0xf000) === 0xf000) return true; // site-local / multicast: never fetch
    // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d embed a v4 target.
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && (w5 === 0 || w5 === 0xffff)) {
      return isPrivateV4(w6 >> 8, w6 & 0xff);
    }
    // 6to4 2002:aabb::/48 and Teredo 2001:0::/32 embed a v4 target.
    if (w0 === 0x2002 && isPrivateV4(w1 >> 8, w1 & 0xff)) return true;
    if (w0 === 0x2001 && w1 === 0) return true; // Teredo: refuses outright
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) return true;
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

/**
 * Resolve a hostname and refuse any private result (SPEC: SSRF, DNS stage).
 * A hostname that resolves to a private, loopback, link-local, or otherwise
 * guarded address throws E_EDGE_PRIVATE; resolution failures are E_EDGE_FETCH.
 * Literal addresses never reach here: isPrivateHost catches them first.
 */
async function resolveChecked(
  hostname: string,
  resolver: (host: string) => Promise<{ address: string; family: number }[]>,
): Promise<void> {
  let records: { address: string; family: number }[];
  try {
    records = await resolver(hostname);
  } catch (err: unknown) {
    throw new EdgeError(
      "E_EDGE_FETCH",
      `DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
  if (records.length === 0) {
    throw new EdgeError("E_EDGE_FETCH", `DNS resolution returned no addresses for ${hostname}`, 502);
  }
  for (const r of records) {
    if (isPrivateHost(r.address)) {
      throw new EdgeError(
        "E_EDGE_PRIVATE",
        `hostname ${hostname} resolves to private address ${r.address}`,
        403,
      );
    }
  }
}

/**
 * Default fetcher: a pinned-connection request. DNS is resolved by the same
 * validating path as the pre-flight check, but the connection itself dials
 * the validated address, so a DNS rebinding attack between check and connect
 * cannot reach a private service. Host and TLS SNI stay the original
 * hostname (certificate validation is unaffected); the redirect chain is
 * re-validated by transcodeUrl per hop because this fetcher never follows
 * redirects (matching transcodeUrl's redirect: "manual" contract).
 */
function pinnedFetch(
  resolver: (hostname: string) => Promise<{ address: string; family: number }[]>,
  validate: boolean,
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const mod = u.protocol === "https:" ? httpsRequest : httpRequest;
    const records = await (validate
      ? resolver(u.hostname)
      : lookup(u.hostname, { all: true, verbatim: true }));
    if (validate) {
      for (const r of records) {
        if (isPrivateHost(r.address)) {
          throw new EdgeError("E_EDGE_PRIVATE", `hostname ${u.hostname} resolves to private address ${r.address}`, 403);
        }
      }
    }
    const record = records[0]!;
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    return await new Promise<Response>((resolve, reject) => {
      const req = mod(
        u,
        {
          method: init?.method ?? "GET",
          headers,
          // Dial the validated address; servername keeps SNI = hostname.
          host: record.address,
          servername: u.protocol === "https:" ? u.hostname : undefined,
          setHost: true,
          lookup: (_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, addr: string, family: number) => void) => {
            // The address is already pinned; hand it straight through.
            cb(null, record.address, record.family);
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const respHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            respHeaders.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
          const resp = new Response(body, { status, headers: respHeaders });
          // transcodeUrl falls back to the requested URL when resp.url is "".
          Object.defineProperty(resp, "url", { value: u.toString(), configurable: true });
          resolve(resp);
        },
      );
      req.on("error", reject);
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          req.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        } else {
          signal.addEventListener("abort", () => {
            req.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          });
        }
      }
      req.end();
    });
  };
}

export interface TranscodeResult {
  /** The final URL after redirects. */
  source: string;
  /** Canonical ad text (DOW-3). */
  canonical: string;
  doc: Doc;
  /** Audit notes from the downconverter (DOW-2). */
  notes: string[];
  /** Raw upstream HTML (for the human pane / raw passthrough). */
  html: string;
}

/**
 * Fetch a page and downconvert it to canonical ad. Checks response.ok
 * (upstream errors are data, not success), enforces the byte cap and
 * timeout, and re-checks the SSRF guard after redirects.
 */
export async function transcodeUrl(url: string, opts: EdgeOptions = {}): Promise<TranscodeResult> {
  const cfg = { ...DEFAULTS, ...opts };
  // DNS is checked per host (initial + every hop); injectable for tests.
  const defaultResolver = (h: string) => lookup(h, { all: true, verbatim: true });
  const resolver = opts.resolver ?? defaultResolver;
  // The default fetcher pins the connection to a validated address, closing
  // the resolve-then-connect rebinding window. An injected fetcher (tests)
  // keeps its own semantics.
  const fetcher = opts.fetcher ?? pinnedFetch(resolver, !opts.allowPrivate);
  const dnsCheck = (host: string): Promise<void> =>
    opts.allowPrivate ? Promise.resolve() : resolveChecked(host, resolver);

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
  await dnsCheck(u.hostname);

  // Follow redirects manually: each hop must pass the SSRF guard before it
  // is fetched. `redirect: "follow"` only re-checks the final URL, so a
  // chain attacker.com -> private host -> attacker.com would hit the private
  // host before any check runs.
  const MAX_REDIRECTS = 5;
  let resp: Response;
  let current = u.toString();
  for (let hop = 0; ; hop += 1) {
    try {
      resp = await fetcher(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
        headers: { "user-agent": cfg.userAgent, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new EdgeError("E_EDGE_TIMEOUT", `upstream timed out after ${cfg.fetchTimeoutMs}ms`, 504);
      }
      throw new EdgeError("E_EDGE_FETCH", `fetch failed: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    if (resp.status !== 301 && resp.status !== 302 && resp.status !== 303 && resp.status !== 307 && resp.status !== 308) {
      break;
    }
    if (hop >= MAX_REDIRECTS) {
      throw new EdgeError("E_EDGE_FETCH", `too many redirects (> ${MAX_REDIRECTS})`, 502);
    }
    const location = resp.headers.get("location");
    if (location === null) {
      break; // A redirect without a Location is the end of the chain.
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new EdgeError("E_EDGE_FETCH", `redirect location is not a valid URL: ${location}`, 502);
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new EdgeError("E_EDGE_SCHEME", `only http/https is supported, got ${next.protocol}`);
    }
    if (!opts.allowPrivate && isPrivateHost(next.hostname)) {
      throw new EdgeError("E_EDGE_PRIVATE", `redirect refused private host: ${next.hostname}`, 403);
    }
    await dnsCheck(next.hostname);
    current = next.toString();
  }

  if (!resp.ok) {
    throw new EdgeError("E_EDGE_FETCH", `upstream returned ${resp.status} ${resp.statusText}`, 502);
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
      // Never served as live HTML on the gateway origin (XSS / SSRF pivot).
      // The human pane uses a sandboxed iframe; raw itself is inert text.
      return { body: result.html, contentType: "text/plain; charset=utf-8" };
    case "canonical":
    default:
      return { body: result.canonical, contentType: "text/x-ad; charset=utf-8" };
  }
}
