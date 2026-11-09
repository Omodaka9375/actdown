# htmldown specification, draft 0.1

Status: DRAFT. This document is normative. The keywords MUST, MUST NOT,
SHOULD, and MAY are to be read as in RFC 2119.

## 1. Overview

htmldown (short form: hdm) is a markup language for documents that are
read and written by both humans and autonomous agents. It is a strict
superset of Markdown (CommonMark 0.31.2) with a block-extension mechanism
called **hdm blocks**, a flat state model, a typed expression language,
and a capability-based action system.

Design invariants:

- INV-1: Every valid hdm document is a valid Markdown document. Renderers
  that do not know htmldown MUST still render its prose content.
- INV-2: The abstract syntax tree (AST) is the contract. All semantics are
  defined on the AST; the text form is one of several serializations.
- INV-3: Canonicalization is total and idempotent. For any input, the
  function `canonical(print(parse(input)))` MUST equal
  `canonical(parse(input))`, and `format(input)` MUST equal
  `format(format(input))`.
- INV-4: No arbitrary code. There is no `<script>` equivalent. All
  behavior is expressed as named capabilities with typed arguments.
- INV-5: Agents are first-class. Every interactive node carries a stable
  identifier and a semantic role, and the AST must be expressible losslessly
  as JSON.

## 2. Document model

A document is a UTF-8 string, no BOM, LF or CRLF line endings (CRLF is
normalized to LF before parsing and never re-emitted in canonical form).

A document is a sequence of **nodes**:

```
Document := Prose* Block* interleaved, in source order
Prose    := any CommonMark content
Block    := fenced code block with info string matching HDM_INFO
```

### 2.1 HDM_INFO

```
HDM_INFO := "hdm-" TYPE [ "?" ATTR { "&" ATTR } ]
ATTR     := NAME [ "=" VALUE ] | "on:" EVENT  ; VALUE percent-decoded
EVENT    := "click" | "submit" | "change" | "load"
TYPE     := [a-z][a-z0-9-]*
NAME     := [a-z][a-z0-9-]*
```

Example info strings:

```text
hdm-price
hdm-state
hdm-action?name=add-to-cart&role=primary
hdm-form?id=contact
```

A fenced block whose info string starts with `hdm-` but whose TYPE is not
known to the parser is a **foreign block**: it MUST be preserved verbatim
in the AST (`type`, raw body, attributes) and rendered as a plain code
fence. This is the forward-compatibility rule; INV-1 depends on it.

### 2.2 Block body

The block body is a sequence of `KEY: VALUE` lines (the **field set**),
optionally followed by a `---` separator and free text (the **body
text**). Field parsing rules:

- `KEY` is `[a-z][a-z0-9-]*`, followed by `:` and one space.
- VALUE runs to end of line; surrounding whitespace is trimmed.
- A line with deeper indentation than its KEY line continues that VALUE
  (folded with a single space). This allows long values.
- Duplicate KEYs: the parser MUST reject the block with error
  `E_DUPLICATE_KEY`. Rejected blocks are foreign blocks (see 2.1).
