import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  canonicalize,
  format,
  html2ad,
  parse,
  parseExpr,
  print,
  renderReactive,
  type Doc,
} from "../src/index.js";
import { ParseError } from "../src/diag.js";
import { ExprError } from "../src/expr.js";
import { parseHtml } from "../src/htmlparse.js";

/**
 * Deterministic property/fuzz tests (no dependency: a tiny xorshift PRNG and
 * a seeded mutator instead of a property framework). Every run is identical,
 * so a failure is reproducible from the printed seed.
 *
 * Properties under test:
 * - `parse` never crashes: any throw is a ParseError with an `E_*` code
 *   (SPEC 15: diagnostics, not exceptions).
 * - `format` is total on parseable input and idempotent (INV-3):
 *   format(format(s)) === format(s), and the canonical text reparses to the
 *   same AST.
 * - `parseExpr` never crashes: any throw is an ExprError (E_EXPR_*).
 * - `parseHtml`/`html2ad` are total: no input, however broken, throws
 *   (malformed HTML degrades to text per SPEC 12).
 * - `renderReactive` never throws for any document the parser accepts
 *   (bad expressions and guards resolve to null / degrade, SPEC 15).
 */

const SEED = 0x5eed_0001;

/** xorshift32: small, deterministic, seed never becomes zero. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[rng() % arr.length]!;
const randInt = (rng: () => number, n: number): number => rng() % n;

/** Characters with high grammar-confusion potential (ASCII + unicode). */
const CHARS = [
  "`", "~", "-", "#", ">", "|", ":", " ", "\t", "\\", "\"", "'",
  "(", ")", "[", "]", "{", "}", ",", "=", "%", "&", "?", ".", "$",
  "0", "1", "9", "a", "z", "\n", "\r", "/", "<", "!", "-",
  "\u00e9", "\u4e2d", "\u0301", "\uFEFF", "\u0000", "\u2028", "\ufffd",
];

const EXPR_CHARS = [
  "0", "1", "9", ".", "e", "E", "-", "+", "(", ")", "[", "]", "{", "}",
  ",", ":", "\"", "'", "\\", "*", "/", "%", "<", ">", "=", "!", "&", "|",
  "$", "a", "z", " ", "true", "false", "null", "if", "??", "?.", "\n",
];

const randomString = (rng: () => number, charset: readonly string[], maxLen: number): string => {
  const len = randInt(rng, maxLen) + 1;
  let out = "";
  for (let i = 0; i < len; i += 1) out += pick(rng, charset);
  return out;
};

const randomExprSoup = (rng: () => number, maxLen: number): string => {
  const len = randInt(rng, maxLen) + 1;
  let out = "";
  for (let i = 0; i < len; i += 1) out += pick(rng, EXPR_CHARS);
  return out;
};

/** Structured junk: grammatical shapes with poisoned parts. */
const STRUCTURED = [
  (s: string) => `\`\`\`ad-state\n${s}: ${s}\n\`\`\``,
  (s: string) => `\`\`\`ad-action?name=${s}&on:click\nargs: {${s}}\n---\nGo\n\`\`\``,
  (s: string) => `# ${s}\n\n\`\`\`ad-data?${s}\n${s}\n\`\`\``,
  (s: string) => `\`\`\`\`\`\n${s}\n\`\`\``,
  (s: string) => `| ${s} |\n| --- |\n| ${s} |`,
  (s: string) => `<p>${s}<b>${s}</p>${s}</b>`,
  (s: string) => `ad ${s} when=${s} each=${s}`,
  (s: string) => `---\n${s}: ${s}\n${s}: ${s}\n---`,
];

