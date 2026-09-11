#!/usr/bin/env node
/**
 * check-doc-images.cjs — verify that every local image referenced by the docs
 * actually exists.
 *
 * Why this exists: the README renders screenshots straight out of
 * `marketing/v<version>/`. Replacing the screenshot set (or deleting one) leaves
 * the README pointing at a file that is gone, and nothing in the build catches
 * it — the first sign is a broken image on the repo page, on all three mirrors.
 *
 * Scope:
 *   - README.md / README.en.md / RELEASE-NOTES-*.md
 *   - every *.md under marketing/ EXCEPT the frozen archives
 *     (marketing/v0.1.0, marketing/v0.2.0), which describe releases that already
 *     shipped and must not be rewritten.
 *
 * Only relative paths are checked; absolute URLs (http/https) are ignored.
 *
 * Usage: node scripts/check-doc-images.cjs
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
/** Version dirs whose documents are frozen release archives. */
const FROZEN_DIRS = ["marketing/v0.1.0", "marketing/v0.2.0"];

/** Markdown targets, relative to the repo root. */
function collectDocs() {
  const docs = [];
  for (const name of ["README.md", "README.en.md"]) {
    if (fs.existsSync(path.join(ROOT, name))) docs.push(name);
  }
  for (const entry of fs.readdirSync(ROOT)) {
    if (/^RELEASE-NOTES-.*\.md$/i.test(entry)) docs.push(entry);
  }
  const marketing = path.join(ROOT, "marketing");
  if (fs.existsSync(marketing)) {
    for (const version of fs.readdirSync(marketing)) {
      const rel = `marketing/${version}`;
      if (FROZEN_DIRS.includes(rel)) continue;
      const dir = path.join(marketing, version);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (file.toLowerCase().endsWith(".md")) docs.push(`${rel}/${file}`);
      }
    }
  }
  return docs;
}

/** All `![alt](target)` and `<img src="target">` references in one document. */
function imageRefs(text) {
  const refs = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) refs.push(m[1]);
  for (const m of text.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/gi)) refs.push(m[1]);
  return refs;
}

const problems = [];
const checked = { docs: 0, refs: 0 };

for (const doc of collectDocs()) {
  const full = path.join(ROOT, doc);
  const text = fs.readFileSync(full, "utf8");
  checked.docs += 1;
  for (const raw of imageRefs(text)) {
    const target = raw.trim();
    if (target === "") continue;
    // Skip remote/absolute targets and pure anchors.
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(target)) continue;
    if (target.startsWith("#")) continue;
    checked.refs += 1;
    const clean = target.split("#")[0].split("?")[0];
    if (clean === "") continue;
    const decoded = decodeURIComponent(clean);
    const resolved = path.resolve(path.dirname(full), decoded);
    if (!fs.existsSync(resolved)) {
      problems.push({ doc, target: clean });
    }
  }
}

console.log("check-doc-images:");
console.log(`  scanned ${checked.docs} document(s), ${checked.refs} local image reference(s)`);

if (problems.length > 0) {
  for (const p of problems) {
    console.log(`  MISSING  ${p.doc}  ->  ${p.target}`);
  }
  console.log(`\ncheck-doc-images: ${problems.length} missing image reference(s) FAILED`);
  process.exit(1);
}
console.log("\ncheck-doc-images: all image references resolve");
