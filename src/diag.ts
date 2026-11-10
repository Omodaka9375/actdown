import { parseExpr } from "./expr.js";
import { parseEach } from "./react.js";
import type { BlockNode, Doc, Diagnostic, Expr, ForeignNode, Literal, Node } from "./types.js";

export class ParseError extends Error {
  readonly code: string;
  readonly line: number;

  constructor(code: string, message: string, line = 0) {
    super(message);
    this.name = "ParseError";
    this.code = code;
    this.line = line;
  }
}

const isExprVal = (v: Literal | Expr): v is Expr =>
  v !== null && typeof v === "object" && "kind" in v && (v as Expr).kind === "expr";

function isForeign(n: Node): n is ForeignNode {
  return n.kind === "block" && "foreign" in n && n.foreign === true;
}

function blockOf(n: Node): BlockNode | null {
  if (n.kind !== "block" || isForeign(n)) return null;
  return n;
}

/**
 * Static review lints (non-fatal, `W_` prefixed; the reviewer's diff surface).
 * Beyond the parser's hard errors, this checks the cross-references a security
 * or compliance reviewer cares about before approving a document:
 *
 * - `W_REGION_FOR`: an ad-region points at a block id that does not exist, so
 *   its phase UI can never switch on.
 * - `W_EXPR_SYNTAX`: a `when=` guard does not parse, so the block would render
 *   with the guard ignored rather than applied.
 * - `W_CAP_UNDECLARED`: an action names a capability that no ad-manifest in
 *   the document declares (the host may still grant it; this flags drift).
 */
export function lint(doc: Doc): Diagnostic[] {
  const out: Diagnostic[] = [];
  const ids = new Set<string>();
  const declared = new Set<string>();
  for (const n of doc.nodes) {
    const b = blockOf(n);
    if (b === null) continue;
    ids.add(b.id);
    if (b.type === "manifest") {
      const name = b.fields.name;
      if (typeof name === "string" && name !== "") declared.add(name);
    }
  }
  for (const n of doc.nodes) {
    const b = blockOf(n);
    if (b === null) continue;
    const forVal = b.fields.for;
    if (b.type === "region" && typeof forVal === "string" && forVal !== "" && !ids.has(forVal)) {
      out.push({
        code: "W_REGION_FOR",
        message: `ad-region "for: ${forVal}" references a block id that does not exist`,
        line: b.line,
      });
    }
    // when=/each= are expressions normalized into fields (SPEC 10). For
    // `each`, the field is a repetition declaration (`item in expr`): lint
    // only the expression portion, so a valid declaration is not flagged.
    for (const key of ["when", "each"] as const) {
      const v = b.fields[key];
      if (v === undefined || !isExprVal(v)) continue;
      const raw = key === "each" ? parseEach(v.raw)?.expr : v.raw;
      if (raw === undefined) continue;
      try {
        parseExpr(raw);
      } catch (err: unknown) {
        out.push({
          code: "W_EXPR_SYNTAX",
          message: `${key}="${v.raw}" does not parse: ${err instanceof Error ? err.message : String(err)}`,
          line: b.line,
        });
      }
    }
    if (b.type === "action") {
      const cap = b.attrs.name;
      if (typeof cap === "string" && cap !== "" && !declared.has(cap)) {
        out.push({
          code: "W_CAP_UNDECLARED",
          message: `action "${b.id}" names capability "${cap}" which no ad-manifest declares`,
          line: b.line,
        });
      }
    }
  }
  return out;
}
