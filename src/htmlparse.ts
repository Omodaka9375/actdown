/**
 * Minimal dependency-free HTML tree parser for the downconverter. Handles
 * quoted/unquoted/boolean attributes, void elements, raw-text elements
 * (script/style) and the common auto-close cases of legacy markup
 * (unclosed <li>, <p>, <td>, <tr>, <option>, <dt>, <dd>).
 */
export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlNode | string)[];
}

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

const RAW = new Set(["script", "style"]);

/** Opening T implicitly closes these open tags. */
const AUTOCLOSE: Record<string, string[]> = {
  li: ["li"],
  p: ["p", "li", "dt", "dd", "tr"],
  td: ["td", "th"],
  th: ["td", "th"],
  tr: ["td", "th", "tr"],
  option: ["option"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  div: ["p"],
  h1: ["p"], h2: ["p"], h3: ["p"], h4: ["p"], h5: ["p"], h6: ["p"],
  ul: ["p"], ol: ["p"], table: ["p"], form: ["p"], pre: ["p"],
  blockquote: ["p"], hr: ["p"],
};

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'>]*))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1]!.toLowerCase();
    const value = m[3] ?? m[4] ?? (m[2] === undefined || m[2] === "" ? "" : m[2]!.replace(/^["']|["']$/g, ""));
    // Own-property check: an attr named "constructor" must not be dropped
    // by an inherited-key false positive.
    if (!Object.hasOwn(attrs, name)) attrs[name] = value;
  }
  return attrs;
}

/** Return the whole opening tag starting at `lt`, honoring quoted `>`. */
function scanQuotedTag(src: string, lt: number): string | null {
  let quote: string | null = null;
  for (let k = lt + 1; k < src.length; k += 1) {
    const c = src[k]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "<") return null; // not a single tag
    if (c === ">") return src.slice(lt, k + 1);
  }
  return null;
}

/** Match an opening tag, honoring quoted `>` inside attribute values. */
function matchOpenTag(src: string, lt: number): RegExpExecArray | null {
  const quoted = scanQuotedTag(src, lt);
  if (quoted === null) return null;
  // The attr region allows `>` only inside quotes; everything else matches
  // the original shape (name, attrs, optional self-close, closing bracket).
  return /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s(?:[^<>"']|"[^"]*"|'[^']*')*?)?)\s*(\/?)>$/.exec(quoted);
}

export function parseHtml(src: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlNode[] = [root];
  const top = (): HtmlNode => stack[stack.length - 1]!;
  const push = (node: HtmlNode | string) => top().children.push(node);
  const close = (tag: string): boolean => {
    const idx = stack.findLastIndex((n) => n.tag === tag);
    if (idx <= 0) return false;
    stack.length = idx; // pop through the matching open tag
    return true;
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      push(src.slice(i));
      break;
    }
    if (lt > i) push(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    const closeM = /^<\/([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/.exec(src.slice(lt));
    if (closeM !== null) {
      close(closeM[1]!.toLowerCase());
      i = lt + closeM[0].length;
      continue;
    }
    const openM = matchOpenTag(src, lt);
    if (openM === null) {
      push("<");
      i = lt + 1;
      continue;
    }
    const tag = openM[1]!.toLowerCase();
    const node: HtmlNode = { tag, attrs: parseAttrs(openM[2] ?? ""), children: [] };
    for (const t of AUTOCLOSE[tag] ?? []) {
      if (stack.findLast((n) => n.tag === t) !== undefined && stack.length > 1) {
        const idx = stack.findLastIndex((n) => n.tag === t);
        if (idx === stack.length - 1) stack.length = idx;
      }
    }
    push(node);
    i = lt + openM[0].length;
    if (openM[3] === "/" || VOID.has(tag)) continue;
    if (RAW.has(tag)) {
      // Drop the content entirely (DOW-2) and consume the closing tag.
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = src.slice(i);
      const m = closeRe.exec(rest);
      i = m === null ? src.length : i + m.index + m[0].length;
      // The raw node was appended to its parent above (push); it never
      // became a stack entry, so there is nothing to pop here.
      continue;
    }
    stack.push(node);
  }
  return root;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "\u00a9",
};

/** A numeric reference outside the Unicode range (or a lone surrogate)
 * decodes to U+FFFD, never a throw. */
function codePoint(n: number): string {
  if (n > 0x10ffff || n < 0) return "\ufffd";
  if (n >= 0xd800 && n <= 0xdfff) return "\ufffd"; // String.fromCodePoint would throw RangeError
  return String.fromCodePoint(n);
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => codePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => ENTITIES[name] ?? m);
}

export function textOf(node: HtmlNode): string {
  let out = "";
  for (const c of node.children) {
    out += typeof c === "string" ? c : textOf(c);
  }
  return decodeEntities(out);
}

/** True when the tag carries only inline content (collapses into prose, DOW-1). */
export function isInline(tag: string): boolean {
  return new Set([
    "a", "span", "em", "strong", "b", "i", "u", "small", "code", "sub", "sup",
    "label", "time", "abbr", "cite", "q", "var", "kbd", "samp", "del", "ins",
    "mark", "s", "font", "tt", "big",
  ]).has(tag);
}