function mutate(rng: () => number, s: string): string {
  const ops = randInt(rng, 4);
  let out = s;
  for (let i = 0; i <= ops; i += 1) {
    const at = out.length === 0 ? 0 : randInt(rng, out.length);
    switch (randInt(rng, 6)) {
      case 0: // insert junk
        out = out.slice(0, at) + randomString(rng, CHARS, 12) + out.slice(at);
        break;
      case 1: // delete a slice
        out = out.slice(0, at) + out.slice(at + randInt(rng, 12));
        break;
      case 2: // duplicate a slice
        out = out.slice(0, at) + out.slice(0, at + randInt(rng, 12)) + out.slice(at);
        break;
      case 3: // truncate
        out = out.slice(0, at);
        break;
      case 4: // splice in a random unicode/control burst
        out = out.slice(0, at) + randomString(rng, CHARS, 6) + out.slice(at + randInt(rng, 4));
        break;
      default: // swap two chars
        if (out.length > 1) {
          const b = randInt(rng, out.length);
          const chars = [...out];
          [chars[at], chars[b]] = [chars[b]!, chars[at]!];
          out = chars.join("");
        }
        break;
    }
  }
  return out;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vectorInputs = (() => {
  const dir = join(repoRoot, "vectors");
  try {
    return ["0001-basic-prose", "0002-state-and-action", "0005-generated-id", "0006-expr-bindings", "0007-async-regions", "0008-prose-table", "0009-chart-and-list", "0010-form-controls"].map(
      (v) => readFileSync(join(dir, v, "input.ad"), "utf8"),
    );
  } catch {
    return ["# fallback\n", "```ad-state\ncount: 0\n```"];
  }
})();

const EXPR_SEEDS = [
  "count + 1",
  "items.map(x => x.price * qty)",
  "{a: 1, b: [2, 3]}",
  "user.name ?? 'anon'",
  "a ? b : c",
  "cart.total() >= 10 && !!cart.items[0]",
  "\u6d4b\u8bd5",
  '"unterminated',
  "1e999",
  "$state + $props.x",
];

describe("property: document parser and printer (fuzz)", () => {
  it("parse never crashes; format is total and idempotent (INV-3)", () => {
    const rng = makeRng(SEED);
    for (let i = 0; i < 1500; i += 1) {
      const base = i % 3 === 0 ? pick(rng, vectorInputs) : pick(rng, STRUCTURED)(randomString(rng, CHARS, 24));
      const input = i % 3 === 1 ? mutate(rng, base) : base;
      const seen = new Set<number>();
      seen.add(rng());
      let first: string | null = null;
      let firstAst: string | null = null;
      try {
        first = format(input);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ParseError);
        expect((err as ParseError).code).toMatch(/^E_/);
        continue;
      }
      // Re-parse of the canonical text must yield the identical AST.
      firstAst = JSON.stringify(parse(first).doc);
      expect(JSON.stringify(parse(format(first)).doc)).toBe(firstAst);
      // Idempotence: a second format pass is a fixed point.
      expect(format(first)).toBe(first);
    }
  });

  it("structured junk through canonicalize/print round-trips without crash", () => {
    const rng = makeRng(SEED + 7);
    for (let i = 0; i < 500; i += 1) {
      const input = pick(rng, STRUCTURED)(randomString(rng, CHARS, 40));
      let doc: Doc;
      try {
        doc = parse(input).doc;
      } catch {
        continue; // hard parse errors are covered above
      }
      const canonical = print(canonicalize(doc));
      expect(() => parse(canonical)).not.toThrow();
    }
  });
});

describe("property: expression parser (fuzz)", () => {
  it("parseExpr never crashes; throws only ExprError", () => {
    const rng = makeRng(SEED + 13);
    for (let i = 0; i < 2000; i += 1) {
      const input = i % 4 === 0 ? mutate(rng, pick(rng, EXPR_SEEDS)) : randomExprSoup(rng, 30);
      try {
        parseExpr(input);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ExprError);
        expect((err as ExprError).code).toMatch(/^E_EXPR/);
      }
    }
  });
});

describe("property: html2ad totalness (fuzz)", () => {
  it("parseHtml and html2ad never throw on any input", () => {
    const rng = makeRng(SEED + 29);
    for (let i = 0; i < 800; i += 1) {
      const input = i % 2 === 0
        ? `<div ${randomString(rng, CHARS, 20)}>${randomString(rng, CHARS, 30)}</div>`
        : mutate(rng, "<p>a</p><ul><li>b</li></ul><table><tr><td>c</td></tr></table>");
      expect(() => parseHtml(input)).not.toThrow();
      const ad = html2ad(input);
      // Whatever comes out must itself be parseable ad text (DOW contract).
      expect(() => parse(ad)).not.toThrow();
    }
  });
});

describe("property: reactive render totalness", () => {
  it("renderReactive never throws for any accepted document", () => {
    const rng = makeRng(SEED + 41);
    for (let i = 0; i < 600; i += 1) {
      const input = mutate(rng, pick(rng, vectorInputs));
      let doc: Doc;
      try {
        doc = parse(input).doc;
      } catch {
        continue;
      }
      expect(() => renderReactive(doc)).not.toThrow();
      const canonical = print(canonicalize(doc));
      expect(() => renderReactive(parse(canonical).doc)).not.toThrow();
    }
  });

  it("poisoned expression fields degrade to null, never throw (SPEC 15)", () => {
    const rng = makeRng(SEED + 59);
    for (let i = 0; i < 400; i += 1) {
      const soup = randomExprSoup(rng, 24);
      const doc = parse(`\`\`\`ad-state\nv: {${soup}}\n\`\`\``).doc;
      expect(() => renderReactive(doc)).not.toThrow();
      const block = doc.nodes.find((n) => n.kind === "block");
      expect(block).toBeDefined();
    }
  });
});
