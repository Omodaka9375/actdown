# actdown

[![CI](https://github.com/Omodaka9375/actdown/actions/workflows/ci.yml/badge.svg)](https://github.com/Omodaka9375/actdown/actions/workflows/ci.yml)

**Reader mode for agents: turn a web page into a structured, canonical actdown document over MCP.**

actdown fetches HTML and converts it to canonical `.ad` text or a JSON AST. It removes scripts and presentation markup, keeps useful semantic structure, and reports conversion notes. The package also includes a document parser, renderer, CLI, and a development HTTP gateway.

**Status:** spec draft 0.1 and development preview. Requires Node.js 20 or newer. Zero runtime dependencies. Visit [actdown.dev](https://actdown.dev) for the project site and browser playground.

## MCP quickstart

Add this to your MCP client configuration:

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

Then ask the agent to use `actdown_transcode` with:

```json
{
  "url": "https://example.com",
  "format": "canonical"
}
```

The result is JSON text with the fetched source, converted document, format, and conversion notes:

```json
{
  "source": "https://example.com/",
  "format": "canonical",
  "canonical": "This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.\n",
  "notes": []
}
```

`format: "ast"` returns a JSON AST (`ad: "0.1"`). `format: "html"` returns rendered HTML. Already have HTML? Use `actdown_html2ad` with `{ html, source? }`; it converts text directly without fetching a URL.

For a checkout, run `pnpm build` and configure your MCP client to run `node dist/mcp.js` instead. The server exposes seven tools and two in-session authoring guides (`actdown://guide/authoring` and `actdown://guide/grammar`).

## Conversion and security boundaries

- **Conversion is lossy.** Reader output prefers the first `<main>` element when present, excluding page headers and surrounding navigation. Pages without `<main>` are converted as complete documents. Headings, paragraphs, lists, tables, links, images, forms, and buttons become prose or semantic blocks. Script and style elements are removed. Inline event handlers are never executed, but their source may remain as an inert `x-legacy-handler` audit note.
- **Converted text is untrusted data, including visible text.** The converter does not detect prompt-injection instructions or decide whether content is trustworthy. Agents must treat it as page content, not instructions from the host or user.
- Recognized hidden markup (`hidden`, `aria-hidden`, `template`, and several inline CSS hiding declarations) is dropped and counted in an aggregate note, without a text preview. External CSS, site-specific classes, matching colors, off-screen positioning, and other layout-only hiding are not detected.
- Private, loopback, link-local, selected special-use, and IPv4-mapped private targets are refused by default. DNS answers and every redirect are checked. The default fetcher pins the connection to a validated address while retaining the original HTTP Host and TLS SNI. A custom fetcher owns its own connection policy.
- Defaults: **10-second fetch timeout**, **5 MiB response-body cap**, and **five redirects**. HTML and other `text/*` content types are accepted; responses without a content-type header are parsed as HTML. Other content types are refused. `EDGE_ALLOW_PRIVATE=1` relaxes private-target checks for controlled fixtures only, never for an exposed service.
- Tool failures return MCP error results with `isError: true` and JSON `{ error: { code, message } }`.

## MCP tools

| Tool | Input | Result |
|---|---|---|
| `actdown_transcode` | `url`, optional `format: canonical\|ast\|html` | Fetched and converted page with notes |
| `actdown_html2ad` | `html`, optional `source` | `{ canonical, notes, source }` |
| `actdown_render` | `doc` | Reactive HTML with bindings filled |
| `actdown_html` | `doc` | Static level-1 HTML |
| `actdown_canonical` | `doc` | Canonical `.ad` text for review diffs |
| `actdown_ast` | `doc` | JSON AST (`ad: "0.1"`) |
| `actdown_check` | `doc` | JSON text `{ diagnostics: [] }`, including review lints |

The authoring and grammar references are also available as MCP resources at `actdown://guide/authoring` and `actdown://guide/grammar`.

## Development HTTP gateway

The gateway is a secondary, development-only surface for agents and a dual-pane browser UI. From the package:

```sh
actdown-edge
```

From a checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm edge
```

The default is `127.0.0.1:8787` and requires no token on loopback:

```text
/transcode?url=https%3A%2F%2Fexample.com&format=canonical
/transcode?url=https%3A%2F%2Fexample.com&format=ast
/view?url=https%3A%2F%2Fexample.com
/healthz
```

`HOST` widens the bind address deliberately. Before using it beyond loopback, set `EDGE_TOKEN` to at least 16 random characters or configure named identities using `EDGE_TOKENS="bot=token-1\nhuman=token-2"` or `EDGE_TOKENS_FILE`. Agents should prefer `Authorization: Bearer <token>`.

The browser UI and iframes use `?token=` because they cannot set request headers. Such URLs may remain in browser history, copied URLs, and intermediary logs. Responses set `Referrer-Policy: no-referrer`, and gateway request logs redact tokens and target URLs. Identity is included in authenticated request logs. A configured token file is reread per request for rotation without restart.

`EDGE_TLS_CERT` + `EDGE_TLS_KEY` enable native HTTPS. `EDGE_TRUST_PROXY=1` uses forwarded client addresses for rate limiting only behind a trusted proxy. `EDGE_RATE_LIMIT`, `EDGE_ALLOW_PRIVATE`, and `EDGE_TOKENS`/`EDGE_TOKENS_FILE` configure the corresponding policies. Public deployments still need a TLS proxy, explicit access policy, and production hardening.

## Library and CLI

```ts
import { html2ad, transcodeUrl } from "actdown";

const result = await transcodeUrl("https://example.com");
console.log(result.canonical);
console.log(result.notes);

console.log(html2ad("<h1>Hello</h1><p>World</p>"));
```

`createEdgeServer` is exported from `actdown` and `actdown/serve`. MCP embedding is exported from `actdown/mcp` (`TOOLS`, `setTranscodeOptions`). The default `transcodeUrl` guard stack applies; injected fetchers and `allowPrivate` are explicit host decisions.

```sh
actdown check document.ad          # diagnostics; --strict also fails on warnings
actdown fmt document.ad            # canonical text
actdown ast document.ad            # JSON AST
actdown render document.ad         # static HTML; add --reactive to apply state
actdown html2ad page.html          # convert an existing file
```

## The actdown format

actdown is also a Markdown superset for documents people and agents can read, write, and operate. Fenced `ad-*` blocks add state, forms, semantic structure, and named actions. Documents do not contain JavaScript. Host applications grant capabilities explicitly and must validate their arguments.

````markdown
# Cart

```ad-state
count: 0
```

```ad-action?name=counter.inc
id: add
---
Add one ({count})
```

Count: {count}.
````

See [SPEC.md](SPEC.md), [DESIGN.md](DESIGN.md), and the [approval example](examples/mcp-approval/) for the interactive runtime and audit workflow. The repository also contains a Rust/WASM implementation, shared conformance vectors, and a browser playground.

## Development and release

```sh
pnpm install --frozen-lockfile
pnpm verify             # TypeScript typecheck and full test suite
pnpm test:mcp           # MCP JSON-RPC smoke test
pnpm test:entrypoints   # npm-link and default gateway checks
pnpm pack               # builds dist via prepack
```

A `v*.*.*` tag matching both package versions triggers the release workflow. It runs the full verification suite, then publishes the npm tarball, standalone WASM playground, and SHA-256 checksums as GitHub release assets. Release notes come from the matching section in `CHANGELOG.md`. A semver suffix, such as `v0.2.0-alpha.0`, marks a prerelease; stable tags create normal releases. The workflow does not publish to npm or crates.io.

[Changelog](CHANGELOG.md) · [Releases](https://github.com/Omodaka9375/actdown/releases) · [Apache-2.0 license](LICENSE)
