# htmldown

**Interactive markup for agents and humans.**

htmldown (short form: hdm) is a strict superset of Markdown with a block
extension for building documents that are read and written by both people
and autonomous agents: a flat state model, a typed expression language,
and a capability-based action system. No scripts, no inline handlers, no
arbitrary code. Every interactive element names a registered capability,
which is what makes the language auditable: the set of side effects of a
document is exactly the capabilities it references.

This repository is the reference implementation (TypeScript) plus a Rust
port that compiles to WASM, both tested against the same conformance
vectors.

## A taste

````markdown
# Cart

```hdm-state
count: 2
total: {count + price}
```

```hdm-action?name=cart.add&role=primary&on:click
id: add
---
Add to cart ({count})
```

You owe {total} dollars.
````

Rendered, the action becomes a `<button data-hdm-id>` bound to the
`cart.add` capability, the bindings become `data-hdm-bind` spans hydrated
by the runtime, and unknown block types degrade to plain code fences
(INV-1: every valid hdm document is a valid Markdown document).

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
  html2hdm.ts    legacy HTML to canonical hdm (SPEC 12)
  edge.ts/serve.ts  the edge transcoder service
test/          vitest suite (88 tests)
vectors/       cross-implementation conformance suite (SPEC 13)
htmldown-rs/   Rust port (parser, canonical, render, expr, react, runtime)
scripts/       verify.mjs: tsc + vitest, shell-agnostic
SPEC.md        the specification (draft 0.1, normative)
DESIGN.md      architecture and solution-path rationale
```

## Getting started

Requires Node 20+ and pnpm; the Rust tests additionally need cargo.

```sh
pnpm install
pnpm verify        # tsc, then the full vitest suite
pnpm verify:rs     # cargo test for htmldown-rs
```

## Usage (TypeScript)

```ts
import { parse, canonicalize, format, render, toJSON } from "htmldown";
import { renderReactive } from "htmldown";
import { hydrate, CapabilityRegistry } from "htmldown/runtime.js";

const input = `...hdm source...`;

// Machine surfaces
const doc = canonicalize(parse(input).doc); // the AST is the contract
const text = format(input);                 // canonical hdm, idempotent
const json = toJSON(doc);                   // stable two-space JSON

// Human surface
const html = render(doc);                   // level-1, complete without JS
const live = renderReactive(doc);           // state applied, ready to hydrate
```

Interactivity is opt-in per capability (SEC-1): a document can name a
capability, never define one. Ungranted capabilities render disabled with
`data-cap-missing`.

```ts
import { hydrate } from "htmldown";

const rt = hydrate(doc, {
  capabilities: {
    "counter.inc": (_args, ctx) => {
      ctx.set({ count: (ctx.state.count as number) + 1 });
    },
  },
});

await rt.fire("add", "click");   // state updates, bindings re-render in one pass
rt.html();                       // current HTML with phase regions applied
```

## Edge transcoder

The deployment wedge: a gateway that fetches any URL, downconverts the
HTML to canonical hdm for agents, and keeps the original for humans.

```sh
pnpm build && pnpm edge          # serves on :8787 (PORT to override)
```

```text
GET /transcode?url=...&format=canonical   text/x-hdm (default)
GET /transcode?url=...&format=ast         application/json
GET /transcode?url=...&format=html        rendered from the converted doc
GET /transcode?url=...&format=raw         the original, for humans
GET /view?url=...                          dual-pane transcoder view
```

Errors are JSON `{ code, message }` (`E_EDGE_FETCH`, `E_EDGE_TIMEOUT`,
`E_EDGE_SIZE`, ...). Literal private/loopback hosts are refused by an SSRF
guard; set `EDGE_ALLOW_PRIVATE=1` for loopback deployments and tests.

## Conformance

The `vectors/` directory is the cross-implementation suite (SPEC 13): each
vector is an input document plus exact `ast.json`, `canonical.hdm`,
`html.html` and (level 2+) `reactive.html` goldens, indexed by
`manifest.json`. Both implementations read the same goldens, so spec
conformance is proven twice, not asserted. See `vectors/README.md` for
the report format (`pass | fail(<vector>:<golden>) | skip(<level>)`).

## Rust / WASM port

`htmldown-rs` mirrors the reference implementation byte for byte on the
spec surfaces (all 7 vectors pass all 4 goldens) and builds for
`wasm32-unknown-unknown`:

```sh
cd htmldown-rs
cargo build --target wasm32-unknown-unknown
```

One documented divergence: Rust capabilities are synchronous, so the
phase map records success/failure per call instead of a pending window.

## Specification

`SPEC.md` is the normative document (draft 0.1, RFC 2119 keywords).
Highlights: the AST is the contract (INV-2); canonicalization is total
and idempotent (INV-3); there is no script equivalent (INV-4); every
interactive node carries a stable id and semantic role (INV-5).

## Status

Draft 0.1. The grammar and canonical form are stable in practice; new
block types and roles are minor bumps, grammar breaks are major (SPEC 14).
No license file yet; add one before redistribution.
