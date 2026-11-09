import type { Literal } from "./types.js";

/**
 * SPEC 6: a small, total, typed expression language. No functions, no loops,
 * no member assignment; evaluation is side-effect free except `cap.send`,
 * which is only valid inside `on:` attributes (SPEC 6/7).
 */

export type BinOp = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-";

export type ExprAst =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "name"; name: string }
  | { k: "dollar"; name: string }
  | { k: "arr"; items: ExprAst[] }
  | { k: "obj"; entries: { key: string; value: ExprAst }[] }
  | { k: "get"; obj: ExprAst; name: string }
  | { k: "idx"; obj: ExprAst; index: ExprAst }
  | { k: "call"; callee: ExprAst; args: ExprAst[] }
  | { k: "un"; op: "!" | "-"; operand: ExprAst }
  | { k: "bin"; op: BinOp; left: ExprAst; right: ExprAst };

export type ExprErrorCode =
  | "E_EXPR_PARSE"
  | "E_EXPR_STEP"
  | "E_EXPR_DEPTH"
  | "E_EXPR_EVAL"
  | "E_BIND_UNKNOWN";

/** A render-scope error (SPEC 15): affects one node, never the document. */
export class ExprError extends Error {
  readonly code: ExprErrorCode;
  readonly pos: number;

  constructor(code: ExprErrorCode, message: string, pos = 0) {
    super(message);
    this.name = "ExprError";
    this.code = code;
    this.pos = pos;
  }
}

/** SEC-4 defaults: a render error, not a hang. */
export interface EvalLimits {
  maxSteps: number;
  maxDepth: number;
}

export const DEFAULT_LIMITS: EvalLimits = { maxSteps: 1000, maxDepth: 64 };

