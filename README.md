# actdown

[![CI](https://github.com/Omodaka9375/actdown/actions/workflows/ci.yml/badge.svg)](https://github.com/Omodaka9375/actdown/actions/workflows/ci.yml)

**Actionable Markdown: documents that agents can read, write, and operate.**

![actdown end to end: an agent-authored approval document is audited
statically, rendered safely with nothing granted, then operated through one
granted capability. Bindings fill, phase regions flip, buttons retire, and
the audit trail records the decision.](docs/demo.gif)

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

You want your agent to offer an action safely, without shipping it code or
hand-building a screen. actdown is that middle option.

- **Agent-platform developers.** You build the bot or copilot that calls real
  tools. The agent proposes its own screen as a text file; you write the
  capability wiring once, not one custom UI per tool.
- **Security and compliance reviewers.** You sign off on what agents may do.
  The artifact is auditable text: the document lists every side effect it
  could ever have, and review is a diff. See the
  [approval demo](examples/mcp-approval/) end to end.
- **Internal-tools teams.** You maintain dashboards where staff approve agent
  proposals. Screen content ships as text, updates like content, and renders
  with no build step.
- **Agent-framework authors.** You maintain a library that only emits text.
  If the host understands ad, the text becomes buttons; if not, it degrades
  to readable Markdown. Zero dependency on this project.

It is not a no-code website builder, a general replacement for React, or a
way to run untrusted application code. End users never need to learn ad.

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
6. **`src/mcp.ts`**: a zero-dependency stdio MCP server (7 tools, 2
   in-session guides) so MCP clients can transcode, convert, render, and
   check documents without writing glue.

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

For MCP clients, the stdio server is the fastest path ("reader mode" for
agents): point the client at the server, and the agent gets
`actdown_transcode` (fetch a URL, get clean canonical ad with the SSRF
guard stack and anti-cloaking enforced), `actdown_html2ad`, and the
render/check tools plus the in-session guides:

```json
{
  "mcpServers": {
    "actdown": {
      "command": "npx",
      "args": ["-y", "-p", "actdown", "actdown-mcp"]
    }
  }
}
```

From a checkout, run `node dist/mcp.js` directly instead.

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
  mcp.ts         stdio MCP server (JSON-RPC 2.0, zero dependencies)
  html2ad.ts    legacy HTML to canonical ad (SPEC 12)
  edge.ts/serve.ts  the edge transcoder service
test/          vitest suite (141 tests)
vectors/       cross-implementation conformance suite (SPEC 13)
actdown-rs/   Rust port (parser, canonical, render, expr, react, runtime)
  src/wasm.rs    flat C ABI exports for the browser playground
  playground.html  self-contained playground (see below)
scripts/       verify.mjs: tsc + vitest, shell-agnostic
SPEC.md        the specification (draft 0.1, normative)
DESIGN.md      architecture and solution-path rationale
docs/demo.gif  the end-to-end approval demo (README hero animation)
```

## Getting started

Requires Node 20+ and pnpm; the Rust tests additionally need cargo.

```sh
pnpm install
pnpm verify        # tsc, then the full vitest suite
pnpm verify:rs     # cargo test for actdown-rs
```

## CLI

A zero-dependency command line ships with the package (`bin: actdown`,
run locally via `pnpm cli`). `-` or no file reads stdin.

```sh
pnpm cli check   examples/mcp-approval/approval.ad   # diagnostics, exit 1 on any
pnpm cli fmt     doc.ad                             # canonical form (diffable)
pnpm cli ast     doc.ad                             # JSON AST
pnpm cli ast     doc.ad --inline                    # AST with ad-include spliced
pnpm cli render  doc.ad                             # static HTML
pnpm cli render  doc.ad --reactive                  # HTML with state applied
pnpm cli html2ad page.html                          # HTML -> canonical ad
cat page.html | pnpm cli html2ad - > page.ad        # stdin works too
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
executed. Author-hidden content (`display:none`, `visibility:hidden`,
`opacity:0`, `aria-hidden`, the `hidden` attribute, `template`) is dropped
during conversion and reported as an aggregate audit note with no content
preview, so invisible-text smuggling (cloaking) cannot reach an agent as
prose. Detection is markup-based; text hidden by rendered-page CSS alone
(for example site classes like `sr-only`, or colors matching the
background) is not caught.

Run it explicitly when needed:

```sh
pnpm build
pnpm edge            # 127.0.0.1:8787; override with PORT and HOST
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
dual-pane inspection UI, `/healthz` is a liveness probe. Errors are JSON
`{ code, message }`, with codes such as `E_EDGE_FETCH`, `E_EDGE_TIMEOUT`,
and `E_EDGE_SIZE`.

The gateway binds to `127.0.0.1` by default (set `HOST` to widen it
deliberately) and enforces limits: per-IP request rate (`EDGE_RATE_LIMIT`
requests per minute, default 120, `429 E_EDGE_RATE`), an in-flight
transcode cap (`503 E_EDGE_BUSY`), and an inbound body cap (`413
E_EDGE_TOO_LARGE`). Every request is logged to stdout as one line.

For untrusted networks, set `EDGE_TOKEN` to a shared secret (at least 16
random characters). Every route except `/healthz` then requires the token:
agents send `Authorization: Bearer <token>`, browsers (and the `/view`
iframes, which cannot set headers) append `?token=<token>`. The comparison
is constant-time, the token is redacted from request logs, and responses
carry `Referrer-Policy: no-referrer` so a token-bearing URL is not leaked
to transcoded origins. Refused requests are `401 E_EDGE_UNAUTHORIZED`.
Binding a non-loopback `HOST` without `EDGE_TOKEN` prints a warning at
startup.

For named identities (who did what in the logs) use per-identity tokens:
`EDGE_TOKENS="bot=tok-1\nhuman=tok-2"` (inline) or a file with one
`name=token` pair per line via `EDGE_TOKENS_FILE`. Any valid token
authenticates as its identity, `EDGE_TOKEN` still works as the shared
"default", and the file is re-read per request, so rotation is: add the
new token, let clients switch, then remove the old one with no restart.
Behind a TLS-terminating proxy, set `EDGE_TRUST_PROXY=1` so the rate limit
keys on the forwarded client instead of the proxy's socket address; only
do this when the proxy is trusted (a client can forge the header).
`EDGE_TLS_CERT` + `EDGE_TLS_KEY` turn on native HTTPS termination for
small deployments; for real deployments put a dedicated TLS proxy in
front (client certificates, HSTS, ACME).

The SSRF guard refuses literal private, loopback, link-local, and mapped
IPv6 targets, and additionally refuses hostnames that RESOLVE to such
addresses (checked before the initial request and before every redirect
hop). `EDGE_ALLOW_PRIVATE=1` disables that guard and should only be
used for controlled local fixtures, never for an exposed gateway.

## Playground

A hosted build is live at **https://omodaka9375.github.io/actdown/** (GitHub
Pages, rebuilt whenever the engine changes). To run it locally, open
`actdown-rs/playground.html`, a single self-contained file: a live editor
next to the rendered document, with the whole Rust engine compiled to WASM
base64-embedded inside it. No server, no bundler, no network. Tabs switch between the rendered document,
static HTML, canonical text, and the JSON AST.

Build it with:

```sh
cd actdown-rs
cargo build --target wasm32-unknown-unknown --release
node ../scripts/build-playground.mjs
```

The exports live in `actdown-rs/src/wasm.rs` (`ad_parse`, `ad_render`,
`ad_render_reactive`, `ad_format`, `ad_ast`) and are a flat C ABI, so any
host that speaks `WebAssembly.instantiate` can embed the engine without
bindgen glue.

## MCP server

`src/mcp.ts` is a zero-dependency Model Context Protocol server (JSON-RPC
2.0 over stdio) that gives any MCP client the actdown engine as tools:

| Tool | Purpose |
|---|---|
| `actdown_render` | reactive HTML with bindings filled |
| `actdown_html` | static level-1 HTML |
| `actdown_canonical` | canonical text (review-diffable) |
| `actdown_ast` | the JSON AST (`ad: "0.1"` contract) |
| `actdown_check` | diagnostics and review lints (empty array when valid) |
| `actdown_html2ad` | HTML page to canonical ad (lossy, SPEC 12) |

Two resources ship embedded so an agent can learn the format in-session:
`actdown://guide/authoring` (how to write documents) and
`actdown://guide/grammar` (block grammar reference), exposed via
`resources/list` and `resources/read`.

Build and register it with the same stdio command an MCP client expects:

```sh
pnpm build
node dist/mcp.js        # speaks initialize / tools/list / tools/call
```

A scriptable smoke test covering the initialize handshake, tool listing,
and one call per tool lives in `scripts/mcp-smoke.mjs`.

## Conformance

The `vectors/` directory is the cross-implementation suite (SPEC 13): each
vector is an input document plus exact `ast.json`, `canonical.ad`,
`html.html` and (level 2+) `reactive.html` goldens, indexed by
`manifest.json`. Both implementations read the same goldens, so spec
conformance is proven twice, not asserted. See `vectors/README.md` for
the report format (`pass | fail(<vector>:<golden>) | skip(<level>)`).

## Rust / WASM port

`actdown-rs` mirrors the reference implementation byte for byte on the
spec surfaces (all 10 vectors pass all 4 goldens) and builds for
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
Rust suites currently cover the same ten conformance vectors, but that is
not enough to certify arbitrary web content or adversarial network
deployments.

Before exposing the gateway beyond a trusted environment, add:

- A last-mile DNS-rebinding defense: every hostname (the initial request and
  each redirect hop) is resolved and checked before it is fetched, but the
  fetch itself re-resolves at connect time, so a full defense still needs
  restricted network egress or a connection pinned to the checked address.
- Authentication for untrusted networks: covered by a shared token
  (`EDGE_TOKEN`) or per-identity tokens (`EDGE_TOKENS` / `EDGE_TOKENS_FILE`,
  each token mapped to a named identity; the file is re-read per request, so
  rotation is add-new-token, clients switch, remove-old-token without a
  restart). All compares are constant-time and tokens are redacted from
  logs; the gateway binds to loopback by default (`HOST` widens it
  deliberately) and also enforces a per-client request rate (keyed on the
  socket address, or the X-Forwarded-For first hop behind a trusted proxy
  with `EDGE_TRUST_PROXY=1`), an in-flight transcode cap, and an inbound
  body cap. Native TLS termination ships via `EDGE_TLS_CERT` + `EDGE_TLS_KEY`
  for small deployments; for real deployments a dedicated TLS-terminating
  proxy in front remains the recommended shape (client certificates,
  HSTS, ACME).
- Fuzzing and property-based parser tests, adversarial redirect tests, and
  real-browser tests for the DOM adapter are in place (`test/property.test.ts`,
  `test/edge.test.ts`, `test/browser-dom.test.ts`; the browser suite skips
  when no Chrome/Edge binary is available).
- Broader CI and operations: the test matrix now covers Node 20/22/24 with
  a dependency-audit job, weekly Dependabot updates, and per-request
  gateway logging plus `/healthz`; a browser-matrix job and a release
  workflow are still open.

Composition is an explicit pass, not an implicit one: `ad-include` blocks
store their `src` reference in the AST (SPEC 4.5), and `--inline` on
`ast` / `fmt` / `render` splices the referenced documents at that position.
Cycle protection is `E_INCLUDE_CYCLE`; a src that cannot be loaded is
`E_INCLUDE_UNRESOLVED`; `cap:` sources stay verbatim for the host to
resolve. Include paths resolve against the entry document's directory.

Review lints (`lint(doc)` in TypeScript, `actdown::lint(&Doc)` in Rust)
flag reviewer-relevant drift in both implementations: `W_REGION_FOR`,
`W_EXPR_SYNTAX`, and `W_CAP_UNDECLARED`. Rust capabilities are
synchronous while TypeScript capabilities may be asynchronous, so async
phase behavior is not identical. Do not treat capability names as a
security sandbox for host functions: capability implementations
themselves remain trusted host code and must validate their arguments.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
