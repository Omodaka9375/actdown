#!/usr/bin/env node
/**
 * actdown MCP server: exposes the actdown engine to MCP clients over stdio.
 *
 * Zero dependencies, JSON-RPC 2.0 per the Model Context Protocol. Import
 * from dist (built by `pnpm build`), so it works whether run from a checkout
 * or an npm install.
 *
 * Run with:   node dist/mcp.js            # after `pnpm build`
 * Registry:   add it with the same command as a stdio MCP server.
 *
 * Tools:
 *   actdown_render     doc (.ad text) -> reactive HTML (bindings filled)
 *   actdown_html       doc -> static level-1 HTML
 *   actdown_canonical  doc -> canonical text (SPEC 9/10)
 *   actdown_ast        doc -> JSON AST (SPEC 8)
 *   actdown_check      doc -> diagnostics array (empty when valid)
 *   actdown_html2ad    html -> canonical ad (lossy downconversion, SPEC 12)
 *   actdown_transcode  url -> fetch + downconvert (the agent "reader mode";
 *                      SSRF-guarded: private/loopback targets refused,
 *                      redirects re-checked per hop, body capped)
 *
 * Resources (embedded guides so an agent can learn the format in-session):
 *   actdown://guide/authoring   how to write .ad documents
 *   actdown://guide/grammar     block grammar quick reference
 */
import { createInterface } from "node:readline";
import type { JSONRPCRequest } from "./jsonrpc.js";
import {
  parse,
  canonicalize,
  format,
  print,
  toJSON,
  lint,
  render,
  renderReactive,
  htmlToDoc,
} from "./index.js";
import { transcodeUrl, type EdgeFormat, type EdgeOptions } from "./edge.js";

// --- tool implementations ---------------------------------------------------
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Edge options for actdown_transcode. Default: the full guard stack
 * (private targets refused, redirects re-checked per hop, body cap).
 * Hosts may relax via allowPrivate for controlled local fixtures, or
 * inject a fetcher/resolver in tests.
 */
let transcodeOpts: EdgeOptions = {};

/** Replace the edge options used by actdown_transcode (host/test seam). */
export function setTranscodeOptions(opts: EdgeOptions): void {
  transcodeOpts = opts;
}

function text(x: string): ToolResult {
  return { content: [{ type: "text", text: x }] };
}

type ToolArgs = { doc?: string; html?: string; source?: string; url?: string; format?: string };

/** Validate the input document; return diagnostics (empty when valid). */
function checkDoc(input: string | undefined) {
  const result = parse(input ?? "");
  const hard = result.diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
    line: d.line,
  }));
  if (hard.length > 0) return hard;
  // Review lints travel with the hard diagnostics (W_ prefix marks warnings).
  return lint(result.doc).map((d) => ({
    code: d.code,
    message: d.message,
    line: d.line,
  }));
}

export interface McpTool {
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: ToolArgs) => ToolResult | Promise<ToolResult>;
}

/** Tool registry; exported for tests only (the wire surface is JSON-RPC). */
export const TOOLS: Record<
  string,
  McpTool
