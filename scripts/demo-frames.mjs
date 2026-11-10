#!/usr/bin/env node
/**
 * Generates the README demo frames: one self-contained HTML file per demo
 * state, rendered with the real engine (dist/index.js). Each frame is
 * captured as a screenshot by the docs pipeline and assembled with ffmpeg.
 *
 * Frames:
 *   1. the agent-authored document (source + canonical audit surface)
 *   2. rendered with nothing granted (data-cap-missing disabled buttons)
 *   3. host grants one capability, reviewer note seeded (state + grants)
 *   4. approve clicked, pending phase region visible
 *   5. success: bindings filled, buttons retired, audit trail recorded
 *
 * Run with:  pnpm build && node scripts/demo-frames.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  parse,
  canonicalize,
  renderReactive,
  hydrate,
} from "../dist/index.js";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "frames");
await mkdir(outDir, { recursive: true });

const source = await readFile(path.join(root, "examples/mcp-approval/approval.ad"), "utf8");
const doc = canonicalize(parse(source).doc);

// ---------------------------------------------------------------------------
// Capability host: exactly one grant, like the MCP host would wire.
// ---------------------------------------------------------------------------
const audit = [];
const grant = async (args, ctx) => {
  await new Promise((r) => setTimeout(r, 120)); // network-ish latency
  const a = args ?? {};
  const who = typeof a.approver === "string" && a.approver !== "" ? a.approver : "anonymous";
  audit.push({
    action: "deploy.approve",
    version: ctx.state.version,
    approver: who,
    note: a.note ?? "",
    scopes: ["deploy:write", "audit:write"],
    at: "2026-11-10T09:14:07Z",
  });
  ctx.set({ approved: true, decision: `approved by ${who}` });
  return { ok: true };
};

const runtime = hydrate(doc, { capabilities: { "deploy.approve": grant } });

// ---------------------------------------------------------------------------
// Frame chrome: fixed 960x560 dark layout, two panes + status strip.
// ---------------------------------------------------------------------------
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 960px; height: 560px; overflow: hidden; }
  body {
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    background: #0b0f14; color: #c9d1d9; display: flex; flex-direction: column;
  }
  .bar {
    height: 46px; flex: none; display: flex; align-items: center;
    justify-content: space-between; padding: 0 18px;
    background: #10151d; border-bottom: 1px solid #1e2733;
  }
  .brand { font-size: 15px; font-weight: 700; color: #f0f6fc; letter-spacing: 0.02em; }
  .brand b { color: #3fb950; }
  .step { font-size: 12px; color: #8b949e; }
  .step b { color: #58a6ff; }
  .body { flex: 1; display: flex; gap: 12px; padding: 12px 14px; min-height: 0; }
  .pane {
    flex: 1; display: flex; flex-direction: column; min-width: 0;
    background: #0f141b; border: 1px solid #1e2733; border-radius: 8px; overflow: hidden;
  }
  .pane h3 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: #8b949e; padding: 8px 12px; background: #10161f; border-bottom: 1px solid #1e2733;
  }
  .pane .scroll { flex: 1; overflow: hidden; padding: 10px 12px; }
  .pane code.src { display: block; font-size: 11px; line-height: 1.5; color: #adbac7; white-space: pre; }
  .pane .scroll pre { font-size: 10.5px; line-height: 1.45; color: #adbac7; white-space: pre; overflow: hidden; }
  .kv { font-size: 11px; line-height: 1.7; }
  .kv .k { color: #8b949e; }
  .kv .v { color: #f0f6fc; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 7px; border-radius: 8px; margin: 1px 2px; }
  .ok { background: #12261e; color: #3fb950; border: 1px solid #2ea04355; }
  .no { background: #2d1215; color: #f85149; border: 1px solid #f8514955; }
  .doc { font-family: -apple-system, "Segoe UI", sans-serif; font-size: 12px; color: #e6edf3; line-height: 1.5; }
  .doc h1 { font-size: 16px; margin-bottom: 6px; color: #f0f6fc; }
  .doc h2 { font-size: 13px; margin: 8px 0 4px; }
  .doc p { margin: 4px 0; }
  .doc code { font-family: inherit; font-size: 11px; background: #161e28; padding: 1px 4px; border-radius: 3px; }
  .doc table { border-collapse: collapse; margin: 6px 0; width: 100%; font-size: 11px; }
  .doc th, .doc td { border: 1px solid #263041; padding: 3px 8px; text-align: left; }
  .doc th { background: #141b25; color: #8b949e; }
  .doc button {
    font: inherit; font-size: 12px; padding: 5px 14px; margin: 3px 4px 3px 0;
    border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; cursor: pointer;
  }
  .doc button[data-ad-role=primary] { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .doc button[data-ad-role=danger] { background: #21262d; border-color: #f85149aa; color: #f85149; }
  .doc button:disabled { opacity: 0.45; cursor: not-allowed; }
  .doc [data-ad-phase-region]:not([hidden]) { display: block; margin: 6px 0; font-size: 12px; }
  .strip {
    flex: none; height: 40px; display: flex; align-items: center; justify-content: center;
    font-size: 12px; color: #8b949e; border-top: 1px solid #1e2733; background: #10151d;
  }
  .strip b { color: #f0f6fc; }
`;

function page(step, caption, leftTitle, leftHtml, docHtml) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body>
  <div class="bar">
    <span class="brand">actdown <b>/ approval.ad</b></span>
    <span class="step">step ${step}/5</span>
  </div>
  <div class="body">
    <div class="pane"><h3>${leftTitle}</h3><div class="scroll">${leftHtml}</div></div>
    <div class="pane"><h3>rendered document (host UI)</h3><div class="scroll"><div class="doc">${docHtml}</div></div></div>
  </div>
  <div class="strip">${caption}</div>
</body></html>`;
}

async function write(step, name, ...args) {
  const html = page(step, ...args);
  await writeFile(path.join(outDir, name), html, "utf8");
  console.log(`wrote frames/${name} (${html.length} bytes)`);
}

// ---------------------------------------------------------------------------
// Frame 1: the document an agent wrote (pure text, no bundle).
// ---------------------------------------------------------------------------
const sourceLines = source.split("\n");
write(
  1,
  "frame-1.html",
  "the agent-authored document &mdash; <b>pure text</b>",
  "the document (source)",
  `<code class="src">${esc(sourceLines.slice(0, 34).join("\n"))}</code>`,
  `<p><em>Everything the document can do is visible before anything runs.</em></p>
   <div style="margin-top:10px" class="kv">
     <div><span class="k">format</span> <span class="v">actdown 0.1</span></div>
     <div><span class="k">scripts</span> <span class="v">none &mdash; there is no script syntax</span></div>
     <div><span class="k">review</span> <span class="v">a diff</span></div>
     <div style="margin-top:8px"><span class="k">declares</span> <span class="v">2 manifests, 2 actions, 3 phase regions</span></div>
   </div>`,
);

// ---------------------------------------------------------------------------
// Frame 2: static audit surface + render with nothing granted.
// ---------------------------------------------------------------------------
const htmlUngranted = renderReactive(doc, { registry: { has: () => false } });
const capHits = [...htmlUngranted.matchAll(/data-cap-missing/g)].length;
write(
  2,
  "frame-2.html",
  "static audit &mdash; render with <b>nothing granted</b>",
  "audit surface",
  `<pre>diagnostics: none
capabilities named:
  deploy.approve  declared: scopes
                    ["deploy:write","audit:write"]
  deploy.reject   declared: scopes
                    ["audit:write"]
events: click (both actions)
network / storage / DOM access: none
(no script equivalent exists)

granted capabilities: <span class="no">none</span>
actions rendered disabled
with data-cap-missing: ${capHits}</pre>`,
  htmlUngranted,
);

// ---------------------------------------------------------------------------
// Frame 3: one grant + reviewer state seeded by the host.
// ---------------------------------------------------------------------------
runtime.set({ approver: "dana", note: "retry policy looks good" });
const htmlGranted = runtime.html();
write(
  3,
  "frame-3.html",
  "host grants <b>deploy.approve</b> only &mdash; reviewer state seeded",
  "grants + host state",
  `<pre>host grants (capability map):
  <span class="ok">deploy.approve</span>   <span class="ok">GRANTED</span>
  deploy.reject              <span class="no">refused</span>

host-seeded state:
  approver: <span class="v">"dana"</span>
  note:     <span class="v">"retry policy looks good"</span></pre>`,
  htmlGranted,
);

// ---------------------------------------------------------------------------
// Frame 4: fire approve; snapshot while the capability promise is pending.
// ---------------------------------------------------------------------------
const fired = runtime.fire("approve", "click");
const htmlPending = runtime.html();
write(
  4,
  "frame-4.html",
  "<b>Approve clicked</b> &mdash; pending phase region shown",
  "runtime",
  `<pre>runtime.fire("approve", "click")

capability deploy.approve:
  <span class="badge ok">running&hellip;</span> awaiting host
  tool call (async)

phase map:
  { approve: "pending" }</pre>`,
  htmlPending,
);

// ---------------------------------------------------------------------------
// Frame 5: settled. Bindings filled, buttons retired, audit trail recorded.
// ---------------------------------------------------------------------------
await fired;
const htmlFinal = runtime.html();
const auditLines = audit
  .map((e) => JSON.stringify(e))
  .map((l) => l.replace(/</g, "&lt;"))
  .join("\n");
write(
  5,
  "frame-5.html",
  "success &mdash; bindings filled, buttons retired, audit recorded",
  "phases + audit trail",
  `<pre>phases: { approve: <span class="ok">"success"</span> }
state: approved=true, decision="approved by dana"

audit trail (returned by the granted capability):
<span class="v">${auditLines}</span>

ungranted reject fires refused:
  CapMissingError: E_CAP_MISSING &mdash; nothing ran</pre>`,
  htmlFinal,
);

console.log("done");
