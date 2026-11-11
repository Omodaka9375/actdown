import { afterEach, describe, expect, it } from "vitest";
import { EdgeError, formatConversion, isPrivateHost, transcodeUrl, type EdgeOptions } from "../src/edge.js";
import { createEdgeServer, parseTokenPairs } from "../src/serve.js";
import { createServer, request, type RequestListener, type Server } from "node:http";
import { AddressInfo } from "node:net";

const PAGE = `<!doctype html>
<html><head><title>Report</title><script>alert(1)</script></head>
<body>
<h1>Weekly report</h1>
<p>Revenue is <strong>up 12%</strong>.</p>
<button onclick="go()">Approve</button>
</body></html>`;

const ok = (body: string, contentType = "text/html; charset=utf-8"): Response =>
  new Response(body, { status: 200, headers: { "content-type": contentType } });

const fetcherOf = (resp: Response): typeof fetch => () => Promise.resolve(resp);

/** JSON parse with an explicit check (json-parse-must-validate). */
function parseJson(body: string): Record<string, unknown> {
  const v: unknown = JSON.parse(body);
  if (typeof v !== "object" || v === null) throw new Error("non-object JSON");
  return v as Record<string, unknown>;
}

function optsWith(resp: Response): EdgeOptions {
  return { fetcher: fetcherOf(resp), allowPrivate: true };
}

