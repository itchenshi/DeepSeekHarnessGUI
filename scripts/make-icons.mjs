#!/usr/bin/env node
/**
 * make-icons.mjs — render the DeepSeek Harness favicon (official site SVG)
 * into every size the app and electron-builder need.
 *
 * The official icon color is measured from the site's static favicon.ico:
 *   dominant   = rgb(77, 107, 254) = #4D6BFE (brand blue)
 *          (center pixel exactly #4D6BFE, corners transparent).
 * The site's favicon.svg is theme-adaptive (black on light, white on dark),
 * so we BAKE the official #4D6BFE into a normalized SVG (media queries
 * stripped) — every consumer is then guaranteed the exact official color.
 * Alternative variants (white / black) are emitted into build/variants/.
 *
 * Outputs:
 *   build/icon.png           1024x1024 (app icon source; win/mac convert)
 *   build/icons/<n>x<n>.png  16/32/48/64/128/256/512/1024 (linux)
 *   build/variants/icon-{white,black}.png  1024x1024 (optional alternates)
 *   src/icon.png             256x256  (BrowserWindow icon, packaged)
 *   src/tray-icon.png        32x32    (tray icon, packaged)
 *
 * Usage: node scripts/make-icons.mjs
 */

import {mkdir, readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_SVG = join(ROOT, "resources", "icons", "harness.svg");
const BUILD_ICON = join(ROOT, "build", "icon.png");
const BUILD_ICONS_DIR = join(ROOT, "build", "icons");
const BUILD_VARIANTS_DIR = join(ROOT, "build", "variants");
const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

/** Official favicon.ico color (measured): brand blue #4D6BFE. */
const OFFICIAL_FILL = "#4D6BFE";

/** Normalize the SVG: drop adaptive <style>, force the official fill. */
function normalizeSvg(svgText, fill) {
  return svgText
    .replace(/<style>[\s\S]*?<\/style>/g, `<style>path{fill:${fill}}</style>`)
    .replace(/\bwidth="\d+"\s+height="\d+"\b/, 'width="1024" height="1024"');
}

async function renderPng(svgBuffer, size, outFile) {
  await sharp(svgBuffer, { density: 300 }).resize(size, size).png().toFile(outFile);
}

async function main() {
  const rawSvg = await readFile(SRC_SVG, "utf8");
  const blueSvg = Buffer.from(normalizeSvg(rawSvg, OFFICIAL_FILL));

  await mkdir(dirname(BUILD_ICON), { recursive: true });
  await mkdir(BUILD_ICONS_DIR, { recursive: true });
  await mkdir(BUILD_VARIANTS_DIR, { recursive: true });
  await mkdir(join(ROOT, "src"), { recursive: true });

  // Master 1024 PNG (electron-builder converts png -> ico/icns from this).
  await renderPng(blueSvg, 1024, BUILD_ICON);
  console.log("->", BUILD_ICON);

  // Linux icon set.
  for (const size of SIZES) {
    await renderPng(blueSvg, size, join(BUILD_ICONS_DIR, `${size}x${size}.png`));
  }
  console.log("->", BUILD_ICONS_DIR, `(${SIZES.length} sizes)`);

  // Packaged window + tray icons (inside asar via src/**).
  await renderPng(blueSvg, 256, join(ROOT, "src", "icon.png"));
  await renderPng(blueSvg, 32, join(ROOT, "src", "tray-icon.png"));
  console.log("->", join(ROOT, "src", "icon.png"), "+ tray-icon.png");

  // Optional variants (theme matches) for users who want the site's
  // light/dark rendering instead of the official static color.
  const whiteSvg = Buffer.from(normalizeSvg(rawSvg, "#FFFFFF"));
  const blackSvg = Buffer.from(normalizeSvg(rawSvg, "#000000"));
  await renderPng(whiteSvg, 1024, join(BUILD_VARIANTS_DIR, "icon-white.png"));
  await renderPng(blackSvg, 1024, join(BUILD_VARIANTS_DIR, "icon-black.png"));
  console.log("->", BUILD_VARIANTS_DIR, "(icon-white/icon-black)");

  const info = await sharp(BUILD_ICON).metadata();
  console.log(`done: master ${info.width}x${info.height} ${info.format} fill=${OFFICIAL_FILL}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});