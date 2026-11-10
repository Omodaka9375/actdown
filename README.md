# actdown

**Actionable Markdown: documents that agents can read, write, and operate.**

actdown (short form: ad) is a Markdown
superset for documents that both people and autonomous agents can read,
write, and operate. Prose stays Markdown. Fenced `ad-*` blocks add
semantic structure, state, forms, and actions. Actions name capabilities
granted by the host application; a document cannot supply arbitrary
JavaScript.

The project, package, and file extension (`.ad`) are named **actdown**.
The wire format is fully consistent: `ad-*` fences, the `ad: "0.1"` AST
header, `.ad` documents, and `data-ad-*` HTML attributes.

## Who is it for?

Every user below has the same underlying problem: **they want their agent to
be able to offer an action safely, without giving it code execution or
building a screen by hand.** Today they must choose between shipping agent
code (dangerous, heavy) or giving the agent nothing (it becomes a text
printer). actdown is the third option.

**Agent-platform developers.** They build the bot or copilot that calls real
tools: deploy, refund, delete. Today every tool call happens silently, or
they hand-build an approval screen per action. With actdown the agent
proposes its own screen as a text file, and they write the capability wiring
once: ten tools means ten short documents plus one shared renderer, not ten
custom UIs.

**Security and compliance reviewers.** They sign off on what agents may do.
If an agent ships a JavaScript bundle with its approval form, review means
auditing compiled code. With actdown the artifact is auditable text: the
document lists every side effect it could ever have, ungranted capabilities
refuse to run, and review is a diff. See the
[approval demo](examples/mcp-approval/) for that flow end to end.

**Internal-tools teams.** They maintain dashboards where staff approve agent
proposals. Screens there are hand-coded React; every change needs a pull
request and a deploy. actdown documents are data, not code: screen content
ships as text, updates like content, renders with no build step, and still
reads fine in a plain Markdown viewer.

**Agent-framework authors.** They maintain an open-source agent library and
cannot ship a UI framework inside it. Their library only emits text, which
is enough: if the user's host understands ad, the text becomes buttons; if
not, it degrades to readable Markdown. Zero dependency on this project.

It is not a no-code website builder, a general replacement for React, or a
way to run untrusted application code. End users interact with the HTML or
native UI produced by a host application; they do not need to learn ad.

## Why actdown?

Three kinds of format exist for agent-facing content, and none of them fits:

```text
Docs for agents    (llms.txt, .md endpoints)  readable but dead:
                                              no state, no actions
Agent UI bundles   (MCP Apps, Apps SDK)       alive but opaque:
                                              JS code, bundler, iframe
Declarative cards  (Adaptive Cards)           JSON, not prose: agents
                                              cannot read their own UI
```

actdown is the missing middle: **a text document that can hold state and
name actions, and still render with no JavaScript at all.**

HTML is a good browser delivery format but an expensive agent interface.
Presentation markup obscures meaning, pages are token-heavy, and behavior
usually depends on JavaScript that an agent should not execute. actdown
separates those concerns:

| Need | actdown answer |
|---|---|
| Readable content | Ordinary Markdown prose |
| Machine meaning | Semantic blocks, stable ids, and roles |
| Reliable interchange | A defined AST and idempotent canonical text |
| Interaction without scripts | A small expression language and named capabilities |
| Controlled side effects | The host grants each capability explicitly |
| Existing web content | Lossy HTML-to-ad conversion plus an edge transcoder |

The important boundary is that **the document describes intent; the host
owns behavior**. A document can request `cart.add`, but it cannot define
what that function does. Ungranted capabilities are not executed. That
boundary is enforced by design, not by policy: there is no script syntax
to abuse, so there is nothing to sandbox.

## What is the deliverable?

This repository contains a language and its implementation tools, not a
hosted service or an end-user application:

1. **`SPEC.md`**: the normative draft 0.1 language specification.
2. **`src/`**: the dependency-free TypeScript reference implementation:
   parsing, canonicalization, JSON AST, HTML rendering, reactive state,
   events, forms, a DOM adapter, and HTML downconversion.
