import { evaluate, parseExpr, ExprError } from "./expr.js";
import { computeState, recomputeExprState, renderWithState, type ReactiveOptions } from "./react.js";
import type { BlockNode, Doc, Literal, Node } from "./types.js";

/**
 * SPEC 7/11: the runtime. It attaches behavior by `data-ad-id`, keeps the
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
   * A plain `ad-action` (no `on:` expression) fires its `name` capability
   * with its `args` field (SPEC 4.2); a plain `ad-form` fires its `action`
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
  // The scope object is mutated in place for the lifetime of the runtime, so
  // a capability holding `ctx.state` always observes current values (no
  // stale snapshot across an await).
  const scope = computeState(doc, opts.initial, opts.limits);
  const phases: Record<string, string> = {};
  const caps = opts.capabilities ?? {};

  const applyPatch = (patch: Record<string, Literal>): void => {
    Object.assign(scope, patch);
    // Computed state tracks patches (SPEC 5): expression-backed fields are
    // re-evaluated after every change. Literal seeds are not reapplied, so a
    // host patch to a literal-named key survives.
    recomputeExprState(doc, scope, opts.limits);
  };

  const html = (): string => renderWithState(doc, scope, { ...opts, phases });

  const runtime: Runtime = {
    state: () => ({ ...scope }),
    phases: () => ({ ...phases }),
    set(patch) {
      applyPatch(patch);
    },
    html,
    submit(formId, fields) {
      return runtime.fire(formId, "submit", { fields });
    },
    async fire(blockId, event, dollar) {
      const block = findBlock(doc, blockId);
      if (block === undefined) throw new Error(`no block with id "${blockId}"`);

      const runCap = (name: string, args: Literal): Literal | Promise<Literal> | void => {
        // Own-property lookup only: `caps.constructor` must not resolve to
        // the inherited Object constructor (E_CAP_MISSING, not a live host
        // function).
        const fn = Object.hasOwn(caps, name) ? caps[name] : undefined;
        if (typeof fn !== "function") throw new CapMissingError(name);
        const out = fn(args, {
          state: scope,
          set: (patch) => {
            applyPatch(patch);
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
          const rawArgs = block.fields.args;
          const isExpr =
            rawArgs !== undefined && typeof rawArgs === "object" && rawArgs !== null && "kind" in rawArgs && rawArgs.kind === "expr";
          const args: Literal = isExpr
            ? evaluate(parseExpr((rawArgs as { raw: string }).raw), { scope })
            : ((rawArgs as Literal | undefined) ?? null);
          await runCap(block.attrs.name, args);
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
      // evaluate() is synchronous, so a capability that returns a promise
      // yields a bare promise inside the value tree. Collect every send
      // promise here and await all of them after evaluation: each send
      // settles (phase regions update), a rejecting send rejects the fire,
      // and a rejecting send nested in the expression tree can never become
      // an unhandled rejection.
      const sends: Promise<Literal>[] = [];
      let value: unknown;
      try {
        value = evaluate(parseExpr(on.raw), {
          scope: { ...local, ...scope },
          dollar,
          send: (name, args) => {
            const r = runCap(name, args);
            if (r instanceof Promise) sends.push(r);
            return r;
          },
          limits: opts.limits,
        });
      } catch (err) {
        // Sends made before a parse/eval failure must still be awaited so a
        // rejecting capability cannot escape as an unhandled rejection.
        await Promise.allSettled(sends);
        throw err;
      }
      await settleSends(value, sends);
    },
  };
  return runtime;
}

/** Await every collected send promise; a rejected send rethrows. */
async function settleSends(value: unknown, sends: Promise<Literal>[]): Promise<void> {
  if (value instanceof Promise) sends.push(value);
  const results = await Promise.allSettled(sends);
  for (const r of results) {
    if (r.status === "rejected") throw r.reason;
  }
}

export { ExprError };
