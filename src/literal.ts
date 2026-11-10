import { ParseError } from "./diag.js";
import type { Expr, Literal } from "./types.js";

/**
 * SPEC 4.1: JSON literals plus unquoted bare words. A value starting with
 * `{` that is not valid JSON is stored as an expression (SPEC 9).
 */
/** JSON.parse accepts 1e400 as Infinity; a non-finite cannot round-trip
 * (JSON.stringify turns it into null), so any number anywhere in the parsed
 * value must be finite. */
function assertFinite(v: unknown, line: number): void {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new ParseError("E_BAD_LITERAL", `number out of range: ${String(v)}`, line);
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) assertFinite(item, line);
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const item of Object.values(v as Record<string, unknown>)) assertFinite(item, line);
  }
}

export function parseField(value: string, line: number): Literal | Expr {
  const s = value.trim();
  if (s === "") return "";
  const c = s[0]!;
  if (c === '"' || c === "[" || c === "{") {
    try {
      const parsed = JSON.parse(s) as Literal;
      // Nested non-finite numbers bypass the scalar check below (e.g.
      // "[1e400]" -> [Infinity]) and would silently print as null.
      assertFinite(parsed, line);
      return parsed;
    } catch (err: unknown) {
      // Validation failures (nested non-finite) are already ParseErrors.
      if (err instanceof ParseError) throw err;
      if (c === '"') {
        throw new ParseError("E_UNTERMINATED_STRING", "unterminated string literal", line);
      }
      if (c === "{") {
        // Expression: `{ ... }` that is not a JSON object. Strip outer braces
        // so printing `{${raw}}` round-trips.
        const raw = s.endsWith("}") ? s.slice(1, -1).trim() : s.slice(1);
        return { kind: "expr", raw };
      }
      throw new ParseError("E_BAD_LITERAL", "malformed array literal", line);
    }
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    // Non-finite numbers cannot round-trip (they serialize as null): refuse.
    if (!Number.isFinite(n)) throw new ParseError("E_BAD_LITERAL", `number out of range: ${s}`, line);
    return n;
  }
  return unescapeBare(s);
}

/** Bare values: `\n` is a newline, `\\` a backslash, `\x` is `x`. */
function unescapeBare(s: string): string {
  return s.replace(/\\(.)/g, (_m, ch: string) => (ch === "n" ? "\n" : ch));
}

const NUMERIC = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * A string may be emitted bare when parseField would read it back
 * identically (SPEC 4.1): no surrounding whitespace, no backslash escapes,
 * not a keyword, number, or something that opens a quoted/array/object
 * literal, and not shaped like a `key: value` line.
 */
function bareSafe(s: string): boolean {
  return (
    s !== "" &&
    s.trim() === s &&
    !/\s/.test(s) &&
    !/[\\"\n]/.test(s) &&
    !NUMERIC.test(s) &&
    s !== "true" && s !== "false" && s !== "null" &&
    !/^["[{]/.test(s) &&
    !/^[a-z][a-z0-9-]*:[ \t]/.test(s)
  );
}

export function printLiteral(v: Literal | Expr): string {
  if (v !== null && typeof v === "object" && "kind" in v && (v as Expr).kind === "expr") {
    return `{${(v as Expr).raw}}`;
  }
  if (typeof v === "string" && bareSafe(v)) return v;
  return JSON.stringify(v);
}
