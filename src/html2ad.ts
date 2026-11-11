/**
 * html2ad: legacy HTML to canonical ad (SPEC 12, DOW-1..4).
 *
 * Lossy in presentation and semantic meaning: presentational nodes collapse
 * into prose, semantic elements become blocks with roles, script/style and
 * event handlers are dropped (handlers recorded as x-legacy-handler for
 * audit), and form actions become x-legacy:<source>#<form-id> capabilities.
 */
import { canonicalize, print } from "./canonical.js";
import { decodeEntities, isInline, parseHtml, textOf, type HtmlNode } from "./htmlparse.js";
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

/**
 * Hidden-content policy (anti cloaking / invisible-text injection). An
 * element the author marked invisible must not reach the agent as visible
 * prose: text smuggled via `display:none`, `aria-hidden`, or the `hidden`
 * attribute is a classic prompt-injection carrier (human sees nothing, the
 * scraper reads it). Dropped elements are counted and reported as ONE
 * aggregate audit note - never with a text preview, which would leak the
 * smuggled content back into the agent's context.
 *
 * Detected: the `hidden` attribute, `aria-hidden="true"`, `template`
 * (inert by definition), and inline styles `display:none`,
 * `visibility:hidden`, `content-visibility:hidden`, `opacity:0`,
 * `font-size:0`, negative `text-indent`. NOT detected (needs rendered
 * layout): colors equal to the background, off-screen positioning, site
 * CSS classes like `sr-only`. A page can still hide text from this check.
 */
