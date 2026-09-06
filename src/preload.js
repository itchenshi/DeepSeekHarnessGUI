"use strict";

// Preload for the settings window only — exposes a narrow, safe API for
// reading/updating the persisted settings. The main dsh window has no
// preload, so the harness page never sees this.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshSettings", {
  get: () => ipcRenderer.invoke("settings:get"),
  set: (patch) => ipcRenderer.invoke("settings:set", patch),
  onChanged: (callback) => {
    ipcRenderer.on("settings:changed", (_event, settings) => callback(settings));
  },
});