- Escaping a literal newline inside a value uses `\n`. A literal `\` is
  `\\`. No other backslash escapes exist.

The field set is the machine surface; the body text is the human surface.
Renderers MUST render the body text; agents SHOULD read the field set.

### 2.3 Identifiers

- `id`: MUST match `[a-z][a-z0-9-]*` and be unique within the document.
  Duplicates are error `E_DUP_ID`. If absent, the parser generates
  `h<sha1(canonical-block-bytes)[0:10]>`, stable under canonicalization.
- `role`: one of the roles in section 8, or a `x-` prefixed private role.
  Unknown unprefixed roles are error `E_BAD_ROLE`.

## 3. Levels

An implementation declares the levels it supports. A parser MUST parse all
lower levels when it claims a level.

- **Level 0**: Markdown only. No hdm blocks.
- **Level 1**: Structural blocks: `state`, `text`, `data`, `action`,
  `form`, `field`, `list`, `region`, `table`, `image`, `link`, `chart`,
  `include`, `manifest`.
- **Level 2**: State and bindings: bindable props, reactive labels
  (`{expr}` in body text), conditional blocks (`when=`), list repetition
  (`each=`).
- **Level 3**: The expression language (section 6), computed state
  (`hdm-state` entries with `=`), async capabilities with pending/success/
  failure regions.

A Level 2 construct in a Level 1 document MUST degrade to its static
projection (level-1 rendering), never to an error.

## 4. Core block types (Level 1)

Common attributes on all blocks: `id`, `role`, `when` (L2), `each` (L2).

### 4.1 hdm-state

A flat, ordered map of typed values. Keys match `NAME`. Values are typed
literals or (Level 3) expressions.

````md
```hdm-state
count: 0
title: "Weekly report"
tags: ["a", "b"]
```
````

Literal grammar: JSON literals plus unquoted bare words (`bare word`).
An unquoted value is parsed as number if numeric, `true`/`false`/`null`
if keyword, else string. Strings with punctuation or leading/trailing
spaces MUST be quoted.

### 4.2 hdm-action

A capability invocation rendered as an interactive element. The block body
text is the label.

````md
```hdm-action?name=cart.add&role=primary&on:click
args: { "sku": "oven-12l" }
---
Add to cart
```
````

- `name`: the capability, `domain.verb` or `cap:<id>@<version>`.
- `on:<event>`: presence declares the trigger. Events: `click`, `submit`,
  `change`, `load`. Exactly one per block (error `E_MULTI_EVENT`).
- `args`: JSON object of literal arguments, or (L2+) `{ "key": "expr" }`
  expressions.
- A renderer MUST NOT fire an action whose capability is not registered
  with the runtime; it renders the block disabled with `data-cap-missing`.

### 4.3 hdm-form

````md
```hdm-form?id=contact&action=cap:contact-form@v1
email:   input(email, required)
message: textarea(maxlength=500)
send:    submit(label="Send")
on:submit="cap.send(action, $fields)"
```
````

Body fields define named controls: `NAME: CONTROL(opts)`. Controls:
`input(TYPE, ...)`, `textarea(...)`, `select(..., options=[...])`,
`checkbox`, `submit`. Types follow the HTML input type vocabulary.
Validation opts: `required`, `min=`, `max=`, `pattern=`, `maxlength=`.
The AST stores controls as structured data; the option string grammar is
shorthand for it.

**Submit semantics (Level 3).** Submitting a form fires its `on:submit`
expression with `$fields` bound to the submitted field values: every named
descendant control contributes `name -> value`; checkboxes contribute a
boolean; unnamed controls are skipped. The form's own attributes are
visible as names in the expression (so `cap.send(action, $fields)` sends
to the form's `action` capability); state shadows attributes. A form
without an `on:` expression fires its `action` capability directly with
the fields as arguments. Async phases (section 7) are keyed by the
form's block id, so `hdm-region` blocks with `for: <form-id>` show
pending/success/failure around a submit.

### 4.4 hdm-data / hdm-table / hdm-image / hdm-link / hdm-chart

- `hdm-data`: a field set published as data; consumers bind to `id.key`.
- `hdm-table`: body text is GitHub-flavored markdown table; the AST stores
  parsed rows (arrays of cells), not the raw markdown.
- `hdm-image`: `src`, `alt` (required), optional `width`, `height`.
- `hdm-link`: `href` (required, absolute or relative URL), body text is
  the label.
- `hdm-chart`: `src` or inline `data`, plus `type` (`line|bar|pie|spark`),
  axis hints. Rendering is renderer-defined; the AST is the contract.

### 4.5 hdm-include

`src` names another hdm document (relative path or `cap:` resource). The
AST stores the reference; inlining is a separate, explicit pass
(`--inline`) so that a document's meaning is always locally readable.
Include cycles are error `E_INCLUDE_CYCLE`.

## 5. State and bindings (Level 2)

- State is a single flat map per document unless `scope="name"` is given;
  nested scopes are addressed `parent.child`.
- Any block attribute or body-text segment of the form `{expr}` is a
  **binding**: it is evaluated against state and re-rendered on change.
  Literal braces are `\{` and `\}`.
- `when="expr"` hides a node when the expression is falsy.
- `each="item in expr"` repeats the node, binding `item` (and `index`)
  inside. Repetition is keyed by the node's `id`.
- Change propagation: renderers MUST update all bindings in one pass;
  there is no observable intermediate state (no torn reads).
- State-block literals seed the runtime state once, at hydration. A
  runtime MUST NOT re-apply them over live state on later renders; the
  runtime's state map is authoritative after hydration.

## 6. Expression language (Level 3)

A small, total, typed expression language. Grammar (EBNF):

```
expr    := or
or      := and { "||" and }
and     := cmp { "&&" cmp }
cmp     := sum [ ("=="|"!="|"<"|"<="|">"|">=") sum ]
sum     := unary { ("+"|"-") unary }
unary   := ["!"|"-"] postfix
postfix := primary { "." NAME | "[" expr "]" | "(" args ")" }
primary := NAME | NUMBER | STRING | "true" | "false" | "null"
         | "(" expr ")" | "{" object "}" | "[" array "]" | "$" NAME
