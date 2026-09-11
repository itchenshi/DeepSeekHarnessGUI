"use strict";

/**
 * 单元测试：src/plugin-state.js
 * 运行：node src/test/plugin-state.test.cjs
 *
 * 勾选框 = 安装状态的实时镜像（不持久化期望集合），唯一需要保证的是
 * statusFingerprint 的稳定性：同样的安装状态产生同样的指纹，任何字段变化
 * 都改变指纹——profile 清单 watch 靠它判重，避免 GUI 自己写文件造成
 * 自我刷新循环。
 */

const assert = require("assert");
const path = require("path");
const { statusFingerprint } = require(path.join(__dirname, "..", "plugin-state.js"));

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log("  ok - " + name);
}

console.log("plugin-state:");

ok("指纹与键顺序无关", () => {
  const a = statusFingerprint({ x: { installed: true }, y: { installed: false } });
  const b = statusFingerprint({ y: { installed: false }, x: { installed: true } });
  assert.strictEqual(a, b);
});

ok("指纹忽略无关字段，只关心 installed/bundle/present/version/enabled/disabledBy", () => {
  const a = statusFingerprint({ x: { installed: true, bundle: true, present: true, version: "1.0.0", pkg: "x", extra: 1 } });
  const b = statusFingerprint({ x: { installed: true, bundle: true, present: true, version: "1.0.0" } });
  assert.strictEqual(a, b);
});

ok("安装状态变化会改变指纹", () => {
  const before = statusFingerprint({ market: { installed: true, bundle: true, present: true, version: "1.0.0" } });
  const after = statusFingerprint({ market: { installed: false, bundle: false, present: true, version: null } });
  assert.notStrictEqual(before, after);
});

ok("半残状态（bundle 登记了但文件没了）指纹也不同", () => {
  const okState = statusFingerprint({ x: { installed: true, bundle: true, present: true, version: "0.1.0" } });
  const half = statusFingerprint({ x: { installed: false, bundle: true, present: false, version: null } });
  assert.notStrictEqual(okState, half);
});

ok("版本变化会改变指纹", () => {
  const v1 = statusFingerprint({ x: { installed: true, bundle: true, present: true, version: "1.0.0" } });
  const v2 = statusFingerprint({ x: { installed: true, bundle: true, present: true, version: "1.0.1" } });
  assert.notStrictEqual(v1, v2);
});

ok("空 / undefined 输入不抛异常", () => {
  assert.strictEqual(statusFingerprint(undefined), "{}");
  assert.strictEqual(statusFingerprint({}), "{}");
});

ok("相同状态幂等（重绘用）", () => {
  const status = { a: { installed: true }, b: { installed: false, present: true } };
  assert.strictEqual(statusFingerprint(status), statusFingerprint(status));
});

ok("启用状态变化会改变指纹（启用/禁用是独立于安装的第二维度）", () => {
  const on = statusFingerprint({ x: { installed: true, bundle: true, present: true, version: "1.0.0", enabled: true } });
  const off = statusFingerprint({ x: { installed: true, bundle: true, present: true, version: "1.0.0", enabled: false } });
  assert.notStrictEqual(on, off);
});

ok("禁用来源（市场 / 补丁层）不同 → 指纹不同", () => {
  const byMarket = statusFingerprint({
    x: { installed: true, enabled: false, disabledBy: "market" },
  });
  const byPatch = statusFingerprint({
    x: { installed: true, enabled: false, disabledBy: "patch" },
  });
  assert.notStrictEqual(byMarket, byPatch);
});

ok("已装但未带 enabled 字段时按启用处理（向后兼容）", () => {
  const legacy = statusFingerprint({ x: { installed: true, bundle: true, present: true, version: "1.0.0" } });
  const explicit = statusFingerprint({
    x: { installed: true, bundle: true, present: true, version: "1.0.0", enabled: true, disabledBy: null },
  });
  assert.strictEqual(legacy, explicit);
});

console.log("\nplugin-state: " + checks + " checks passed");