#!/usr/bin/env node
/**
 * bundle-node.mjs — download a portable Node.js runtime for the CURRENT
 * platform and unpack it into <project>/resources/node so electron-builder
 * can ship it via extraResources. The engine (@deepseek-ai/dsh) is then run
 * with this bundled node (main.js prefers resources/node), which keeps the
 * native-module ABI consistent with whatever npm installed.
 *
 * Layout after extraction:
 *   Windows: resources/node/node.exe  +  resources/node/node_modules/...
 *   macOS/Linux: resources/node/bin/node  +  resources/node/lib/node_modules/...
 *
 * Env overrides:
 *   DSH_NODE_VERSION   e.g. "26.0.0" (default: v26 — see below)
 *   DSH_NODE_MIRROR    e.g. "https://npmmirror.com/mirrors/node/" (default: https://nodejs.org/dist)
 */

import {execFileSync} from "node:child_process";
import {createWriteStream, existsSync} from "node:fs";
import {mkdir, readdir, rm, stat, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {Readable} from "node:stream";
import {fileURLToPath} from "node:url";
import {pipeline} from "node:stream/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "resources", "node");

// The engine currently depends on Node >= 23's zstd API (node:zlib
// createZstdDecompress / zstdCompress). LTS v22 lacks it, so default to a
// recent stable that ships it; override with DSH_NODE_VERSION.
const NODE_VERSION = process.env.DSH_NODE_VERSION || "26.0.0";
const MIRROR = (process.env.DSH_NODE_MIRROR || "https://nodejs.org/dist").replace(/\/+$/, "");

const MATRIX = {
  "win32-x64": { os: "win", arch: "x64", ext: "zip" },
  "darwin-arm64": { os: "darwin", arch: "arm64", ext: "tar.gz" },
  "darwin-x64": { os: "darwin", arch: "x64", ext: "tar.gz" },
  "linux-x64": { os: "linux", arch: "x64", ext: "tar.gz" },
  "linux-arm64": { os: "linux", arch: "arm64", ext: "tar.gz" },
};
// Allow cross-arch bundling (CI builds the x64 macOS app on an Apple Silicon
// runner): DSH_NODE_PLATFORM / DSH_NODE_ARCH override the host platform/arch.
const NODE_PLATFORM = process.env.DSH_NODE_PLATFORM || process.platform;
const NODE_ARCH = process.env.DSH_NODE_ARCH || process.arch;
const KEY = `${NODE_PLATFORM}-${NODE_ARCH}`;
const entry = MATRIX[KEY];
if (!entry) {
  console.error(`unsupported platform: ${KEY}`);
  process.exit(1);
}

const BASE = `node-v${NODE_VERSION}-${entry.os}-${entry.arch}`;
const URL = `${MIRROR}/v${NODE_VERSION}/${BASE}.${entry.ext}`;
const TMP = join(ROOT, "resources", `.node-tmp-${BASE}`);

async function download(url, dest) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (${url})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
  await mkdir(dirname(OUT_DIR), { recursive: true });
  await rm(OUT_DIR, { recursive: true, force: true });
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  const archive = join(TMP, `${BASE}.${entry.ext}`);
  await download(URL, archive);

  // tar.exe (bsdtar) on Windows and system tar on macOS/Linux both handle zip and tar.gz.
  execFileSync("tar", ["-xf", archive, "-C", TMP], { stdio: "inherit" });

  const extracted = join(TMP, BASE);
  if (!existsSync(extracted)) throw new Error(`unexpected archive layout: ${BASE} missing`);

  await mkdir(OUT_DIR, { recursive: true });
  execFileSync(
    process.platform === "win32" ? "xcopy" : "cp",
    process.platform === "win32"
      ? [extracted, OUT_DIR, "/E", "/I", "/Y", "/Q"]
      : ["-R", `${extracted}/.`, OUT_DIR],
    { stdio: "ignore" },
  );

  const executable =
    process.platform === "win32"
      ? join(OUT_DIR, "node.exe")
      : join(OUT_DIR, "bin", "node");
  if (!existsSync(executable)) throw new Error(`node executable missing: ${executable}`);

  const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  await writeFile(join(OUT_DIR, "version.txt"), `${version}\n`);

  // Recursive size of the bundled runtime (stat on the dir itself is not recursive).
  let sizeBytes = 0;
  for await (const file of walkFiles(OUT_DIR)) sizeBytes += (await stat(file)).size;

  await rm(TMP, { recursive: true, force: true });
  await rm(archive, { force: true });
  console.log(`bundled node ${version} -> ${OUT_DIR} (${(sizeBytes / 1024 / 1024).toFixed(1)} MiB)`);
}

/** Yield every file path under a directory. */
async function* walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});