```

- Types: `number, string, boolean, null, array, object`. No functions,
  no loops, no member assignment. Evaluation is side-effect free.
- `$name` refers to event payload (e.g. `$fields` on form submit).
- The only side-effecting form is the `cap.send(name, args)` call, valid
  only inside `on:` attributes.
- Implementations MUST evaluate expressions in a fixed-point integer +
  IEEE 754 double model, reject NaN and Infinity in canonical output.

## 7. Capabilities and the security model

- A **capability** is a named, versioned function registered with the
  runtime: `cap:<id>@<semver>` or a built-in `domain.verb`.
- The document can name a capability; it cannot define one. Defining
  behavior is out of band (runtime registry), which is what makes the
  language auditable: the set of side effects of a document is exactly its
  `hdm-action`/`on:` references.
- Runtimes MUST enforce:
  - SEC-1: capabilities are opt-in per document origin (granted list).
  - SEC-2: argument values are data, never evaluated as code.
  - SEC-3: no network, storage, or DOM access except through capabilities.
  - SEC-4: expressions have a step budget (default 1000) and depth cap
    (default 64); exceeding is a render error, not a hang.
- Event handlers: an `on:<event>` attribute holds an expression. Inside
  it, the block's own string attributes are visible as names (e.g.
  `action` on a form) and `$name` carries the event payload (`$fields`
  on form submit); state names shadow attribute names. `cap.send` is
  the only side effect and routes to the granted registry; firing a
  capability that is not granted is error `E_CAP_MISSING`.
- Async phases: a capability that returns a promise marks the firing
  block's id `pending`, then `success` or `failure` when it settles.
  Renderers consult the phase map to show/hide `hdm-region` blocks whose
  `for` names the firing block (section 4). A failure is visible state,
  not a crash: the document MUST still render.
- A document MAY declare its capabilities in an `hdm-manifest` block
  (`name`, `min-version`, `scopes`); agents SHOULD use the manifest to
  decide trust before rendering interactively.

## 8. Semantic roles

`button, link, input, label, heading, chart, table, image, form, region,
status, nav, danger, primary, secondary`. Renderers map roles to ARIA;
agents map roles to intent. Private extensions MUST use `x-` prefix and
MUST be ignored by conforming renderers that do not know them.

## 9. AST

The canonical serialization is JSON. Shape (TypeScript-style):

```ts
type Doc    = { hdm: "0.1"; nodes: Node[] }
type Node   = Prose | Block
type Prose  = { kind: "prose"; md: string }        // raw markdown, preserved
type Block  = {
  kind: "block"; type: string;                     // "state" | "action" | ...
  id: string; role?: string;
  attrs: Record<string, string | Expr>;            // resolved attributes
  fields: Record<string, Literal | Expr>;
  body: string | Node[];                           // body text or parsed children
  src?: { line: number };                          // source position, optional
}
type Literal = number | string | boolean | null | Literal[] | { [k: string]: Literal }
```

Rules:

- Prose nodes keep raw markdown. The spec does NOT define parsing inside
  prose; renderers do. This keeps the spec small and CommonMark-aligned.
- Field values are typed at parse time (section 4.1); `attrs` values
  containing `{...}` are stored as `Expr` with `raw` and parsed AST.
- JSON output MUST be UTF-8, LF, two-space indent, keys in the order
  given above (fixed key order, not alphabetical) so diffs are stable.

## 10. Canonical text form

The printer emits:

1. Prose verbatim (normalized to LF, trailing spaces stripped except
   hard-break double-space).
2. Blocks in canonical layout:

```text
```hdm-TYPE?attr=value&attr2=value2
key: value
role: primary
---
body text
```
```

- Info-string attributes sorted by name, with `on:<event>` attributes
  last. Body fields emit in the fixed reserved order (`id`, `role`,
  `when`, `each`), then alphabetical. `id` and `role` are always emitted
  as body fields in canonical form, even if they arrived as info-string
  attributes. Body text after `---`. Blank line before the closing fence.
- `format(doc)` = `print(canonicalize(parse(doc)))` and MUST be
  idempotent (INV-3). Canonical bytes hash to the document's content id:
  `sha256(canonical)[0:16]` hex.

## 11. HTML mapping (non-normative summary, normative in appendix A)

- Prose: pass through to the markdown renderer.
- `hdm-action` role=button -> `<button data-hdm-id role aria-label>`;
  the label is text content; no inline handlers; the runtime attaches
  listeners by `data-hdm-id`.
- `hdm-form` -> `<form>` with typed inputs; control ids are
  `<form-id>.<field-name>`.
- Bindings render once server-side with current state and are hydrated by
  the runtime; the static HTML MUST be complete and valid without JS
  (progressive enhancement is a MUST for level 0-2 documents).
- Hydration contract (the DOM adapter): the runtime attaches listeners to
  elements by `data-hdm-id` (from the block's `on:` attributes, else the
  type default: action -> `click`, form -> `submit`), updates
  `data-hdm-bind` spans in place from the state map, and toggles the
  `hidden` attribute of `[data-hdm-phase]` regions from the phase map.
  Each state change is applied as ONE pass over the tree; conforming
  adapters MUST NOT replace DOM fragments wholesale on every change.

## 12. HTML to hdm downconverter

`html2hdm` converts legacy HTML into canonical hdm. Contract:

- DOW-1: Lossy in presentation, lossless in meaning. Presentational-only
  nodes (span wrappers, inline style) collapse into prose; every semantic
  element (headings, lists, tables, forms, buttons, links, images) maps to
  a node or block with `role`.
- DOW-2: `<script>` is dropped; `<style>` is dropped; event attributes
  (`onclick=` etc.) are dropped and, if non-trivial, recorded as
  `x-legacy-handler` on the node for audit.
- DOW-3: Output is canonical form, so the converter is testable by
  snapshot vectors.
- DOW-4: Forms convert controls to `hdm-form` fields; action names become
  `x-legacy:<original-path>#<form-id>` capabilities that the proxy runtime
  implements by replaying the original request.

