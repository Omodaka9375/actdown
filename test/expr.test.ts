import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, ExprError, display, evaluate, evalExpr, parseExpr } from "../src/expr.js";

const ev = (raw: string, scope: Record<string, unknown> = {}) => evalExpr(raw, { scope: scope as never });

describe("parseExpr", () => {
  it("parses precedence: || < && < cmp < sum < unary", () => {
    // a || b && c == d + !e  ->  or(a, and(b, cmp(c, sum(d, unary!e))))
    const ast = parseExpr("a || b && c == d + !e");
    expect(ast).toMatchObject({ k: "bin", op: "||" });
    const right = (ast as { right: { k: string; op?: string } }).right;
    expect(right).toMatchObject({ k: "bin", op: "&&" });
  });

  it("parses postfix chains: get, index, call", () => {
    const ast = parseExpr("a.b[0].c(x, 1)");
    expect(ast).toMatchObject({ k: "call" });
  });

  it("parses $payload, object and array literals", () => {
    expect(parseExpr("$fields")).toMatchObject({ k: "dollar", name: "fields" });
    expect(parseExpr("{a: 1, b: \"x\"}")).toMatchObject({ k: "obj" });
    expect(parseExpr("[1, 2, 3]")).toMatchObject({ k: "arr" });
  });

  it("rejects garbage", () => {
    expect(() => parseExpr("a +")).toThrow(ExprError);
    expect(() => parseExpr("(a")).toThrow(ExprError);
    expect(() => parseExpr("a b")).toThrow(ExprError);
    expect(() => parseExpr("\"unterminated")).toThrow(ExprError);
  });

  it("keeps dashes in names only when followed by a letter", () => {
    expect(parseExpr("cart-total")).toMatchObject({ k: "name", name: "cart-total" });
    expect(parseExpr("count-1")).toMatchObject({ k: "bin", op: "-" });
  });
});

describe("evaluate", () => {
  it("arithmetic and string concat", () => {
    expect(ev("1 + 2 + 3")).toBe(6);
    expect(ev("\"a\" + 1 + true")).toBe("a1true");
    expect(() => ev("10 / 2")).toThrow(ExprError); // no division in SPEC 6
    expect(ev("5 - 2")).toBe(3);
  });

  it("comparisons and logic with short-circuit", () => {
    expect(ev("1 < 2 && 2 <= 2")).toBe(true);
    expect(ev("1 == 1 || thrower")).toBe(true); // right side never evaluated
    expect(ev("null == null")).toBe(true);
    expect(ev("\"a\" != \"b\"")).toBe(true);
    expect(ev("!0")).toBe(true);
    expect(ev("-3")).toBe(-3);
  });

  it("mixed-type ordering is false, not an error", () => {
    expect(ev("1 < \"a\"")).toBe(false);
  });

  it("names come from scope; unknown is E_BIND_UNKNOWN", () => {
    expect(ev("count + 1", { count: 2 })).toBe(3);
    try {
      ev("missing");
      expect.unreachable();
    } catch (e) {
      expect((e as ExprError).code).toBe("E_BIND_UNKNOWN");
    }
  });

  it("property access and indexing", () => {
    expect(ev("cart.total", { cart: { total: 5 } })).toBe(5);
    expect(ev("cart.missing", { cart: {} })).toBe(null);
    expect(ev("items[1]", { items: ["a", "b"] })).toBe("b");
    expect(ev("items[9]", { items: ["a"] })).toBe(null);
    expect(ev("map[\"k\"]", { map: { k: 1 } })).toBe(1);
    expect(() => ev("5.foo")).toThrow(ExprError);
  });

  it("deep equality on arrays and objects", () => {
    expect(ev("[1, 2] == [1, 2]")).toBe(true);
    expect(ev("{a: 1} == {a: 2}")).toBe(false);
  });

  it("cap.send routes through the send sink", () => {
    const sent: unknown[] = [];
    const out = evalExpr("cap.send(\"cart.add\", {sku: \"oven\"})", {
      scope: {},
      send: (name, args) => {
        sent.push([name, args]);
        return "ok";
      },
    });
    expect(out).toBe("ok");
    expect(sent).toEqual([["cart.add", { sku: "oven" }]]);
  });

  it("cap.send without a sink is an error; other calls are errors", () => {
    expect(() => evalExpr("cap.send(\"x\", 1)", { scope: {} })).toThrow(ExprError);
    expect(() => evalExpr("foo(1)", { scope: {} })).toThrow(ExprError);
  });

  it("rejects non-finite results", () => {
    expect(() => ev("1e308 + 1e308")).toThrow(ExprError);
  });

  it("enforces step budget and depth cap (SEC-4)", () => {
    const deep = parseExpr("1" + " + 1".repeat(100));
    expect(() => evalExpr("1", { scope: {}, limits: { maxSteps: 0 } })).toThrow(ExprError);
    expect(() => evaluate(deep, { scope: {}, limits: { maxSteps: 1000, maxDepth: 4 } })).toThrow(/depth/);
  });

  it("display formats values for HTML", () => {
    expect(display("hi")).toBe("hi");
    expect(display(null)).toBe("");
    expect(display([1, 2])).toBe("[1,2]");
    expect(display({ a: 1 })).toBe("{\"a\":1}");
  });
});
