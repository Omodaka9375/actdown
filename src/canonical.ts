import { createHash } from "node:crypto";
import { printLiteral } from "./literal.js";
import { parse } from "./parse.js";
import type { AttrValue, BlockNode, Doc, ForeignNode, Node } from "./types.js";

const RESERVED = ["id", "role", "when", "each"];

function encodeAttrVal(v: AttrValue): string {
  const s = typeof v === "string" ? v : `{${v.raw}}`;
  return /[?&=%#"+\s`]/.test(s) ? encodeURIComponent(s) : s;
}

function attrCompare(a: string, b: string): number {
  const ae = a.startsWith("on:") ? 1 : 0;
  const be = b.startsWith("on:") ? 1 : 0;
  if (ae !== be) return ae - be;
  return a < b ? -1 : a > b ? 1 : 0;
}

function fieldCompare(a: string, b: string): number {
  const ia = RESERVED.indexOf(a);
  const ib = RESERVED.indexOf(b);
  if (ia !== -1 || ib !== -1) {
    return (ia === -1 ? RESERVED.length : ia) - (ib === -1 ? RESERVED.length : ib);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function printBlock(b: BlockNode, opts?: { omitId?: boolean }): string {
  const parts: string[] = [];
  const attrEntries = Object.entries(b.attrs).sort(([a], [c]) => attrCompare(a, c));
  let info = "```ad-" + b.type;
  if (attrEntries.length > 0) {
    info += "?" + attrEntries.map(([k, v]) => (v === "" ? k : `${k}=${encodeAttrVal(v)}`)).join("&");
  }
  parts.push(info);
  if (!opts?.omitId) parts.push(`id: ${b.id}`);
  if (b.role !== undefined) parts.push(`role: ${b.role}`);
  for (const k of Object.keys(b.fields).sort(fieldCompare)) {
    parts.push(`${k}: ${printLiteral(b.fields[k]!)}`);
  }
  if (b.body !== null) {
    parts.push("---");
    if (b.body !== "") parts.push(...b.body.split("\n"));
  }
  parts.push("", "```");
  return parts.join("\n");
}

function printProse(md: string): string {
  const lines = md.split("\n").map((l) => {
    const m = /[ \t]+$/.exec(l);
    if (!m) return l;
    // A trailing run of 2+ spaces is a CommonMark hard break: normalize every
    // qualifying run to exactly two spaces so meaning survives printing
    // (three trailing spaces degrade to a hard break too, not to nothing).
    const spacesOnly = !m[0].includes("\t");
    return spacesOnly && m[0].length >= 2 ? `${l.slice(0, l.length - m[0].length)}  ` : l.slice(0, l.length - m[0].length);
  });
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.join("\n");
}

function isForeign(n: Node): n is ForeignNode {
  return n.kind === "block" && "foreign" in n && n.foreign === true;
}

export function print(doc: Doc): string {
  const parts = doc.nodes.map((n: Node) => {
    if (n.kind === "prose") return printProse(n.md);
    if (isForeign(n)) return n.raw;
    return printBlock(n);
  });
  return parts.join("\n\n") + "\n";
}

/** SPEC 2.3: generated ids hash the canonical block bytes, id omitted. */
function genId(b: BlockNode): string {
  const bytes = printBlock(b, { omitId: true });
  return "h" + createHash("sha1").update(bytes, "utf8").digest("hex").slice(0, 10);
}

export function canonicalize(doc: Doc): Doc {
  const seen = new Set<string>();
  const renames = new Map<string, string>();
  const nodes = doc.nodes.map((n) => {
    if (n.kind !== "block" || isForeign(n)) return n;
    let id = n.id === "" ? genId(n) : n.id;
    // Explicit ids can collide (e.g. repeated slugs from html2ad); the parser
    // rejects duplicates, so canonicalize makes later ones unique instead.
    if (seen.has(id)) {
      const base = id;
      for (let k = 2; seen.has(id); k += 1) id = `${base}-${k}`;
      renames.set(base, id);
    }
    seen.add(id);
    return id === n.id ? n : { ...n, id };
  });
  // Renaming a duplicate id must update every cross-reference to it in the
  // same pass, or `ad-region for:` would dangle after canonicalization.
  if (renames.size > 0) {
    for (const n of nodes) {
      if (n.kind !== "block" || isForeign(n)) continue;
      const forVal = n.fields.for;
      if (typeof forVal === "string" && renames.has(forVal)) {
        n.fields.for = renames.get(forVal)!;
      }
    }
  }
  return { ad: doc.ad, nodes };
}

export function format(input: string): string {
  return print(canonicalize(parse(input).doc));
}

/** SPEC 9: canonical AST serialization, two-space indent, trailing LF. */
export function toJSON(doc: Doc): string {
  return JSON.stringify(doc, null, 2) + "\n";
}
