# actdown (HyperText Markdown): an interactive markup language for agents and humans

The project is named actdown. Its compatible wire format retains the `ad`
short form, block prefix, AST header, and HTML data attributes.

## The problem

HTML was built for browsers and humans. Agents pay three taxes for it:

1. **Token tax**: a page's markup is 5-20x larger than its meaning.
2. **Ambiguity tax**: `<div class="btn-primary">` says nothing about intent.
3. **Interactivity tax**: real behavior needs JS, which agents cannot safely write, read, or run.

actdown should be a language that is cheap to read, cheap to write,
unambiguous in meaning, and interactive without arbitrary code. One
document serves both a human renderer and an agent reader.

Design goals, in priority order:

- G1: Markdown-native. A plain markdown file must be valid actdown.
- G2: Deterministic. Same document, same canonical bytes. Diffable, cacheable.
- G3: Declarative interactivity. State, events, and actions, but no JS.
- G4: Agent-first ergonomics: stable ids, semantic roles, schema validation,
  and a lossless downconverter from existing HTML.
- G5: Progressive power. Level 0 is markdown. Level 3 is a full reactive app.

## Core syntax sketch

Level 0: plain markdown, unchanged.

Level 1: semantic blocks in fenced code with the `ad` info string.

````md
# Product page

A durable **12L oven** with steam injection.

```ad-price
sku: oven-12l
value: 129.00
currency: EUR
```

```ad-action name="add-to-cart" role="button" on:click="cart.add(sku)"
Add to cart
```
````

Level 2: shared state and bindings.

````md
```ad-state
count: 0
step: 1
```

```ad-counter bind="count"
- on:click="count = count + step"
- label: "Clicked {count} times"
```
````

Level 3: forms, views, and remote capabilities.

````md
```ad-form id="contact" action="cap:contact-form@v1"
email:   input(email, required)
message: textarea(maxlength=500)
send:    submit(label="Send")
on:submit="cap.send(action, $fields)"
```
````

Rules that make it agent-safe:

- Actions are **capabilities**, not scripts. An action names a registered
  function (`cart.add`, `cap.send`) with typed args. No eval, no URLs as
  code, no inline JS anywhere in the language.
- Every interactive block carries a stable `id` and a `role`. Renderers map
  roles to ARIA; agents map roles to intent.
- State is a flat typed map per document. Two blocks share state by binding
  to the same key. Scoping comes from nesting or explicit `scope=`.
- Canonical form: the parser emits a sorted, normalized AST; the printer
  re-emits canonical actdown. `format()` is idempotent.

## Three solution paths

### Path A: "Markdown plus blocks" (conventional, adoption-first)

A strict markdown superset. actdown blocks are fenced code blocks with an
`ad-<type>` info string. Unknown blocks render as plain code fences, so
actdown degrades gracefully in every existing markdown renderer.

- Parser: line-based, streaming, ~1-2k LOC.
- Renderer: walks blocks, emits HTML or a native UI.
- Strengths: instant authorship, GitHub/any-md renders it read-only today,
  trivial to teach an LLM in one prompt.
- Weaknesses: block grammar is stringly typed inside fences; complex
  nesting gets awkward; interactivity is islands, not layout.

### Path B: "Semantic tree" (unconventional, structure-first)

No markdown at all. Indentation-based UI tree, YAML-flavored, where every
node is `role: props` and text is a leaf. Maps 1:1 onto a DOM.

```text
page "Pricing"
  section id="plans"
    card sku="oven-12l"
      heading "12L Oven"
      price currency=EUR 129.00
      button on:click="cart.add(sku)" "Add to cart"
```

- Strengths: zero parse ambiguity, perfect for machine generation and
  round-tripping, trivially serializable to JSON.
- Weaknesses: hostile to humans writing prose; whitespace semantics; worse
  paste-in story for existing content.

### Path C: "Reactive flow" (hybrid, power-first)

