#!/usr/bin/env node
/**
 * make-icons.mjs — render the DeepSeek Harness favicon (official site SVG)
 * into every size the app and electron-builder need.
 *
 * 两个图标问题的修复历史：
 *
 * 1. 桌面/快捷方式看不到（无背景色）——旧主图标是透明底蓝色字形，浅色桌面下
 *    几乎不可见。现在主图标为**白色圆角方块 + 品牌蓝字形**（官方 #4D6BFE），
 *    深色/浅色壁纸上都醒目。
 * 2. Maye 等老式快速启动工具读不到图标——electron-builder 从 PNG 转出的
 *    ICO 全是 PNG 压缩帧（Vista+ 格式），旧解析器（如 .NET Framework 的
 *    ExtractAssociatedIcon）只认未压缩 BMP 帧，结果一片空白。现在直接在
 *    make-icons 阶段生成 **build/icon.ico**：16~128 用未压缩 BMP 帧、256 用
 *    PNG 帧，electron-builder 以 .ico 原样打进 exe / 安装包。
 * 3. Windows「更改图标」报「不包含图标」——两处根因：① 256 帧必须是 PNG
 *    （BMP 在 256 上不可靠）；② BMP 帧的 AND 掩码长度若按 w*h（32bpp 行距）
 *    生成，electron-builder 嵌入 exe 时会截断成紧凑 1bpp，造成 DIB 头声明的
 *    biSizeImage 与实际载荷不一致，严格解析器照样拒收。所以源码 .ico 直接用
 *    紧凑 1bpp 掩码，保持头/载荷/组条目三者一致。详见 renderBmpFrame 注释。
 *
 * Outputs:
 *   build/icon.png           1024x1024 (app icon source; mac/linux convert)
 *   build/icon.ico           16~128 BMP 帧 + 256 PNG 帧 (win exe / installer 用，见上)
 *   build/icons/<n>x<n>.png  16/32/48/64/128/256/512/1024 (linux)
 *   build/variants/icon-{white,black}.png  1024x1024 (可选的主题替代色字形)
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
const BUILD_ICO = join(ROOT, "build", "icon.ico");
const BUILD_ICONS_DIR = join(ROOT, "build", "icons");
const BUILD_VARIANTS_DIR = join(ROOT, "build", "variants");
const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
/**
 * ICO 帧构成（实测结论，别随意改）：
 *  - 16..128：**未压缩 BMP 帧** —— Maye 等老式快速启动工具（.NET Framework
 *    ExtractAssociatedIcon）只认 BMP 帧，PNG 帧会让它们显示空白；
 *  - 256：**必须是 PNG 帧** —— ICO 规范里 256×256 靠 ICONDIRENTRY 的宽高字节
 *    编码为 0，未压缩 BMP 在该尺寸上不可靠（Windows「更改图标」对话框会直接报
 *    「不包含图标」）。官方 electron.exe 同样是 16/32/48 BMP + 256 PNG，这里与
 *    它保持一致。
 */
const ICO_BMP_SIZES = [16, 24, 32, 48, 64, 128];
const ICO_PNG_SIZE = 256;

/** 官方 favicon 品牌蓝。 */
const OFFICIAL_FILL = "#4D6BFE";

/** 取出 SVG 里的 <path> 等内容（去掉 <style> 与 <svg> 外壳）。 */
function glyphMarkup(svgText) {
  return svgText
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<svg[^>]*>/i, "")
    .replace(/<\/svg>/i, "")
    .trim();
}

/**
 * 主图标 SVG：白色圆角方块 + 品牌蓝字形居中（约 81%）。
 *
 * 白底在深色壁纸/深色任务栏上醒目，且与 Harness 页面浅色主题一致；字形用官方
 * 品牌蓝 #4D6BFE 保证白底上的对比度。圆角外的四角保持透明（Windows 10 以本图
 * 自带圆角显示，Windows 11 会再加蒙版）。
 *
 * 注意：favicon 源路径的坐标是 0..50 viewBox 系的，必须用嵌套 <svg viewBox>
 * 重新映射到目标画布，直接 <g transform> 会把它渲染成左上角一小点。
 */
function appIconSvg(glyph) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">' +
    // 底色用极浅渐变（纯白 → #F2F5FF），避免纯平白看起来"发灰/像缺图"。
    "<defs>" +
    '<linearGradient id="appBg" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#FFFFFF"/>' +
    '<stop offset="1" stop-color="#F2F5FF"/>' +
    "</linearGradient>" +
    "</defs>" +
    '<rect width="1024" height="1024" rx="232" fill="url(#appBg)"/>' +
    '<rect x="0.5" y="0.5" width="1023" height="1023" rx="231.5" fill="none" stroke="#DCE3F5" stroke-width="1"/>' +
    `<svg x="98" y="98" width="828" height="828" viewBox="0 0 50 50">` +
    `<g fill="${OFFICIAL_FILL}">${glyph}</g>` +
    "</svg>" +
    "</svg>"
  );
}

async function renderPng(svgBuffer, size, outFile) {
  await sharp(svgBuffer, { density: 300 }).resize(size, size).png().toFile(outFile);
}