> = {
  actdown_render: {
    description:
      "Render an actdown document (.ad, HyperText Markdown) to reactive HTML: " +
      "prose plus semantic blocks with bindings filled from the document's own " +
      "state. Interactive elements are inert placeholders; the host decides " +
      "which capabilities exist. Input: { doc: string }.",
    inputSchema: {
      type: "object",
      properties: { doc: { type: "string" } },
      required: ["doc"],
    },
    run(args) {
      const diags = checkDoc(args.doc);
      if (diags.length > 0) return text(JSON.stringify({ diagnostics: diags }, null, 2));
      return text(renderReactive(canonicalize(parse(args.doc ?? "").doc)));
    },
  },
  actdown_html: {
    description:
      "Render an actdown document to static level-1 HTML (no state applied, " +
      "bindings empty). Input: { doc: string }.",
    inputSchema: {
      type: "object",
      properties: { doc: { type: "string" } },
      required: ["doc"],
    },
    run(args) {
      const diags = checkDoc(args.doc);
      if (diags.length > 0) return text(JSON.stringify({ diagnostics: diags }, null, 2));
      return text(render(canonicalize(parse(args.doc ?? "").doc)));
    },
  },
  actdown_canonical: {
    description:
      "Return the canonical form of an actdown document: a byte-stable, " +
      "idempotent text with ids assigned, suitable for review diffs. " +
      "Input: { doc: string }.",
    inputSchema: {
      type: "object",
      properties: { doc: { type: "string" } },
      required: ["doc"],
    },
    run(args) {
      const diags = checkDoc(args.doc);
      if (diags.length > 0) return text(JSON.stringify({ diagnostics: diags }, null, 2));
      return text(format(print(canonicalize(parse(args.doc ?? "").doc))));
    },
  },
  actdown_ast: {
    description:
      "Return the JSON AST (hdm:\"0.1\" contract) of an actdown document. " +
      "Input: { doc: string }.",
    inputSchema: {
      type: "object",
      properties: { doc: { type: "string" } },
      required: ["doc"],
    },
    run(args) {
      const diags = checkDoc(args.doc);
      if (diags.length > 0) return text(JSON.stringify({ diagnostics: diags }, null, 2));
      return text(toJSON(canonicalize(parse(args.doc ?? "").doc)));
    },
  },
  actdown_check: {
    description:
      "Check an actdown document without producing output: returns the " +
      "diagnostics array (empty when the document is valid). Input: { doc: string }.",
    inputSchema: {
      type: "object",
      properties: { doc: { type: "string" } },
      required: ["doc"],
    },
    run(args) {
      return text(JSON.stringify({ diagnostics: checkDoc(args.doc ?? "") }, null, 2));
    },
  },
  actdown_html2ad: {
    description:
      "Convert an existing HTML page to canonical actdown (lossy downconversion, " +
      "SPEC 12): semantic elements map to blocks, presentation-only markup " +
      "collapses into prose, scripts are recorded for audit and never carried. " +
      "Returns JSON { canonical, notes, source }. Input: { html: string, source?: string }.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "The HTML source to convert." },
        source: { type: "string", description: "Optional origin URL recorded in the document." },
      },
      required: ["html"],
    },
    run(args) {
      const { doc, notes } = htmlToDoc(args.html ?? "", { source: args.source });
      return text(
        JSON.stringify(
          {
            canonical: format(print(canonicalize(doc))),
            notes,
            source: args.source ?? "",
          },
          null,
          2,
        ),
      );
    },
  },
  actdown_transcode: {
    description:
      "Fetch a web page by URL and downconvert it to canonical actdown: the " +
      "agent \"reader mode\". Guards are on: private/loopback targets are " +
      "refused (SSRF), every redirect hop is re-checked, the body is capped, " +
      "and scripts never reach the output; author-hidden content is dropped " +
      "and reported. Returns JSON { source, canonical, notes, format }. " +
      "Input: { url: string, format?: \"canonical\" | \"ast\" | \"html\" }.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch and convert." },
        format: {
          type: "string",
          enum: ["canonical", "ast", "html"],
          description: "Response format (default canonical; ast = JSON AST, html = rendered).",
        },
      },
      required: ["url"],
    },
    async run(args) {
      const url = args.url ?? "";
      let fmt: EdgeFormat = "canonical";
      if (args.format === "ast" || args.format === "html" || args.format === "canonical") {
        fmt = args.format;
      } else if (args.format !== undefined && args.format !== "raw") {
        return text(JSON.stringify({ error: `unknown format: ${args.format}` }, null, 2));
      }
      try {
        const result = await transcodeUrl(url, transcodeOpts);
        const { doc, notes, source } = result;
        if (fmt === "ast") {
          return text(JSON.stringify({ source, notes, format: fmt, ast: JSON.parse(toJSON(doc)) }, null, 2));
        }
        if (fmt === "html") {
          return text(JSON.stringify({ source, notes, format: fmt, html: renderReactive(doc) }, null, 2));
        }
        return text(JSON.stringify({ source, notes, format: fmt, canonical: format(print(canonicalize(doc))) }, null, 2));
      } catch (err: unknown) {
        const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "E_EDGE_INTERNAL";
        const message = err instanceof Error ? err.message : String(err);
        return text(JSON.stringify({ error: { code, message } }, null, 2));
      }
    },
  },
};

