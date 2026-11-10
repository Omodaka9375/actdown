#!/usr/bin/env node
/**
 * actdown CLI: parse, check, format, render, and convert .ad documents.
 *
 *   actdown check   <file|- >  parse and report diagnostics (exit 1 on any)
 *   actdown fmt     <file|->   print the canonical form (INV-3)
 *   actdown ast     <file|->   print the JSON AST
 *   actdown render  <file|->   static HTML (--reactive applies state)
 *   actdown html2ad <file|->   convert HTML to canonical ad
 *
 * "-" reads stdin. Zero dependencies beyond Node 20.
 */
import { readFileSync } from "node:fs";
import {
  parse,
  canonicalize,
  format,
  toJSON,
  lint,
  render,
  renderReactive,
  html2ad,
} from "./index.js";

const USAGE = `actdown - actionable markdown for agents and humans

usage: actdown <command> [file|-]

commands:
  check     parse a document and report diagnostics (exit 1 on any)
  fmt       print the canonical form
  ast       print the JSON AST
  render    print static HTML (pass --reactive to apply state)
  html2ad   convert an HTML file to canonical ad

"-" or no file reads stdin. Example:

  actdown fmt doc.ad
  cat page.html | actdown html2ad - > page.ad
`;

function readInput(arg: string | undefined): string {
  if (arg === undefined || arg === "-") return readFileSync(0, "utf8");
  return readFileSync(arg, "utf8");
}

function die(msg: string): never {
  process.stderr.write(`actdown: ${msg}\n`);
  process.exit(2);
}

const [, , cmd, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const file = rest.find((a) => !a.startsWith("--"));

if (cmd === undefined || cmd === "--help" || cmd === "-h") {
  process.stdout.write(USAGE);
  process.exit(cmd === undefined ? 2 : 0);
}

let input: string;
try {
  input = readInput(file);
} catch (err) {
  die(`cannot read ${file ?? "stdin"}: ${err instanceof Error ? err.message : String(err)}`);
}

const docResult = parse(input);
const doc = canonicalize(docResult.doc);

switch (cmd) {
  case "check": {
    for (const d of docResult.diagnostics) {
      process.stdout.write(`${d.code}: ${d.message} (line ${d.line})\n`);
    }
    if (docResult.diagnostics.length > 0) process.exit(1);
    // Review lints are warnings: reported, counted, failing only with --strict.
    const warnings = lint(doc);
    for (const w of warnings) {
      process.stdout.write(`${w.code}: ${w.message} (line ${w.line})\n`);
    }
    if (warnings.length > 0) {
      if (process.argv.includes("--strict")) process.exit(1);
      process.stdout.write(`ok: no errors, ${warnings.length} warning(s)\n`);
      break;
    }
    process.stdout.write("ok: no diagnostics\n");
    break;
  }
  case "fmt":
    process.stdout.write(format(input) + "\n");
    break;
  case "ast":
    process.stdout.write(toJSON(doc) + "\n");
    break;
  case "render":
    process.stdout.write(
      (flags.has("--reactive") ? renderReactive(doc) : render(doc)) + "\n",
    );
    break;
  case "html2ad":
    process.stdout.write(html2ad(input, { source: file ?? "stdin" }) + "\n");
    break;
  default:
    die(`unknown command "${cmd}"\n\n${USAGE}`);
}
