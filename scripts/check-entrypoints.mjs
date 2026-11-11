#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Execute a child with a bounded lifetime and return its output. */
function run(file, args, { input = "", env = {}, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout: ${file} ${args.join(" ")}\n${out}\n${err}`));
    }, timeout);
    child.stdout.on("data", (x) => (out += x));
    child.stderr.on("data", (x) => (err += x));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (input !== "") child.stdin.write(input);
    child.stdin.end();
  });
}

const root = process.cwd();
const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
const temp = mkdtempSync(join(tmpdir(), "actdown-entry-"));
try {
  // npx/npm invokes through a symlink: the server must still run.
  const link = join(root, "dist", ".mcp-entry-check.js");
  // Windows allows file symlinks only with the Developer Mode privilege.
  // Real package CI covers POSIX npx bins; otherwise use a hard link as a
  // different argv[1] path to the same real file.
  try {
    symlinkSync(join(root, "dist", "mcp.js"), link, process.platform === "win32" ? "file" : undefined);
  } catch (err) {
    if (err.code !== "EPERM") throw err;
    const { linkSync } = await import("node:fs");
    linkSync(join(root, "dist", "mcp.js"), link);
  }
  const mcp = await run(process.execPath, [link], { input: init });
  if (!mcp.out.includes('"serverInfo"')) throw new Error(`symlink MCP failed: ${mcp.out}\n${mcp.err}`);
  console.log("ok symlink MCP entry point");

  // A default, token-free gateway must not turn auth on implicitly.
  const port = 18_700 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, [join(root, "dist", "serve.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", EDGE_TOKEN: "", EDGE_TOKENS: "", EDGE_TOKENS_FILE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (x) => (stderr += x));
  try {
    let ready = false;
    for (let n = 0; n < 60; n += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (r.ok) { ready = true; break; }
      } catch { /* wait for listen */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error(`gateway did not listen: ${stderr}`);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    if (response.status !== 200) throw new Error(`default gateway status: ${response.status}`);
    console.log("ok default gateway entry point (no auth required)");
  } finally {
    server.kill();
  }
} finally {
  rmSync(join(root, "dist", ".mcp-entry-check.js"), { force: true });
  rmSync(temp, { recursive: true, force: true });
}
