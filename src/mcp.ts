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
} from "./index.js";

// --- tool implementations ---------------------------------------------------
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function text(x: string): ToolResult {
  return { content: [{ type: "text", text: x }] };
}

type ToolArgs = { doc: string };

/** Validate the input document; return diagnostics (empty when valid). */
function checkDoc(input: string) {
  const result = parse(input);
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

const TOOLS: Record<
  string,
  {
    description: string;
    inputSchema: Record<string, unknown>;
    run: (args: ToolArgs) => ToolResult;
  }
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
      return text(renderReactive(canonicalize(parse(args.doc).doc)));
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
      return text(render(canonicalize(parse(args.doc).doc)));
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
      return text(format(print(canonicalize(parse(args.doc).doc))));
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
      return text(toJSON(canonicalize(parse(args.doc).doc)));
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
      return text(JSON.stringify({ diagnostics: checkDoc(args.doc) }, null, 2));
    },
  },
};

// --- JSON-RPC plumbing ------------------------------------------------------
const SERVER_INFO = { name: "actdown", version: "0.1.0" };

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function fail(id: unknown, code: number, message: string): void {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}

function handle(msg: JSONRPCRequest): void {
  const { id, method, params } = msg;
  if (method === undefined) return;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
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
  if (method === "tools/call") {
    const tool = TOOLS[params?.name ?? ""];
    if (tool === undefined) {
      fail(id, -32602, `unknown tool: ${String(params?.name)}`);
      return;
    }
    try {
      reply(id, tool.run((params?.arguments ?? {}) as ToolArgs));
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

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let msg: JSONRPCRequest;
  try {
    msg = JSON.parse(trimmed) as JSONRPCRequest;
  } catch {
    return; // not JSON: ignore, a stdio MCP stream must stay silent otherwise
  }
  try {
    handle(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(msg?.id ?? null, -32603, `internal error: ${message}`);
  }
});
rl.on("close", () => process.exit(0));
