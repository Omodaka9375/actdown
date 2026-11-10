#!/usr/bin/env node
/**
 * actdown demo: an MCP approval document, end to end.
 *
 * Run with:  pnpm build && pnpm demo
 *
 * The story this demo tells:
 *   1. A release agent writes a small text document describing a deploy.
 *   2. The host can statically audit everything that document can do.
 *   3. Rendering is safe even when nothing is granted.
 *   4. The host grants exactly one capability; the other is refused.
 *   5. State, phases, and bindings update in one pass; the document
 *      still renders after a failure.
 *
 * Mapping to the MCP Apps world (see README.md in this folder):
 *   - The tool result is the .ad text (compact, readable by the model).
 *   - The capability map below is what an MCP host would wire to tool calls.
 *   - runtime.fire is what a UI bridge event handler would call.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parse,
  canonicalize,
  format,
  render,
  hydrate,
  CapMissingError,
} from "../../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const H = (s) => {
  const line = "-".repeat(Math.min(72, Math.max(8, s.length + 4)));
  return `${line}\n  ${s}\n${line}`;
};

// ---------------------------------------------------------------------------
// 1. Load the document an agent would have produced.
// ---------------------------------------------------------------------------
const source = await readFile(path.join(here, "approval.ad"), "utf8");

console.log(H("1. THE DOCUMENT (agent-authored, 1.6 KB of text)"));
console.log(source);

// ---------------------------------------------------------------------------
// 2. Parse and canonicalize: deterministic surfaces for machines.
// ---------------------------------------------------------------------------
const parsed = parse(source);
const doc = canonicalize(parsed.doc);
const canonical = format(source);

console.log(H("2. PARSE: diagnostics and canonical form"));
console.log(`diagnostics: ${parsed.diagnostics.length === 0 ? "none" : JSON.stringify(parsed.diagnostics)}`);
console.log("--- canonical form (byte-stable, diffable in review) ---");
console.log(canonical);

// ---------------------------------------------------------------------------
// 3. Statically audit what the document can possibly do. No execution.
// ---------------------------------------------------------------------------
console.log(H("3. STATIC AUDIT: every side effect this document could ever have"));

const caps = [];
const manifests = new Map();
for (const n of doc.nodes) {
  if (n.kind !== "block" || n.foreign) continue;
  if (n.type === "manifest" && typeof n.fields.name === "string") {
    manifests.set(n.fields.name, {
      scopes: Array.isArray(n.fields.scopes) ? n.fields.scopes : [],
    });
  }
  if (n.type === "action" && typeof n.attrs.name === "string") caps.push(n.attrs.name);
  if (n.type === "form" && typeof n.attrs.action === "string") caps.push(n.attrs.action);
}
const declared = (name) => (manifests.has(name) ? `declared: scopes ${JSON.stringify(manifests.get(name).scopes)}` : "no manifest entry");
for (const c of [...new Set(caps)]) console.log(`  capability ${c}: ${declared(c)}`);
console.log("  events: click (both actions)");
console.log("  network/storage/DOM access: none (no script equivalent exists)");

// ---------------------------------------------------------------------------
// 4. Render with nothing granted: complete, safe, visibly degraded HTML.
// ---------------------------------------------------------------------------
const htmlUngranted = render(doc, { registry: { has: () => false } });
console.log(H("4. RENDER WITH NOTHING GRANTED"));
const hit = htmlUngranted.match(/<button[^>]*data-cap-missing[^>]*>/g) ?? [];
console.log(`actions rendered disabled with data-cap-missing: ${hit.length}`);
console.log(`  ${hit[0]?.slice(0, 110)}...`);

// ---------------------------------------------------------------------------
// 5. Hydrate with exactly ONE grant. The other capability stays ungranted.
// ---------------------------------------------------------------------------
const audit = [];
const runtime = hydrate(doc, {
  capabilities: {
    "deploy.approve": async (args, ctx) => {
      // In a real host this is an MCP tool call; here it mutates local state.
      const a = args ?? {};
      await new Promise((r) => setTimeout(r, 250)); // network-ish latency
      const who = typeof a.approver === "string" && a.approver !== "" ? a.approver : "anonymous";
      audit.push({
        action: "deploy.approve",
        version: ctx.state.version,
        approver: who,
        note: a.note ?? "",
        scopes: manifests.get("deploy.approve")?.scopes ?? [],
        at: new Date().toISOString(),
      });
      ctx.set({ approved: true, decision: `approved by ${who}` });
      return { ok: true };
    },
  },
});

console.log(H("5. HYDRATE: grant deploy.approve only, simulate the reviewer"));
runtime.set({ approver: "dana", note: "retry policy looks good" });
console.log(`state seeded by the host: approver=dana, note set`);

// ---------------------------------------------------------------------------
// 6. Fire the approve button: pending -> success phases, one-pass re-render.
// ---------------------------------------------------------------------------
console.log(H("6. FIRE approve (click)"));
await runtime.fire("approve", "click");
console.log(`phases after fire: ${JSON.stringify(runtime.phases())}`);
console.log(`state: approved=${runtime.state().approved}, decision="${runtime.state().decision}"`);

// ---------------------------------------------------------------------------
// 7. Try the ungranted capability: refused, nothing runs.
// ---------------------------------------------------------------------------
console.log(H("7. FIRE reject (ungranted capability)"));
try {
  await runtime.fire("reject", "click");
  console.log("UNEXPECTED: ungranted capability ran");
} catch (err) {
  if (err instanceof CapMissingError) {
    console.log(`refused: ${err.message} (${err.code})`);
    console.log("the document asked; the host said no; nothing ran");
  } else {
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 8. Final HTML: when= removed the buttons, the success region is visible.
// ---------------------------------------------------------------------------
console.log(H("8. FINAL HTML (bindings filled, buttons retired, success region shown)"));
const html = runtime.html();
const has = (needle) => html.includes(needle) ? "yes" : "no";
console.log(`  success region visible:        ${has("Deployed. The decision is recorded")}`);
console.log(`  pending region still hidden:   ${has(">Deploy in progress.") ? "no (hidden)" : "yes"}`);
console.log(`  buttons retired by when=:      ${!html.includes("Approve deploy") ? "yes" : "no"}`);
console.log(`  decision binding filled:       ${has('data-ad-bind="decision"') && html.match(/decision"[^<]*>[^<]+</) ? "yes" : "no"}`);
console.log("");
console.log(html.split("\n").filter((l) => l.includes("data-ad-bind") || l.includes("Deployed.")).join("\n"));

console.log(H("9. AUDIT TRAIL (returned by the granted capability)"));
for (const entry of audit) console.log(`  ${JSON.stringify(entry)}`);

console.log(H("DONE"));
console.log(`
The document never contained code. The host granted one capability.
Everything the document could do was knowable before any of it ran.
That is the product.`);
