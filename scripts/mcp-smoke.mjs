#!/usr/bin/env node
/** Smoke test for the stdio MCP server: spawns dist/mcp.js, speaks JSON-RPC. */
import { spawn } from "node:child_process";
import path from "node:path";

const server = spawn(process.execPath, [path.resolve("dist/mcp.js")], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();

server.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim() === "") continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

const call = (method, params) =>
  new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

let failures = 0;
const expect = (name, cond, detail) => {
  if (cond) console.log(`ok ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
};

const init = await call("initialize", { protocolVersion: "2025-06-18" });
expect("initialize returns serverInfo", init.result?.serverInfo?.name === "actdown", JSON.stringify(init.result));

const list = await call("tools/list", {});
const names = list.result?.tools?.map((t) => t.name) ?? [];
expect("tools/list has 5 tools", names.length === 5, names.join(","));
expect("render tool listed", names.includes("actdown_render"));

const doc = `# Hi

\`\`\`ad-state
n: 3
\`\`\`

Count: {n}.`;
const rendered = await call("tools/call", { name: "actdown_render", arguments: { doc } });
expect("render fills bindings", rendered.result?.content?.[0]?.text?.includes(">3<") === true, rendered.result?.content?.[0]?.text?.slice(0, 200));

const canonical = await call("tools/call", { name: "actdown_canonical", arguments: { doc } });
expect("canonical assigns an id", /id: h[0-9a-f]{10}/.test(canonical.result?.content?.[0]?.text ?? ""), canonical.result?.content?.[0]?.text);

const ast = await call("tools/call", { name: "actdown_ast", arguments: { doc } });
expect("ast is the JSON contract", ast.result?.content?.[0]?.text?.includes('"ad": "0.1"') === true, (ast.result?.content?.[0]?.text ?? "").slice(0, 120));

const bad = await call("tools/call", { name: "actdown_check", arguments: { doc: "```ad-state\nn: [unclosed\n```" } });
expect("check reports diagnostics", (bad.result?.content?.[0]?.text ?? "").includes("diagnostics"), bad.result?.content?.[0]?.text);

const unknown = await call("tools/call", { name: "nope", arguments: {} });
expect("unknown tool errors", unknown.error?.code === -32602, JSON.stringify(unknown));

server.stdin.end();
await new Promise((r) => server.on("close", r));
process.exit(failures === 0 ? 0 : 1);
