import { describe, expect, it } from "vitest";
import { canonicalize, parse, render, renderMarkdown, parseField, parseExpr, evalExpr } from "../src/index.js";
import { decodeEntities, parseHtml } from "../src/htmlparse.js";
import type { BlockNode } from "../src/index.js";

function blockOf(src: string): BlockNode {
  const { doc } = parse(src);
  const n = doc.nodes[0]!;
  if (n.kind !== "block" || "foreign" in n) throw new Error("expected a parsed block");
  return canonicalize({ ad: "0.1", nodes: [n] }).nodes[0] as BlockNode;
}

describe("prose renderer", () => {
  it("renders headings, paragraphs, lists, fences, inline styles", () => {
    const html = renderMarkdown(
      ["# Title", "", "Hello **bold** *em* `code` [x](https://e.x)", "", "- a", "- b", "", "```js", "a < b;", "```"].join("\n"),
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://e.x">x</a>');
    expect(html).toContain("<li>a</li>");
    expect(html).toContain('<pre><code class="language-js">a &lt; b;</code></pre>');
  });

  it("escapes raw HTML in prose", () => {
    expect(renderMarkdown("<script>x</script>")).not.toContain("<script>");
  });

  it("escapes markdown link hrefs and neutralizes script URLs", () => {
    // A quote in the href must not break out of the attribute.
    const hostile = renderMarkdown('[t](x"onmouseover=alert(1))');
    expect(hostile).not.toContain('"onmouseover'); // no live attribute breakout
    expect(hostile).toContain("&quot;"); // quote is escaped instead
    expect(renderMarkdown("[t](javascript:alert(1))")).not.toContain("javascript:");
    expect(renderMarkdown("[t](data:text/html,x)")).not.toContain("data:text/html");
    // Relative and http(s) links still pass through untouched.
    expect(renderMarkdown("[t](/a/b)")).toContain('<a href="/a/b">');
    expect(renderMarkdown("[t](https://e.x)")).toContain('<a href="https://e.x">');
  });
});

describe("block rendering (Appendix A)", () => {  it("renders ad-action as a button with data-ad-id and label", () => {
    const html = render({ ad: "0.1", nodes: [blockOf("```ad-action?name=cart.add&role=primary&on:click\nargs: {}\n---\nAdd to cart\n```")] });
    expect(html).toMatch(/^<button data-ad-id="h[0-9a-f]{10}" role="primary">Add to cart<\/button>$/);
  });

  it("renders unregistered capabilities disabled with data-cap-missing", () => {
    const b = blockOf("```ad-action?name=cart.add\n---\nGo\n```");
    const html = render({ ad: "0.1", nodes: [b] }, { registry: { has: () => false } });
    expect(html).toContain("data-cap-missing");
    expect(html).toContain("disabled");
  });

  it("renders registered capabilities enabled", () => {
    const b = blockOf("```ad-action?name=cart.add\n---\nGo\n```");
    const html = render({ ad: "0.1", nodes: [b] }, { registry: { has: (n) => n === "cart.add" } });
    expect(html).not.toContain("data-cap-missing");
  });

  it("renders ad-action with href as an anchor", () => {
    const b = blockOf("```ad-action?name=nav.open&href=%2Fdocs\n---\nDocs\n```");
    expect(render({ ad: "0.1", nodes: [b] })).toContain('<a href="/docs"');
  });

  it("renders ad-form controls with name and id", () => {
    const b = blockOf("```ad-form\nid: contact\nemail: input(email, required)\nmessage: textarea(maxlength=500)\nsend: submit(label=\"Send\")\n```");
    const html = render({ ad: "0.1", nodes: [b] });
    expect(html).toContain('<input type="email" name="email" id="contact.email" required>');
    expect(html).toContain('<textarea name="message" id="contact.message"');
    expect(html).toContain('<button type="submit" id="contact.send">Send</button>');
  });

  it("renders ad-table from parsed GFM rows", () => {
    const b = blockOf("```ad-table\nrole: table\n---\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```");
    const html = render({ ad: "0.1", nodes: [b] });
    expect(html).toContain("<thead><tr><th>a</th><th>b</th></tr></thead>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders ad-image, ad-link, ad-data and chart fallback", () => {
    const img = render({ ad: "0.1", nodes: [blockOf("```ad-image\nsrc: a.png\nalt: A\nwidth: 320\n```")] });
    expect(img).toBe('<img src="a.png" alt="A" width="320">');
    const data = render({ ad: "0.1", nodes: [blockOf("```ad-data\nprice: 9\n```")] });
    expect(data).toContain('type="application/x-ad-data"');
    expect(data).toContain('{"price":9}');
    const chart = render({ ad: "0.1", nodes: [blockOf("```ad-chart\ntype: line\n```")] });
    expect(chart).toContain('data-ad-chart="line"');
  });

  it("renders ad-chart table fallbacks and refuses mixed shapes", () => {
    const rows = render({ ad: "0.1", nodes: [blockOf("```ad-chart\ntype: line\ncolumns: [\"x\", \"y\"]\ndata: [[1, 2], [3, 4]]\n```")] });
    expect(rows).toContain('data-ad-chart="line">');
    expect(rows).toContain("<thead><tr><th>x</th><th>y</th></tr></thead>");
    expect(rows).toContain("<tr><td>1</td><td>2</td></tr>");
    const objs = render({ ad: "0.1", nodes: [blockOf('```ad-chart\ntype: bar\ndata: [{"a": 1, "b": 2}, {"a": 3, "b": 4}]\n```')] });
    expect(objs).toContain("<thead><tr><th>a</th><th>b</th></tr></thead>");
    const flat = render({ ad: "0.1", nodes: [blockOf("```ad-chart\ntype: spark\ndata: [2, 3]\n```")] });
    expect(flat).toContain("<tr><td>2</td></tr>");
    expect(flat).not.toContain("<thead>");
    // Mixed shapes have no deterministic table: the figure stays empty.
    const mixed = render({ ad: "0.1", nodes: [blockOf('```ad-chart\ntype: line\ndata: [[1, 2], "nope"]\n```')] });
    expect(mixed.endsWith("</figure>")).toBe(true);
    expect(mixed).not.toContain("<table>");
  });

  it("renders ad-list from body markers or the items field", () => {
    const body = render({ ad: "0.1", nodes: [blockOf("```ad-list\n---\n- one\n- two\n```")] });
    expect(body).toContain("<ul");
    expect(body).toContain("<li>one</li>");
    const orderedBody = render({ ad: "0.1", nodes: [blockOf("```ad-list\n---\n1. one\n2. two\n```")] });
    expect(orderedBody).toContain("<ol ");
    const items = render({ ad: "0.1", nodes: [blockOf('```ad-list\nordered: true\nitems: ["a", "b"]\n```')] });
    expect(items).toContain("<ol ");
    expect(items).toContain("<li>a</li>");
  });

  it("renders bindings as data-ad-bind spans", () => {
    const html = renderMarkdown("Clicked {count} times");
    expect(html).toContain('<span data-ad-bind="count"></span>');
  });

  it("renders foreign blocks as escaped code", () => {
    const { doc } = parse("```ad-widget\nmystery: true\n```");
    const html = render(doc);
    expect(html).toContain("<pre><code>");
    expect(html).not.toContain("<script");
  });
});

describe("robustness (review fixes)", () => {
  it("decodes out-of-range numeric entities to U+FFFD instead of throwing", () => {
    expect(decodeEntities("&#x110000; &#99999999999; &#65;")).toBe("\ufffd \ufffd A");
  });

  it("refuses non-finite numeric literals", () => {
    expect(() => parseField("1e999", 1)).toThrow(/out of range/);
    expect(parseField("1e308", 1)).toBe(1e308);
  });

  it("bounds expression parser nesting with E_EXPR_DEPTH, not a stack overflow", () => {
    const deep = "(".repeat(5000) + "1" + ")".repeat(5000);
    expect(() => parseExpr(deep)).toThrowError(expect.objectContaining({ code: "E_EXPR_DEPTH" }) as Error);
    const deepIdx = "a" + "[".repeat(5000) + "0" + "]".repeat(5000);
    expect(() => parseExpr(deepIdx)).toThrowError(expect.objectContaining({ code: "E_EXPR_DEPTH" }) as Error);
  });

  it("compares large finite numbers without a spurious overflow error", () => {
    expect(evalExpr("1e308 < 1e308", { scope: {} })).toBe(false);
    expect(evalExpr("1e308 <= 1e308", { scope: {} })).toBe(true);
    // Arithmetic that really overflows still errors.
    expect(() => evalExpr("1e308 + 1e308", { scope: {} })).toThrow(/non-finite/);
  });

  it("rejects duplicate attributes in an info string", () => {
    const { diagnostics } = parse("```ad-action?name=a&name=b\n---\nGo\n```");
    expect(diagnostics.some((d) => d.code === "E_DUPLICATE_KEY")).toBe(true);
  });

  it("canonicalize de-duplicates colliding explicit ids", () => {
    const d = canonicalize({
      ad: "0.1",
      nodes: [
        { kind: "block", type: "link", id: "x", attrs: {}, fields: { href: "a" }, body: "A", line: 1 },
        { kind: "block", type: "link", id: "x", attrs: {}, fields: { href: "b" }, body: "B", line: 2 },
      ],
    });
    const ids = d.nodes.map((n) => (n.kind === "block" ? n.id : ""));
    expect(new Set(ids).size).toBe(2);
  });

  it("parses quoted > inside attribute values without leaking text", () => {
    const t = parseHtml('<p title="a>b">x</p>');
    const p = t.children[0]!;
    expect(typeof p).not.toBe("string");
    if (typeof p !== "string") {
      expect(p.attrs.title).toBe("a>b");
      expect(p.children).toEqual(["x"]);
    }
  });
});
