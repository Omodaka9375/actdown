import { display, evalExpr } from "./expr.js";
import { printLiteral } from "./literal.js";
import type { AttrValue, BlockNode, Doc, Expr, ForeignNode, Literal, Node } from "./types.js";

/** Names visible to `{expr}` bindings while rendering (SPEC 5). */
export type Scope = Record<string, Literal>;

/** SPEC 4.2/7: a registry of capabilities granted to the runtime. */
export interface CapabilityRegistry {
  has(name: string): boolean;
}

export interface RenderOptions {
  /** Missing capabilities render disabled with `data-cap-missing` (SPEC 4.2). */
  registry?: CapabilityRegistry;
  /** Prose renderer override (default: the minimal markdown renderer below). */
  markdown?: (md: string) => string;
  /**
   * Async phase per action id (level 3): `"pending" | "success" | "failure"`.
   * Static render (no phases) shows every phase region `hidden` so the HTML is
   * complete without JS; a matching entry unhides its region.
   */
  phases?: Record<string, string>;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  // Escape both quote types: several attributes below are built by string
  // interpolation, so a stray quote must never break out of the attribute.
  return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * A link URL is inert only when it is relative or uses http(s)/mailto/tel.
 * Everything else (javascript:, data:, vbscript:) is replaced with "#" so a
 * converted page cannot carry a live script URL (SEC: untrusted content).
 */
export function safeUrl(u: string): string {
  // Browsers strip tab/newline from URL attributes, so `jav\tascript:` would
  // pass the scheme check below and still become a live script URL. Strip
  // them before the scheme checks.
  const t = u.replace(/[\t\n\r]/g, "").trim();
  if (/^https?:\/\//i.test(t) || /^mailto:/i.test(t) || /^tel:/i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return "#";
  return t;
}

/**
 * SPEC 5/Appendix A: `{expr}` bindings become data-ad-bind spans. Without an
 * env (level-1 render) the span is empty; with one the current value is
 * rendered inside for hydration. A binding that fails to evaluate renders as
 * an empty span: a render error affects one node, never the document.
 * Literal segments are escaped here, so the result is safe HTML.
 */
function bind(s: string, env?: Scope): string {
  let out = "";
  let rest = s;
  for (;;) {
    const m = /(^|[^\\])\{([^{}]+)\}/.exec(rest);
    if (m === null) return out + esc(rest);
    out += esc(rest.slice(0, m.index)) + esc(m[1]!);
    const raw = m[2]!.trim();
    let val = "";
    if (env !== undefined) {
      try {
        val = display(evalExpr(raw, { scope: env }));
      } catch {
        val = "";
      }
    }
    out += `<span data-ad-bind="${escAttr(raw)}">${esc(val)}</span>`;
    rest = rest.slice(m.index + m[0].length);
  }
}

function attr(v: AttrValue): string {
  return typeof v === "string" ? v : `{${v.raw}}`;
}

function dataAttrs(b: BlockNode): string {
  const parts = [`data-ad-id="${escAttr(b.id)}"`];
  if (b.role !== undefined) parts.push(`role="${escAttr(b.role)}"`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Prose: a minimal CommonMark-subset renderer (headings, lists, fences,
// blockquotes, GFM pipe tables, paragraphs, inline emphasis/code/links). SPEC
// 11 allows the implementation to plug any markdown renderer in via
// RenderOptions.
// ---------------------------------------------------------------------------

/** One row of a GFM pipe table: strip the optional edge pipes, split, trim. */
function splitRow(s: string): string[] {
  const t = s.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

/** A delimiter row: `|---|:---:|` style; every cell is `:?-+:?`. */
function isDelimRow(s: string): boolean {
  if (!s.includes("|")) return false;
  const cells = splitRow(s);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function proseTable(header: string[], rows: string[][], env?: Scope): string {
  const ths = header.map((c) => `<th>${inline(c, env)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${inline(c, env)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table>\n<thead><tr>${ths}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function inline(s: string, env?: Scope): string {
  let out = bind(s, env);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => `<a href="${escAttr(safeUrl(href))}">${text}</a>`);
  return out;
}

export function renderMarkdown(md: string, env?: Scope): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: { lang: string; lines: string[]; ch: string; len: number } | null = null;

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map((p) => inline(p, env)).join("<br>\n")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list === null) return;
    const tag = list.ordered ? "ol" : "ul";
    out.push(`<${tag}>\n${list.items.map((i) => `<li>${inline(i, env)}</li>`).join("\n")}\n</${tag}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    const cf = /^(`{3,}|~{3,})[ \t]*(\S*)/.exec(ln);
    if (fence === null && cf) {
      flushPara();
      flushList();
      fence = { lang: cf[2]!, lines: [], ch: cf[1]![0]!, len: cf[1]!.length };
      continue;
    }
    if (fence !== null) {
      // CommonMark: the closing fence must be the same character and at
      // least as long as the opening one.
      if (cf && cf[1]![0] === fence.ch && cf[1]!.length >= fence.len) {
        const lang = fence.lang === "" ? "" : ` class="language-${escAttr(fence.lang)}"`;
        out.push(`<pre><code${lang}>${esc(fence.lines.join("\n"))}</code></pre>`);
        fence = null;
      } else {
        fence.lines.push(ln);
      }
      continue;
    }
    // GFM pipe table: a row followed by a delimiter row; body rows continue
    // until a line without a pipe (blank or paragraph text ends the table).
    if (ln.includes("|") && i + 1 < lines.length && isDelimRow(lines[i + 1]!)) {
      flushPara();
      flushList();
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.trim() !== "" && lines[j]!.includes("|")) {
        rows.push(splitRow(lines[j]!));
        j++;
      }
      i = j - 1;
      out.push(proseTable(splitRow(ln), rows, env));
      continue;
    }
    const h = /^(#{1,6})[ \t]+(.*)$/.exec(ln);
    if (h) {
      flushPara();
      flushList();
      const n = h[1]!.length;
      out.push(`<h${n}>${inline(h[2]!, env)}</h${n}>`);
      continue;
    }
    const ul = /^[*+-][ \t]+(.*)$/.exec(ln);
    if (ul) {
      flushPara();
      if (list === null || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(ul[1]!);
      continue;
    }
    const ol = /^\d+[.)][ \t]+(.*)$/.exec(ln);
    if (ol) {
      flushPara();
      if (list === null || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ol[1]!);
      continue;
    }
    if (/^>[ \t]?(.*)$/.test(ln)) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(ln.replace(/^>[ \t]?/, ""), env)}</blockquote>`);
      continue;
    }
    if (/^\s*$/.test(ln)) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(ln);
  }
  if (fence !== null) out.push(`<pre><code>${esc(fence.lines.join("\n"))}</code></pre>`);
  flushPara();
  flushList();
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Blocks (Appendix A)
// ---------------------------------------------------------------------------

function renderControls(b: BlockNode): string {
  const fid = escAttr(b.id);
  const out: string[] = [];
  for (const [name, v] of Object.entries(b.fields)) {
    if (typeof v !== "string") continue;
    const m = /^([a-z]+)\((.*)\)$/.exec(v.trim());
    const kind = m === null ? v.trim() : m[1]!;
    const opts = parseOpts(m === null ? "" : m[2]!);
    const id = `${fid}.${escAttr(name)}`;
    const req = opts.has("required") ? " required" : "";
    switch (kind) {
      case "input": {
        const type = opts.get("type") ?? (m === null ? "text" : m[2]!.split(",")[0]!.trim() || "text");
        out.push(`<input type="${escAttr(type)}" name="${escAttr(name)}" id="${id}"${req}>`);
        break;
      }
      case "textarea":
        out.push(`<textarea name="${escAttr(name)}" id="${id}"${req}></textarea>`);
        break;
      case "select": {
        const raw = opts.get("options") ?? "[]";
        const items: string[] = safeJsonArray(raw);
        const body = items.map((o) => `<option>${esc(o)}</option>`).join("");
        out.push(`<select name="${escAttr(name)}" id="${id}"${req}>${body}</select>`);
        break;
      }
      case "checkbox":
        out.push(`<input type="checkbox" name="${escAttr(name)}" id="${id}">`);
        break;
      case "submit": {
        const label = (opts.get("label") ?? "Submit").replace(/^"(.*)"$/, "$1");
        out.push(`<button type="submit" id="${id}">${esc(label)}</button>`);
        break;
      }
      default:
        break;
    }
  }
  return out.join("\n");
}

function parseOpts(s: string): Map<string, string> {
  const map = new Map<string, string>();
  if (s.trim() === "") return map;
  for (const part of s.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) map.set(part.trim(), "");
    else map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return map;
}

function safeJsonArray(s: string): string[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function renderAction(b: BlockNode, opts: RenderOptions, env?: Scope): string {
  const cap = b.attrs.name === undefined ? "" : attr(b.attrs.name);
  const known = cap === "" || (opts.registry?.has(cap) ?? true);
  const missing = known ? "" : " data-cap-missing";
  const disabled = known ? "" : " disabled";
  const label = bind(b.body ?? "", env);
  if (b.attrs.href !== undefined) {
    return `<a href="${escAttr(safeUrl(attr(b.attrs.href)))}" ${dataAttrs(b)}${missing}>${label}</a>`;
  }
  return `<button ${dataAttrs(b)}${missing}${disabled}>${label}</button>`;
}

function renderTable(b: BlockNode, env?: Scope): string {
  const rows: string[][] = [];
  for (const ln of (b.body ?? "").split("\n")) {
    const t = ln.trim();
    if (t === "" || /^\|?[ \t]*:?-{2,}/.test(t)) continue;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    rows.push(cells);
  }
  if (rows.length === 0) return `<table ${dataAttrs(b)}></table>`;
  const [head, ...rest] = rows;
  const cell = (c: string, tag: string) => `<${tag}>${inline(c, env)}</${tag}>`;
  const body = rest
    .map((r) => `<tr>${r.map((c) => cell(c, "td")).join("")}</tr>`)
    .join("\n");
  return `<table ${dataAttrs(b)}>\n<thead><tr>${head!.map((c) => cell(c, "th")).join("")}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

const isExprVal = (v: Literal | Expr): v is Expr =>
  v !== null && typeof v === "object" && "kind" in v && (v as Expr).kind === "expr";

/**
 * One cell of a chart fallback table: strings pass through inline(), other
 * literals render via display(), expressions evaluate in the binding scope
 * (empty like any binding when there is no env) and never throw past one cell.
 */
function chartCell(v: Literal | Expr, env?: Scope): string {
  if (isExprVal(v)) {
    if (env === undefined) return "";
    try {
      return inline(display(evalExpr(v.raw, { scope: env })), env);
    } catch {
      return "";
    }
  }
  return inline(display(v), env);
}

/**
 * SPEC Appendix A: an ad-chart renders `<figure data-ad-chart="type">` with a
 * `<table>` fallback of the data. Accepted shapes for the `data` field:
 * array of arrays (rows; `columns` field names them), array of objects
 * (first-seen key order is the header), or a flat array of scalars (one
 * column). Mixed or empty shapes render no table: the figure stays empty and
 * the AST is still the contract.
 */
function chartTable(
  data: Literal | Expr | undefined,
  columns: Literal | Expr | undefined,
  env?: Scope,
): string {
  if (data === undefined || !Array.isArray(data) || data.length === 0) return "";
  const arr: Literal[] = data;
  let header: string[] | null = null;
  let rows: string[][];
  if (arr.every((r) => Array.isArray(r))) {
    rows = (arr as Literal[][]).map((r) => r.map((c) => chartCell(c, env)));
    if (Array.isArray(columns) && columns.every((c) => typeof c === "string")) {
      header = columns as string[];
    }
  } else if (arr.every((r) => r !== null && typeof r === "object" && !Array.isArray(r) && !isExprVal(r as Literal))) {
    const keys: string[] = [];
    for (const r of arr as Record<string, Literal>[]) {
      for (const k of Object.keys(r)) {
        if (!keys.includes(k)) keys.push(k);
      }
    }
    header = keys;
    rows = (arr as Record<string, Literal>[]).map((r) => keys.map((k) => chartCell(r[k] ?? "", env)));
  } else if (arr.every((r) => r === null || typeof r === "string" || typeof r === "number" || typeof r === "boolean")) {
    rows = (arr as Literal[]).map((v) => [chartCell(v, env)]);
  } else {
    return ""; // mixed shapes: no deterministic fallback
  }
  const tbody = `<tbody>\n${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n")}\n</tbody>`;
  if (header === null) return `<table>\n${tbody}\n</table>`;
  const thead = `<thead><tr>${header.map((c) => `<th>${inline(c, env)}</th>`).join("")}</tr></thead>`;
  return `<table>\n${thead}\n${tbody}\n</table>`;
}

function renderChart(b: BlockNode, env?: Scope): string {
  const type = b.fields.type === undefined ? "" : escAttr(printLiteral(b.fields.type));
  const table = chartTable(b.fields.data, b.fields.columns, env);
  return `<figure ${dataAttrs(b)} data-ad-chart="${type}">${table === "" ? "" : `\n${table}\n`}</figure>`;
}

/**
 * ad-list (SPEC 3 level 1): an `items` field (array of literals) or body
 * lines (markdown list markers stripped) render as `<ul>`/`<ol>`. Ordered
 * when every body line uses `N.` / `N)` markers, or via `ordered: true`.
 */
function renderListBlock(b: BlockNode, env?: Scope): string {
  let items: string[] = [];
  let ordered = b.fields.ordered === true;
  const it = b.fields.items;
  if (it !== undefined && Array.isArray(it)) {
    items = (it as Literal[]).map((v) => chartCell(v, env));
  } else if (b.body !== null && b.body.trim() !== "") {
    const lines = b.body.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const ulRe = /^[*+-][ \t]+/;
    const olRe = /^\d+[.)][ \t]+/;
    let allOl = lines.length > 0;
    items = lines.map((l) => {
      if (olRe.test(l)) return l.replace(olRe, "");
      allOl = false;
      if (ulRe.test(l)) return l.replace(ulRe, "");
      return l;
    });
    if (lines.length > 0) ordered = allOl;
  }
  const tag = ordered ? "ol" : "ul";
  if (items.length === 0) return `<${tag} ${dataAttrs(b)}></${tag}>`;
  return `<${tag} ${dataAttrs(b)}>\n${items.map((i) => `<li>${i}</li>`).join("\n")}\n</${tag}>`;
}

function renderDataBlock(b: BlockNode): string {
  const json = JSON.stringify(b.fields);
  return `<script type="application/x-ad-data" ${dataAttrs(b)}>${esc(json)}</script>`;
}

export function renderBlock(b: BlockNode, opts: RenderOptions, env?: Scope): string {
  switch (b.type) {
    case "state":
    case "data":
      return renderDataBlock(b);
    case "text":
      return bind(b.fields.body === undefined ? "" : printLiteral(b.fields.body), env);
    case "action":
      return renderAction(b, opts, env);
    case "form":
      return `<form ${dataAttrs(b)}>\n${renderControls(b)}\n</form>`;
    case "image": {
      const dim = (k: string) =>
        b.fields[k] === undefined || typeof b.fields[k] !== "number"
          ? ""
          : ` ${k}="${b.fields[k]}"`;
      const src = b.fields.src === undefined ? "" : escAttr(safeUrl(printLiteral(b.fields.src)));
      const alt = b.fields.alt === undefined ? "" : escAttr(printLiteral(b.fields.alt));
      return `<img src="${src}" alt="${alt}"${dim("width")}${dim("height")}>`;
    }
    case "link":
      const href = b.fields.href === undefined ? "" : printLiteral(b.fields.href);
      return `<a href="${escAttr(safeUrl(href))}" ${dataAttrs(b)}>${bind(b.body ?? "", env)}</a>`;
    case "table":
      return renderTable(b, env);
    case "chart":
      return renderChart(b, env);
    case "list":
      return renderListBlock(b, env);
    case "include":
    case "manifest":
    case "field":
    case "region":
    default: {
      const json = JSON.stringify(b.fields);
      const phase = b.fields.phase;
      const forId = typeof b.fields.for === "string" ? b.fields.for : "";
      const asyncAttrs =
        typeof phase === "string"
          ? ` data-ad-for="${escAttr(forId)}" data-ad-phase="${escAttr(phase)}"${opts.phases?.[forId] === phase ? "" : " hidden"}`
          : "";
      return `<section data-ad-type="${escAttr(b.type)}" ${dataAttrs(b)}${asyncAttrs} data-ad-fields="${escAttr(json)}">${bind(b.body ?? "", env)}</section>`;
    }
  }
}

function isForeign(n: Node): n is ForeignNode {
  return n.kind === "block" && "foreign" in n && n.foreign === true;
}

/** Render one node with an optional binding scope (used by react.ts). */
export function renderNode(n: Node, opts: RenderOptions, env?: Scope): string {
  if (n.kind === "prose") return (opts.markdown ?? renderMarkdown)(n.md, env);
  if (isForeign(n)) return `<pre><code>${esc(n.raw)}</code></pre>`;
  return renderBlock(n, opts, env);
}

/** Render a document to level-1 HTML (SPEC 11, Appendix A). */
export function render(doc: Doc, opts: RenderOptions = {}): string {
  return doc.nodes.map((n) => renderNode(n, opts)).join("\n");
}
