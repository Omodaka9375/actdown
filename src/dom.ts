import { display, evaluate, parseExpr } from "./expr.js";
import { hydrate, type Runtime, type RuntimeOptions } from "./runtime.js";
import { parseEach } from "./react.js";
import type { BlockNode, Doc, Expr, Literal, Node } from "./types.js";

const isExprVal = (v: unknown): v is Expr =>
  v !== null && typeof v === "object" && (v as Expr).kind === "expr";

/**
 * SPEC 11: the DOM adapter. Instead of re-rendering whole fragments, it maps
 * `data-ad-id` to event listeners and `data-ad-bind` to live element
 * updates: `sync()` is one pass over the tree (bindings + phase regions) with
 * no torn reads. It is written against a minimal structural element view so
 * the package stays dependency-free; a standard browser `HTMLElement`
 * satisfies `DomElementView` as-is, and tests use a tiny fake.
 */
export interface DomElementView {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelectorAll(selector: string): { forEach(cb: (el: DomElementView) => void): void };
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  textContent: string;
  /** `HTMLElement.hidden`; optional so narrower hosts can conform. */
  hidden?: boolean;
  /** Input value; only field elements have one. */
  value?: string;
  /** Checkbox state. */
  checked?: boolean;
  /**
   * `HTMLElement.closest`; optional. When present, the adapter resolves the
   * `each=` clone an element belongs to so bindings inside repeated blocks
   * keep their `item`/`index` scope across `sync()`.
   */
  closest?(selector: string): DomElementView | null;
}

/** Extract a form's field values on submit (SPEC 4.3 `$fields`). */
export type FieldCollector = (form: DomElementView) => Record<string, Literal>;

export interface HydrateDomOptions extends RuntimeOptions {
  /** Field extraction for submit; default reads named descendants. */
  collectFields?: FieldCollector;
}

export interface DomHandle {
  runtime: Runtime;
  /**
   * One binding + phase pass over the live DOM. Called automatically after
   * every event the adapter fires; call it manually after `runtime.set`.
   */
  sync(): void;
}

function isBlock(n: Node): n is BlockNode {
  return n.kind === "block" && !("foreign" in n && n.foreign === true);
}

/**
 * Events a block listens to, from its `on:` attrs; without one, the type
 * defaults apply (action -> click, form -> submit, SPEC 4.2/4.3).
 */
function eventsOf(b: BlockNode): string[] {
  const evs: string[] = [];
  for (const k of Object.keys(b.attrs)) {
    if (k.startsWith("on:") && b.attrs[k] !== undefined) evs.push(k.slice(3));
  }
  if (evs.length === 0) {
    if (b.type === "action" && typeof b.attrs.name === "string") return ["click"];
    if (b.type === "form" && typeof b.attrs.action === "string") return ["submit"];
  }
  return evs;
}

/** Default `$fields`: named descendants; checkboxes become booleans. */
function collectNamed(form: DomElementView): Record<string, Literal> {
  const out: Record<string, Literal> = {};
  form.querySelectorAll("[name]").forEach((el) => {
    const name = el.getAttribute("name");
    if (name === null || name === "") return;
    if (el.getAttribute("type") === "checkbox") out[name] = el.checked === true;
    else out[name] = el.value ?? "";
  });
  return out;
}

function preventDefault(ev: unknown): void {
  if (ev !== null && typeof ev === "object" && "preventDefault" in ev) {
    (ev as { preventDefault(): void }).preventDefault();
  }
}

/**
 * Hydrate rendered HTML in place: attach listeners by `data-ad-id` and keep
 * `data-ad-bind` spans and phase regions in sync with the runtime state.
 */
