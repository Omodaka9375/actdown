import { describe, expect, it } from "vitest";
import { canonicalize, parse, print, render, inlineIncludes, ParseError } from "../src/index.js";
import type { InlineOptions } from "../src/include.js";

const loaderOf = (files: Record<string, string>) => (src: string) => {
  const hit = files[src];
  if (hit === undefined) throw new Error(`no such file: ${src}`);
  return hit;
};

const inlineOf = (main: string, files: Record<string, string>) =>
  inlineIncludes(parse(main).doc, { loader: loaderOf(files) } satisfies InlineOptions);

const PARTIAL = `## Payments

Retry policy tightened.

\`\`\`ad-state
retries: 3
\`\`\`
`;

const shapeOf = (doc: ReturnType<typeof parse>["doc"]) =>
  doc.nodes.map((n) => (n.kind === "prose" ? "prose" : n.kind === "block" && !("foreign" in n && n.foreign === true) ? n.type : "foreign"));

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return "";
  } catch (e) {
    return e instanceof ParseError ? e.code : `not-a-ParseError: ${String(e)}`;
  }
};

describe("ad-include inlining (SPEC 4.5)", () => {
  it("splices the included document's nodes at the include position", () => {
    const main = `# Report\n\n\`\`\`ad-include\nsrc: partial.ad\n\`\`\`\n\nDone.`;
    const doc = inlineOf(main, { "partial.ad": PARTIAL });
    expect(shapeOf(doc)).toEqual(["prose", "prose", "state", "prose"]);
    expect(doc.nodes.some((n) => n.kind === "block" && !("foreign" in n && n.foreign === true) && n.type === "state")).toBe(true);
    // The spliced document carries no include reference anymore.
    expect(print(canonicalize(doc))).not.toContain("ad-include");
  });

  it("leaves cap: includes verbatim (host resource)", () => {
    const doc = inlineOf("```ad-include\nsrc: cap:header@v1\n```", {});
    expect(doc.nodes).toHaveLength(1);
    expect((doc.nodes[0] as { fields: { src: string } }).fields.src).toBe("cap:header@v1");
  });

  it("throws E_INCLUDE_CYCLE for cycles and self-includes", () => {
    const cycle = () =>
      inlineOf("```ad-include\nsrc: a.ad\n```", {
        "a.ad": "```ad-include\nsrc: b.ad\n```",
        "b.ad": "```ad-include\nsrc: a.ad\n```",
      });
    expect(codeOf(cycle)).toBe("E_INCLUDE_CYCLE");
    const self = () => inlineOf("```ad-include\nsrc: me.ad\n```", { "me.ad": "```ad-include\nsrc: me.ad\n```" });
    expect(codeOf(self)).toBe("E_INCLUDE_CYCLE");
  });

  it("allows diamond includes (same file twice, not on one path)", () => {
    const main = ["```ad-include", "src: b.ad", "```", "", "```ad-include", "src: c.ad", "```"].join("\n");
    const files = {
      "b.ad": "```ad-include\nsrc: shared.ad\n```",
      "c.ad": "```ad-include\nsrc: shared.ad\n```",
      "shared.ad": "Shared text.",
    };
    const doc = inlineOf(main, files);
    expect(shapeOf(doc)).toEqual(["prose", "prose"]);
  });

  it("throws E_INCLUDE_UNRESOLVED for missing files and missing src", () => {
    expect(codeOf(() => inlineOf("```ad-include\nsrc: ghost.ad\n```", {}))).toBe("E_INCLUDE_UNRESOLVED");
    expect(codeOf(() => inlineOf("```ad-include\n---\nnot-src: x\n```", {}))).toBe("E_INCLUDE_UNRESOLVED");
  });

  it("splices nested includes relative to the same loader", () => {
    const doc = inlineOf("```ad-include\nsrc: outer.ad\n```", {
      "outer.ad": "Outer.\n\n```ad-include\nsrc: inner.ad\n```",
      "inner.ad": "Inner.",
    });
    const texts = doc.nodes.filter((n) => n.kind === "prose").map((n) => (n as { md: string }).md);
    expect(texts).toContain("Outer.");
    expect(texts).toContain("Inner.");
  });

  it("renders the spliced document like pasted content", () => {
    const doc = canonicalize(inlineOf("```ad-include\nsrc: p.ad\n```", { "p.ad": PARTIAL }));
    expect(render(doc)).toContain("<h2>Payments</h2>");
    expect(render(doc)).toContain("Retry policy tightened.");
  });
});
