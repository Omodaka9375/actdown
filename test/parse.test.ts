import { describe, expect, it } from "vitest";
import { canonicalize, format, parse, type BlockNode, type ForeignNode } from "../src/index.js";

function fence(info: string, body: string): string {
  return "```" + info + "\n" + body + "\n```\n";
}

function firstBlock(src: string): BlockNode {
  const { doc } = parse(src);
  const n = doc.nodes[0]!;
  if (n.kind !== "block" || "foreign" in n) throw new Error("expected a parsed block");
  return n;
}

function firstForeign(src: string): ForeignNode {
  const { doc } = parse(src);
  const n = doc.nodes[0]!;
  if (n.kind !== "block" || !("foreign" in n)) throw new Error("expected a foreign block");
  return n;
}

describe("literal typing (SPEC 4.1)", () => {
  it("types numbers, keywords, bare strings, quoted strings, arrays, objects", () => {
    const b = firstBlock(fence("ad-state", [
      "count: 0",
      "price: 129.50",
      "flag: true",
      "none: null",
      "name: Weekly report",
      'quoted: "42"',
      "tags: [\"a\", \"b\"]",
      'args: { "sku": "oven-12l" }',
    ].join("\n")));
    expect(b.fields).toEqual({
      count: 0,
      price: 129.5,
      flag: true,
      none: null,
      name: "Weekly report",
      quoted: "42",
      tags: ["a", "b"],
      args: { sku: "oven-12l" },
    });
  });

  it("folds continuation lines with a single space", () => {
    const b = firstBlock(fence("ad-text", "body: this is a\n  long folded value"));
    expect(b.fields.body).toBe("this is a long folded value");
  });

  it("unescapes bare values", () => {
    const b = firstBlock(fence("ad-text", "msg: line1\\nline2 \\\\ end"));
    expect(b.fields.msg).toBe("line1\nline2 \\ end");
  });

  it("stores non-JSON braces as expressions", () => {
    const b = firstBlock(fence("ad-region", "when: {count > 0}"));
    expect(b.fields).toEqual({ when: { kind: "expr", raw: "count > 0" } });
  });
});

describe("block structure", () => {
  it("reads id and role from info attrs or body fields", () => {
    const a = firstBlock(fence("ad-action?name=cart.add&role=primary&on:click", "args: {}\n---\nGo"));
    expect(a.id).toBe("");
    expect(a.role).toBe("primary");
    expect(a.attrs).toEqual({ name: "cart.add", "on:click": "" });
    expect(a.body).toBe("Go");
    const b = firstBlock(fence("ad-region", "id: contact\nrole: form"));
    expect(b.id).toBe("contact");
    expect(b.role).toBe("form");
  });

  it("rejects multiple trigger events", () => {
    const f = firstForeign(fence("ad-action?on:click&on:load", "x: 1"));
    expect(f.diagnostic.code).toBe("E_MULTI_EVENT");
  });

  it("rejects unknown roles but allows x- prefixed ones", () => {
    expect(firstForeign(fence("ad-region", "role: wizard")).diagnostic.code).toBe("E_BAD_ROLE");
    expect(firstBlock(fence("ad-region", "role: x-magic")).role).toBe("x-magic");
  });

  it("demotes a block with a duplicate field key", () => {
    const f = firstForeign(fence("ad-state", "count: 0\ncount: 1"));
    expect(f.diagnostic.code).toBe("E_DUPLICATE_KEY");
    expect(f.raw).toContain("count: 1");
  });

  it("demotes the second block on duplicate explicit ids", () => {
    const { doc, diagnostics } = parse(
      fence("ad-state", "id: dup\na: 1") + fence("ad-state", "id: dup\nb: 2"),
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["E_DUP_ID"]);
    const second = doc.nodes[1]!;
    expect("foreign" in second && second.foreign).toBe(true);
  });
});

describe("foreign blocks and prose (INV-1)", () => {
  it("preserves unknown ad types verbatim", () => {
    const f = firstForeign(fence("ad-widget", "mystery: true"));
    expect(f.type).toBe("widget");
    expect(f.raw).toContain("```ad-widget");
  });

  it("keeps ordinary fenced code blocks as prose", () => {
    const { doc } = parse("```js\nconsole.log(1);\n```\n");
    expect(doc.nodes[0]).toEqual({ kind: "prose", md: "```js\nconsole.log(1);\n```" });
  });

  it("normalizes CRLF", () => {
    const b = firstBlock("```ad-state\r\ncount: 0\r\n```\r\n");
    expect(b.fields.count).toBe(0);
  });
});

describe("generated ids and canonical form (SPEC 2.3, 10)", () => {
  it("generates a stable id from canonical block bytes", () => {
    const a = canonicalize(parse(fence("ad-state", "count: 0")).doc).nodes[0] as BlockNode;
    const again = canonicalize(parse(fence("ad-state", "count: 0")).doc).nodes[0] as BlockNode;
    expect(a.id).toMatch(/^h[0-9a-f]{10}$/);
    expect(a.id).toBe(again.id);
  });

  it("format is idempotent (INV-3)", () => {
    const messy = "# Title\r\n\r\nSome prose with trailing spaces   \n\n" +
      fence("ad-action?name=cart.add&role=primary&on:click", "args: { \"sku\": \"oven\" }\n---\nAdd to cart") +
      "\n" + fence("ad-state", "count: 0\n   continued value");
    const once = format(messy);
    expect(format(once)).toBe(once);
    expect(once).toContain("id: h");
  });

  it("emits canonical field order and on: attrs last", () => {
    const once = format(fence("ad-action?zeta=1&on:click&alpha=2&role=primary", "z: 1\na: 2"));
    const lines = once.split("\n");
    expect(lines[0]).toBe("```ad-action?alpha=2&zeta=1&on:click");
    expect(lines[1]).toMatch(/^id: h[0-9a-f]{10}$/);
    expect(lines[2]).toBe("role: primary");
    expect(lines[3]).toBe("a: 2");
    expect(lines[4]).toBe("z: 1");
  });
});
