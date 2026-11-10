import { describe, expect, it } from "vitest";
import { canonicalize, lint, parse } from "../src/index.js";

const lintOf = (src: string) => lint(canonicalize(parse(src).doc));

describe("review lints (diag.lint)", () => {
  it("flags a region whose for= references a missing block id", () => {
    const src = '```ad-region\nfor: ghost\nphase: pending\n---\nbusy\n```';
    expect(lintOf(src)).toMatchObject([{ code: "W_REGION_FOR" }]);
  });

  it("flags an unparseable when= guard", () => {
    const src = '```ad-action?name=cap.x&when=1 +\nid: a\n---\nGo\n```';
    const out = lintOf(src);
    expect(out).toContainEqual(expect.objectContaining({ code: "W_EXPR_SYNTAX" }));
  });

  it("flags actions whose capability no manifest declares", () => {
    const src = '```ad-action?name=deploy.approve\nid: a\n---\nGo\n```';
    expect(lintOf(src)).toMatchObject([{ code: "W_CAP_UNDECLARED" }]);
  });

  it("is clean for a document that declares its capabilities and regions", () => {
    const src = [
      "```ad-manifest",
      "name: deploy.approve",
      "min-version: 1.0.0",
      "```",
      "",
      "```ad-action?name=deploy.approve",
      "id: approve",
      "---",
      "Go",
      "```",
      "",
      "```ad-region",
      "for: approve",
      "phase: pending",
      "---",
      "busy",
      "```",
    ].join("\n");
    expect(lintOf(src)).toEqual([]);
  });

  it("ignores foreign blocks", () => {
    const src = '```ad-totally-unknown\nfor: ghost\n```';
    expect(lintOf(src)).toEqual([]);
  });
});
