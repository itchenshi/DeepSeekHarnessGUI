"use strict";

/**
 * home-migrate.js — pure filesystem helpers for moving DeepSeek Harness data
 * between DSH_HOME locations (system ~/.dsh <-> app data dir). No Electron
 * imports so it can be unit-tested standalone with plain Node.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

/** Default harness home when DSH_HOME is unset. */
function defaultDshHome() {
  return path.join(os.homedir(), ".dsh");
}

/**
 * Whether a harness home directory has any data (readable and non-empty).
 * A missing directory counts as no data.
 */
async function hasHomeData(dir) {
  try {
    const entries = await fsp.readdir(dir);
    return entries.length > 0;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Move every top-level entry of `src` into `dst`, merging with anything the
 * target already holds. Uses rename first (fast, same volume); on
 * cross-device (EXDEV), permission (EPERM) or merge-conflict (ENOTEMPTY)
 * it falls back to recursive copy + delete (fs.cp with force merges dirs).
 *
 * @returns {Promise<{ moved: number, skipped: string[] }>}
 */
async function moveHomeData(src, dst) {
  const entries = await fsp.readdir(src);
  const skipped = [];
  let moved = 0;
  await fsp.mkdir(dst, { recursive: true });
  for (const entry of entries) {
    const from = path.join(src, entry);
    const to = path.join(dst, entry);
    try {
      await fsp.rename(from, to);
      moved++;
    } catch (error) {
      const code = error && error.code;
      if (code === "EXDEV" || code === "EPERM" || code === "ENOTEMPTY") {
        try {
          await fsp.cp(from, to, { recursive: true, force: true, errorOnExist: false });
          await fsp.rm(from, { recursive: true, force: true });
          moved++;
        } catch (copyError) {
          skipped.push(`${entry}: ${copyError.message}`);
        }
      } else {
        skipped.push(`${entry}: ${error.message}`);
      }
    }
  }
  // Drop the source home dir once it has been fully emptied (nothing skipped).
  if (skipped.length === 0) {
    try {
      const left = await fsp.readdir(src);
      if (left.length === 0) await fsp.rm(src, { recursive: true, force: true });
    } catch {
      /* keep src on read failure */
    }
  }
  return { moved, skipped };
}

module.exports = { defaultDshHome, hasHomeData, moveHomeData };