3. **`actdown-rs/`**: the Rust implementation, including a WASM build.
4. **`vectors/`**: shared byte-exact conformance fixtures used by both
   implementations.
5. **`src/edge.ts` and `src/serve.ts`**: an embeddable transcoder core and
   a development HTTP gateway for HTML-to-ad conversion.

There is no prebuilt hosted UI or capability catalog. The integrating
application decides which capabilities exist and what they are allowed to
do. This is a development preview, not a production-ready public gateway;
see [Status and deployment limits](#status-and-deployment-limits).

## How is it used?

There are three main workflows, which can be used independently.

### 1. Author an interactive document

A document mixes normal prose with semantic blocks:

````markdown
# Cart

```ad-state
count: 0
```

```ad-action?name=counter.inc&role=primary
id: add
---
Add one ({count})
```

Current count: {count}.
````

When clicked, the host's `counter.inc` capability updates `count`; the
rendered binding spans then show the new value.

### 2. Let an agent read or produce structured content

The host parses ad into the AST, or converts an existing HTML page. It
can then inspect canonical ad or JSON without executing document code.
The edge gateway exposes the same conversion over HTTP during development.

### 3. Render and connect host-owned actions

The host renders HTML, grants only the capabilities it trusts, and fires
events through the runtime. For a browser, `hydrateDom` attaches listeners
and updates existing binding spans in place.

Unknown block types remain code fences, so a document still degrades to
readable Markdown in tools that do not understand ad.

## Levels

An implementation declares the levels it supports; each is a strict
superset of the one below (SPEC 3):

| Level | Surface |
|---|---|
| 0 | Markdown prose only |
| 1 | Structural blocks: state, data, action, form, table, image, link, chart, region, ... |
| 2 | Bindings, `when=`, `each=`, generated ids |
| 3 | Expression language, computed state, async phase regions |

## Repository layout

```text
src/           TypeScript reference implementation
  parse.ts       block grammar (fences, info strings, field sets)
  canonical.ts   canonical printer + AST JSON (SPEC 9/10)
  render.ts      level-1 HTML (SPEC 11, Appendix A)
  expr.ts        expression language (SPEC 6)
  react.ts       computed state, when/each, reactive render
  runtime.ts     hydrate/fire/submit, capability registry, phases
  dom.ts         DOM adapter: in-place binding updates, no re-render
  html2ad.ts    legacy HTML to canonical ad (SPEC 12)
  edge.ts/serve.ts  the edge transcoder service
test/          vitest suite (97 tests)
vectors/       cross-implementation conformance suite (SPEC 13)
actdown-rs/   Rust port (parser, canonical, render, expr, react, runtime)
scripts/       verify.mjs: tsc + vitest, shell-agnostic
SPEC.md        the specification (draft 0.1, normative)
DESIGN.md      architecture and solution-path rationale
```

## Getting started

Requires Node 20+ and pnpm; the Rust tests additionally need cargo.

```sh
pnpm install
pnpm verify        # tsc, then the full vitest suite
pnpm verify:rs     # cargo test for actdown-rs
```

## TypeScript example

After `pnpm build`, use `./dist/index.js` from this repository. If this
package is installed in an application, import from `actdown` instead.
The public exports live in `src/index.ts`; there is no separate runtime
subpath export.

This example parses the counter document above, grants one capability,
and fires the button's click event:

```ts
import {
  canonicalize,
  format,
  hydrate,
  parse,
  render,
  renderReactive,
  toJSON,
} from "./dist/index.js";

const input = `# Cart

\`\`\`ad-state
count: 0
\`\`\`

\`\`\`ad-action?name=counter.inc&role=primary
id: add
---
Add one ({count})
\`\`\`

Current count: {count}.
`;

const doc = canonicalize(parse(input).doc);

// Machine surfaces: stable AST and canonical text.
console.log(toJSON(doc));
console.log(format(input));

// Human surfaces: static HTML, or HTML with state-filled binding spans.
console.log(render(doc));
console.log(renderReactive(doc));

const runtime = hydrate(doc, {
  capabilities: {
    "counter.inc": (_args, ctx) => {
      ctx.set({ count: (ctx.state.count as number) + 1 });
    },
  },
});

await runtime.fire("add", "click");
console.log(runtime.state().count); // 1
console.log(runtime.html());        // bindings and phase regions updated
```

In a browser, insert the reactive HTML and call `hydrateDom(doc, root,
options)` with the same options instead of manually calling `fire`. The
DOM adapter attaches event listeners by `data-ad-id`; `handle.sync()`
refreshes binding spans after an external `runtime.set(...)`.

Interactivity is opt-in per capability: a document can name a capability,
never define one. During rendering, an unregistered action can be marked
disabled with `data-cap-missing` by passing a `registry`. Firing an
ungranted capability through the runtime raises `CapMissingError`.

## Edge transcoder

The development gateway fetches a URL, downconverts its HTML to canonical
ad for agents, and retains the original text. It converts existing pages;
it does not make them interactive, and scripts in the source page are not
executed.

Run it explicitly when needed:

```sh
pnpm build
pnpm edge            # listens on port 8787; override with PORT
```

Then request a conversion, for example:

```text
/transcode?url=https%3A%2F%2Fexample.com&format=canonical
/transcode?url=https%3A%2F%2Fexample.com&format=ast
/transcode?url=https%3A%2F%2Fexample.com&format=html
/transcode?url=https%3A%2F%2Fexample.com&format=raw
/view?url=https%3A%2F%2Fexample.com
```

Formats are canonical ad (`text/x-ad`, the default), JSON AST, rendered
HTML, and the original source as inert `text/plain`. `/view` is the
dual-pane inspection UI. Errors are JSON `{ code, message }`, with codes
such as `E_EDGE_FETCH`, `E_EDGE_TIMEOUT`, and `E_EDGE_SIZE`.

The SSRF guard refuses literal private, loopback, link-local, and mapped
IPv6 targets. `EDGE_ALLOW_PRIVATE=1` disables that guard and should only be
used for controlled local fixtures, never for an exposed gateway.

## Conformance

The `vectors/` directory is the cross-implementation suite (SPEC 13): each
vector is an input document plus exact `ast.json`, `canonical.ad`,
`html.html` and (level 2+) `reactive.html` goldens, indexed by
`manifest.json`. Both implementations read the same goldens, so spec
conformance is proven twice, not asserted. See `vectors/README.md` for
the report format (`pass | fail(<vector>:<golden>) | skip(<level>)`).

## Rust / WASM port

`actdown-rs` mirrors the reference implementation byte for byte on the
spec surfaces (all 7 vectors pass all 4 goldens) and builds for
`wasm32-unknown-unknown`:

```sh
cd actdown-rs
cargo build --target wasm32-unknown-unknown
```

One documented divergence: Rust capabilities are synchronous, so the
phase map records success/failure per call instead of a pending window.

## Specification

`SPEC.md` is the normative document (draft 0.1, RFC 2119 keywords).
Highlights: the AST is the contract (INV-2); canonicalization is total
and idempotent (INV-3); there is no script equivalent (INV-4); every
interactive node carries a stable id and semantic role (INV-5).

## Status and deployment limits

This is **draft 0.1, suitable for local tools and controlled internal
experiments, not a production-ready public service**. The TypeScript and
Rust suites currently cover the same seven vectors, but that is not enough
to certify arbitrary web content or adversarial network deployments.

Before exposing the gateway beyond a trusted environment, add:

- DNS resolution checks on every redirect and protection against DNS
  rebinding, backed by restricted network egress. Literal-IP checks alone
  do not stop a public hostname resolving to a private address.
- Authentication or an explicit trusted-client boundary, rate and
  concurrency limits, request-size limits, and an explicit listen address.
- Fuzzing and property-based parser tests, adversarial redirect tests, and
  real-browser tests for the DOM adapter.
- CI across supported Node and browser versions, dependency and release
  policies, and operational logging/monitoring.

Feature work still open includes `ad-include`, some form-control
rendering, and wasm-bindgen integration. Rust capabilities are synchronous
while TypeScript capabilities may be asynchronous, so async phase behavior
is not identical. Do not treat capability names as a security sandbox for
host functions: capability implementations themselves remain trusted host
code and must validate their arguments.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
