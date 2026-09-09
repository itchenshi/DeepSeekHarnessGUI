"use strict";

// Preload for the settings window only — exposes a narrow, safe API for
// reading/updating the persisted settings and triggering a manual engine
// update check. The main dsh window has no preload, so the harness page
// never sees this.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshSettings", {
  get: () => ipcRenderer.invoke("settings:get"),
  set: (patch) => ipcRenderer.invoke("settings:set", patch),
  checkUpdate: () => ipcRenderer.invoke("settings:update-check"),
  // 立即安装设置中已勾选的第三方插件（启动时也会自动执行）。
  syncPlugins: () => ipcRenderer.invoke("settings:plugin-sync"),
  // 请求 DSH GUI 重启托管的 dsh 引擎（插件安装/挂载后需重启生效）。
  restartEngine: () => ipcRenderer.invoke("settings:restart-engine"),
  // 内容高度变化时通知主进程自适应窗口高度（≤ 屏幕工作区）。
  autoSize: (height) => ipcRenderer.invoke("settings:autosize", height),
  onChanged: (callback) => {
    ipcRenderer.on("settings:changed", (_event, settings) => callback(settings));
  },
});
