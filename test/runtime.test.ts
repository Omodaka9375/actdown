import { describe, expect, it } from "vitest";
import { canonicalize, parse, render } from "../src/index.js";
import { CapMissingError, hydrate } from "../src/runtime.js";
import type { Doc } from "../src/types.js";

const doc = (src: string): Doc => canonicalize(parse(src).doc);

const COUNTER = `# Counter

\`\`\`ad-state
count: 0
\`\`\`

\`\`\`ad-action?name=counter.inc&role=primary&on:click
id: inc
---
Add one ({count})
\`\`\`

Count is {count}.
`;

const SAVE = `# Save

\`\`\`ad-action?name=doc.save&on:click
id: save
---
Save now
\`\`\`

\`\`\`ad-region
for: save
phase: pending
---
Saving...
\`\`\`

\`\`\`ad-region
for: save
phase: success
---
Saved at {saved}.
\`\`\`

\`\`\`ad-region
for: save
phase: failure
---
Could not save.
\`\`\`
`;

const ECHO = '```ad-action?name=echo.set&on:click=cap.send("echo.set", {value: $value})\nid: echo\n---\nEcho\n```';

describe("runtime (SPEC 7/11)", () => {
  it("attaches capabilities by data-ad-id and updates bindings in one pass", async () => {
    const rt = hydrate(doc(COUNTER), {
      capabilities: {
        "counter.inc": (_args, ctx) => ctx.set({ count: (ctx.state.count as number) + 1 }),
      },
    });
    expect(rt.html()).toContain('data-ad-bind="count">0</span>');
    await rt.fire("inc", "click");
    expect(rt.state()).toEqual({ count: 1 });
    expect(rt.html()).toContain('data-ad-bind="count">1</span>');
  });

  it("passes $payload from fire into on: expressions", async () => {
    const rt = hydrate(doc(ECHO), {
      initial: { last: "" },
      capabilities: {
        "echo.set": (args, ctx) => {
          const a = args as Record<string, unknown>;
          ctx.set({ last: String(a.value) });
        },
      },
    });
    await rt.fire("echo", "click", { value: "hi" });
    expect(rt.state().last).toBe("hi");
  });

  it("refuses capabilities that are not granted (SEC-1)", async () => {
    const rt = hydrate(doc(COUNTER));
    await expect(rt.fire("inc", "click")).rejects.toThrow(CapMissingError);
  });

  it("tracks pending/success phases around an awaited capability", async () => {
    let resolveSave: (v: unknown) => void = () => {};
    const saved = new Promise((r) => (resolveSave = r));
    const rt = hydrate(doc(SAVE), {
      initial: { saved: "never" },
      capabilities: {
        "doc.save": async (_args, ctx) => {
          await saved;
          ctx.set({ saved: "just now" });
        },
      },
    });
    const done = rt.fire("save", "click");
    // Pending is visible in html() before the capability settles.
    expect(rt.phases()).toEqual({ save: "pending" });
    expect(rt.html()).not.toContain('data-ad-phase="pending" hidden');
    expect(rt.html()).toContain('data-ad-phase="success" hidden');
    resolveSave(undefined);
    await done;
    expect(rt.phases()).toEqual({ save: "success" });
    expect(rt.html()).toContain('data-ad-phase="success"');
    expect(rt.html()).not.toContain('data-ad-phase="success" hidden');
    expect(rt.html()).toContain('>just now</span>');
  });

  it("marks failure when the capability rejects", async () => {
    const rt = hydrate(doc(SAVE), {
      capabilities: {
        "doc.save": async () => {
          throw new Error("disk full");
        },
      },
    });
    await expect(rt.fire("save", "click")).rejects.toThrow("disk full");
    expect(rt.phases()).toEqual({ save: "failure" });
    expect(rt.html()).toContain("Could not save.");
  });

  it("static level-1 render keeps every phase region hidden", () => {
    const html = render(doc(SAVE));
    expect(html.match(/hidden/g)!.length).toBe(3);
    expect(html).toContain('data-ad-for="save"');
  });

  it("submits a form end to end: on:submit sees $fields and action (SPEC 4.3)", async () => {
    const seen: { cap: string; args: unknown }[] = [];
    const rt = hydrate(doc(CONTACT), {
      capabilities: {
        "cap:contact-form@v1": (args) => {
          seen.push({ cap: "contact", args });
        },
      },
    });
    await rt.submit("contact", { email: "a@b.c", message: "hi" });
    expect(seen).toEqual([
      { cap: "contact", args: { email: "a@b.c", message: "hi" } },
    ]);
  });

  it("a plain form routes submit to its action capability with the fields", async () => {
    const seen: unknown[] = [];
    const rt = hydrate(doc(PLAIN_FORM), {
      capabilities: {
        "cap:search@v1": (args) => {
          seen.push(args);
        },
      },
    });
    await rt.fire("search", "submit", { fields: { q: "ad" } });
    expect(seen).toEqual([{ q: "ad" }]);
    await expect(rt.fire("search", "submit", { fields: { q: "x" } })).resolves.toBeUndefined();
  });

  it("form submit drives pending/success phases on the form id", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const rt = hydrate(doc(CONTACT), {
      initial: { email: "" },
      capabilities: {
        "cap:contact-form@v1": async (args, ctx) => {
          await gate;
          const a = args as Record<string, unknown>;
          ctx.set({ email: String(a.email) });
        },
      },
    });
    const done = rt.submit("contact", { email: "a@b.c" });
    expect(rt.phases()).toEqual({ contact: "pending" });
    expect(rt.html()).toContain('data-ad-phase="pending"');
    release();
    await done;
    expect(rt.phases()).toEqual({ contact: "success" });
    expect(rt.html()).toContain(">a@b.c</span>");
  });
});

const CONTACT = `# Contact

\`\`\`ad-form?id=contact&action=cap:contact-form@v1
email: input(email, required)
message: textarea(maxlength=500)
send: submit(label="Send")
on:submit: cap.send(action, $fields)
\`\`\`

\`\`\`ad-region
for: contact
phase: pending
---
Sending...
\`\`\`

\`\`\`ad-region
for: contact
phase: success
---
Thanks, {email}.
\`\`\`
`;

const PLAIN_FORM = `# Search

\`\`\`ad-form?id=search&action=cap:search@v1
q: input(text, required)
go: submit(label="Go")
\`\`\`
`;
