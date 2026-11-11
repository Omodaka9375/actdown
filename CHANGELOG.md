# Changelog

All notable changes to actdown are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-10

First development preview. Spec draft 0.1 (see `SPEC.md`, normative).

### Added

- **MCP reader mode (primary product surface):** `actdown_transcode` fetches
  a URL and returns canonical actdown, JSON AST, or rendered HTML. The stdio
  server exposes seven tools and two in-session authoring guides. It uses the
  same guard stack as the gateway and returns MCP error results with
  `{ error: { code, message } }`. See the README quickstart.
- Package and gateway surfaces: `actdown-mcp` and `actdown-edge` binaries,
  `actdown/mcp` and `actdown/serve` exports, `createEdgeServer` in the root
  API, and a `prepack` build. MCP smoke and entry-point checks cover npm-link
  invocation and the token-free loopback gateway.
- Anti-cloaking in html2ad: author-hidden markup is dropped and reported as
  one aggregate audit note with no content preview. Recognized cases include
  the `hidden` attribute, `aria-hidden="true"`, `template`, and several inline
  hiding styles, including encoded attributes and CSS comments. Detection is
  markup-based and best-effort, not prompt-injection prevention: external CSS,
  matching colors, off-screen positioning, and all converted visible text
  remain untrusted.
- Gateway auth hardening: per-identity tokens (`EDGE_TOKENS` inline text or
  `EDGE_TOKENS_FILE`, `name=token` per line; the file is re-read per request
  so rotation needs no restart, and overlap during rotation works), native
  TLS termination (`EDGE_TLS_CERT` + `EDGE_TLS_KEY`), and an opt-in
  `EDGE_TRUST_PROXY=1` mode that keys the per-client rate limit on the
  X-Forwarded-For first hop for deployments behind a TLS-terminating proxy
  (the default remains the socket address, which a client cannot spoof).
- Test hardening: a deterministic property/fuzz suite
  (`test/property.test.ts`) for the document parser, the expression
  parser, html2ad, and the reactive render (parse/expr throw only typed
  diagnostics; `format` is total and idempotent; html2ad output always
  reparses), adversarial redirect tests (loop bounded by the hop cap,
  malformed or missing Location, scheme downgrade, over-cap chains,
  per-hop SSRF re-checks), and real-browser DOM-adapter tests
  (`test/browser-dom.test.ts`, headless Chrome/Edge over the DevTools
  protocol; skipped when no browser is available). The fuzzer found and
  the fix landed: an unclosed fence's verbatim raw absorbed the
  document-terminating newline on re-parse, so every `format` pass grew a
  foreign block by one blank line (INV-3); fixed in both implementations.
- Edge gateway hardening: every hostname (initial request and each redirect
  hop) is resolved via DNS and refused when any resolved address is private,
  loopback, or special-use (`E_EDGE_PRIVATE`). The default fetcher pins the
  socket to the validated address while preserving HTTP Host, TLS SNI, and
  the URL port. An injected custom fetcher owns its own connection policy.
- Gateway limits and operations: explicit listen address (`HOST`, loopback
  by default), per-IP request rate (`EDGE_RATE_LIMIT`, `429 E_EDGE_RATE`),
  in-flight transcode cap (`503 E_EDGE_BUSY`), inbound body cap (`413
  E_EDGE_TOO_LARGE`), per-request logging, and a `/healthz` probe.
- CI: test matrix over Node 20/22/24, a `pnpm audit --prod` job, and weekly
  Dependabot updates for npm, GitHub Actions, and cargo.
- `ad-chart` now renders its SPEC Appendix A fallback: a `<table>` of the
  `data` field inside `<figure data-ad-chart="type">` (array rows with an
  optional `columns` header, object rows keyed by first-seen order, flat
  scalar arrays as one column). Mixed shapes render no table.
- `ad-list` (level 1) now renders `<ul>`/`<ol>` instead of a generic
  section: from body list markers, the `items` field, or `ordered: true`.
