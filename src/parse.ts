import { ParseError } from "./diag.js";
import { parseField } from "./literal.js";
import type {
  AttrValue,
  BlockNode,
  Diagnostic,
  Expr,
  Literal,
  Node,
  ParseResult,
} from "./types.js";

/** SPEC 8: semantic roles; private extensions use the `x-` prefix. */
export const ROLES = new Set([
  "button", "link", "input", "label", "heading", "chart", "table",
  "image", "form", "region", "status", "nav", "danger", "primary", "secondary",
]);

const EVENT_RE = /^on:(click|submit|change|load)$/;

/** SPEC 3 (level 1) plus region (4) and manifest (7). */
const KNOWN_TYPES = new Set([
  "state", "text", "data", "action", "form", "field", "list",
  "table", "image", "link", "chart", "include", "region", "manifest",
]);

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const AD_INFO = /^ad-([a-z][a-z0-9-]*)(\?(.*))?$/;

interface FenceRef {
  /** Index of the closing fence line, or lines.length when unclosed. */
  end: number;
  info: string;
  backtick: boolean;
}

function scanFence(lines: readonly string[], i: number): FenceRef | null {
  const m = FENCE_OPEN.exec(lines[i]!);
  if (!m) return null;
  const marker = m[1]!;
  const ch = marker[0]!;
  const closeRe = new RegExp(`^ {0,3}\\${ch}{${marker.length},}[ \\t]*$`);
  let j = i + 1;
  while (j < lines.length && !closeRe.test(lines[j]!)) j += 1;
  return { end: j, info: m[2]!.trim(), backtick: ch === "`" };
}

export function parse(input: string): ParseResult {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const nodes: Node[] = [];
  const diagnostics: Diagnostic[] = [];
  const seenIds = new Set<string>();
  let prose: string[] = [];

  const flushProse = () => {
    while (prose.length > 0 && prose[0]!.trim() === "") prose.shift();
    while (prose.length > 0 && prose[prose.length - 1]!.trim() === "") prose.pop();
    if (prose.length > 0) {
      nodes.push({ kind: "prose", md: prose.join("\n") });
    }
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const f = scanFence(lines, i);
    if (!f) {
      prose.push(lines[i]!);
      i += 1;
      continue;
    }
    const m = AD_INFO.exec(f.info);
    const isAd = f.backtick && m !== null;
    const unclosed = f.end >= lines.length;
    const last = unclosed ? lines.length - 1 : f.end;
    if (!isAd || m === null) {
      // Not an ad block: preserve verbatim as prose (INV-1).
      for (let k = i; k <= last; k += 1) prose.push(lines[k]!);
      i = f.end + 1;
      continue;
    }
    flushProse();
    const bodyEnd = unclosed ? lines.length : f.end;
    const inner = lines.slice(i + 1, bodyEnd);
    // INV-3: an unclosed fence's verbatim raw must not absorb trailing blank
    // lines. print() terminates the document with "\n"; if re-parsing folded
    // that into an unclosed fence's raw, every format pass would grow the
    // foreign block by one newline. Closed fences end at their fence line and
    // are unaffected.
    let rawEnd = bodyEnd + (unclosed ? 0 : 1);
    if (unclosed) {
      while (rawEnd > i + 1 && lines[rawEnd - 1]!.trim() === "") rawEnd -= 1;
    }
    const raw = lines.slice(i, rawEnd).join("\n");
    const startLine = i + 1;
    const foreign = (diagnostic?: Diagnostic) => {
      nodes.push({
        kind: "block",
        foreign: true,
        type: m[1]!,
        raw,
        line: startLine,
        ...(diagnostic !== undefined ? { diagnostic } : {}),
      });
    };
    try {
      const block = parseBlock(m[1]!, m[2] ?? "", inner, startLine);
      if (!KNOWN_TYPES.has(block.type)) {
        // SPEC 2.1: unknown types are preserved verbatim as foreign blocks.
        foreign();
      } else {
        if (block.id !== "" && seenIds.has(block.id)) {
          throw new ParseError("E_DUP_ID", `duplicate id "${block.id}"`, startLine);
        }
        if (block.id !== "") seenIds.add(block.id);
        nodes.push(block);
      }
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      const diagnostic: Diagnostic = { code: e.code, message: e.message, line: e.line };
      // SPEC 15: a parse error demotes the block to a foreign block.
      foreign(diagnostic);
      diagnostics.push(diagnostic);
    }
    i = f.end + 1;
  }
  flushProse();
  return { doc: { ad: "0.1", nodes }, diagnostics };
}

