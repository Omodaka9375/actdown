# Changelog

All notable changes to actdown are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-10

First development preview. Spec draft 0.1 (see `SPEC.md`, normative).

### Added

- Edge gateway hardening: every hostname (initial request and each redirect
  hop) is resolved via DNS and refused when any resolved address is private,
  loopback, or link-local (`E_EDGE_PRIVATE`). Resolution failures map to
  `E_EDGE_FETCH`. The resolver is injectable (`EdgeOptions.resolver`) for
  tests and policy. A residual connect-time re-resolution window remains;
  full DNS-rebinding defense still needs restricted network egress.

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
  all 7 conformance vectors (ast/canonical/html/reactive goldens); WASM
  build via a flat C ABI (`src/wasm.rs`) and a self-contained playground.
- Shared conformance vectors (`vectors/`) and a 97-test vitest suite.

### Known limits

- Rust capabilities are synchronous; TypeScript capabilities may be async,
  so async phase behavior is not identical across implementations.
- The edge gateway is a development preview: no auth, no rate limits, and
  no DNS-rebinding protection beyond literal-IP checks. Not for public
  exposure.
- `ad-include` and some form-control rendering are still open.

### Fixed

- GFM pipe tables inside prose now render as `<table>` in both
  implementations; previously they fell through to paragraph text and the
  `|---|` delimiter row printed literally.

[0.1.0]: https://github.com/Omodaka9375/actdown/releases/tag/v0.1.0
