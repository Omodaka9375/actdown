import { afterEach, describe, expect, it } from "vitest";
import { TOOLS, setTranscodeOptions } from "../src/mcp.js";
import type { EdgeOptions } from "../src/edge.js";

/**
 * Unit coverage for the stdio MCP tool registry (the wire surface is
 * exercised by scripts/mcp-smoke.mjs). The transcode tool's happy path runs
 * with an injected fetcher so the suite never touches the network; options
 * are restored after each test so the guard-stack defaults never leak.
 */

const PAGE = `<!doctype html>
<html><head><title>Report</title><script>alert(1)</script></head>
<body><h1>Weekly report</h1><p>Revenue is <strong>up 12%</strong>.</p></body></html>`;

const okPage = (): Response =>
  new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

afterEach(() => {
  setTranscodeOptions({});
});

describe("mcp tools", () => {
  it("registers the seven tools with schemas", () => {
    expect(Object.keys(TOOLS).sort()).toEqual([
      "actdown_ast",
      "actdown_canonical",
      "actdown_check",
      "actdown_html",
      "actdown_html2ad",
      "actdown_render",
      "actdown_transcode",
    ]);
    for (const t of Object.values(TOOLS)) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("transcode happy path: fetch, downconvert, no scripts in output", async () => {
    const opts: EdgeOptions = {
      allowPrivate: true,
      fetcher: async () => okPage(),
    };
    setTranscodeOptions(opts);
    const out = await TOOLS["actdown_transcode"]!.run({ url: "http://fixture.test/report" });
    const payload = JSON.parse(out.content[0]!.text) as {
      source: string;
      canonical: string;
      notes: string[];
      format: string;
    };
    expect(payload.format).toBe("canonical");
    expect(payload.source).toBe("http://fixture.test/report");
    expect(payload.canonical).toContain("# Weekly report");
    expect(payload.canonical).toContain("**up 12%**");
    expect(payload.canonical).not.toContain("alert(");
    expect(Array.isArray(payload.notes)).toBe(true);
  });

  it("transcode ast and html formats post-process the same conversion", async () => {
    setTranscodeOptions({ allowPrivate: true, fetcher: async () => okPage() });
    const tool = TOOLS["actdown_transcode"]!;
    const ast = JSON.parse((await tool.run({ url: "http://f.test/r", format: "ast" })).content[0]!.text) as {
      format: string;
      ast: { ad: string };
    };
    expect(ast.format).toBe("ast");
    expect(ast.ast.ad).toBe("0.1");
    const html = JSON.parse((await tool.run({ url: "http://f.test/r", format: "html" })).content[0]!.text) as {
      format: string;
      html: string;
    };
    expect(html.format).toBe("html");
    expect(html.html).toContain("<h1>Weekly report</h1>");
  });

  it("transcode errors are structured JSON, not thrown", async () => {
    const tool = TOOLS["actdown_transcode"]!;
    const bad = await tool.run({ url: "not a url" });
    expect(JSON.parse(bad.content[0]!.text)).toMatchObject({ error: { code: "E_EDGE_URL" } });
    const scheme = await tool.run({ url: "ftp://example.com/x" });
    expect(JSON.parse(scheme.content[0]!.text)).toMatchObject({ error: { code: "E_EDGE_SCHEME" } });
    const unknownFormat = await tool.run({ url: "http://f.test/r", format: "nope" });
    expect(JSON.parse(unknownFormat.content[0]!.text)).toMatchObject({
      error: { code: "E_EDGE_FORMAT", message: "unknown format: nope" },
    });
    expect(unknownFormat.isError).toBe(true);
    const raw = await tool.run({ url: "http://f.test/r", format: "raw" });
    expect(raw.isError).toBe(true);
    expect(JSON.parse(raw.content[0]!.text)).toMatchObject({ error: { code: "E_EDGE_FORMAT" } });
  });

  it("transcode keeps the SSRF guard by default (no options leak between tests)", async () => {
    // Default options: a loopback target is refused before any fetch.
    const out = await TOOLS["actdown_transcode"]!.run({ url: "http://127.0.0.1:9/x" });
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ error: { code: "E_EDGE_PRIVATE" } });
  });

  it("html2ad keeps anti-cloaking notes flowing through the tool", async () => {
    const out = await TOOLS["actdown_html2ad"]!.run({
      html: '<p>ok</p><span style="display:none">smuggled</span>',
      source: "https://example.com/x",
    });
    const payload = JSON.parse(out.content[0]!.text) as { notes: string[]; canonical: string };
    expect(payload.notes.join(" ")).toContain("hidden content dropped: 1");
    expect(payload.canonical).not.toContain("smuggled");
  });
});
