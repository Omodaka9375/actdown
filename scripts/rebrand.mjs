#!/usr/bin/env node
/**
 * One-shot rebrand codemod: htmldown/htmd/hdm -> actdown/ad.
 *
 * Case-preserving rules, applied to every text file in the repo (excluding
 * node_modules/dist/.git/rust target and lockfiles). File renames: *.hdm -> *.ad.
 *
 * NOTE: this script rewrites its own rules when run over its own directory,
 * so it must not be re-run after APPLY without restoring this file. It is a
 * one-shot migration aid; delete it once the rename is complete.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? ".";
const APPLY = process.argv.includes("--apply");
const IGNORE = new Set(["node_modules", "dist", ".git", "target", ".kai", "scripts"]);
const SKIP_EXT = new Set([".png", ".jpg", ".ico", ".woff", ".woff2", ".exe", ".dll"]);

// Order matters only for readability; the strings do not overlap.
const RULES = [
  [/htmldown/g, "actdown"],
  [/Htmldown/g, "Actdown"],
  [/HTMLDOWN/g, "ACTDOWN"],
  [/htmd-rs/g, "actdown-rs"],
  [/htmd/g, "actdown"],
  [/Htmd/g, "Actdown"],
  [/HTMD/g, "ACTDOWN"],
  [/hdm/g, "ad"],
  [/Hdm/g, "Ad"],
  [/HDM/g, "AD"],
];

const textExts = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".rs", ".toml",
  ".ad", ".hdm", ".html", ".css", ".yml", ".yaml", ".gitignore", ".npmrc",
  "", ".txt", ".xml",
]);

let filesChanged = 0;
let filesRenamed = 0;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (IGNORE.has(entry.name)) continue;
    if (entry.isDirectory()) {
      walk(p);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (SKIP_EXT.has(ext) || (!textExts.has(ext) && ext !== "")) continue;

    const before = readFileSync(p, "utf8");
    let after = before;
    for (const [re, to] of RULES) after = after.replace(re, to);
    if (after !== before) {
      if (APPLY) writeFileSync(p, after);
      console.log(`content: ${p}`);
      filesChanged += 1;
    }

    if (/\.hdm$/i.test(entry.name)) {
      const target = path.join(dir, entry.name.replace(/\.hdm$/i, ".ad"));
      if (APPLY) renameSync(p, target);
      console.log(`rename:  ${p} -> ${target}`);
      filesRenamed += 1;
    }
  }
}

walk(root);
console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: ${filesChanged} file(s) rebranded, ${filesRenamed} file(s) renamed`);
if (!APPLY) console.log("re-run with --apply to write changes");
