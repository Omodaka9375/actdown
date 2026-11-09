import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, format, parse, render, renderReactive, toJSON } from "../src/index.js";

const vectorsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

const vectorDirs = existsSync(vectorsRoot) ? readdirSync(vectorsRoot).filter((d) => existsSync(join(vectorsRoot, d, "input.hdm"))) : [];

/** One manifest entry (SPEC 13): level, human description, expected goldens. */
interface VectorEntry {
  level: number;
  description: string;
  goldens: string[];
}

/** Parse and validate manifest.json (json-parse-must-validate). */
function loadManifest(): Record<string, VectorEntry> {
  const raw = readFileSync(join(vectorsRoot, "manifest.json"), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`manifest.json is not valid JSON: ${String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("manifest.json: root must be an object");
  const vectors = (parsed as { vectors?: unknown }).vectors;
  if (typeof vectors !== "object" || vectors === null) throw new Error("manifest.json: missing vectors object");
  const out: Record<string, VectorEntry> = {};
  for (const [name, rawEntry] of Object.entries(vectors)) {
    if (!/^\d{4}-[a-z0-9-]+$/.test(name)) throw new Error(`manifest.json: bad vector name "${name}"`);
    if (typeof rawEntry !== "object" || rawEntry === null) throw new Error(`manifest.json: ${name} entry must be an object`);
    const e = rawEntry as Record<string, unknown>;
    if (typeof e.level !== "number" || !Number.isInteger(e.level) || e.level < 0 || e.level > 3) {
      throw new Error(`manifest.json: ${name} level must be an integer 0..3`);
    }
    if (typeof e.description !== "string" || e.description === "") {
      throw new Error(`manifest.json: ${name} needs a description`);
    }
    if (!Array.isArray(e.goldens) || !e.goldens.every((g) => typeof g === "string")) {
      throw new Error(`manifest.json: ${name} goldens must be a string array`);
    }
    out[name] = { level: e.level, description: e.description, goldens: e.goldens };
  }
  return out;
}

describe.runIf(vectorDirs.length > 0)("conformance vectors (SPEC 13)", () => {
  const manifest = loadManifest();

  it("manifest covers every vector directory and vice versa", () => {
    const listed = Object.keys(manifest).sort();
    expect(vectorDirs.slice().sort()).toEqual(listed);
  });

  it("every vector's declared goldens exist on disk", () => {
    for (const [name, entry] of Object.entries(manifest)) {
      for (const g of entry.goldens) {
        expect(existsSync(join(vectorsRoot, name, g)), `${name}/${g}`).toBe(true);
      }
    }
  });

  for (const name of vectorDirs) {
    const entry = manifest[name];
    it.runIf(entry !== undefined)(`vector ${name} (level ${entry?.level})`, () => {
      const dir = join(vectorsRoot, name);
      const input = readFileSync(join(dir, "input.hdm"), "utf8");

      const { doc } = parse(input);
      const cdoc = canonicalize(doc);
      const ast = toJSON(cdoc);
      const canonical = format(input);

      if (UPDATE) {
        writeFileSync(join(dir, "ast.json"), ast);
        writeFileSync(join(dir, "canonical.hdm"), canonical);
        writeFileSync(join(dir, "html.html"), render(cdoc) + "\n");
        writeFileSync(join(dir, "reactive.html"), renderReactive(cdoc) + "\n");
        return;
      }

      // SPEC 13: goldens are exact; the manifest lists which are required.
      const golden = (file: string): string => readFileSync(join(dir, file), "utf8");
      for (const g of entry?.goldens ?? []) {
        if (g === "ast.json") expect(ast).toBe(golden(g));
        else if (g === "canonical.hdm") {
          expect(canonical).toBe(golden(g));
          // INV-3: canonicalization is idempotent.
          expect(format(canonical)).toBe(canonical);
        } else if (g === "html.html") expect(render(cdoc) + "\n").toBe(golden(g));
        else if (g === "reactive.html") expect(renderReactive(cdoc) + "\n").toBe(golden(g));
        else throw new Error(`unknown golden "${g}" in ${name} (add a branch here)`);
      }
    });
  }
});