// --- embedded guides (resources) --------------------------------------------
// The server ships its own documentation so an agent can learn the format in
// the same session where it writes documents.

const AUTHORING_GUIDE = `# Authoring actdown (.ad) documents

actdown (short: ad) is a Markdown superset: prose stays plain Markdown, and
fenced code blocks with an \`ad-*\` info string add state, structure, forms,
and actions. The document is text; it cannot carry JavaScript. Actions name
*capabilities* that the host application grants; ungranted capabilities render
disabled and refuse to run.

## Levels

- Level 0: plain Markdown.
- Level 1: structural blocks (state, data, action, form, table, image, link,
  chart, list, region, manifest).
- Level 2: bindings ({expr} in text), when= guards, each= repetition.
- Level 3: full expression language, computed state, async phase regions.

## Field grammar

Inside an ad-* block, lines are \`key: value\` where value is JSON (strings,
numbers, booleans, null, arrays, objects) or a bare word. A line of just
\`---\` separates fields from body text:

\`\`\`ad-text
body: Hello
\`\`\`

\`\`\`ad-link?href=https://example.com
---
Read the docs
\`\`\`

Body-only blocks need the \`---\` separator first; otherwise every line is
parsed as a field.

## State, actions, regions

\`\`\`ad-state
count: 0
\`\`\`

\`\`\`ad-action?name=counter.inc&role=primary&when=!approved
id: add
on:click: cap.send("counter.inc", { by: 1 })
---
Add one ({count})
\`\`\`

- \`name=\` names the capability the host must grant.
- \`when=\` is an expression guard; the block renders only when it holds.
- \`id:\` must be unique; generated ids are h<sha1[0:10]>.
- ad-region blocks with \`for: <action-id>\` and \`phase: pending|success|failure\`
  switch on async progress.

## Forms

\`\`\`ad-form?id=contact&action=cap:contact-form@v1
email:   input(email, required, maxlength=320)
score:   input(number, min=0, max=10)
channel: select(options=["email", "slack"])
message: textarea(maxlength=500)
send:    submit(label="Send")
\`\`\`

Control kinds: input(TYPE, ...), textarea(...), select(..., options=[...]),
checkbox, submit(...). Validation opts: required, min=, max=, pattern=,
maxlength=. value= seeds initial content.

## Reviewing

actdown check reports lints: W_REGION_FOR (region points at a missing id),
W_EXPR_SYNTAX (unparseable when=/each=), W_CAP_UNDECLARED (an action names a
capability no ad-manifest declares).

## Rules

The JSON AST (ad: "0.1") is the contract. Canonicalization is total and
idempotent: format(doc) is byte-stable and diffable. There is no script
syntax (INV-4): if a document seems to need code, it needs a capability.
`;

const GRAMMAR_REFERENCE = `# ad-* block grammar quick reference

Info string: \`\`\`ad-TYPE or \`\`\`ad-TYPE?key=value&key=value.
Percent-encoding applies to attribute values. Unknown types degrade to plain
code fences in Markdown viewers (INV-1).

- ad-state      field set; the document's shared state (flat map).
- ad-data       field set published as data; consumers bind to id.key.
- ad-text       body: text (fields.body or body text) with {expr} bindings.
- ad-action     attrs: name (capability), role, when; body is the label.
                on:click: expression fires on click via the host runtime.
- ad-form       fields are controls: NAME: CONTROL(opts); body-less.
                Phases key on the form's block id (ad-region for:).
- ad-region     for: <action-or-form id>, phase: pending|success|failure;
                body shows while that phase is active.
- ad-manifest   declares a capability: name, min-version, scopes.
- ad-table      body is a GFM markdown table; the AST stores parsed rows.
- ad-image      src, alt (required); width, height (numbers).
- ad-link       href (required); body is the label.
- ad-chart      type: line|bar|pie|spark; data: rows (arrays, objects, or
                flat scalars); columns: header names; src: external data.
                Renders <figure data-ad-chart> with a <table> fallback.
- ad-list       body list markers or items: [...]; ordered via N. markers
                or ordered: true.
- ad-include    include another document by path (SPEC 4.5).

Roles (SPEC 8): button, link, input, label, heading, chart, table, image,
form, region, status, nav, danger, primary, secondary. Private extensions
use the x- prefix.

Diagnostics: parse errors are E_* (E_DUP_ID, E_BAD_FIELD, E_BAD_LITERAL,
...); review lints are W_* (W_REGION_FOR, W_EXPR_SYNTAX, W_CAP_UNDECLARED).
`;

