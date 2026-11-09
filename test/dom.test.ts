import { describe, expect, it } from "vitest";
import { hydrateDom, type DomElementView } from "../src/dom.js";
import { parseHtml, type HtmlNode } from "../src/htmlparse.js";
import { canonicalize, parse, renderReactive } from "../src/index.js";
import type { Doc, Literal } from "../src/types.js";

const doc = (src: string): Doc => canonicalize(parse(src).doc);

/** A fake element satisfying DomElementView; selectors support the forms the adapter uses. */
class FakeEl implements DomElementView {
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  textContent = "";
  hidden?: boolean;
  value?: string;
  checked?: boolean;

  constructor(
    readonly tag: string,
    attrs: Record<string, string> = {},
  ) {
    this.attrs = { ...attrs };
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  querySelectorAll(selector: string): { forEach(cb: (el: FakeEl) => void): void } {
    const hits: FakeEl[] = [];
    const walk = (el: FakeEl): void => {
      for (const c of el.children) {
        if (matches(c, selector)) hits.push(c);
        walk(c);
      }
    };
    walk(this);
    return { forEach: (cb) => hits.forEach(cb) };
  }
  /** Test helper: dispatch a synthetic event to attached listeners. */
  fire(type: string, ev: unknown = undefined): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
}

function matches(el: FakeEl, selector: string): boolean {
  // "[name]" or "[name=value]" attribute selectors, the only forms used.
  const m = /^\[([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:=(.*))?\]$/.exec(selector);
  if (m === null) return false;
  const v = el.getAttribute(m[1]!);
  if (m[2] === undefined) return v !== null;
  return v === m[2];
}

/** Build a FakeEl tree from rendered HTML using the dependency-free parser. */
function dom(html: string): FakeEl {
  const tree = parseHtml(html);
  const convert = (n: HtmlNode): FakeEl => {
    const el = new FakeEl(n.tag, n.attrs);
    for (const c of n.children) {
      if (typeof c === "string") el.textContent += c;
      else el.children.push(convert(c));
    }
    return el;
  };
  const root = new FakeEl("#root");
  for (const c of tree.children) {
    if (typeof c === "string") continue;
    root.children.push(convert(c));
  }
  return root;
}

const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

const all = (root: FakeEl, selector: string): FakeEl[] => {
  const el: FakeEl[] = [];
  root.querySelectorAll(selector).forEach((e) => el.push(e));
  return el;
};

const byId = (root: FakeEl, id: string): FakeEl =>
  all(root, "[data-hdm-id]").filter((e) => e.getAttribute("data-hdm-id") === id)[0]!;

const COUNTER = `# Counter

\`\`\`hdm-state
count: 0
\`\`\`

\`\`\`hdm-action?name=counter.inc&role=primary
id: inc
---
Add one ({count})
\`\`\`

Count is {count}.
`;

const CONTACT = `# Contact

\`\`\`hdm-form?id=contact&action=cap:contact-form@v1
email: input(email, required)
message: textarea(maxlength=500)
\`\`\`

\`\`\`hdm-region
for: contact
phase: pending
---
Sending...
\`\`\`

\`\`\`hdm-region
for: contact
phase: success
---
Thanks, {email}.
\`\`\`
`;

describe("dom adapter (SPEC 11)", () => {
  it("updates data-hdm-bind spans in place instead of re-rendering", async () => {
    const html = renderReactive(doc(COUNTER));
    const root = dom(html);
    const handle = hydrateDom(doc(COUNTER), root, {
      capabilities: {
        "counter.inc": (_args, ctx) => {
          ctx.set({ count: (ctx.state.count as number) + 1 });
        },
      },
    });

    const spans = all(root, "[data-hdm-bind]");
    expect(spans.map((s) => s.textContent)).toEqual(["0", "0"]);

    byId(root, "inc").fire("click");
    await flush();

    // Same element objects, new text: updated in place, not re-rendered.
    expect(all(root, "[data-hdm-bind]")).toEqual(spans);
    expect(spans.map((s) => s.textContent)).toEqual(["1", "1"]);
  });

  it("wires form submit to $fields via the default collector and toggles phases", async () => {
    const html = renderReactive(doc(CONTACT), { initial: { email: "" } });
    const root = dom(html);
    const handle = hydrateDom(doc(CONTACT), root, {
      initial: { email: "" },
      capabilities: {
        "cap:contact-form@v1": async (args, ctx) => {
          const a = args as Record<string, Literal>;
          ctx.set({ email: String(a.email) });
        },
      },
    });

    const form = byId(root, "contact");
    const email = all(form, "[name]").filter((e) => e.getAttribute("name") === "email")[0]!;
    email.value = "a@b.c";

    let prevented = false;
    form.fire("submit", { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    await flush();

    // Success region unhidden, pending re-hidden, binding refreshed.
    const phase = (p: string): FakeEl =>
      all(root, "[data-hdm-phase]").filter((e) => e.getAttribute("data-hdm-phase") === p)[0]!;
    expect(phase("success")!.hidden).toBe(false);
    expect(phase("pending")!.hidden).toBe(true);
    expect(handle.runtime.state().email).toBe("a@b.c");
    expect(all(root, "[data-hdm-bind]").map((s) => s.textContent)).toEqual(["a@b.c"]);
  });

  it("sync() refreshes bindings after an external runtime.set", () => {
    const html = renderReactive(doc(COUNTER));
    const root = dom(html);
    const handle = hydrateDom(doc(COUNTER), root);
    const span = all(root, "[data-hdm-bind]")[0]!;
    expect(span.textContent).toBe("0");
    handle.runtime.set({ count: 7 });
    handle.sync();
    expect(span.textContent).toBe("7");
  });

  it("wires listeners on each= clones and passes $index", async () => {
    const src = "```hdm-state\nitems: [10, 20]\n```\n\n```hdm-action?name=item.pick&id=pick&each=item%20in%20items\non:click: cap.send(\"item.pick\", $index)\n---\nPick\n```";
    const root = dom(renderReactive(doc(src)));
    const seen: Literal[] = [];
    hydrateDom(doc(src), root, {
      capabilities: {
        "item.pick": (args) => {
          seen.push(args);
        },
      },
    });
    byId(root, "pick-0").fire("click");
    byId(root, "pick-1").fire("click");
    await flush();
    expect(seen).toEqual([0, 1]);
  });
});