/** `$name` refers to event payload (SPEC 6); `send` implements `cap.send`. */
export interface EvalContext {
  scope: Record<string, Literal>;
  dollar?: Record<string, Literal>;
  send?: (name: string, args: Literal) => Literal | Promise<Literal> | void;
  limits?: Partial<EvalLimits>;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { t: "num"; v: number; pos: number }
  | { t: "str"; v: string; pos: number }
  | { t: "name"; v: string; pos: number }
  | { t: "op"; v: string; pos: number };

const OPERATORS = ["<=", ">=", "==", "!=", "&&", "||", ".", "[", "]", "(", ")", "{", "}", ",", ":", "!", "-", "+", "<", ">", "$"];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === '"') {
      const start = i;
      i += 1;
      let out = "";
      for (;;) {
        if (i >= src.length) throw new ExprError("E_EXPR_PARSE", "unterminated string", start);
        const ch = src[i]!;
        if (ch === '"') {
          i += 1;
          break;
        }
        if (ch === "\\") {
          i += 1;
          const e = src[i]!;
          if (e === undefined) throw new ExprError("E_EXPR_PARSE", "unterminated escape", i);
          if (e === "u") {
            const hex = src.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ExprError("E_EXPR_PARSE", "bad unicode escape", i);
            out += String.fromCharCode(parseInt(hex, 16));
            i += 5;
          } else {
            out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[e] ?? e;
            i += 1;
          }
          continue;
        }
        out += ch;
        i += 1;
      }
      toks.push({ t: "str", v: out, pos: start });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      toks.push({ t: "num", v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      // A trailing `-` only joins when followed by a letter, so `count-1`
      // still parses as subtraction.
      toks.push({ t: "name", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op === undefined) throw new ExprError("E_EXPR_PARSE", `unexpected character ${JSON.stringify(c)}`, i);
    toks.push({ t: "op", v: op, pos: i });
    i += op.length;
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Parser (SPEC 6 EBNF)
// ---------------------------------------------------------------------------

class Parser {
  private toks: Tok[];
  private i = 0;
  private depth = 0;

  constructor(src: string) {
    this.toks = tokenize(src);
  }

  /** SEC-4: the parser must bound recursion too, not just the evaluator. */
  private nested<T>(fn: () => T): T {
    this.depth += 1;
    if (this.depth > DEFAULT_LIMITS.maxDepth) {
      this.depth -= 1;
      throw new ExprError("E_EXPR_DEPTH", "expression nesting too deep");
    }
    try {
      return fn();
    } finally {
      this.depth -= 1;
    }
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  private next(): Tok {
    const t = this.toks[this.i];
    if (t === undefined) throw new ExprError("E_EXPR_PARSE", "unexpected end of expression", 0);
    this.i += 1;
    return t;
  }

  private expectOp(v: string): void {
    const t = this.next();
    if (t.t !== "op" || t.v !== v) {
      throw new ExprError("E_EXPR_PARSE", `expected ${v}`, t.pos);
    }
  }

  private atOp(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.t === "op" && t.v === v;
  }

  parse(): ExprAst {
    const e = this.or();
    const t = this.peek();
    if (t !== undefined) throw new ExprError("E_EXPR_PARSE", `unexpected token after expression`, t.pos);
    return e;
  }

  private or(): ExprAst {
    let left = this.and();
    while (this.atOp("||")) {
      this.next();
      left = { k: "bin", op: "||", left, right: this.and() };
    }
    return left;
  }

  private and(): ExprAst {
    let left = this.cmp();
    while (this.atOp("&&")) {
      this.next();
      left = { k: "bin", op: "&&", left, right: this.cmp() };
    }
    return left;
  }

  private cmp(): ExprAst {
    const left = this.sum();
    const t = this.peek();
    if (t !== undefined && t.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      this.next();
      return { k: "bin", op: t.v as BinOp, left, right: this.sum() };
    }
    return left;
  }

  private sum(): ExprAst {
    let left = this.unary();
    while (this.atOp("+") || this.atOp("-")) {
      const op = (this.next() as { v: string }).v as BinOp;
      left = { k: "bin", op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): ExprAst {
    if (this.atOp("!") || this.atOp("-")) {
      const op = (this.next() as { v: string }).v as "!" | "-";
      return { k: "un", op, operand: this.nested(() => this.unary()) };
    }
    return this.postfix();
  }

  private postfix(): ExprAst {
    let e = this.primary();
    for (;;) {
      if (this.atOp(".")) {
        this.next();
        const t = this.next();
        if (t.t !== "name") throw new ExprError("E_EXPR_PARSE", "expected property name after .", t.pos);
        e = { k: "get", obj: e, name: t.v };
        continue;
      }
      if (this.atOp("[")) {
        this.next();
        const index = this.nested(() => {
          const inner = this.or();
          this.expectOp("]");
          return inner;
        });
        e = { k: "idx", obj: e, index };
        continue;
      }
      if (this.atOp("(")) {
        this.next();
        const args: ExprAst[] = [];
        if (!this.atOp(")")) {
          for (;;) {
            args.push(this.or());
            if (this.atOp(",")) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expectOp(")");
        e = { k: "call", callee: e, args };
        continue;
      }
      return e;
    }
  }

  private primary(): ExprAst {
    const t = this.next();
    switch (t.t) {
      case "num":
        return { k: "num", v: t.v };
      case "str":
        return { k: "str", v: t.v };
      case "name": {
        if (t.v === "true") return { k: "bool", v: true };
        if (t.v === "false") return { k: "bool", v: false };
        if (t.v === "null") return { k: "null" };
        return { k: "name", name: t.v };
      }
      case "op":
        switch (t.v) {
          case "(": {
            return this.nested(() => {
              const e = this.or();
              this.expectOp(")");
              return e;
            });
          }
          case "{": {
            const entries: { key: string; value: ExprAst }[] = [];
            if (!this.atOp("}")) {
              for (;;) {
                const kt = this.next();
                if (kt.t !== "name" && kt.t !== "str") {
                  throw new ExprError("E_EXPR_PARSE", "expected object key", kt.pos);
                }
                this.expectOp(":");
                entries.push({ key: kt.v, value: this.or() });
                if (this.atOp(",")) {
                  this.next();
                  continue;
                }
                break;
              }
            }
            this.expectOp("}");
            return { k: "obj", entries };
          }
          case "[": {
            return this.nested(() => {
              const items: ExprAst[] = [];
              if (!this.atOp("]")) {
                for (;;) {
                  items.push(this.or());
                  if (this.atOp(",")) {
                    this.next();
                    continue;
                  }
                  break;
                }
              }
              this.expectOp("]");
              return { k: "arr", items };
            });
          }
          case "$": {
            const n = this.next();
            if (n.t !== "name") throw new ExprError("E_EXPR_PARSE", "expected name after $", n.pos);
            return { k: "dollar", name: n.v };
          }
          default:
            throw new ExprError("E_EXPR_PARSE", `unexpected ${t.v}`, t.pos);
        }
    }
  }
}

/** Parse an expression string into an AST. Throws `ExprError` (E_EXPR_PARSE). */
export function parseExpr(raw: string): ExprAst {
  return new Parser(raw).parse();
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function deepEqual(a: Literal, b: Literal): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i] as Literal));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const bb = b as Record<string, Literal>;
  return ka.every((k) => k in (a as Record<string, Literal>) && deepEqual((a as Record<string, Literal>)[k]!, bb[k]!));
}

function checkNum(v: number, pos: number): number {
  if (!Number.isFinite(v)) {
    throw new ExprError("E_EXPR_EVAL", "non-finite number in expression", pos);
  }
  return v;
}

/**
 * Evaluate an expression against a scope (SEC-4 budgets; SPEC 6 semantics).
 * Unknown names throw `E_BIND_UNKNOWN`; budgets exceeded throw
 * `E_EXPR_STEP` / `E_EXPR_DEPTH`; type errors and non-finite results throw
 * `E_EXPR_EVAL`. All render errors: one node, never the document.
 */
export function evaluate(ast: ExprAst, ctx: EvalContext): Literal {
  const limits = { ...DEFAULT_LIMITS, ...ctx.limits };
  let steps = 0;

  const run = (e: ExprAst, depth: number): Literal => {
    steps += 1;
    if (steps > limits.maxSteps) throw new ExprError("E_EXPR_STEP", "expression step budget exceeded");
    if (depth > limits.maxDepth) throw new ExprError("E_EXPR_DEPTH", "expression depth cap exceeded");

    switch (e.k) {
      case "num":
        return checkNum(e.v, 0);
      case "str":
        return e.v;
      case "bool":
        return e.v;
      case "null":
        return null;
      case "name": {
        if (e.name in ctx.scope) return ctx.scope[e.name]!;
        throw new ExprError("E_BIND_UNKNOWN", `unknown binding "${e.name}"`);
      }
      case "dollar": {
        const v = ctx.dollar?.[e.name];
        if (v === undefined) throw new ExprError("E_BIND_UNKNOWN", `unknown payload "$${e.name}"`);
        return v;
      }
      case "arr":
        return e.items.map((it) => run(it, depth + 1));
      case "obj": {
        const out: Record<string, Literal> = {};
        for (const en of e.entries) out[en.key] = run(en.value, depth + 1);
        return out;
      }
      case "get": {
        const obj = run(e.obj, depth + 1);
        if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
          return (obj as Record<string, Literal>)[e.name] ?? null;
        }
        throw new ExprError("E_EXPR_EVAL", "property access on non-object");
      }
      case "idx": {
        const obj = run(e.obj, depth + 1);
        const idx = run(e.index, depth + 1);
        if (Array.isArray(obj)) {
          if (typeof idx !== "number" || !Number.isInteger(idx)) {
            throw new ExprError("E_EXPR_EVAL", "array index must be an integer");
          }
          return obj[idx] ?? null;
        }
        if (obj !== null && typeof obj === "object" && typeof idx === "string") {
          return (obj as Record<string, Literal>)[idx] ?? null;
        }
        throw new ExprError("E_EXPR_EVAL", "cannot index this value");
      }
      case "call": {
        // SPEC 6: the only call form is cap.send(name, args), valid only in
        // `on:` attributes. It is evaluated only when a send sink is wired.
        if (e.callee.k === "get" && e.callee.obj.k === "name" && e.callee.obj.name === "cap" && e.callee.name === "send") {
          if (ctx.send === undefined) {
            throw new ExprError("E_EXPR_EVAL", "cap.send outside an event handler");
          }
          if (e.args.length !== 2) throw new ExprError("E_EXPR_EVAL", "cap.send takes (name, args)");
          const name = run(e.args[0]!, depth + 1);
          const args = run(e.args[1]!, depth + 1);
          if (typeof name !== "string") throw new ExprError("E_EXPR_EVAL", "capability name must be a string");
          return (ctx.send(name, args) as Literal) ?? null;
        }
        throw new ExprError("E_EXPR_EVAL", "unknown function");
      }
      case "un": {
        if (e.op === "!") return !truthy(run(e.operand, depth + 1));
        const v = run(e.operand, depth + 1);
        if (typeof v !== "number") throw new ExprError("E_EXPR_EVAL", "unary - on non-number");
        return checkNum(-v, 0);
      }
      case "bin": {
        if (e.op === "||") {
          const l = run(e.left, depth + 1);
          return truthy(l) ? l : run(e.right, depth + 1);
        }
        if (e.op === "&&") {
          const l = run(e.left, depth + 1);
          return truthy(l) ? run(e.right, depth + 1) : l;
        }
        const l = run(e.left, depth + 1);
        const r = run(e.right, depth + 1);
        switch (e.op) {
          case "==":
            return deepEqual(l, r);
          case "!=":
            return !deepEqual(l, r);
          case "<":
          case "<=":
          case ">":
          case ">=": {
            if (typeof l === "number" && typeof r === "number") {
              // Both operands are already finite (literals/arith are checked);
              // a comparison of finite numbers never needs a new check.
              return e.op === "<" ? l < r : e.op === "<=" ? l <= r : e.op === ">" ? l > r : l >= r;
            }
            if (typeof l === "string" && typeof r === "string") {
              return e.op === "<" ? l < r : e.op === "<=" ? l <= r : e.op === ">" ? l > r : l >= r;
            }
            return false;
          }
          case "+": {
            if (typeof l === "string" || typeof r === "string") {
              return display(l) + display(r);
            }
            if (typeof l === "number" && typeof r === "number") return checkNum(l + r, 0);
            throw new ExprError("E_EXPR_EVAL", "cannot add these types");
          }
          case "-": {
            if (typeof l !== "number" || typeof r !== "number") {
              throw new ExprError("E_EXPR_EVAL", "subtraction on non-numbers");
            }
            return checkNum(l - r, 0);
          }
        }
      }
    }
  };

  return run(ast, 0);
}

function truthy(v: Literal): boolean {
  if (v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Stringify a value for display in rendered output (SPEC 11). */
export function display(v: Literal): string {
  if (v === null) return "";
  if (Array.isArray(v) || typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Parse and evaluate in one step. */
export function evalExpr(raw: string, ctx: EvalContext): Literal {
  return evaluate(parseExpr(raw), ctx);
}
