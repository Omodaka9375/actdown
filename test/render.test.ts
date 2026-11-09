import { describe, expect, it } from "vitest";
import { canonicalize, parse, render, renderMarkdown } from "../src/index.js";
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
});

describe("block rendering (Appendix A)", () => {
  it("renders hdm-action as a button with data-hdm-id and label", () => {
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
