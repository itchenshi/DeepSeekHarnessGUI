/* engine-patch.test.cjs — engine-patch 内部工具纯单测（不依赖已装引擎）。 */
"use strict";

const {
  findBlock,
  insertAfter,
  indentOf,
  versionOf,
  stripLegacyPatch,
  LAST_MARKER,
  SUPPORTED_ENGINE,
} = require("../engine-patch.js");

let failed = 0;
function check(name, cond, message) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${message ? `\n    ${message}` : ""}`);
  }
}

check("indentOf 提取行首空白", indentOf("\t\tabc") === "\t\t" && indentOf("abc") === "");

{
  const lines = ["function x() {", "  hello();", "world();", "}"];
  const idx = findBlock(lines, ["hello();", "world();"]);
  check("findBlock 定位连续块", idx === 1, `got ${idx}`);
  check("findBlock 缺失返回 -1", findBlock(lines, ["missing"]) === -1);
}

{
  const lines = ["a", "\t\tb,", "c"];
  const ok = insertAfter(lines, ["b,"], ["NEW()", "OTHER()"]);
  check("insertAfter 成功", ok === true);
  check("insertAfter 保留锚点", lines[1] === "\t\tb,");
  check("insertAfter 插入并继承缩进", lines[2].trim() === "NEW()" && lines[2].startsWith("\t\t") && lines[3].trim() === "OTHER()");
}

check("常量 LAST_MARKER/版本", typeof LAST_MARKER === "string" && LAST_MARKER.length > 0 && SUPPORTED_ENGINE === "0.1.2-rc.1");

{
  const os = require("node:os");
  const path = require("node:path");
  check("versionOf 缺文件返回 null", versionOf(os.tmpdir(), "no-such-package.json") === null);
}

{
  // stripLegacyPatch：模拟 v1 补丁块插入在锚点与 const slots 之间的形态。
  const anchor = ["function apply(ctx) {", "const sessions = ctx.sessions;"];
  const legacy = [
    "",
    "// dsh-gui: 记住“最近一次对话”并在重启后自动打开（原 dsh-undo 页内逻辑，现由引擎补丁承载）。",
    "if (typeof window !== \"undefined\") {",
    "\tconst bridge = window.__dshGui;",
    "\tctx.effect(() => {}, \"dsh-gui: remember last session\");",
    "}",
  ];
  const tail = [
    "",
    "\tconst slots = ctx.slots;",
    "\tconst after = true;",
    "}",
    "/* dsh-gui-last-session-patch v1 */",
  ];
  const lines = [...anchor, ...legacy, ...tail];
  const stripped = stripLegacyPatch(lines, anchor);
  check("stripLegacyPatch 返回 true", stripped === true);
  check("stripLegacyPatch 移除旧注释", lines.every((l) => !l.trim().startsWith("// dsh-gui:")));
  check("stripLegacyPatch 移除旧标记", lines.every((l) => !/dsh-gui-last-session-patch v1/.test(l)));
  check("stripLegacyPatch 保留锚点", lines[0].trim() === "function apply(ctx) {" && lines[1].trim() === "const sessions = ctx.sessions;");
  const joined = lines.join("\n");
  check("stripLegacyPatch 保留 slots 与尾随代码", joined.includes("const slots = ctx.slots;") && joined.includes("const after = true;"));
  check("stripLegacyPatch 旧块不再残留", !joined.includes("remember last session"));

  // 无旧块时返回 false 且不动内容。
  const clean = ["function apply(ctx) {", "const sessions = ctx.sessions;", "const slots = ctx.slots;"];
  check("stripLegacyPatch 无旧块返回 false", stripLegacyPatch([...clean], anchor) === false);
}

console.log(`\n${failed === 0 ? "all" : failed + " failed"}`);
if (failed > 0) process.exitCode = 1;
