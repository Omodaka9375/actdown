import { evaluate, parseExpr, ExprError } from "./expr.js";
import { computeState, renderWithState, type ReactiveOptions } from "./react.js";
import type { BlockNode, Doc, Literal, Node } from "./types.js";

/**
 * SPEC 7/11: the runtime. It attaches behavior by `data-hdm-id`, keeps the
 * flat state map, and re-renders all bindings in one pass on every change
 * (no torn reads, SPEC 5). Capabilities are opt-in: a capability runs only if
 * it is present in the capabilities granted to `hydrate` (SEC-1).
 */

/** A capability receives data args (SEC-2) and a state handle; never code. */
export type CapabilityFn = (
  args: Literal,
  ctx: { state: Record<string, Literal>; set: (patch: Record<string, Literal>) => void },
) => Literal | Promise<Literal> | void;

export interface RuntimeOptions extends ReactiveOptions {
  /** Granted capabilities (SEC-1): name -> implementation. */
  capabilities?: Record<string, CapabilityFn>;
}

/** Fired when a document names a capability the runtime has not granted. */
export class CapMissingError extends Error {
  readonly code = "E_CAP_MISSING";
  constructor(name: string) {
    super(`capability not granted: ${name}`);
    this.name = "CapMissingError";
  }
}

function isPlainBlock(n: Node): n is BlockNode {
  return n.kind === "block" && !("foreign" in n && n.foreign === true);
}

function findBlock(doc: Doc, id: string): BlockNode | undefined {
  for (const n of doc.nodes) {
    if (isPlainBlock(n) && n.id === id) return n;
  }
  return undefined;
}

export interface Runtime {
  /** Current flat state (SPEC 5). */
  state(): Record<string, Literal>;
  /** Current async phase per action id: pending | success | failure. */
  phases(): Record<string, string>;
  /** Apply a state patch and re-render all bindings in one pass. */
  set(patch: Record<string, Literal>): void;
  /** Current reactive HTML (SPEC 11). */
  html(): string;
  /**
   * Fire a block's `on:<event>` expression with `$name` payload available.
   * A plain `hdm-action` (no `on:` expression) fires its `name` capability
   * with its `args` field (SPEC 4.2); a plain `hdm-form` fires its `action`
   * capability with the submitted fields (SPEC 4.3). Resolves after any
   * awaited capability settles and the phase regions are updated.
   */
  fire(blockId: string, event: string, dollar?: Record<string, Literal>): Promise<void>;
  /**
   * Submit a form block (SPEC 4.3): fires its `on:submit` expression (or its
   * plain `action` capability) with `$fields` bound to the field values.
   */
  submit(formId: string, fields: Record<string, Literal>): Promise<void>;
}

export function hydrate(doc: Doc, opts: RuntimeOptions = {}): Runtime {
  let scope = computeState(doc, opts.initial);
  const phases: Record<string, string> = {};
  const caps = opts.capabilities ?? {};

  const html = (): string => renderWithState(doc, scope, { ...opts, phases });

  const runtime: Runtime = {
    state: () => ({ ...scope }),
    phases: () => ({ ...phases }),
    set(patch) {
      scope = { ...scope, ...patch };
    },
    html,
    submit(formId, fields) {
      return runtime.fire(formId, "submit", { fields });
    },
    async fire(blockId, event, dollar) {
      const block = findBlock(doc, blockId);
      if (block === undefined) throw new Error(`no block with id "${blockId}"`);

      const runCap = (name: string, args: Literal): Literal | Promise<Literal> | void => {
        const fn = caps[name];
        if (fn === undefined) throw new CapMissingError(name);
        const out = fn(args, {
          state: scope,
          set: (patch) => {
            scope = { ...scope, ...patch };
          },
        });
        if (out instanceof Promise) {
          phases[blockId] = "pending";
          return out
            .then((v) => {
              phases[blockId] = "success";
              return v;
            })
            .catch((err: unknown) => {
              phases[blockId] = "failure";
              throw err;
            });
        }
        return out;
      };

      const on = block.attrs[`on:${event}`];
      if (on === undefined || typeof on === "string" || on.raw === "") {
        // SPEC 4.2: a plain action fires its named capability with data args.
        if (event === "click" && block.type === "action" && typeof block.attrs.name === "string") {
          await runCap(block.attrs.name, (block.fields.args as Literal) ?? null);
          return;
        }
        // SPEC 4.3: a plain form fires its `action` capability with the fields.
        if (event === "submit" && block.type === "form" && typeof block.attrs.action === "string") {
          await runCap(block.attrs.action, dollar?.fields ?? null);
        }
        return;
      }

      // SPEC 6: `on:` attributes evaluate expressions; cap.send routes to
      // caps. The block's own string attrs (e.g. a form's `action`) are
      // visible as names; state shadows them.
      const local: Record<string, Literal> = {};
      for (const [k, v] of Object.entries(block.attrs)) {
        if (typeof v === "string") local[k] = v;
      }
      await evaluate(parseExpr(on.raw), {
        scope: { ...local, ...scope },
        dollar,
        send: (name, args) => runCap(name, args),
        limits: opts.limits,
      });
    },
  };
  return runtime;
}

export { ExprError };
