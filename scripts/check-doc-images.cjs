#!/usr/bin/env node
/**
 * check-doc-images.cjs — verify that every local image referenced by a
 * PUBLISHED document actually exists.
 *
 * Why this exists: the README renders screenshots straight out of the repo.
 * Replacing or deleting a screenshot leaves the README pointing at a file that
 * is gone, and nothing in the build catches it — the first sign is a broken
 * image on the repo page, on all three mirrors.
 *
 * Scope = every markdown file git tracks. That is exactly what gets pushed, so
 * it needs no per-directory list to maintain:
 *   - a document that is local-only (e.g. the gitignored `marketing/` promo
 *     drafts) cannot break the published pages, so it is not scanned;
 *   - a new published doc is covered the moment it is committed.
 *
 * Only relative paths are checked; absolute URLs (http/https) are ignored.
 *
 * Usage: node scripts/check-doc-images.cjs
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

/** Markdown files tracked by git (i.e. what would be pushed). */
function collectDocs() {
  let out = "";
  try {
    out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    // Outside a git checkout (e.g. an exported tarball) fall back to the
    // documents that are always published.
    console.log(`  note: git ls-files unavailable (${(error && error.message) || error}); checking the root docs only`);
    return ["README.md", "README.en.md"].filter((f) => fs.existsSync(path.join(ROOT, f)));
  }
  return out
    .split("\0")
    .map((s) => s.trim())
    .filter((s) => s !== "");
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
const docs = collectDocs();

for (const doc of docs) {
  const full = path.join(ROOT, doc);
  if (!fs.existsSync(full)) continue;
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
console.log(`  scanned ${checked.docs} tracked document(s), ${checked.refs} local image reference(s)`);

if (problems.length > 0) {
  for (const p of problems) {
    console.log(`  MISSING  ${p.doc}  ->  ${p.target}`);
  }
  console.log(`\ncheck-doc-images: ${problems.length} missing image reference(s) FAILED`);
  process.exit(1);
}
console.log("\ncheck-doc-images: all image references resolve");
