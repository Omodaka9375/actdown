/**
 * html2ad: legacy HTML to canonical ad (SPEC 12, DOW-1..4).
 *
 * Lossy in presentation, lossless in meaning: presentational nodes collapse
 * into prose, semantic elements become blocks with roles, script/style and
 * event handlers are dropped (handlers recorded as x-legacy-handler for
 * audit), and form actions become x-legacy:<source>#<form-id> capabilities.
 */
import { canonicalize, print } from "./canonical.js";
import { isInline, parseHtml, textOf, type HtmlNode } from "./htmlparse.js";
import type { BlockNode, Doc, Node } from "./types.js";

export interface Html2AdOptions {
  /** Original path of the page, used for x-legacy capability names (DOW-4). */
  source?: string;
}

const BLOCK_CONTAINER = new Set([
  "html", "body", "div", "section", "article", "main", "header", "footer",
  "nav", "aside", "figure", "figcaption", "details", "summary", "dialog",
  "fieldset", "address",
]);

function block(
  type: string,
  fields: Record<string, unknown>,
  attrs: Record<string, string>,
  body: string | null,
  role?: string,
): BlockNode {
  return {
    kind: "block",
    type,
    id: "",
    ...(role !== undefined ? { role } : {}),
    attrs,
    fields: fields as BlockNode["fields"],
    body,
    line: 0,
  };
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Escape characters that markdown would treat as syntax. */
function mdEscape(s: string): string {
  return s.replace(/([\\`*_\[\]])/g, "\\$1");
}

/** A URL inside markdown `(...)` must not close the link early. */
function mdUrl(u: string): string {
  return u.replace(/[()\\]/g, (c) => (c === "\\" ? "\\\\" : `\\${c}`));
}

/** Inline code as a CommonMark code span: backtick-safe. */
function mdCodeSpan(text: string): string {
  if (!text.includes("`")) return `\`${text}\``;
  // A double-backtick delimiter can hold single backticks; CommonMark pads
  // with spaces when the content touches the delimiters.
  return `\`\` ${text} \`\``;
}

/** Render an inline subtree as markdown (exported for tests/debug). */
export function inlineMd(node: HtmlNode): string {
  let out = "";
  for (const c of node.children) {
    if (typeof c === "string") {
      out += mdEscape(textOf({ tag: "#t", attrs: {}, children: [c] }).replace(/\s+/g, " "));
    } else {
      out += inlineSelf(c);
    }
  }
  return out;
}

/** Markdown for one inline element, including its own wrapper. */
function inlineSelf(el: HtmlNode): string {
  switch (el.tag) {
    case "br":
      return "\n";
    case "strong":
    case "b":
      return `**${inlineMd(el).trim()}**`;
    case "em":
    case "i":
      return `*${inlineMd(el).trim()}*`;
    case "code":
    case "kbd":
    case "samp":
    case "var":
      return mdCodeSpan(textOf(el).trim());
    case "a": {
      const href = el.attrs.href;
      return href === undefined ? inlineMd(el) : `[${inlineMd(el).trim()}](${mdUrl(href)})`;
    }
    case "img":
      // alt is raw markup input: escape it so untrusted HTML cannot inject
      // markdown (a `]` would close the label, a fence line could swallow
      // following blocks on re-parse).
      return `![${mdEscape(el.attrs.alt ?? "")}](${mdUrl(el.attrs.src ?? "")})`;
    default:
      return inlineMd(el);
  }
}

/** Inline content of an <li>, excluding nested lists (those repeat below). */
function liLabel(li: HtmlNode): string {
  const parts = li.children
    .filter((c) => typeof c === "string" || (c.tag !== "ul" && c.tag !== "ol"))
    .map((c) =>
      typeof c === "string"
        ? mdEscape(textOf({ tag: "#t", attrs: {}, children: [c] }).replace(/\s+/g, " "))
        : inlineMd(c),
    );
  return parts.join("").replace(/\s+/g, " ").trim();
}

export interface Conversion {
  doc: Doc;
  /** Audit notes: dropped or recorded legacy behavior (DOW-2). */
  notes: string[];
}

export function htmlToDoc(html: string, opts: Html2AdOptions = {}): Conversion {
  const root = parseHtml(html);
  const nodes: Node[] = [];
  const prose: string[] = [];
  const notes: string[] = [];
  const source = opts.source ?? "unknown";
  let inlineBuf: string[] = [];

  const flush = () => {
    const md = prose.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    if (md !== "") nodes.push({ kind: "prose", md });
    prose.length = 0;
  };
  const flushInline = () => {
    const md = inlineBuf.join("").replace(/[ \t]+\n/g, "\n").trim();
    if (md !== "") prose.push(md);
    inlineBuf = [];
  };
  const pushProse = (md: string) => {
    if (md.trim() !== "") prose.push(md);
  };
  const pushInline = (md: string) => {
    if (md !== "") inlineBuf.push(md);
  };
  const pushBlock = (b: BlockNode) => {
    flushInline();
    flush();
    nodes.push(b);
  };

  const walk = (node: HtmlNode, listDepth: number): void => {
    for (const child of node.children) {
      if (typeof child === "string") {
        const text = textOf({ tag: "#t", attrs: {}, children: [child] }).replace(/\s+/g, " ");
        if (text.trim() !== "") pushInline(text);
        continue;
      }
      convert(child, listDepth);
    }
  };

  const listLines = (list: HtmlNode, depth: number): string[] => {
    const indent = "  ".repeat(depth);
    const marker = list.tag === "ol" ? "1." : "-";
    const out: string[] = [];
    for (const c of list.children) {
      if (typeof c === "string" || c.tag !== "li") continue;
      out.push(`${indent}${marker} ${liLabel(c)}`);
      for (const n of c.children) {
        if (typeof n !== "string" && (n.tag === "ul" || n.tag === "ol")) {
          out.push(...listLines(n, depth + 1));
        }
      }
    }
    return out;
  };

  const convert = (el: HtmlNode, listDepth: number): void => {
    const { tag, attrs } = el;

    if (tag === "br") {
      pushInline("\n");
      return;
    }
    // DOW-1: inline content flows into the current paragraph.
    // (Except <a>: with href it is an ad-link block, handled below.)
    if (isInline(tag) && tag !== "a") {
      pushInline(inlineSelf(el));
      return;
    }
    // DOW-2: script/style never reach the AST (raw content already skipped).
    if (tag === "script" || tag === "style" || tag === "title") return;

    flushInline();

    if (tag === "hr") {
      pushProse("---");
    } else if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      pushProse("#".repeat(level) + " " + inlineMd(el).replace(/\s+/g, " ").trim());
    } else if (tag === "ul" || tag === "ol") {
      pushProse(listLines(el, listDepth).join("\n"));
    } else if (tag === "pre") {
      const code = el.children.find((c): c is HtmlNode => typeof c !== "string" && c.tag === "code");
      const cls = (code?.attrs.class ?? "").match(/(?:language|lang)-([a-zA-Z0-9+#-]+)/);
      const body = textOf(code ?? el).replace(/\n$/, "");
      // Canonical output must be re-parse-safe (INV-3): a ``` line inside
      // <pre> would close the fence early and leak body lines as live
      // blocks. Emit the fence one longer than the longest body run.
      const maxRun = Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
      const fenceMark = "`".repeat(maxRun + 1);
      pushProse(fenceMark + (cls?.[1] ?? "") + "\n" + body + "\n" + fenceMark);
    } else if (tag === "blockquote") {
      pushProse(
        inlineMd(el)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "")
          .map((l) => "> " + l)
          .join("\n"),
      );
    } else if (tag === "table") {
      pushBlock(tableBlock(el));
    } else if (tag === "img") {
      const fields: Record<string, unknown> = { src: attrs.src ?? "", alt: attrs.alt ?? "" };
      if (attrs.width !== undefined && /^\d+$/.test(attrs.width)) fields.width = Number(attrs.width);
      if (attrs.height !== undefined && /^\d+$/.test(attrs.height)) fields.height = Number(attrs.height);
      const b = block("image", fields, {}, null, "image");
      b.id = slug(attrs.id ?? "");
      pushBlock(b);
    } else if (tag === "a") {
      if (attrs.href === undefined) {
        pushInline(inlineMd(el)); // named anchor: collapse to text
      } else {
        const b = block("link", { href: attrs.href }, {}, inlineMd(el).replace(/\s+/g, " ").trim(), "link");
        b.id = slug(attrs.id ?? "");
        pushBlock(b);
      }
    } else if (tag === "button") {
      pushBlock(buttonBlock(el));
    } else if (tag === "form") {
      pushBlock(formBlock(el, source, notes));
    } else if (BLOCK_CONTAINER.has(tag) || tag === "p") {
      // DOW-1: presentational wrappers collapse; children flow into prose.
      walk(el, listDepth);
    } else {
      // Unknown tags: recurse (their children still convert).
      walk(el, listDepth);
    }

    flushInline();
  };

  walk(root, 0);
  flushInline();
  flush();
  return { doc: { ad: "0.1", nodes }, notes };
}

function tableBlock(el: HtmlNode): BlockNode {
  const rowsOf = (section: HtmlNode | undefined): string[][] =>
    section === undefined
      ? []
      : section.children
          .filter((c): c is HtmlNode => typeof c !== "string" && c.tag === "tr")
          .map((tr) =>
            tr.children
              .filter((c): c is HtmlNode => typeof c !== "string" && (c.tag === "td" || c.tag === "th"))
              .map((cell) => inlineMd(cell).replace(/\s+/g, " ").trim()),
          );
  const section = (name: string) =>
    el.children.find((c): c is HtmlNode => typeof c !== "string" && c.tag === name);

  const headRows = rowsOf(section("thead"));
  let bodyRows = rowsOf(section("tbody"));
  if (headRows.length === 0 && bodyRows.length === 0) {
    bodyRows = rowsOf(el);
  }
  const header = headRows[0] ?? bodyRows[0] ?? null;
  const rest = headRows.length > 0 ? bodyRows : bodyRows.slice(1);
  const lines: string[] = [];
  if (header !== null && header.length > 0) {
    lines.push(`| ${header.join(" | ")} |`);
    lines.push(`| ${header.map(() => "---").join(" | ")} |`);
    for (const r of rest) lines.push(`| ${r.join(" | ")} |`);
  }
  return block("table", {}, {}, lines.length > 0 ? lines.join("\n") : null, "table");
}

function legacyHandler(el: HtmlNode): string | null {
  for (const [k, v] of Object.entries(el.attrs)) {
    if (/^on[a-z]+$/.test(k) && v.trim() !== "") return v;
  }
  return null;
}

function buttonBlock(el: HtmlNode): BlockNode {
  const attrs: Record<string, string> = {};
  const handler = legacyHandler(el);
  if (handler !== null) {
    attrs.name = "x-legacy:button";
    attrs["x-legacy-handler"] = handler;
  }
  if (el.attrs.disabled !== undefined) attrs["x-legacy-disabled"] = "";
  return block("action", {}, attrs, inlineMd(el).replace(/\s+/g, " ").trim(), "button");
}

function formBlock(form: HtmlNode, source: string, notes: string[]): BlockNode {
  const fields: Record<string, unknown> = {};
  const collect = (node: HtmlNode): void => {
    for (const c of node.children) {
      if (typeof c === "string") continue;
      if (c.tag === "form") continue;
      collect(c);
      if (c.tag === "input" || c.tag === "textarea" || c.tag === "select") {
        addControl(c, fields, notes);
      } else if (c.tag === "button") {
        const type = (c.attrs.type ?? "submit").toLowerCase();
        if (type === "submit") {
          const label = textOf(c).trim() || "Submit";
          const key = slug(label) || "submit";
          if (!(key in fields)) fields[key] = `submit(label=${JSON.stringify(label)})`;
        }
      }
    }
  };
  collect(form);

  const fid = form.attrs.id ?? "";
  const attrs: Record<string, string> = {
    action: `x-legacy:${source}#${fid || "form"}`,
  };
  const handler = legacyHandler(form);
  if (handler !== null) attrs["x-legacy-handler"] = handler;
  const b = block("form", fields, attrs, null, "form");
  b.id = slug(fid) || "form";
  return b;
}

function addControl(
  el: HtmlNode,
  fields: Record<string, unknown>,
  notes: string[],
): void {
  const name = el.attrs.name ?? el.attrs.id ?? "";
  if (name === "") {
    notes.push(`control without name dropped: <${el.tag}>`);
    return;
  }
  const key = slug(name) || name;
  if (key in fields) return;
  const req = el.attrs.required !== undefined ? ", required" : "";
  const max = el.attrs.maxlength !== undefined ? `, maxlength=${el.attrs.maxlength}` : "";
  if (el.tag === "input") {
    const type = (el.attrs.type ?? "text").toLowerCase();
    fields[key] = type === "checkbox" || type === "radio" ? "checkbox" : `input(${type}${req}${max})`;
  } else if (el.tag === "textarea") {
    fields[key] = max === "" ? "textarea" : `textarea(maxlength=${el.attrs.maxlength})`;
  } else if (el.tag === "select") {
    const options = el.children
      .filter((c): c is HtmlNode => typeof c !== "string" && c.tag === "option")
      .map((o) => o.attrs.value ?? textOf(o).trim());
    fields[key] = `select(options=${JSON.stringify(options)})`;
  }
}

/** Convert legacy HTML to canonical ad text (DOW-3). */
export function html2ad(html: string, opts: Html2AdOptions = {}): string {
  const { doc } = htmlToDoc(html, opts);
  return print(canonicalize(doc));
}
