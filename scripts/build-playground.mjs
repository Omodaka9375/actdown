#!/usr/bin/env node
/**
 * Builds the playground: base64-embeds the wasm32 release build of the Rust
 * engine into actdown-rs/playground-template.html (replacing the @@WASM@@
 * placeholder) and writes playground.html.
 *
 * Run with: node scripts/build-playground.mjs [path-to-wasm]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const wasmPath =
  process.argv[2] ??
  path.join(root, "actdown-rs/target/wasm32-unknown-unknown/release/actdown.wasm");
const template = await readFile(
  path.join(root, "actdown-rs/playground-template.html"),
  "utf8",
);
const wasm = await readFile(wasmPath);

if (!template.includes("@@WASM@@")) {
  console.error("template has no @@WASM@@ placeholder");
  process.exit(1);
}
const out = template.replace("@@WASM@@", wasm.toString("base64"));
const target = path.join(root, "actdown-rs/playground.html");
await writeFile(target, out);
console.log(
  `wrote ${path.relative(root, target)} ` +
    `(${(wasm.length / 1024).toFixed(0)} KB wasm embedded, ` +
    `${(out.length / 1024).toFixed(0)} KB total)`,
);
