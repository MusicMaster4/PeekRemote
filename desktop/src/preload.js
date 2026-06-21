"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Secure bridge: the renderer never touches Node/Electron directly. The PIN is
// kept in the main process and never sent back to the UI.
contextBridge.exposeInMainWorld("peek", {
  // One-shot queries
  appInfo: () => ipcRenderer.invoke("app:info"),
  tailscaleStatus: () => ipcRenderer.invoke("tailscale:status"),
  connectInfo: () => ipcRenderer.invoke("connect:info"),
  backendLogs: () => ipcRenderer.invoke("backend:logs"),
  listDevices: () => ipcRenderer.invoke("devices:list"),
  renameDevice: (payload) => ipcRenderer.invoke("devices:rename", payload),

  // Onboarding + settings
  completeOnboarding: (payload) => ipcRenderer.invoke("onboarding:complete", payload),
  restartOnboarding: () => ipcRenderer.invoke("onboarding:restart"),
  setAutoStart: (enabled) => ipcRenderer.invoke("config:setAutoStart", enabled),
  setAutoCheckUpdates: (enabled) => ipcRenderer.invoke("config:setAutoCheckUpdates", enabled),
  setClipboardSync: (enabled) => ipcRenderer.invoke("config:setClipboardSync", enabled),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),

  // Updates
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),

  // Misc
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  copy: (text) => ipcRenderer.invoke("app:copy", text),

  // Subscriptions (return an unsubscribe fn)
  onBackendState: (cb) => sub("backend:state", cb),
  onBackendLog: (cb) => sub("backend:log", cb),
  onUpdateStatus: (cb) => sub("update:status", cb),
  onShowPairing: (cb) => sub("ui:show-pairing", cb),
});

function sub(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