function parseBlock(
  type: string,
  attrStr: string,
  inner: readonly string[],
  startLine: number,
): BlockNode {
  const attrs: Record<string, AttrValue> = {};
  if (attrStr !== "") {
    if (!attrStr.startsWith("?")) {
      throw new ParseError("E_BAD_INFO", "malformed info string", startLine);
    }
    for (const part of attrStr.slice(1).split("&")) {
      if (part === "") continue;
      const eq = part.indexOf("=");
      const key = eq === -1 ? part : part.slice(0, eq);
      const rawVal = eq === -1 ? "" : part.slice(eq + 1);
      let val: string;
      try {
        val = decodeURIComponent(rawVal);
      } catch {
        throw new ParseError("E_BAD_INFO", `bad percent-encoding in attribute "${key}"`, startLine);
      }
      // Object.hasOwn: an attr literally named "constructor" must not be
      // flagged by an inherited-key false positive.
      if (Object.hasOwn(attrs, key)) {
        throw new ParseError("E_DUPLICATE_KEY", `duplicate attribute "${key}"`, startLine);
      }
      attrs[key] = val;
    }
  }

  // Trigger events may arrive as info attrs or body fields (SPEC 4.2, 4.3).
  const events = new Map<string, string>();
  for (const k of Object.keys(attrs)) {
    if (EVENT_RE.test(k)) {
      const v = attrs[k]!;
      events.set(k.slice(3), typeof v === "string" ? v : v.raw);
      delete attrs[k];
    }
  }

  const sepIdx = inner.findIndex((ln) => /^---[ \t]*$/.test(ln));
  const fieldLines = sepIdx === -1 ? inner : inner.slice(0, sepIdx);
  const bodyLines = sepIdx === -1 ? null : inner.slice(sepIdx + 1);

  const rawFields = new Map<string, { value: string; line: number }>();
  let currentKey: string | null = null;
  fieldLines.forEach((ln, idx) => {
    const lineNo = startLine + idx + 1;
    const evm = /^on:(click|submit|change|load):[ \t]*(.*)$/.exec(ln);
    if (evm) {
      events.set(evm[1]!, evm[2]!.trim());
      currentKey = null;
      return;
    }
    // SPEC 4.3 documents `on:submit="expr"` (equals + quoted expression) as
    // the field form; without this branch it parses as an ordinary field
    // named `on` and the trigger is silently lost.
    const evq = /^on:(click|submit|change|load)=[ \t]*(.*)$/.exec(ln);
    if (evq) {
      let v = evq[2]!.trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
      events.set(evq[1]!, v);
      currentKey = null;
      return;
    }
    const fm = /^([a-z][a-z0-9-]*):[ \t]*(.*)$/.exec(ln);
    if (fm) {
      const key = fm[1]!;
      if (rawFields.has(key)) {
        throw new ParseError("E_DUPLICATE_KEY", `duplicate field "${key}"`, lineNo);
      }
      rawFields.set(key, { value: fm[2]!.trim(), line: lineNo });
      currentKey = key;
      return;
    }
    if (/^[ \t]+\S/.test(ln) && currentKey !== null) {
      // Continuation: folded into the current value with a single space.
      const cur = rawFields.get(currentKey)!;
      cur.value = `${cur.value} ${ln.trim()}`;
      return;
    }
    if (/^[ \t]*$/.test(ln)) {
      currentKey = null;
      return;
    }
    throw new ParseError("E_BAD_FIELD", `expected "key: value" line, got: ${ln.trim()}`, lineNo);
  });

  if (events.size > 1) {
    throw new ParseError("E_MULTI_EVENT", `multiple trigger events: ${[...events.keys()].join(", ")}`, startLine);
  }

  const fields: Record<string, Literal | Expr> = {};
  for (const [k, { value, line }] of rawFields) {
    fields[k] = parseField(value, line);
  }

  let id = "";
  const attrId = attrs.id;
  if (attrId !== undefined) {
    if (typeof attrId !== "string") throw new ParseError("E_BAD_ID", "id must be a plain name", startLine);
    id = attrId;
    delete attrs.id;
  }
  if (rawFields.has("id")) {
    const v = fields.id!;
    if (typeof v !== "string") throw new ParseError("E_BAD_ID", "id must be a plain name", startLine);
    id = v;
    delete fields.id;
  }
  if (id !== "" && !/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new ParseError("E_BAD_ID", `invalid id "${id}"`, startLine);
  }

  let role: string | undefined;
  const attrRole = attrs.role;
  if (attrRole !== undefined) {
    if (typeof attrRole !== "string") throw new ParseError("E_BAD_ROLE", "role must be a plain name", startLine);
    role = attrRole;
    delete attrs.role;
  }
  if (rawFields.has("role")) {
    const v = fields.role!;
    if (typeof v !== "string") throw new ParseError("E_BAD_ROLE", "role must be a plain name", startLine);
    role = v;
    delete fields.role;
  }
  if (role !== undefined && !ROLES.has(role) && !role.startsWith("x-")) {
    throw new ParseError("E_BAD_ROLE", `unknown role "${role}"`, startLine);
  }

  // `when` / `each` are expressions; normalize them into fields (SPEC 10).
  for (const rk of ["when", "each"] as const) {
    const av = attrs[rk];
    if (av !== undefined) {
      const raw = typeof av === "string" ? av : av.raw;
      if (raw === "") throw new ParseError("E_BAD_LITERAL", `${rk} needs an expression`, startLine);
      fields[rk] = { kind: "expr", raw };
      delete attrs[rk];
    }
  }

  for (const [ev, raw] of events) {
    attrs[`on:${ev}`] = raw === "" ? "" : { kind: "expr", raw };
  }

  const body = bodyLines === null ? null : bodyLines.join("\n").replace(/\n+$/, "");

  return { kind: "block", type, id, role, attrs, fields, body, line: startLine };
}
