import { describe, expect, it } from "vitest";
import { canonicalize, parse } from "../src/index.js";
import { bindValue, computeState, renderReactive } from "../src/react.js";
import type { Doc } from "../src/types.js";

const doc = (src: string): Doc => canonicalize(parse(src).doc);

const CART = `# Cart

\`\`\`hdm-state
count: 3
items: ["a", "b"]
total: {count + 10}
\`\`\`

\`\`\`hdm-text
body: {count + 10}
\`\`\`

\`\`\`hdm-region
when: {count > 5}
---
hidden
\`\`\`

\`\`\`hdm-text
each: item in items
body: {item}
\`\`\`

You have {count} items, missing {nope}.
`;

describe("computeState", () => {
  it("applies state blocks in order, literals as-is", () => {
    const { doc: d } = parse("```hdm-state\ncount: 0\nname: cart\n```");
    expect(computeState(d)).toEqual({ count: 0, name: "cart" });
  });

  it("evaluates computed entries (level 3) against state so far", () => {
    expect(computeState(doc(CART))).toEqual({ count: 3, items: ["a", "b"], total: 13 });
  });

  it("later blocks override earlier ones; initial seeds the rest", () => {
    const { doc: d } = parse("```hdm-state\ncount: 1\n```\n```hdm-state\ncount: {count + 1}\n```");
    expect(computeState(d)).toEqual({ count: 2 });
    expect(computeState(d, { count: 10, start: 5 })).toEqual({ count: 2, start: 5 });
  });
});

describe("renderReactive", () => {
  it("renders current values into data-hdm-bind spans", () => {
    const html = renderReactive(doc(CART));
    expect(html).toContain('<span data-hdm-bind="count + 10">13</span>');
    expect(html).toContain('<span data-hdm-bind="count">3</span>');
  });

  it("hides falsy when= nodes entirely", () => {
    const html = renderReactive(doc(CART));
    expect(html).not.toContain("hidden");
  });

  it("repeats each= nodes keyed by id with item and index bound", () => {
    const html = renderReactive(doc(CART));
    expect(html).toContain('<span data-hdm-bind="item">a</span>');
    expect(html).toContain('<span data-hdm-bind="item">b</span>');
    expect(html.match(/<span data-hdm-bind="count \+ 10">13<\/span>/g)!.length).toBe(1);
  });

  it("unknown bindings render as empty spans, one node not the document", () => {
    const html = renderReactive(doc(CART));
    expect(html).toContain('<span data-hdm-bind="nope"></span>');
    expect(html).toContain("You have");
  });

  it("level-1 render is unchanged: spans stay empty", () => {
    const { doc: d } = parse("Hello {name}");
    expect(renderReactive(d, { initial: { name: "Ada" } })).toContain(">Ada</span>");
  });

  it("bindValue evaluates a single binding for display", () => {
    expect(bindValue("count > 2", { count: 3 })).toBe("true");
    expect(bindValue("name", { name: "Ada" })).toBe("Ada");
  });
});