describe("edge core", () => {
  it("guards private and non-http targets (SSRF)", async () => {
    for (const url of [
      "http://127.0.0.1/x",
      "http://10.0.0.1/x",
      "http://192.168.1.4/x",
      "http://172.16.5.5/x",
      "http://169.254.169.254/latest/meta-data",
      "http://100.100.1.1/x",
      "http://localhost:8787/x",
      "http://[::1]:8787/x",
      "http://[fd00::1]/x",
      "http://[fe80::1]/x",
      // IPv4-mapped / embedded IPv6 forms of private targets.
      "http://[::ffff:127.0.0.1]/x",
      "http://[::ffff:7f00:1]/x",
      "http://[::ffff:169.254.169.254]/latest/meta-data",
      "http://[::ffff:a00:1]/x",
      "http://[::7f00:1]/x",
      "http://[2002:7f00:1::]/x",
      "http://[2001:0::1]/x",
      "file:///etc/passwd",
      "ftp://example.com/x",
    ]) {
      await expect(transcodeUrl(url)).rejects.toThrow(EdgeError);
    }
  });

  it("transcodes a fetched page to canonical ad (agents) and keeps the html (humans)", async () => {
    const result = await transcodeUrl("https://example.com/report", optsWith(ok(PAGE)));
    expect(result.source).toBe("https://example.com/report");
    expect(result.canonical).toContain("ad-");
    expect(result.canonical).toContain("# Weekly report");
    expect(result.canonical).toContain("**up 12%**");
    expect(result.html).toContain("<h1>Weekly report</h1>");
    // DOW-2 audit: script/style are dropped (silently), so nothing survives.
    expect(result.canonical).not.toContain("alert(");
    expect(result.notes).toBeInstanceOf(Array);
    expect(result.doc.nodes.length).toBeGreaterThan(0);
  });

  it("checks response.ok and the content type (fetch-must-check-ok)", async () => {
    await expect(transcodeUrl("https://x.test/a", optsWith(new Response("nope", { status: 404 })))).rejects.toThrow(/404/);
    await expect(
      transcodeUrl("https://x.test/a", optsWith(ok("{}", "application/json"))),
    ).rejects.toThrow(EdgeError);
  });

  it("enforces the byte cap while streaming", async () => {
    const big = new Response(new Uint8Array(1024 * 1024), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    await expect(
      transcodeUrl("https://x.test/big", { ...optsWith(big), maxBytes: 1024 }),
    ).rejects.toThrow(/exceeds 1024/);
  });

  it("maps fetch timeouts to E_EDGE_TIMEOUT", async () => {
    const slow: typeof fetch = () => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      return Promise.reject(e);
    };
    await expect(
      transcodeUrl("https://x.test/slow", {
        fetcher: slow,
        resolver: async () => [{ address: "1.2.3.4", family: 4 }],
      }),
    ).rejects.toMatchObject({
      code: "E_EDGE_TIMEOUT",
    });
  });

  it("resolves hostnames and refuses private results (SSRF: DNS stage)", async () => {
    // The public path: a hostname that resolves public is fetched normally.
    const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
    const result = await transcodeUrl("https://good.test/report", {
      fetcher: fetcherOf(ok(PAGE)),
      resolver: publicResolver,
    });
    expect(result.source).toBe("https://good.test/report");

    // A hostname that resolves private is refused before any fetch runs.
    let fetched = false;
    const probe: typeof fetch = () => {
      fetched = true;
      return Promise.resolve(ok(PAGE));
    };
    await expect(
      transcodeUrl("http://evil.test/x", {
        fetcher: probe,
        resolver: async () => [{ address: "10.0.0.5", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "E_EDGE_PRIVATE" });
    expect(fetched).toBe(false);

    await expect(
      transcodeUrl("http://evil.test/x", {
        fetcher: probe,
        resolver: async () => [{ address: "fd00::1", family: 6 }],
      }),
    ).rejects.toMatchObject({ code: "E_EDGE_PRIVATE" });

    // Resolution failure is a fetch error, not a silent pass-through.
    await expect(
      transcodeUrl("http://gone.test/x", {
        fetcher: probe,
        resolver: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toMatchObject({ code: "E_EDGE_FETCH" });
  });

  it("re-checks DNS on every redirect hop (SSRF: rebinding via redirect)", async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: "http://hop.test/x" } }));
    const resolver = async (host: string) =>
      host === "hop.test" ? [{ address: "192.168.0.9", family: 4 }] : [{ address: "1.2.3.4", family: 4 }];
    await expect(transcodeUrl("http://start.test/x", { fetcher, resolver })).rejects.toMatchObject({
      code: "E_EDGE_PRIVATE",
    });
  });

  it("adversarial redirects: loop, malformed Location, scheme downgrade, over-cap chain", async () => {
    // Redirect loop: the hop cap bounds it (never hangs).
    let hops = 0;
    const loop: typeof fetch = () => {
      hops += 1;
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://loop.test/x" } }));
    };
    const publicResolve = async () => [{ address: "1.2.3.4", family: 4 }];
    await expect(transcodeUrl("http://loop.test/x", { fetcher: loop, resolver: publicResolve })).rejects.toMatchObject({
      code: "E_EDGE_FETCH",
    });
    expect(hops).toBe(6); // 1 initial + 5 capped follow-ups

    // A redirect whose Location is not a valid URL is a fetch error.
    const badLoc: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: "http://\u0000junk" } }));
    await expect(transcodeUrl("http://start.test/x", { fetcher: badLoc, resolver: publicResolve })).rejects.toMatchObject({
      code: "E_EDGE_FETCH",
    });

    // A redirect with no Location header ends the chain, then fails on ok().
    const noLoc: typeof fetch = () => Promise.resolve(new Response(null, { status: 302 }));
    await expect(transcodeUrl("http://start.test/x", { fetcher: noLoc, resolver: publicResolve })).rejects.toMatchObject({
      code: "E_EDGE_FETCH",
    });

    // A redirect that downgrades to a non-http(s) scheme is refused.
    const toFtp: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: "ftp://example.com/x" } }));
    await expect(transcodeUrl("http://start.test/x", { fetcher: toFtp, resolver: publicResolve })).rejects.toMatchObject({
      code: "E_EDGE_SCHEME",
    });

    // Six distinct hops (one past the cap of 5) are refused.
    let n = 0;
    const chain: typeof fetch = (input) => {
      const u = new URL(typeof input === "string" ? input : input.url);
      n += 1;
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: `http://h${n}.test/${u.pathname}` } }),
      );
    };
    await expect(transcodeUrl("http://h0.test/x", { fetcher: chain, resolver: publicResolve })).rejects.toMatchObject({
      code: "E_EDGE_FETCH",
    });

    // A 307/308 chain keeps the method contract; the guard still applies per hop.
    const permanent: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 308, headers: { location: "http://192.168.1.1/x" } }));
    await expect(transcodeUrl("http://start.test/x", { fetcher: permanent, resolver: publicResolve })).rejects.toMatchObject({
      code: "E_EDGE_PRIVATE",
    });
  });

  it("adversarial redirect: private hop mid-chain via literal host is refused before fetching it", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = (input) => {
      const u = new URL(typeof input === "string" ? input : input.url);
      seen.push(u.hostname);
      if (u.hostname === "attacker.test") {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
        );
      }
      return Promise.resolve(ok(PAGE));
    };
    await expect(
      transcodeUrl("http://attacker.test/x", { fetcher, resolver: async () => [{ address: "1.2.3.4", family: 4 }] }),
    ).rejects.toMatchObject({ code: "E_EDGE_PRIVATE" });
    // The metadata service was never contacted.
    expect(seen).toEqual(["attacker.test"]);
  });

  it("serves every format from one conversion", async () => {
    const result = await transcodeUrl("https://example.com/r", optsWith(ok(PAGE)));
    const canonical = formatConversion(result, "canonical");
    expect(canonical.contentType).toBe("text/x-ad; charset=utf-8");
    const ast = formatConversion(result, "ast");
    expect(ast.contentType).toBe("application/json; charset=utf-8");
    expect(parseJson(ast.body)).toMatchObject({ ad: "0.1" });
    const html = formatConversion(result, "html");
    expect(html.contentType).toBe("text/html; charset=utf-8");
    expect(html.body).toContain("<h1>Weekly report</h1>");
  });
});