function isHidden(el: HtmlNode): boolean {
  if (el.tag === "template") return true;
  if (Object.hasOwn(el.attrs, "hidden")) return true;
  if (el.attrs["aria-hidden"] === "true") return true;
  const style = el.attrs.style;
  if (style === undefined) return false;
  // CSS comments do not change declarations; strip them before matching.
  const css = style.replace(/\/\*[\s\S]*?\*\//g, "");
  return /(?:^|;)\s*(?:display|visibility|content-visibility)\s*:\s*(?:none|hidden)(?:\s*!important)?(?:\s*;|$)/i.test(css) ||
    /(?:^|;)\s*(?:opacity|font-size)\s*:\s*0(?:\.0+)?(?:[a-z%]+)?(?:\s*!important)?(?:\s*;|$)/i.test(css) ||
    /(?:^|;)\s*text-indent\s*:\s*-\d/i.test(css);
}

/**
 * Dropped hidden-element count for the conversion in progress. Safe as
 * module state because htmlToDoc is fully synchronous: the count is reset
 * at entry and consumed before returning, so interleaved calls cannot
 * corrupt it.
 */
let hiddenDropped = 0;

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

/** Inline markdown of a subtree with author-hidden elements dropped. */
function inlineMdVisible(node: HtmlNode): string {
  let out = "";
  for (const c of node.children) {
    if (typeof c === "string") {
      out += mdEscape(textOf({ tag: "#t", attrs: {}, children: [c] }).replace(/\s+/g, " "));
    } else if (isHidden(c)) {
      hiddenDropped += 1;
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
      return `**${inlineMdVisible(el).trim()}**`;
    case "em":
    case "i":
      return `*${inlineMdVisible(el).trim()}*`;
    case "code":
    case "kbd":
    case "samp":
    case "var":
      return mdCodeSpan(visibleTextOf(el).trim());
    case "a": {
      const href = el.attrs.href;
      return href === undefined ? inlineMdVisible(el) : `[${inlineMdVisible(el).trim()}](${mdUrl(href)})`;
    }
    case "img":
      // alt is raw markup input: escape it so untrusted HTML cannot inject
      // markdown (a `]` would close the label, a fence line could swallow
      // following blocks on re-parse).
      return `![${mdEscape(el.attrs.alt ?? "")}](${mdUrl(el.attrs.src ?? "")})`;
    default:
      // Generic inline containers (span, label, ...): recurse visibly so
      // hidden children are dropped here too.
      return inlineMdVisible(el);
  }
}

/** Inline content of an <li>, excluding nested lists (those repeat below). */
function liLabel(li: HtmlNode): string {
  const parts = li.children
    .filter((c) => {
      if (typeof c === "string") return true;
      if (c.tag === "ul" || c.tag === "ol") return false;
      if (isHidden(c)) {
        hiddenDropped += 1;
        return false;
      }
      return true;
    })
    .map((c) =>
      typeof c === "string"
        ? mdEscape(textOf({ tag: "#t", attrs: {}, children: [c] }).replace(/\s+/g, " "))
        : inlineMdVisible(c),
    );
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** Text-only extraction that applies visibility at every descendant. */
function visibleTextOf(node: HtmlNode): string {
  let out = "";
  for (const c of node.children) {
    if (typeof c === "string") {
      out += c;
    } else if (isHidden(c)) {
      hiddenDropped += 1;
    } else {
      out += visibleTextOf(c);
    }
  }
  return decodeEntities(out);
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
  hiddenDropped = 0;

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
        if (text.trim() !== "") pushInline(mdEscape(text));
        continue;
      }
      convert(child, listDepth);
    }
  };

  /** Inline walk: skip children the author hid (anti cloaking). */


  const listLines = (list: HtmlNode, depth: number): string[] => {
    const indent = "  ".repeat(depth);
    const marker = list.tag === "ol" ? "1." : "-";
    const out: string[] = [];
    for (const c of list.children) {
      if (typeof c === "string" || c.tag !== "li") continue;
      if (isHidden(c)) {
        hiddenDropped += 1;
        continue;
      }
      out.push(`${indent}${marker} ${liLabel(c)}`);
      for (const n of c.children) {
        if (typeof n !== "string" && (n.tag === "ul" || n.tag === "ol")) {
          if (isHidden(n)) hiddenDropped += 1;
          else out.push(...listLines(n, depth + 1));
        }
      }
    }
    return out;
  };

  const convert = (el: HtmlNode, listDepth: number): void => {
    const { tag, attrs } = el;

    // Anti cloaking: an author-hidden element is dropped entirely (and
    // counted); its text must not leak into prose via any path.
    if (isHidden(el)) {
      hiddenDropped += 1;
      return;
    }

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
      pushProse("#".repeat(level) + " " + inlineMdVisible(el).replace(/\s+/g, " ").trim());
    } else if (tag === "ul" || tag === "ol") {
      pushProse(listLines(el, listDepth).join("\n"));
    } else if (tag === "pre") {
      const code = el.children.find((c): c is HtmlNode => typeof c !== "string" && c.tag === "code");
      const cls = (code?.attrs.class ?? "").match(/(?:language|lang)-([a-zA-Z0-9+#-]+)/);
      const body = visibleTextOf(code ?? el).replace(/\n$/, "");
      // Canonical output must be re-parse-safe (INV-3): a ``` line inside
      // <pre> would close the fence early and leak body lines as live
      // blocks. Emit the fence one longer than the longest body run.
      const maxRun = Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
      const fenceMark = "`".repeat(maxRun + 1);
      pushProse(fenceMark + (cls?.[1] ?? "") + "\n" + body + "\n" + fenceMark);
    } else if (tag === "blockquote") {
      pushProse(
        inlineMdVisible(el)
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
        pushInline(inlineMdVisible(el)); // named anchor: collapse to text
      } else {
        const b = block("link", { href: attrs.href }, {}, inlineMdVisible(el).replace(/\s+/g, " ").trim(), "link");
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
  if (hiddenDropped > 0) {
    notes.push(`hidden content dropped: ${hiddenDropped} element(s) the author marked invisible (anti-cloaking)`);
  }
  return { doc: { ad: "0.1", nodes }, notes };
}

function tableBlock(el: HtmlNode): BlockNode {
  // A literal `|` inside a cell must not become a column separator when the
  // body is reparsed: escape it GFM-style (`\|`); renderTable/splitRow split
  // pipe-aware and restore the literal.
  const cellText = (s: string): string => s.replace(/\|/g, "\\|");
  const rowsOf = (section: HtmlNode | undefined): string[][] =>
    section === undefined
      ? []
      : section.children
          .filter((c): c is HtmlNode => typeof c !== "string" && c.tag === "tr")
          .filter((tr) => {
            if (isHidden(tr)) {
              hiddenDropped += 1;
              return false;
            }
            return true;
          })
          .map((tr) =>
            tr.children
              .filter((c): c is HtmlNode => typeof c !== "string" && (c.tag === "td" || c.tag === "th"))
              .filter((cell) => {
                if (isHidden(cell)) {
                  hiddenDropped += 1;
                  return false;
                }
                return true;
              })
              .map((cell) => cellText(inlineMdVisible(cell).replace(/\s+/g, " ").trim())),
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
  return block("action", {}, attrs, inlineMdVisible(el).replace(/\s+/g, " ").trim(), "button");
}

function formBlock(form: HtmlNode, source: string, notes: string[]): BlockNode {
  const fields: Record<string, unknown> = {};
  const collect = (node: HtmlNode): void => {
    for (const c of node.children) {
      if (typeof c === "string") continue;
      if (c.tag === "form") continue;
      if (isHidden(c)) {
        hiddenDropped += 1;
        continue;
      }
      collect(c);
      if (c.tag === "input" || c.tag === "textarea" || c.tag === "select") {
        addControl(c, fields, notes);
      } else if (c.tag === "button") {
        const type = (c.attrs.type ?? "submit").toLowerCase();
        if (type === "submit") {
          const label = visibleTextOf(c).trim() || "Submit";
          const base = slug(label) || "submit";
          let key = base;
          for (let k = 2; Object.hasOwn(fields, key); k += 1) key = `${base}-${k}`;
          fields[key] = `submit(label=${JSON.stringify(label)})`;
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
  // Field keys must match the field-line grammar (`^[a-z][a-z0-9-]*$`) so the
  // canonical form reparses: `constructor` must not vanish via an inherited
  // key, and numeric/non-ASCII names get a valid synthetic key.
  let key = slug(name);
  if (key === "" || !/^[a-z][a-z0-9-]*$/.test(key)) key = "control";
  let unique = key;
  for (let k = 2; Object.hasOwn(fields, unique); k += 1) unique = `${key}-${k}`;
  key = unique;
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
      .filter((o) => {
        if (isHidden(o)) {
          hiddenDropped += 1;
          return false;
        }
        return true;
      })
      .map((o) => o.attrs.value ?? visibleTextOf(o).trim());
    fields[key] = `select(options=${JSON.stringify(options)})`;
  }
}

/** Convert legacy HTML to canonical ad text (DOW-3). */
export function html2ad(html: string, opts: Html2AdOptions = {}): string {
  const { doc } = htmlToDoc(html, opts);
  return print(canonicalize(doc));
}
