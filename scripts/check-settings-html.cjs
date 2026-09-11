"use strict";

/**
 * 校验 src/settings.html 里内嵌的 <script> 语法，并断言插件行结构的两条硬约束。
 * 运行：node scripts/check-settings-html.cjs
 *
 * 为什么需要它：settings.html 的 JS 是内联在 HTML 里的，`node --check` 管不到；
 * 一处拼写错误会让整个设置窗口白屏，而单元测试看不到。
 *
 * 断言的结构约束（都踩过）：
 *   1. 启用开关必须在安装 <label> **外面**——HTML label 会把内部第一个可标注
 *      控件当成目标，嵌进去会导致「点启用」顺带切换安装勾选框（意外卸载）。
 *   2. 启用开关必须带 class="plg-enable"（渲染层与测试按它取元素）。
 */

const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "src", "settings.html");
const html = fs.readFileSync(file, "utf8");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok - " + name);
  } catch (error) {
    failures += 1;
    console.log("  FAIL - " + name + ": " + error.message);
  }
}

console.log("settings.html:");

check("内嵌 <script> 语法正确", () => {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (blocks.length === 0) throw new Error("no inline <script> block found");
  for (const block of blocks) {
    // eslint-disable-next-line no-new-func
    new Function(block);
  }
});

check("安装/启用两个状态都在渲染里（不会只剩一个）", () => {
  for (const token of ["plg-check", "plg-enable", "enabledText"]) {
    if (!html.includes(token)) throw new Error("missing " + token);
  }
});

check("启用开关不在安装 <label> 内部（否则点击会连带切换安装）", () => {
  const start = html.indexOf("function renderPlugins");
  if (start < 0) throw new Error("renderPlugins not found");
  const end = html.indexOf("\n    }", start);
  const body = html.slice(start, end > 0 ? end : start + 6000);
  const labelClose = body.indexOf("</span></label>");
  const enableUse = body.indexOf("enableRow +");
  if (labelClose < 0) throw new Error("install </label> not found in renderPlugins");
  if (enableUse < 0) throw new Error("enableRow not interpolated in renderPlugins");
  if (enableUse < labelClose) {
    throw new Error("enableRow is rendered INSIDE the install label (nested labels toggle the wrong box)");
  }
});

check("i18n 中英文都有启用/禁用文案", () => {
  const keys = [
    "settings.plugins.enableLabel",
    "settings.plugins.enabled",
    "settings.plugins.disabled",
    "settings.plugins.disabledByMarket",
    "settings.plugins.disabledByPatch",
    "settings.plugins.driftHint",
    "settings.plugins.reloadPage",
    "settings.plugins.needRefresh",
  ];
  for (const key of keys) {
    const occurrences = html.split('"' + key + '"').length - 1;
    if (occurrences < 2) throw new Error(key + " should exist in both zh and en tables (found " + occurrences + ")");
  }
});

check("刷新页面按钮存在、默认隐藏，且由 refresh 信号驱动", () => {
  const tag = /<button id="btnReloadPage"[^>]*>/.exec(html);
  if (!tag) throw new Error("btnReloadPage button tag not found in the markup");
  if (!/\bhidden\b/.test(tag[0])) throw new Error("btnReloadPage must start hidden");
  // The enable/disable handler must react to the market's refresh signal and the
  // button must call the IPC that reloads the engine window.
  if (!/res\.refresh/.test(html)) throw new Error("the toggle handler must react to res.refresh");
  if (!/reloadEngineWindow/.test(html)) throw new Error("the reload button must call api.reloadEngineWindow");
});

if (failures > 0) {
  console.log("\nsettings.html: " + failures + " check(s) FAILED");
  process.exit(1);
}
console.log("\nsettings.html: all checks passed");