describe("edge gateway (live HTTP)", () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  const listen = (handler: RequestListener): Promise<number> =>
    new Promise((resolve) => {
      const s = createServer(handler);
      servers.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port));
    });

  it("end to end: fixture page through the gateway to canonical ad", async () => {
    const upstreamPort = await listen((req, res) => {
      if ((req.url ?? "").split("?")[0] !== "/report") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    });
    const edge = createEdgeServer({ allowPrivate: true, onRequest: () => {} });
    servers.push(edge);
    const edgePort = await new Promise<number>((resolve) => {
      edge.listen(0, "127.0.0.1", () => resolve((edge.address() as AddressInfo).port));
    });
    const base = `http://127.0.0.1:${edgePort}`;
    const upstream = `http://127.0.0.1:${upstreamPort}/report`;

    const canonical = await fetch(`${base}/transcode?url=${encodeURIComponent(upstream)}`);
    expect(canonical.status).toBe(200);
    expect(canonical.headers.get("content-type")).toBe("text/x-ad; charset=utf-8");
    const text = await canonical.text();
    expect(text).toContain("ad-");
    expect(text).toContain("# Weekly report");

    const ast = await fetch(`${base}/transcode?url=${encodeURIComponent(upstream)}&format=ast`);
    expect(ast.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(parseJson(await ast.text())).toMatchObject({ ad: "0.1" });

    const rendered = await fetch(`${base}/transcode?url=${encodeURIComponent(upstream)}&format=html`);
    expect(await rendered.text()).toContain("<h1>Weekly report</h1>");

    const raw = await fetch(`${base}/transcode?url=${encodeURIComponent(upstream)}&format=raw`);
    expect(await raw.text()).toContain("alert(1)"); // humans still get the original
    // ...but as inert text, and any HTML surface is CSP-sandboxed (no script on this origin).
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(rendered.headers.get("content-security-policy")).toContain("sandbox");

    // Upstream failure surfaces as JSON with the right code.
    const fail = await fetch(`${base}/transcode?url=${encodeURIComponent(`http://127.0.0.1:${upstreamPort}/missing`)}`);
    expect(fail.status).toBe(502);
    expect(((await fail.json()) as { code: string }).code).toBe("E_EDGE_FETCH");

    // Guard is off in this deployment (allowPrivate); UI pages exist.
    const home = await fetch(base);
    expect(await home.text()).toContain("actdown edge");
  });

  it("enforces rate limit, body cap, concurrency cap, and /healthz", async () => {
    // Rate limit: fixed window per IP, third request refused.
    const rateEdge = createEdgeServer({ rateLimit: 2, onRequest: () => {} });
    servers.push(rateEdge);
    const ratePort = await new Promise<number>((resolve) => {
      rateEdge.listen(0, "127.0.0.1", () => resolve((rateEdge.address() as AddressInfo).port));
    });
    const rateBase = `http://127.0.0.1:${ratePort}`;
    expect((await fetch(`${rateBase}/healthz`)).status).toBe(200);
    expect((await fetch(`${rateBase}/healthz`)).status).toBe(200);
    const limited = await fetch(`${rateBase}/healthz`);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe("E_EDGE_RATE");

    // Body cap: a GET declaring an oversized body is refused before routing.
    const sizeEdge = createEdgeServer({ maxRequestBodyBytes: 8 });
    servers.push(sizeEdge);
    const sizePort = await new Promise<number>((resolve) => {
      sizeEdge.listen(0, "127.0.0.1", () => resolve((sizeEdge.address() as AddressInfo).port));
    });
    const oversized = await new Promise<{ status: number; code: string }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: sizePort, path: "/healthz", method: "GET", headers: { "content-length": "64" } },
        (r) => {
          let body = "";
          r.on("data", (c: Buffer) => {
            body += c.toString();
          });
          r.on("end", () => resolve({ status: r.statusCode ?? 0, code: (JSON.parse(body) as { code: string }).code }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(oversized.status).toBe(413);
    expect(oversized.code).toBe("E_EDGE_TOO_LARGE");

    // Concurrency cap: a slow upstream holds its slot; the next request 503s.
    const slowUpstream = await listen((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
      }, 150);
    });
    const busyEdge = createEdgeServer({ allowPrivate: true, maxConcurrent: 1, onRequest: () => {} });
    servers.push(busyEdge);
    const busyPort = await new Promise<number>((resolve) => {
      busyEdge.listen(0, "127.0.0.1", () => resolve((busyEdge.address() as AddressInfo).port));
    });
    const busyBase = `http://127.0.0.1:${busyPort}`;
    const upstream = `http://127.0.0.1:${slowUpstream}/report`;
    const first = fetch(`${busyBase}/transcode?url=${encodeURIComponent(upstream)}`);
    const second = await fetch(`${busyBase}/transcode?url=${encodeURIComponent(upstream)}`);
    expect(second.status).toBe(503);
    expect(((await second.json()) as { code: string }).code).toBe("E_EDGE_BUSY");
    expect((await first).status).toBe(200);
  });

  it("refuses private targets when the guard is on", async () => {    const edge = createEdgeServer({});
    servers.push(edge);
    const port = await new Promise<number>((resolve) => {
      edge.listen(0, "127.0.0.1", () => resolve((edge.address() as AddressInfo).port));
    });
    const resp = await fetch(`http://127.0.0.1:${port}/transcode?url=${encodeURIComponent("http://127.0.0.1:1/x")}`);
    expect(resp.status).toBe(403);
    expect(((await resp.json()) as { code: string }).code).toBe("E_EDGE_PRIVATE");
  });
});

