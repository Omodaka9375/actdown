/**
 * ad-include inlining (SPEC 4.5): the AST stores the include reference;
 * inlining is a separate, explicit pass so a document's meaning is always
 * locally readable. Cycles are E_INCLUDE_CYCLE; a src that cannot be loaded
 * is E_INCLUDE_UNRESOLVED. `cap:` sources are host resources and stay
 * verbatim: the host resolves them at render time, not the filesystem.
 */
import { parse } from "./parse.js";
import { ParseError } from "./diag.js";
import type { BlockNode, Doc, ForeignNode, Node } from "./types.js";

export interface InlineOptions {
  /**
   * Resolve an include src to ad document text. Relative paths are resolved
   * by the caller (the CLI resolves against the entry document's directory);
   * an injected loader keeps this testable and keeps hosts in control of
   * which paths a document may read.
   */
  loader: (src: string) => string;
  /** Depth cap against runaway chains (default 16). */
  maxDepth?: number;
}

function isForeign(n: Node): n is ForeignNode {
  return n.kind === "block" && "foreign" in n && n.foreign === true;
}

function isBlock(n: Node): n is BlockNode {
  return n.kind === "block" && !isForeign(n);
}

/** Normalize a src for cycle detection: trim, drop a leading "./". */
function keyOf(src: string): string {
  return src.trim().replace(/^\.\//, "");
}

export function inlineIncludes(doc: Doc, opts: InlineOptions): Doc {
  return inlineDoc(doc, new Set<string>(), 0, opts);
}

function inlineDoc(doc: Doc, stack: Set<string>, depth: number, opts: InlineOptions): Doc {
  if (depth > (opts.maxDepth ?? 16)) {
    throw new ParseError("E_INCLUDE_CYCLE", "include depth exceeded (possible cycle)", 0);
  }
  const nodes: Node[] = [];
  for (const n of doc.nodes) {
    if (!isBlock(n) || n.type !== "include") {
      nodes.push(n);
      continue;
    }
    const src = n.fields.src;
    if (typeof src !== "string" || src === "") {
      throw new ParseError("E_INCLUDE_UNRESOLVED", `ad-include "${n.id}" has no string src field`, n.line);
    }
    if (src.startsWith("cap:")) {
      nodes.push(n); // SPEC 4.5: the AST stores the reference
      continue;
    }
    const key = keyOf(src);
    if (stack.has(key)) {
      throw new ParseError("E_INCLUDE_CYCLE", `include cycle through "${src}"`, n.line);
    }
    let text: string;
    try {
      text = opts.loader(src);
    } catch (err: unknown) {
      throw new ParseError(
        "E_INCLUDE_UNRESOLVED",
        `cannot resolve include "${src}": ${err instanceof Error ? err.message : String(err)}`,
        n.line,
      );
    }
    const inner = parse(text);
    // The included document's own demoted blocks stay foreign (visible);
    // its ids collide the same way any pasted content would (canonicalize
    // de-duplicates, SPEC 2.3).
    stack.add(key);
    const spliced = inlineDoc(inner.doc, stack, depth + 1, opts);
    stack.delete(key);
    nodes.push(...spliced.nodes);
  }
  return { ad: "0.1", nodes };
}