## 13. Conformance

A conforming implementation passes the vector suite. Vectors are files:

```text
vectors/
  manifest.json      # level, description and required goldens per vector
  0001-basic-prose/
    input.hdm
    ast.json          # exact expected canonical AST
    canonical.hdm     # exact expected canonical form
    html.html         # expected level-1 HTML render
    reactive.html     # expected state-applied render (level 2+)
```

`manifest.json` is the machine-readable suite index:

```json
{
  "version": "0.1",
  "vectors": {
    "0001-basic-prose": {
      "level": 0,
      "description": "one line: what the vector pins",
      "goldens": ["ast.json", "canonical.hdm", "html.html"]
    }
  }
}
```

Rules: vector names are `NNNN-kebab-case` and stable, never reused; a
vector is added, never edited, after release; the manifest MUST cover
every vector directory (and vice versa). Implementations declare their
highest supported level (section 3) and report `pass | fail(<vector>:<golden>) |
skip(<level>)` per vector; a run is conforming when nothing reports `fail`.
`ast.json` and `canonical.hdm` are UTF-8, LF, exact byte comparisons;
`canonical.hdm` MUST also satisfy INV-3 (idempotence).

## 14. Versioning and evolution

- Spec version `MAJOR.MINOR`; the document declares `hdm: "0.1"` in its
  AST header and MAY carry a first-line comment `<!-- hdm 0.1 -->`.
- New block types and roles are MINOR bumps (forward-compatible via
  foreign blocks). Grammar breaks are MAJOR.
- The AST JSON header carries the spec version; the text form does not
  need one (a parser is level-aware, not version-aware).

## 15. Error catalogue

Parse errors: `E_DUPLICATE_KEY, E_DUP_ID, E_BAD_ROLE, E_BAD_ID, E_BAD_INFO,
E_UNTERMINATED_STRING, E_BAD_LITERAL, E_BAD_FIELD, E_MULTI_EVENT,
E_INCLUDE_CYCLE`.
Render errors: `E_CAP_MISSING, E_EXPR_STEP, E_EXPR_DEPTH, E_BIND_UNKNOWN`.
Parse errors demote the offending block to a foreign block; the document
MUST still render. Render errors affect one node, never the document.

## Appendix A: normative HTML mapping table

| hdm node | HTML |
|---|---|
| `hdm-action` | `<button>` or `<a>` (if `href` also set) with `data-hdm-id`, `data-hdm-cap` |
| `hdm-form` | `<form data-hdm-id>`; submit via runtime |
| control | `<input>/<textarea>/<select>` with `name=<field>`, `id=<form>.<field>` |
| `hdm-data` | `<script type="application/x-hdm-data">` (JSON) |
| `hdm-image` | `<img src alt width height>` |
| `hdm-link` | `<a href>` |
| `hdm-table` | `<table>` from parsed rows |
| `hdm-chart` | `<figure data-hdm-chart="type">` with `<table>` fallback of the data |
| binding `{expr}` | `<span data-hdm-bind="expr">initial</span>` |