- `ad-include` (SPEC 4.5) is now fully supported in both implementations:
  the AST stores the reference, and an explicit inlining pass
  (`inlineIncludes(doc, { loader })` in TS, `inline_includes` in Rust;
  `--inline` on the CLI's `ast`/`fmt`/`render`) splices referenced
  documents at the include position. Cycles are `E_INCLUDE_CYCLE`
  (path-based, diamonds allowed), unresolvable srcs are
  `E_INCLUDE_UNRESOLVED`, and `cap:` sources stay verbatim for the host.
  The loader is injected, so hosts control which paths a document may read.
- Conformance vector `0009-chart-and-list` locks both behaviors byte-exact
  across the TypeScript and Rust implementations.
- `ad-form` controls now render the SPEC 4.3 validation options (`min=`,
  `max=`, `pattern=`, `maxlength=`) as HTML attributes, and `value=` seeds
  initial content (textarea uses it as its text). The control-option parser
  splits only on top-level commas, so `options=["a", "b"]` and quoted
  values containing commas work; vector `0010-form-controls` locks it.
- `actdown check` now reports review lints beyond parse errors:
  `W_REGION_FOR` (an ad-region pointing at a missing block id),
  `W_EXPR_SYNTAX` (an unparseable `when=`/`each=` guard), and
  `W_CAP_UNDECLARED` (an action naming a capability no ad-manifest
  declares). Warnings are reported but fail the run only with `--strict`;
  `actdown_check` in the MCP server includes them. The linter is exported
  as `lint(doc)` and mirrored in the Rust port as `actdown::lint(&Doc)`
  (with the same three warnings and identical fixtures in
  `actdown-rs/tests/lint.rs`).
- `actdown_html2ad` converts existing HTML to canonical ad (returning
  `{ canonical, notes, source }`). Resources `actdown://guide/authoring` and
  `actdown://guide/grammar` teach the format in-session.

- Markdown superset with `ad-*` fenced blocks: state, data, action, form,
  table, image, link, chart, region (level 1), bindings, `when=`/`each=`
  (level 2), expression language and async phase regions (level 3).
- TypeScript reference implementation, zero runtime dependencies:
  parser, canonical printer (total and idempotent, INV-3), AST JSON
  (`ad: "0.1"` contract), level-1 HTML renderer, expression evaluator,
  reactive render, runtime with capability registry (`hydrate`/`fire`),
  DOM adapter for in-place binding updates.
- HTML downconversion to canonical ad (`html2ad`) with a dual-pane `/view`.
- Edge transcoder gateway (`src/edge.ts`, `src/serve.ts`) with an SSRF
  literal-IP guard (`EDGE_ALLOW_PRIVATE=1` opts out; not for public use).
- Zero-dependency stdio MCP server (`src/mcp.ts`, JSON-RPC 2.0).
- CLI: `actdown check | fmt | ast | render | html2ad`, stdin supported.
- Rust port (`actdown-rs`) byte-exact with the reference implementation on
  all 10 conformance vectors (ast/canonical/html/reactive goldens); WASM
  build via a flat C ABI (`src/wasm.rs`) and a self-contained playground.
- Shared conformance vectors (`vectors/`) and the TypeScript/Rust test suites.

### Known limits

- Rust capabilities are synchronous; TypeScript capabilities may be async,
  so async phase behavior is not identical across implementations.
- The edge gateway is a development preview: shared-token and per-identity
  auth, native TLS termination, rate limits, and an SSRF resolution guard
  are in. Default connections are pinned to validated addresses. Real user
  accounts, client certificates, and ACME are open; front a public gateway
  with a TLS proxy and an explicit access policy. Converted page content
  remains untrusted input to the agent.

### Fixed

- Reader conversion now starts at the first `<main>` element when present, excluding page headers and surrounding navigation. Empty link and button controls no longer produce semantic blocks. Pages without `<main>` retain full-document conversion.
- GFM pipe tables inside prose now render as `<table>` in both
  implementations; previously they fell through to paragraph text and the
  `|---|` delimiter row printed literally.

[0.1.0]: https://github.com/Omodaka9375/actdown/releases/tag/v0.1.0