Path A as the substrate, plus a tiny typed expression language and
document-level reactivity. Compiles to web components; the runtime is
~5-10kb, no framework. Cross-block bindings, computed values, conditional
regions, and capability-scoped async actions.

- Strengths: can express real apps (dashboards, wizards, live docs) while
  staying markdown-readable.
- Weaknesses: biggest spec and test surface; expression language needs a
  formal grammar and an interpreter audit; harder to keep canonical.

## Tech stack comparison

| Stack | Fit | Strengths | Weaknesses | Ideal use |
|---|---|---|---|---|
| TypeScript + unified/remark | Path A, C | md ecosystem free, AST tooling, quick iteration, ships everywhere | JS perf ceiling, GC pauses | The reference implementation and VS Code / web tooling |
| Rust + WASM (tree-sitter grammar) | Path B, C | tiny fast parser, embeds in any agent runtime, edge-safe | slower iteration, grammar authoring cost | Agent SDKs, CLI, embedding in host apps |
| Go single binary | proxy renderer | one-file deploy, great HTTP story, HTML-to-ad proxy service | weaker md AST ecosystem | A gateway that serves ad and downconverts legacy HTML |
| Python reference | agent tooling | fastest to spec against LLM toolchains | not a shipping renderer | spec conformance tests, notebooks |

Recommendation: TypeScript + unified/remark for the reference implementation
(Path A grammar, Path C runtime later), with a Rust/WASM port as the
milestone-two deliverable once the spec freezes.

## Architecture comparison

1. **Compiler** (build time): ad -> HTML/React/native. No runtime cost,
   static hosting, but no live bindings without hydration. Best for docs.
2. **Runtime interpreter**: ship the 10kb interpreter, parse on device.
   Live state, offline docs, agent sandboxes. Best for interactive pages.
3. **Edge proxy / transcoder**: a gateway that fetches any URL, converts
   HTML to canonical ad, and serves it to agents; humans get the original.
   This is the killer deployment: it gives agents a uniform view of the web
   today without waiting for adoption.

These compose: compile for sites, interpret for apps, proxy for the legacy
web. The spec should define the AST and canonical form first; targets are
pluggable.

## UX pattern sketches

1. **Progressive disclosure doc**: headings and paragraphs render as
   markdown; each `ad-*` block renders as a collapsed island the reader
   expands; agents see the expanded form in the AST. Same artifact, two
   experiences.
2. **Agent-authored page**: an agent writes an ad "worksheet" with state
   and capability buttons; the user clicks instead of reading JSON dumps.
   The page is the agent's UI toolkit.
3. **Dual-pane transcoder view**: legacy page on the left, canonical ad on
   the right, click a rendered element to highlight its ad node. Teaches
   authoring and debugs the downconverter.
4. **Wireframe: canonical ad card**

```text
+--------------------------------------+
| # Weekly report                       |
|                                       |
| Revenue is up 12% month over month.   |
|                                       |
| [ chart src="rev.csv" type=line ]     |  <- collapsed island
| ( button "Approve"  role=primary )    |  <- cap:approve@v1
| ( button "Reject"   role=danger  )    |  <- cap:reject@v1
+--------------------------------------+
```

## Recommendation

Build Path A now, Path C by design:

1. Week 1-2: spec the AST and canonical printer (the contract everything
   depends on), plus Level 0/1 grammar and an HTML downconverter, because
   agents need to read the existing web before they write the new one.
2. Week 3-4: TypeScript renderer to HTML + capability registry; publish the
   conformance test vectors.
3. Later: Level 2/3 reactivity, Rust/WASM port, and the edge transcoder as
   the deployment wedge.

Rationale: Path A is the only path where actdown is useful on day one in
every existing surface (GitHub, chat clients, static hosts), and the block
grammar can be extended toward Path C without breaking it. Path B's tree
form can return later as the machine serialization of the same AST, which
costs nothing if the AST is the contract.
