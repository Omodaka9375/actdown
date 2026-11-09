import { display, evalExpr, ExprError, type EvalLimits } from "./expr.js";
import { renderNode, type RenderOptions, type Scope } from "./render.js";
import type { BlockNode, Doc, Expr, Literal, Node } from "./types.js";

/**
 * SPEC 5/6: document-level reactivity. `computeState` resolves the flat state
 * map (literal entries pass through, expression entries are evaluated in
 * order, level-3 computed state). `renderReactive` renders the document with
 * the current state applied: bindings carry their value, `when=` hides nodes,
 * `each=` repeats them.
 */

export interface ReactiveOptions extends RenderOptions {
  /** Seed state before document state blocks are applied. */
  initial?: Record<string, Literal>;
  /** Event payload visible to `$name` (SPEC 6). */
  dollar?: Record<string, Literal>;
  /** Sink for `cap.send(name, args)` inside `on:` expressions. */
  send?: (name: string, args: Literal) => Literal | void;
  /** SEC-4 budgets (default 1000 steps / depth 64). */
  limits?: Partial<EvalLimits>;
}

function isBlock(n: Node): n is BlockNode {
  return n.kind === "block" && !("foreign" in n && n.foreign === true);
}

function isExpr(v: unknown): v is Expr {
  return typeof v === "object" && v !== null && (v as Expr).kind === "expr";
}

/**
 * Resolve the document's flat state map (SPEC 5). `state` blocks are applied
 * in document order; literal fields are taken as-is, expression fields are
 * evaluated against the state accumulated so far (computed state, level 3).
 * Later entries override earlier ones.
 */
export function computeState(doc: Doc, initial?: Record<string, Literal>): Record<string, Literal> {
  const scope: Record<string, Literal> = { ...initial };
  for (const n of doc.nodes) {
    if (!isBlock(n) || (n.type !== "state" && n.type !== "data")) continue;
    for (const [k, v] of Object.entries(n.fields)) {
      if (isExpr(v)) {
        scope[k] = evalExpr(v.raw, { scope });
      } else {
        scope[k] = v;
      }
    }
  }
  return scope;
}

/** `each="item in expr"` or `each="item, index in expr"` (SPEC 5). */
function parseEach(raw: string): { item: string; index: string; expr: string } | null {
  const m = /^([a-z][a-z0-9-]*)(?:\s*,\s*([a-z][a-z0-9-]*))?\s+in\s+(.+)$/.exec(raw.trim());
  if (m === null) return null;
  return { item: m[1]!, index: m[2] ?? "index", expr: m[3]! };
}

function evalRaw(raw: string, opts: ReactiveOptions, scope: Scope): Literal {
  return evalExpr(raw, { scope, dollar: opts.dollar, send: opts.send, limits: opts.limits });
}

function renderReactiveNode(n: Node, opts: ReactiveOptions, scope: Scope): string {
  if (!isBlock(n)) return renderNode(n, opts, scope);

  // SPEC 5: `when="expr"` hides the node when the expression is falsy.
  const when = n.fields.when;
  if (when !== undefined) {
    const v = isExpr(when) ? evalRaw(when.raw, opts, scope) : when;
    if (!v) return "";
  }

  // SPEC 5: `each="item in expr"` repeats the node, keyed by id. The field
  // may arrive as an expression (braced) or a plain string body field.
  const each = n.fields.each;
  if (each !== undefined && (typeof each === "string" || isExpr(each))) {
    const rawEach = typeof each === "string" ? each : each.raw;
    const spec = parseEach(rawEach);
    if (spec === null) return renderNode(n, opts, scope);
    const items = evalRaw(spec.expr, opts, scope);
    if (!Array.isArray(items)) return "";
    return items
      .map((item, index) => {
        const clone: BlockNode = { ...n, id: `${n.id}-${index}` };
        return renderNode(clone, opts, { ...scope, [spec.item]: item as Literal, [spec.index]: index });
      })
      .join("\n");
  }

  return renderNode(n, opts, scope);
}

/**
 * Render a document with its state applied (SPEC 5/11): the server-side
 * render pass that the runtime hydrates. Hidden nodes render nothing.
 */
export function renderReactive(doc: Doc, opts: ReactiveOptions = {}): string {
  return renderWithState(doc, computeState(doc, opts.initial), opts);
}

/** Render with a precomputed scope; the runtime uses this to keep its own
 * state authoritative over document state-block literals. */
export function renderWithState(doc: Doc, scope: Record<string, Literal>, opts: ReactiveOptions = {}): string {
  return doc.nodes
    .map((n) => renderReactiveNode(n, opts, scope))
    .filter((s) => s !== "")
    .join("\n");
}

/** Evaluate one binding for display (kept for runtimes and tests). */
export function bindValue(raw: string, scope: Record<string, Literal>): string {
  return display(evalExpr(raw, { scope }));
}

export { ExprError };
