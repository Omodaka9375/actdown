import { display, evaluate, parseExpr } from "./expr.js";
import { hydrate, type Runtime, type RuntimeOptions } from "./runtime.js";
import type { BlockNode, Doc, Literal, Node } from "./types.js";

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

  root.querySelectorAll("[data-ad-id]").forEach((el) => {
    const id = el.getAttribute("data-ad-id");
    if (id === null) return;
    // `each=` repeats a block as `${id}-${index}`: resolve the source block
    // and expose the clone index as `$index` so handlers can act on the item.
    const m = /^(.*)-(\d+)$/.exec(id);
    const base = m !== null && blocks.has(m[1]!) ? m[1]! : id;
    const index = base === id ? undefined : Number(m![2]);
    const block = blocks.get(base);
    if (block === undefined) return;
    for (const ev of eventsOf(block)) {
      el.addEventListener(ev, (raw) => {
        if (ev === "submit") preventDefault(raw);
        const dollar: Record<string, Literal> = {};
        if (ev === "submit" && block.type === "form") dollar.fields = collect(el);
        if (index !== undefined) dollar.index = index;
        void runtime.fire(base, ev, dollar).then(sync, sync);
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
        val = display(evaluate(parseExpr(raw), { scope }));
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
