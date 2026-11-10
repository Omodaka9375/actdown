import { afterEach, describe, expect, it } from "vitest";
import { EdgeError, formatConversion, isPrivateHost, transcodeUrl, type EdgeOptions } from "../src/edge.js";
import { createEdgeServer } from "../src/serve.js";
import { createServer, type RequestListener, type Server } from "node:http";
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
    await expect(transcodeUrl("https://x.test/slow", { fetcher: slow })).rejects.toMatchObject({
      code: "E_EDGE_TIMEOUT",
    });
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

  it("refuses private targets when the guard is on", async () => {
    const edge = createEdgeServer({});
    servers.push(edge);
    const port = await new Promise<number>((resolve) => {
      edge.listen(0, "127.0.0.1", () => resolve((edge.address() as AddressInfo).port));
    });
    const resp = await fetch(`http://127.0.0.1:${port}/transcode?url=${encodeURIComponent("http://127.0.0.1:1/x")}`);
    expect(resp.status).toBe(403);
    expect(((await resp.json()) as { code: string }).code).toBe("E_EDGE_PRIVATE");
  });
});
