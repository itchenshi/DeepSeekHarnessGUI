"use strict";
/**
 * ico-info.cjs — 列出 ICO 文件的帧（尺寸/位深/编码），并校验 BMP 帧长度。
 * 用于验证打包出来的 .ico 是否满足兼容性：
 *  - BMP 帧（未压缩 32bpp）→ 老解析器（Maye / .NET Framework ExtractAssociatedIcon）能读；
 *  - PNG 帧（Vista+）→ 只有现代解析器能读。
 *  - BMP 帧总长必须自洽：40 + w*h*4 + 掩码长度。electron-builder 嵌入 exe 时
 *    会把掩码统一成紧凑 1bpp（((w+31)>>5)*4*h 字节），所以源码 .ico 也直接用
 *    紧凑掩码，避免 exe 内 DIB 头部（biSizeImage）与实际载荷长度不一致——
 *    不一致会让 Windows「更改图标」对话框判定「不包含图标」。
 * 用法：node scripts/ico-info.cjs <file.ico>
 */
const fs = require("fs");
const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/ico-info.cjs <file.ico>");
  process.exit(2);
}
const buf = fs.readFileSync(file);
if (buf.readUInt16LE(0) !== 0) {
  console.error("not an ICO");
  process.exit(2);
}
const count = buf.readUInt16LE(4);
console.log("ICO:", file, "| frames:", count, "| bytes:", buf.length);
for (let i = 0; i < count; i++) {
  const o = 6 + i * 16;
  const w = buf.readUInt8(o); // 0 => 256
  const h = buf.readUInt8(o + 1);
  const bpp = buf.readUInt16LE(o + 6);
  const size = buf.readUInt32LE(o + 8);
  const offset = buf.readUInt32LE(o + 12);
  const ww = w === 0 ? 256 : w;
  const hh = h === 0 ? 256 : h;
  const isPng = buf.readUInt32BE(offset) === 0x89504e47;
  if (isPng) {
    console.log(`  #${i} ${ww}x${hh} ${bpp}bpp PNG-compressed (Vista+) size=${size}`);
  } else {
    const biWidth = buf.readInt32LE(offset + 4);
    const biHeight = buf.readInt32LE(offset + 8);
    const biCompression = buf.readUInt32LE(offset + 16);
    const comp = biCompression === 0 ? "BI_RGB" : biCompression === 3 ? "BI_BITFIELDS" : `0x${biCompression.toString(16)}`;
    // 期望长度：BITMAPINFOHEADER(40) + XOR(w*h*4) + 紧凑 AND((w+31)>>5)*4*h。
    // electron-builder 嵌入 exe 时统一用紧凑掩码；官方 electron.exe 用 w*h 掩码，
    // 但那种帧经 electron-builder 会被截断，造成 DIB 头与实际长度不一致。
    const px = biWidth * (biHeight / 2);
    const packed = 40 + px * 4 + ((biWidth + 31) >> 5) * 4 * (biHeight / 2);
    const stride = 40 + px * 4 + px;
    const verdict =
      size === packed
        ? "OK"
        : size === stride
          ? "*** official-style w*h mask (builder will truncate to packed) ***"
          : `*** unexpected length (expected ${packed}) ***`;
    console.log(
      `  #${i} ${ww}x${hh} ${bpp}bpp BMP (biWidth=${biWidth} biHeight=${biHeight} ${comp}) size=${size} ${verdict}`,
    );
  }
}