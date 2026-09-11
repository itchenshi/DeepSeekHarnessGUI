"use strict";

/**
 * 插件状态指纹（纯函数，可脱离 Electron 单测）。
 *
 * 插件的**两个正交状态**都进指纹，任何一个变了设置窗口都要重绘：
 *   - installed/bundle/present/version = 安装状态（profiles/web package.json
 *     的 dsh.profile.bundles + node_modules 实存）；
 *   - enabled/disabledBy = 启用状态（profile 用户补丁层 cordis.patch.yml 的
 *     `- id: X` + `disabled: true` 行，以及市场 .dsh-market/state.json 的
 *     disabled 列表）。
 *
 * 指纹用于 profile 目录 watch 判重——GUI 自己写文件触发的 fs.watch 事件与插件
 * 市场/手改补丁层的真实改动都经过它，指纹没变就不广播，避免自我刷新循环。
 */

/** 安装 + 启用状态指纹。 */
function statusFingerprint(status) {
  const out = {};
  for (const id of Object.keys(status ?? {}).sort()) {
    const s = status[id] ?? {};
    out[id] = {
      installed: Boolean(s.installed),
      bundle: Boolean(s.bundle),
      present: Boolean(s.present),
      version: s.version ?? null,
      enabled: s.enabled === undefined ? true : Boolean(s.enabled),
      disabledBy: s.disabledBy ?? null,
    };
  }
  return JSON.stringify(out);
}

module.exports = {
  statusFingerprint,
};