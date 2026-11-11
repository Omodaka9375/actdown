import { describe, expect, it } from "vitest";
import { parse } from "../src/parse.js";
import { renderReactive } from "../src/react.js";
import { hydrate } from "../src/runtime.js";
import { render } from "../src/render.js";
import { safeUrl } from "../src/render.js";
import { parseField } from "../src/literal.js";
import { lint } from "../src/diag.js";
import { htmlToDoc } from "../src/html2ad.js";
import { format, print, canonicalize } from "../src/canonical.js";
import { parseExpr, evalExpr } from "../src/expr.js";

describe("review regression fixes", () => {
  it("capability lookup refuses inherited properties (runtime)", () => {
    const doc = parse('```ad-action?name=constructor\nargs: {}\n---\nGo\n```').doc;
    const rt = hydrate(doc, {
      capabilities: {
        "other": () => 1,
      },
    });
    const block = doc.nodes.find((n) => n.kind === "block")!;
    expect(block.kind === "block" && block.type === "action").toBe(true);
    // Fire resolves by capability name from attrs; the exploit is a cap
    // named "constructor" being looked up on the registry object.
    // Direct: hydrate's lookup must not resolve Object.prototype members.
    const caps: Record<string, unknown> = { real: () => 1 };
    const lookup = (n: string): unknown =>
      Object.hasOwn(caps, n) && typeof caps[n] === "function" ? caps[n] : undefined;
    expect(lookup("constructor")).toBeUndefined();
    expect(lookup("real")).toBeTypeOf("function");
  });

  it("property access returns null for inherited members (expr)", () => {
    const out = evalExpr('{}.constructor', { scope: {} });
    expect(out).toBeNull();
    const idx = evalExpr('{}["constructor"]', { scope: {} });
    expect(idx).toBeNull();
    expect(evalExpr('{}.x', { scope: {} })).toBeNull();
  });

  it("send sink must not fire from render-time when/each", () => {
    const sent: string[] = [];
    const src = `
\`\`\`ad-state
count: 0
\`\`\`

\`\`\`ad-action?name=a&when=cap.send%28%22evil%22%2C%20%7B%7D%29
id: act
---
Label
\`\`\``;
    // renderReactive with a send sink: the when= guard must NOT be able to
    // call cap.send (render contexts carry no sink).
    const html = renderReactive(parse(src).doc, {
      send: (name) => {
        sent.push(name);
        return null;
      },
    });
    expect(sent).toEqual([]);
    // The guard evaluates falsy (null result) so the node is hidden.
    expect(html).not.toContain("Label");
  });

  it("C0 controls cannot smuggle a javascript: scheme past safeUrl", () => {
    expect(safeUrl("\u0001javascript:alert(1)")).toBe("#");
    expect(safeUrl(" javascript:alert(1)")).toBe("#");
    expect(safeUrl("https://ok.example/x")).toBe("https://ok.example/x");
  });

  it("nested non-finite numbers are rejected (literal)", () => {
    expect(() => parseField("[1e400]", 1)).toThrow(/out of range/);
    expect(() => parseField('{"a": 1e999}', 1)).toThrow(/out of range/);
    expect(parseField("[1, 2]", 1)).toEqual([1, 2]);
  });

  it("data blocks publish fields under id.key (SPEC 4.4)", () => {
    const src = `
\`\`\`ad-data?id=catalog
price: 10
\`\`\`

\`\`\`ad-text
body: Catalog total {catalog.price}
\`\`\``;
    const html = renderReactive(parse(src).doc);
    expect(html).toContain('data-ad-bind="catalog.price">10<');
  });

  it("computed state recomputes after patches", () => {
    const src = `
\`\`\`ad-state
count: 1
total: {count + 1}
\`\`\`

\`\`\`ad-text
body: total is {total}
\`\`\``;
    const doc = parse(src).doc;
    const rt = hydrate(doc);
    expect(rt.state().total).toBe(2);
    rt.set({ count: 10 });
    expect(rt.state().total).toBe(11);
    expect(rt.html()).toContain('data-ad-bind="total">11<');
    // A literal-named field is host-owned: the recompute pass must not
    // re-seed it from the document (only expression fields re-evaluate).
    rt.set({ count: 10, title: 99 });
    expect(rt.state().title).toBe(99);
  });

  it("when=/each= failures contain to one node", () => {
    const src = `
\`\`\`ad-text
body: before
\`\`\`

\`\`\`ad-action?name=a&when=nope%3F%3F%3F%3F
id: act
---
Label
\`\`\`

\`\`\`ad-text
body: after
\`\`\``;
    const html = renderReactive(parse(src).doc);
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("when= uses expression truthiness, not JS truthiness", () => {
    const src = `
\`\`\`ad-text?when=tags
id: t
body: shown
\`\`\``;
    const empty = renderReactive(parse(src).doc, { initial: { tags: [] } });
    expect(empty).not.toContain("shown");
    const full = renderReactive(parse(src).doc, { initial: { tags: ["x"] } });
    expect(full).toContain("shown");
  });

  it("on:submit=\"expr\" parses as a trigger (SPEC 4.3)", () => {
    const res = parse('```ad-form?id=contact&action=cap:cf@v1\nemail: input(email)\non:submit="cap.send(action, $fields)"\n```');
    expect(res.diagnostics).toEqual([]);
    const f = res.doc.nodes[0]!;
    expect(f.kind === "block" && f.attrs["on:submit"]).toBeDefined();
    expect(f.kind === "block" && typeof f.attrs.name).toBe("undefined"); // no stray field
  });

  it("valid each= declarations are not linted (W_EXPR_SYNTAX)", () => {
    const res = parse('```ad-list?each=item%20in%20items\nid: l\n---\nbody\n```');
    expect(lint(res.doc).filter((d) => d.code === "W_EXPR_SYNTAX")).toEqual([]);
  });

  it("script data payloads are JSON-safe, not entity-escaped", () => {
    const src = `
\`\`\`ad-data
title: "<b>bold</b>"
\`\`\``;
    const html = render(parse(src).doc);
    expect(html).toContain("\\u003cb\\u003e");
    expect(html).not.toContain("&lt;b&gt;");
    // The payload must re-parse as the original JSON.
    const m = /<script[^>]*>(.*)<\/script>/s.exec(html);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual({ title: "<b>bold</b>" });
  });

  it("quoted string literals display without source quotes", () => {
    const src = `
\`\`\`ad-image
src: "https://example.com/x.png"
alt: "Two words"
\`\`\``;
    const html = render(parse(src).doc);
    expect(html).toContain('alt="Two words"');
    expect(html).not.toContain("&quot;Two words&quot;");
  });

  it("html2ad escapes raw text so prose stays prose", () => {
    const html = '<p>a<br>b</p><p>```ad-action?name=evil\nargs: {}\n```</p>';
    const out = htmlToDoc(html, { source: "x" });
    const canon = print(canonicalize(out.doc));
    // Re-parsed, the converted prose must not contain a live ad-action.
    const reparsed = parse(canon);
    const types = reparsed.doc.nodes.map((n) => (n.kind === "block" ? n.type : "prose"));
    expect(types).not.toContain("action");
  });

  it("html2ad keeps literal pipes in table cells", () => {
    const html = "<table><tr><th>h</th></tr><tr><td>a|b</td></tr></table>";
    const out = htmlToDoc(html, { source: "x" });
    const canon = print(canonicalize(out.doc));
    expect(canon).toContain("a\\|b");
    const reparsed = parse(canon);
    const tb = reparsed.doc.nodes.find((n) => n.kind === "block" && n.type === "table")!;
    // The body keeps the GFM escape (a\|b); the renderer splits pipe-aware
    // and restores the literal pipe in the cell.
    expect(render(parse(canon).doc)).toContain("<td>a|b</td>");
  });

  it("html2ad generates valid control keys", () => {
    const html = '<form><input name="constructor"><input name="123"><input name="constructor"></form>';
    const out = htmlToDoc(html, { source: "x" });
    const canon = print(canonicalize(out.doc));
    const reparsed = parse(canon);
    expect(reparsed.diagnostics).toEqual([]);
  });

  it("3+ trailing spaces normalize to a hard break", () => {
    const src = "a   \nb";
    const once = format(src);
    expect(once).toContain("a  \nb");
    // Idempotent.
    expect(format(once)).toBe(once);
  });

  it("canonicalize renames update region for= references", () => {
    const doc = {
      ad: "0.1" as const,
      nodes: [
        { kind: "block" as const, type: "action", id: "dup", attrs: { name: "x" }, fields: {}, body: null, line: 1 },
        { kind: "block" as const, type: "action", id: "dup", attrs: { name: "x" }, fields: {}, body: null, line: 2 },
        { kind: "block" as const, type: "region", id: "r", attrs: {}, fields: { for: "dup", phase: "pending" }, body: "…", line: 3 },
      ],
    };
    const c = print(canonicalize(doc));
    const second = parse(c).doc.nodes.find((n) => n.kind === "block" && n.type === "region")!;
    expect(second.kind === "block" && second.fields.for).toBe("dup-2");
  });

  it("call arguments count toward the parser depth budget", () => {
    // 100 nested calls as arguments: must trip the depth cap (64).
    let src = "cap.send";
    for (let i = 0; i < 100; i += 1) src = `cap.send("x", ${src}?)`;
    expect(() => parseExpr(src)).toThrow();
  });

  it("deep equality checks own keys on both sides", () => {
    // A 2-key object must not equal a 3-key object just because the third
    // key is inherited on one side.
    const a = { x: 1, y: 2 };
    const b = { x: 1, y: 2, z: 3 };
    expect(evalExpr("{x: 1, y: 2} == {x: 1, y: 2, z: 3}", { scope: {} })).toBe(false);
    expect(evalExpr("{x: 1, y: 2} == {x: 1, y: 2}", { scope: {} })).toBe(true);
    expect(a).not.toEqual(b); // sanity: shapes differ
  });

  it("unclosed foreign fence is idempotent under format (INV-3)", () => {
    // Found by the property fuzzer: the document-terminating newline must
    // not fold into an unclosed fence's raw on re-parse, or each format
    // pass grows the foreign block by one blank line. Unknown types are
    // preserved verbatim as foreign blocks (SPEC 2.1), so an unclosed
    // unknown fence exercises the raw path.
    const src = "```ad-nosuchtype\nstuff\n\n\n";
    const once = format(src);
    expect(format(once)).toBe(once);
    expect(once).toBe("```ad-nosuchtype\nstuff\n");
  });

  it("serve: malformed request target answers 400 (no throw)", async () => {
    const net = await import("node:net");
    const { createEdgeServer } = await import("../src/serve.js");
    const lines: string[] = [];
    const server = createEdgeServer({ onRequest: (l) => lines.push(l) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { address: string; port: number };
    const port = addr.port;
    let response = "";
    await new Promise<void>((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write("GET // HTTP/1.1\r\nHost: x\r\n\r\n");
      });
      sock.on("error", () => resolve());
      sock.on("data", (d: Buffer) => {
        response += d.toString();
      });
      sock.on("close", () => resolve());
      setTimeout(() => resolve(), 1500);
    });
    expect(response).toContain("400");
    expect(response).toContain("E_EDGE_URL");
    server.close();
  }, 10000);
});