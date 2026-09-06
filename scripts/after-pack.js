"use strict";

/**
 * after-pack.js — electron-builder afterPack hook.
 *
 * electron-builder's extraResources matcher silently drops node_modules, so
 * the bundled portable Node would ship without npm. This hook copies the
 * whole `resources/node` (bundled by scripts/bundle-node.mjs) into the app's
 * resources dir right after packaging — before the installer/archive is built
 * — with no filter involved.
 *
 * Configured via electron-builder.yml: afterPack: scripts/after-pack.js
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

module.exports = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const projectNode = path.join(packager.projectDir, "resources", "node");
  if (!fs.existsSync(projectNode)) {
    console.warn("afterPack: resources/node missing — run `npm run bundle:node` first");
    return;
  }
  // Target app resources dir per platform.
  const appResources =
    process.platform === "darwin"
      ? path.join(appOutDir, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  const dst = path.join(appResources, "node");

  await fsp.mkdir(dst, { recursive: true });
  await fsp.cp(projectNode, dst, { recursive: true, force: true });

  let files = 0;
  for await (const _file of walk(dst)) files++;
  console.log(`afterPack: bundled portable node -> ${dst} (${files} files)`);
};

async function* walk(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}