export function hydrateDom(
  doc: Doc,
  root: DomElementView,
  opts: HydrateDomOptions = {},
): DomHandle {
  const runtime = hydrate(doc, opts);
  const blocks = new Map<string, BlockNode>();
  for (const n of doc.nodes) if (isBlock(n)) blocks.set(n.id, n);

  const collect = opts.collectFields ?? collectNamed;

  // Clone resolution: an id is an `each=` clone only when it is NOT itself a
  // declared block id (exact ids always win over the `-N` suffix) and it
  // matches `${base}-${n}` for a declared base. A real block named "job-1"
  // next to a base "job" is therefore never mistaken for a clone.
  const cloneOf = (id: string): { base: BlockNode; index: number } | null => {
    if (blocks.has(id)) return null;
    const m = /^(.*)-(\d+)$/.exec(id);
    if (m === null) return null;
    const base = blocks.get(m[1]!);
    if (base === undefined) return null;
    return { base, index: Number(m[2]) };
  };

  /** The base block's `each=` declaration, or null. */
  const eachSpecOf = (base: BlockNode): { item: string; index: string; expr: string } | null => {
    const each = base.fields.each;
    if (each === undefined) return null;
    const raw = typeof each === "string" ? each : isExprVal(each) ? each.raw : null;
    return raw === null ? null : parseEach(raw);
  };

  /** The clone's item/index overlay, resolved against current state. */
  const itemScopeOf = (base: BlockNode, index: number, scope: Record<string, Literal>): Record<string, Literal> => {
    const spec = eachSpecOf(base);
    const out: Record<string, Literal> = {};
    if (spec === null) return out;
    try {
      const items = evaluate(parseExpr(spec.expr), { scope });
      if (Array.isArray(items) && index < items.length) {
        out[spec.item] = items[index]!;
        out[spec.index] = index;
      }
    } catch {
      // Unresolvable item: bindings inside the clone fall back to document scope.
    }
    return out;
  };

  root.querySelectorAll("[data-ad-id]").forEach((el) => {
    const id = el.getAttribute("data-ad-id");
    if (id === null) return;
    const clone = cloneOf(id);
    const base = clone === null ? blocks.get(id) : clone.base;
    if (base === undefined) return;
    const index = clone === null ? undefined : clone.index;
    for (const ev of eventsOf(base)) {
      el.addEventListener(ev, (raw) => {
        if (ev === "submit") preventDefault(raw);
        const dollar: Record<string, Literal> = {};
        if (ev === "submit" && base.type === "form") dollar.fields = collect(el);
        if (index !== undefined) {
          dollar.index = index;
          // `$item` must be visible to handlers inside a clone: resolved
          // against the current state at fire time, not hydration time.
          const spec = eachSpecOf(base);
          const item = spec === null ? undefined : itemScopeOf(base, index, runtime.state())[spec.item];
          if (item !== undefined) dollar.item = item;
        }
        // fire() sets pending phases synchronously before its first await,
        // so an immediate sync shows the pending state; the settle sync
        // shows the final phase.
        const fired = runtime.fire(base.id, ev, dollar);
        sync();
        void fired.then(sync, sync);
      });
    }
  });

  function sync(): void {
    const scope = runtime.state();
    root.querySelectorAll("[data-ad-bind]").forEach((el) => {
      const raw = el.getAttribute("data-ad-bind");
      if (raw === null) return;
      let val = "";
      try {
        // A binding inside an `each=` clone evaluates with the clone's
        // item/index overlay, so `{item}` labels survive every sync pass
        // instead of being erased to E_BIND_UNKNOWN -> "".
        let env = scope;
        if (el.closest !== undefined) {
          const owner = el.closest("[data-ad-id]");
          const oid = owner === null ? null : owner.getAttribute("data-ad-id");
          if (oid !== null) {
            const clone = cloneOf(oid);
            if (clone !== null) {
              env = { ...scope, ...itemScopeOf(clone.base, clone.index, scope) };
            }
          }
        }
        val = display(evaluate(parseExpr(raw), { scope: env }));
      } catch {
        val = "";
      }
      el.textContent = val;
    });
    const phases = runtime.phases();
    root.querySelectorAll("[data-ad-phase]").forEach((el) => {
      const phase = el.getAttribute("data-ad-phase");
      const forId = el.getAttribute("data-ad-for");
      el.hidden = !(phase !== null && forId !== null && phases[forId] === phase);
    });
  }

  return { runtime, sync };
}
