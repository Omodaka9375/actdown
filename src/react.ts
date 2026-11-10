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
 * Evaluate a block's fields into a plain object (data blocks, SPEC 4.4).
 * A failing expression field contributes null, never a render abort.
 */
function fieldsToObject(
  fields: Record<string, Literal | Expr>,
  scope: Record<string, Literal>,
  limits?: Partial<EvalLimits>,
): Record<string, Literal> {
  const out: Record<string, Literal> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (isExpr(v)) {
      try {
        out[k] = evalExpr(v.raw, { scope, limits });
      } catch {
        out[k] = null;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Resolve the document's flat state map (SPEC 5). `state` blocks are applied
 * in document order; literal fields are taken as-is, expression fields are
 * evaluated against the state accumulated so far (computed state, level 3).
 * Later entries override earlier ones. SPEC 4.4: a data block with an id
 * publishes ONE nested object under that id (bindings read `id.key`), so
 * `catalog.price` resolves; a data block without an id stays flat. One bad
 * field resolves to null: a render error affects one entry, never the
 * document (SPEC 15).
 */
export function computeState(doc: Doc, initial?: Record<string, Literal>, limits?: Partial<EvalLimits>): Record<string, Literal> {
  const scope: Record<string, Literal> = { ...initial };
  const applyBlock = (n: BlockNode): void => {
    const dataId = n.type === "data" && n.id !== "" ? n.id : null;
    for (const [k, v] of Object.entries(n.fields)) {
      if (dataId !== null) continue; // handled once, below
      if (isExpr(v)) {
        try {
          scope[k] = evalExpr(v.raw, { scope, limits });
        } catch {
          scope[k] = null;
        }
      } else {
        scope[k] = v;
      }
    }
    if (dataId !== null) {
      const prev = scope[dataId];
      const obj = fieldsToObject(n.fields, scope, limits);
      scope[dataId] =
        prev !== null && typeof prev === "object" && !Array.isArray(prev)
          ? { ...(prev as Record<string, Literal>), ...obj }
          : obj;
    }
  };
  for (const n of doc.nodes) {
    if (!isBlock(n) || (n.type !== "state" && n.type !== "data")) continue;
    applyBlock(n);
  }
  return scope;
}

/**
 * Re-evaluate only the expression-backed entries against the current scope,
 * mutating it in place (SPEC 5: computed state tracks patches). Literal seeds
 * are NOT reapplied, so a host patch to a literal-named key survives.
 * A data block's nested object is rebuilt only from its expression fields,
 * preserving literal parts (and any host-patched values).
 */
export function recomputeExprState(doc: Doc, scope: Record<string, Literal>, limits?: Partial<EvalLimits>): void {
  for (const n of doc.nodes) {
    if (!isBlock(n) || (n.type !== "state" && n.type !== "data")) continue;
    if (n.type === "data" && n.id !== "") {
      const cur = scope[n.id];
      const base =
        cur !== null && typeof cur === "object" && !Array.isArray(cur) ? { ...(cur as Record<string, Literal>) } : {};
      for (const [k, v] of Object.entries(n.fields)) {
        if (!isExpr(v)) continue;
        try {
          base[k] = evalExpr(v.raw, { scope, limits });
        } catch {
          base[k] = null;
        }
      }
      scope[n.id] = base;
      continue;
    }
    for (const [k, v] of Object.entries(n.fields)) {
      if (!isExpr(v)) continue;
      try {
        scope[k] = evalExpr(v.raw, { scope, limits });
      } catch {
        scope[k] = null;
      }
    }
  }
}

/** `each="item in expr"` or `each="item, index in expr"` (SPEC 5). */
export function parseEach(raw: string): { item: string; index: string; expr: string } | null {
  const m = /^([a-z][a-z0-9-]*)(?:\s*,\s*([a-z][a-z0-9-]*))?\s+in\s+(.+)$/.exec(raw.trim());
  if (m === null) return null;
  return { item: m[1]!, index: m[2] ?? "index", expr: m[3]! };
}

/** The expression language's own truthiness (SPEC 6); shared by `!` and when=. */
function truthy(v: Literal): boolean {
  if (v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

function evalRaw(raw: string, opts: ReactiveOptions, scope: Scope): Literal {
  // Render-time contexts never carry a send sink: cap.send is valid only
  // inside on: handlers (SPEC 6), so a sink here would silently widen the
  // side-effect boundary to when=/each=/bindings during render.
  return evalExpr(raw, { scope, dollar: opts.dollar, limits: opts.limits });
}

function renderReactiveNode(n: Node, opts: ReactiveOptions, scope: Scope): string {
  if (!isBlock(n)) return renderNode(n, opts, scope);

  // SPEC 5: `when="expr"` hides the node when the expression is falsy.
  // Truthiness is the expression language's own (SPEC 6), not JS `!`: an
  // empty array is falsy exactly where `![]` is true in an expression.
  const when = n.fields.when;
  if (when !== undefined) {
    try {
      const v = isExpr(when) ? evalRaw(when.raw, opts, scope) : when;
      if (!truthy(v)) return "";
    } catch {
      return ""; // a failing guard hides only this node (SPEC 15)
    }
  }

  // SPEC 5: `each="item in expr"` repeats the node, keyed by id. The field
  // may arrive as an expression (braced) or a plain string body field.
  const each = n.fields.each;
  if (each !== undefined && (typeof each === "string" || isExpr(each))) {
    const rawEach = typeof each === "string" ? each : each.raw;
    const spec = parseEach(rawEach);
    if (spec === null) return renderNode(n, opts, scope);
    let items: Literal;
    try {
      items = evalRaw(spec.expr, opts, scope);
    } catch {
      return ""; // a failing repetition renders only this node empty (SPEC 15)
    }
    if (!Array.isArray(items)) return "";
    return items
      .map((item, index) => {
        // A block without an id keeps it: `id-0` clones are unresolvable by
        // runtime listeners, and -0 reads as falsy noise.
        const clone: BlockNode = { ...n, id: n.id === "" ? "" : `${n.id}-${index}` };
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
  return renderWithState(doc, computeState(doc, opts.initial, opts.limits), opts);
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