const RESOURCES: Record<
  string,
  { name: string; description: string; mimeType: string; text: string }
> = {
  "actdown://guide/authoring": {
    name: "authoring-guide",
    description: "How to write actdown (.ad) documents: fields, actions, forms, regions, lints.",
    mimeType: "text/markdown",
    text: AUTHORING_GUIDE,
  },
  "actdown://guide/grammar": {
    name: "grammar-reference",
    description: "Quick reference for every ad-* block type, roles, and diagnostics.",
    mimeType: "text/markdown",
    text: GRAMMAR_REFERENCE,
  },
};

// --- JSON-RPC plumbing ------------------------------------------------------
const SERVER_INFO = { name: "actdown", version: "0.1.0" };

/** A JSON-RPC id must be a string, a finite number, or null; anything else
 * (objects, arrays, huge values) is sanitized to null so the reply itself
 * can always serialize and a malformed id can never kill the process. */
function safeId(id: unknown): string | number | null {
  if (typeof id === "string") return id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  return null;
}

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: safeId(id), result }) + "\n");
}

function fail(id: unknown, code: number, message: string): void {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: safeId(id), error: { code, message } }) + "\n",
  );
}

function handle(msg: JSONRPCRequest): void {
  const { id, method, params } = msg;
  if (typeof method !== "string") {
    if (id !== undefined) fail(id, -32600, "invalid request: method must be a string");
    return;
  }
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    return;
  }
  if (method === "resources/list") {
    reply(id, {
      resources: Object.entries(RESOURCES).map(([uri, r]) => ({
        uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    });
    return;
  }
  if (method === "resources/read") {
    const uri = params?.uri;
    const r = typeof uri === "string" ? RESOURCES[uri] : undefined;
    if (r === undefined) {
      fail(id, -32602, `unknown resource: ${String(uri)}`);
      return;
    }
    reply(id, {
      contents: [{ uri, mimeType: r.mimeType, text: r.text }],
    });
    return;
  }
  if (method === "tools/call") {
    const tool = TOOLS[params?.name ?? ""];
    if (tool === undefined) {
      fail(id, -32602, `unknown tool: ${String(params?.name)}`);
      return;
    }
    try {
      const out = tool.run((params?.arguments ?? {}) as ToolArgs);
      if (out instanceof Promise) {
        void out.then(
          (r) => reply(id, r),
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            reply(id, { content: [{ type: "text", text: `error: ${message}` }], isError: true });
          },
        );
      } else {
        reply(id, out);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply(id, {
        content: [{ type: "text", text: `error: ${message}` }],
        isError: true,
      });
    }
    return;
  }
  // Notifications and unknown methods: acknowledged where required.
  if (id === undefined) return; // notification, no reply
  fail(id, -32601, `method not found: ${method}`);
}

/** Start the stdio loop. Only run when this file is the entry point: an
 * import (tests, tools poking at TOOLS) must not capture process.stdin. */
function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let msg: JSONRPCRequest;
    try {
      msg = JSON.parse(trimmed) as JSONRPCRequest;
    } catch {
      // Not JSON: answer with a protocol error (id unknown, so null) rather
      // than dropping the frame silently - a stuck client deserves a reply.
      fail(null, -32700, "parse error");
      return;
    }
    try {
      handle(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail(msg?.id ?? null, -32603, `internal error: ${message}`);
    }
  });
  rl.on("close", () => process.exit(0));
}

if (process.argv[1] !== undefined && (await import("node:url")).pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