/** BMP 帧（未压缩 32bpp BGRA + 全 0 AND 掩码），老解析器/Maye 都能读。 */
async function renderBmpFrame(svgBuffer, size) {
  const { data } = await sharp(svgBuffer, { density: 300 })
    .resize(size, size)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rowBytes = size * 4;
  const xor = Buffer.alloc(size * rowBytes);
  for (let y = 0; y < size; y++) {
    // 图标 DIB 是自下而上的行序；来源 RGBA → 目标 BGRA。
    const src = data.subarray((size - 1 - y) * rowBytes, (size - y) * rowBytes);
    for (let x = 0; x < size; x++) {
      const si = x * 4;
      const di = y * rowBytes + x * 4;
      xor[di] = src[si + 2]; // B
      xor[di + 1] = src[si + 1]; // G
      xor[di + 2] = src[si]; // R
      xor[di + 3] = src[si + 3]; // A
    }
  }
  // AND 掩码长度用**紧凑 1bpp 行距** ((size+31)>>5)*4*size：这是 electron-builder
  // 的写入器强制采用的格式——实测它会把超长掩码截断（官方 electron.exe 用
  // size*size 的掩码，但我们经 .ico 交给 electron-builder 时它只写紧凑长度），
  // 所以这里直接生成紧凑长度，避免 exe 内的 DIB 与资源头不一致。
  const andRowBytes = ((size + 31) >> 5) * 4;
  const and = Buffer.alloc(andRowBytes * size); // 全 0 → 不透明遮罩
  const bmp = Buffer.alloc(40);
  bmp.writeUInt32LE(40, 0); // biSize
  bmp.writeInt32LE(size, 4); // biWidth
  bmp.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  bmp.writeUInt16LE(1, 12); // biPlanes
  bmp.writeUInt16LE(32, 14); // biBitCount
  bmp.writeUInt32LE(0, 16); // biCompression = BI_RGB
  bmp.writeUInt32LE(xor.length + and.length, 20); // biSizeImage
  bmp.writeInt32LE(0, 24);
  bmp.writeInt32LE(0, 28);
  bmp.writeUInt32LE(0, 32);
  bmp.writeUInt32LE(0, 36);
  return Buffer.concat([bmp, xor, and]);
}

/** 组装 ICO 容器（ICONDIR + ICONDIRENTRY[] + 帧数据）。 */
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const entries = [];
  const payloads = [];
  for (const f of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(f.w === 256 ? 0 : f.w, 0);
    entry.writeUInt8(f.h === 256 ? 0 : f.h, 1);
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(f.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(f.data);
    offset += f.data.length;
  }
  return Buffer.concat([header, ...entries, ...payloads]);
}

async function main() {
  const rawSvg = await readFile(SRC_SVG, "utf8");
  const glyph = glyphMarkup(rawSvg);
  const appSvg = Buffer.from(appIconSvg(glyph));

  await mkdir(dirname(BUILD_ICON), { recursive: true });
  await mkdir(BUILD_ICONS_DIR, { recursive: true });
  await mkdir(BUILD_VARIANTS_DIR, { recursive: true });
  await mkdir(join(ROOT, "src"), { recursive: true });

  // Master 1024 PNG（mac icns / linux 由它转，win 改用自产 icon.ico）。
  await renderPng(appSvg, 1024, BUILD_ICON);
  console.log("->", BUILD_ICON);

  // Windows：16..128 未压缩 BMP（Maye 等老工具可读）+ 256 PNG（规范要求，
  // 也让资源管理器大图标更清晰、体积更小）。
  const frames = [];
  for (const size of ICO_BMP_SIZES) {
    frames.push({ w: size, h: size, data: await renderBmpFrame(appSvg, size) });
  }
  frames.push({
    w: ICO_PNG_SIZE,
    h: ICO_PNG_SIZE,
    data: await sharp(appSvg, { density: 300 }).resize(ICO_PNG_SIZE, ICO_PNG_SIZE).png().toBuffer(),
  });
  await (await import("node:fs/promises")).writeFile(BUILD_ICO, buildIco(frames));
  console.log("->", BUILD_ICO, `(${frames.length} frames: BMP ${ICO_BMP_SIZES.join("/")} + PNG ${ICO_PNG_SIZE})`);

  // Linux icon set.
  for (const size of SIZES) {
    await renderPng(appSvg, size, join(BUILD_ICONS_DIR, `${size}x${size}.png`));
  }
  console.log("->", BUILD_ICONS_DIR, `(${SIZES.length} sizes)`);

  // Packaged window + tray icons (inside asar via src/**).
  await renderPng(appSvg, 256, join(ROOT, "src", "icon.png"));
  await renderPng(appSvg, 32, join(ROOT, "src", "tray-icon.png"));
  console.log("->", join(ROOT, "src", "icon.png"), "+ tray-icon.png");

  // 可选主题替代色字形（保持透明底，供想用官方明暗渲染的用户）。
  const whiteGlyph = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 50 50"><g fill="#FFFFFF">${glyph}</g></svg>`,
  );
  const blackGlyph = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 50 50"><g fill="#000000">${glyph}</g></svg>`,
  );
  await renderPng(whiteGlyph, 1024, join(BUILD_VARIANTS_DIR, "icon-white.png"));
  await renderPng(blackGlyph, 1024, join(BUILD_VARIANTS_DIR, "icon-black.png"));
  console.log("->", BUILD_VARIANTS_DIR, "(icon-white/icon-black)");

  const info = await sharp(BUILD_ICON).metadata();
  console.log(`done: master ${info.width}x${info.height} ${info.format}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});