describe("edge gateway auth (untrusted networks)", () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  const TOKEN = "s3cret-edge-token-value";

  const start = async (opts: Parameters<typeof createEdgeServer>[0]): Promise<string> => {
    const edge = createEdgeServer(opts);
    servers.push(edge);
    return new Promise((resolve) => {
      edge.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(edge.address() as AddressInfo).port}`));
    });
  };

  it("refuses missing, wrong, and malformed credentials (401 E_EDGE_UNAUTHORIZED)", async () => {
    const base = await start({ authToken: TOKEN, onRequest: () => {} });

    // /healthz stays open: it is a liveness probe and reveals nothing.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    const missing = await fetch(`${base}/transcode?url=${encodeURIComponent("https://example.com/x")}`);
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { code: string }).code).toBe("E_EDGE_UNAUTHORIZED");
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    const wrong = await fetch(`${base}/?token=not-the-token`);
    expect(wrong.status).toBe(401);

    // A malformed Authorization header is an error, not a fallthrough to ?token=.
    const malformed = await fetch(`${base}/?token=${encodeURIComponent(TOKEN)}`, {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(malformed.status).toBe(401);
  });

  it("accepts the token via Bearer header (agents) and ?token= (browser UI)", async () => {
    // A fresh Response per call: response bodies are one-shot.
    const base = await start({
      authToken: TOKEN,
      allowPrivate: true,
      fetcher: async () => ok(PAGE),
      onRequest: () => {},
    });

    const viaHeader = await fetch(`${base}/transcode?url=${encodeURIComponent("https://example.com/r")}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.headers.get("content-type")).toBe("text/x-ad; charset=utf-8");
    expect(await viaHeader.text()).toContain("# Weekly report");

    const viaQuery = await fetch(
      `${base}/transcode?url=${encodeURIComponent("https://example.com/r")}&token=${encodeURIComponent(TOKEN)}`,
    );
    expect(viaQuery.status).toBe(200);
  });

  it("propagates the token into the view iframes and redacts it from logs", async () => {
    const lines: string[] = [];
    const base = await start({
      authToken: TOKEN,
      allowPrivate: true,
      fetcher: async () => ok(PAGE),
      onRequest: (l) => lines.push(l),
    });

    const page = await fetch(
      `${base}/view?url=${encodeURIComponent("https://example.com/r")}&token=${encodeURIComponent(TOKEN)}`,
    );
    expect(page.status).toBe(200);
    const body = await page.text();
    // Both iframes (rendered + canonical) and the hidden form field carry the
    // token, so the browser UI keeps working without setting headers.
    expect(body.split(`&amp;token=${TOKEN}`).length - 1).toBe(2);
    expect(body).toContain(`value="${TOKEN}"`);
    // ...but the request log must not.
    expect(lines.some((l) => l.includes(TOKEN))).toBe(false);
    expect(lines.some((l) => l.includes("token=REDACTED"))).toBe(true);
  });

  it("per-identity tokens: each token authenticates as its own identity, rotation without restart", async () => {
    const base = await start({
      authTokens: parseTokenPairs("# ci token\nbot=circle-ci-token-0123456789\nhuman=alice-token-0123456789"),
      allowPrivate: true,
      fetcher: async () => ok(PAGE),
    });

    // Each valid token authenticates; the identity is recorded on the log.
    for (const t of ["circle-ci-token-0123456789", "alice-token-0123456789"]) {
      const r = await fetch(`${base}/healthz`, { headers: { authorization: `Bearer ${t}` } });
      expect(r.status).toBe(200);
    }
    const bad = await fetch(`${base}/transcode?url=https://example.com/r`, {
      headers: { authorization: "Bearer wrong-token-0123456789" },
    });
    expect(bad.status).toBe(401);

    // Rotation: a function-valued token set is re-read per request, so a
    // server started against a mutable set picks up changes live.
    const mutable = { text: "bot=old-token-0123456789abcdef" };
    const rotBase = await start({
      authTokens: () => parseTokenPairs(mutable.text),
      allowPrivate: true,
      fetcher: async () => ok(PAGE),
    });
    const url = `${rotBase}/transcode?url=${encodeURIComponent("https://example.com/r")}`;
    const before = await fetch(url, { headers: { authorization: "Bearer old-token-0123456789abcdef" } });
    expect(before.status).toBe(200);
    mutable.text = "bot=new-token-fedcba987654321\nhuman=old-token-0123456789abcdef";
    const rotated = await fetch(url, { headers: { authorization: "Bearer new-token-fedcba987654321" } });
    expect(rotated.status).toBe(200);
    const oldStillValid = await fetch(url, { headers: { authorization: "Bearer old-token-0123456789abcdef" } });
    expect(oldStillValid.status).toBe(200); // grace overlap works
    mutable.text = "bot=new-token-fedcba987654321";
    const revoked = await fetch(url, { headers: { authorization: "Bearer old-token-0123456789abcdef" } });
    expect(revoked.status).toBe(401); // then it is gone
  });

  it("trustProxy: rate bucket keys on X-Forwarded-For when enabled, socket IP otherwise", async () => {
    // Two forged-header clients share a bucket when trustProxy is on: the
    // shared 2-request budget below proves the key came from the header.
    const startTight = async (trustProxy: boolean): Promise<string> =>
      start({ trustProxy, rateLimit: 2, onRequest: () => {} });
    const base = await startTight(true);
    const fwd = async (): Promise<number> =>
      (await fetch(`${base}/healthz`, { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } })).status;
    expect(await fwd()).toBe(200);
    expect(await fwd()).toBe(200);
    expect(await fwd()).toBe(429); // same forged bucket
    // Different forwarded IP gets its own bucket.
    const other = await fetch(`${base}/healthz`, { headers: { "x-forwarded-for": "203.0.113.8" } });
    expect(other.status).toBe(200);

    // Without trustProxy the socket address is the key: forged XFF values
    // do NOT create distinct buckets (all three requests share one).
    const plainBase = await startTight(false);
    const p1 = await fetch(`${plainBase}/healthz`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    const p2 = await fetch(`${plainBase}/healthz`, { headers: { "x-forwarded-for": "203.0.113.8" } });
    const p3 = await fetch(`${plainBase}/healthz`, { headers: { "x-forwarded-for": "203.0.113.7" } });
    expect([p1.status, p2.status, p3.status]).toEqual([200, 200, 429]);
  });

  it("native TLS (opts.tls): serves https with the same routes", async () => {
    let cert: string;
    let key: string;
    try {
      ({ cert, key } = (await import("../src/testcert.js")).selfSignedCert("actdown-test"));
    } catch {
      return; // openssl unavailable: TLS covered in docs/CI
    }
    if (cert === "") return; // openssl unavailable: TLS covered in docs/CI
    const https = await import("node:https");
    const edge = createEdgeServer({
      tls: { key, cert },
      allowPrivate: true,
      fetcher: async () => ok(PAGE),
    });
    servers.push(edge as unknown as Server);
    const port = await new Promise<number>((resolve) => {
      edge.listen(0, "127.0.0.1", () => resolve((edge.address() as AddressInfo).port));
    });
    const agent = new https.Agent({ rejectUnauthorized: false });
    const status = await new Promise<number>((resolve, reject) => {
      const req = https.request({ host: "127.0.0.1", port, path: "/healthz", agent, method: "GET" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    // A real transcode over TLS answers canonical ad.
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port, path: `/transcode?url=${encodeURIComponent("https://example.com/r")}`, agent },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c.toString()));
          res.on("end", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(body).toContain("ad-");
  });
});
