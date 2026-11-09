import { describe, expect, it } from "vitest";
import { canonicalize, parse, render, renderMarkdown, parseField, parseExpr, evalExpr } from "../src/index.js";
import { decodeEntities, parseHtml } from "../src/htmlparse.js";
import type { BlockNode } from "../src/index.js";

function blockOf(src: string): BlockNode {
  const { doc } = parse(src);
  const n = doc.nodes[0]!;
  if (n.kind !== "block" || "foreign" in n) throw new Error("expected a parsed block");
  return canonicalize({ hdm: "0.1", nodes: [n] }).nodes[0] as BlockNode;
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

describe("block rendering (Appendix A)", () => {  it("renders hdm-action as a button with data-hdm-id and label", () => {
    const html = render({ hdm: "0.1", nodes: [blockOf("```hdm-action?name=cart.add&role=primary&on:click\nargs: {}\n---\nAdd to cart\n```")] });
    expect(html).toMatch(/^<button data-hdm-id="h[0-9a-f]{10}" role="primary">Add to cart<\/button>$/);
  });

  it("renders unregistered capabilities disabled with data-cap-missing", () => {
    const b = blockOf("```hdm-action?name=cart.add\n---\nGo\n```");
    const html = render({ hdm: "0.1", nodes: [b] }, { registry: { has: () => false } });
    expect(html).toContain("data-cap-missing");
    expect(html).toContain("disabled");
  });

  it("renders registered capabilities enabled", () => {
    const b = blockOf("```hdm-action?name=cart.add\n---\nGo\n```");
    const html = render({ hdm: "0.1", nodes: [b] }, { registry: { has: (n) => n === "cart.add" } });
    expect(html).not.toContain("data-cap-missing");
  });

  it("renders hdm-action with href as an anchor", () => {
    const b = blockOf("```hdm-action?name=nav.open&href=%2Fdocs\n---\nDocs\n```");
    expect(render({ hdm: "0.1", nodes: [b] })).toContain('<a href="/docs"');
  });

  it("renders hdm-form controls with name and id", () => {
    const b = blockOf("```hdm-form\nid: contact\nemail: input(email, required)\nmessage: textarea(maxlength=500)\nsend: submit(label=\"Send\")\n```");
    const html = render({ hdm: "0.1", nodes: [b] });
    expect(html).toContain('<input type="email" name="email" id="contact.email" required>');
    expect(html).toContain('<textarea name="message" id="contact.message"');
    expect(html).toContain('<button type="submit" id="contact.send">Send</button>');
  });

  it("renders hdm-table from parsed GFM rows", () => {
    const b = blockOf("```hdm-table\nrole: table\n---\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```");
    const html = render({ hdm: "0.1", nodes: [b] });
    expect(html).toContain("<thead><tr><th>a</th><th>b</th></tr></thead>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders hdm-image, hdm-link, hdm-data and chart fallback", () => {
    const img = render({ hdm: "0.1", nodes: [blockOf("```hdm-image\nsrc: a.png\nalt: A\nwidth: 320\n```")] });
    expect(img).toBe('<img src="a.png" alt="A" width="320">');
    const data = render({ hdm: "0.1", nodes: [blockOf("```hdm-data\nprice: 9\n```")] });
    expect(data).toContain('type="application/x-hdm-data"');
    expect(data).toContain('{"price":9}');
    const chart = render({ hdm: "0.1", nodes: [blockOf("```hdm-chart\ntype: line\n```")] });
    expect(chart).toContain('data-hdm-chart="line"');
  });

  it("renders bindings as data-hdm-bind spans", () => {
    const html = renderMarkdown("Clicked {count} times");
    expect(html).toContain('<span data-hdm-bind="count"></span>');
  });

  it("renders foreign blocks as escaped code", () => {
    const { doc } = parse("```hdm-widget\nmystery: true\n```");
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
    const { diagnostics } = parse("```hdm-action?name=a&name=b\n---\nGo\n```");
    expect(diagnostics.some((d) => d.code === "E_DUPLICATE_KEY")).toBe(true);
  });

  it("canonicalize de-duplicates colliding explicit ids", () => {
    const d = canonicalize({
      hdm: "0.1",
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
