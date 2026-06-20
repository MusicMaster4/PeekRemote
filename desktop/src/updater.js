"use strict";

const { app } = require("electron");

/**
 * Thin wrapper over electron-updater. Forwards lifecycle events to the renderer
 * so the UI can show "update available", a download progress bar, and an
 * "Install & Restart" button.
 *
 * User config lives in userData (see config.js), which survives the update, so
 * settings/PIN are preserved automatically across versions.
 */
function setupUpdater(getWindow) {
  // electron-updater is a no-op without packaged update metadata; only wire it
  // up in the packaged app to avoid "dev-app-update.yml not found" noise.
  if (!app.isPackaged) {
    return makeDevStub();
  }

  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = false; // user clicks to download
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  autoUpdater.on("checking-for-update", () => send("update:status", { state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    send("update:status", { state: "available", version: info.version, notes: info.releaseNotes })
  );
  autoUpdater.on("update-not-available", (info) =>
    send("update:status", { state: "none", version: info.version })
  );
  autoUpdater.on("error", (err) =>
    send("update:status", { state: "error", message: String(err && err.message ? err.message : err) })
  );
  autoUpdater.on("download-progress", (p) =>
    send("update:status", {
      state: "downloading",
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    })
  );
  autoUpdater.on("update-downloaded", (info) =>
    send("update:status", { state: "downloaded", version: info.version })
  );

  return {
    async check() {
      try {
        const r = await autoUpdater.checkForUpdates();
        return { ok: true, version: r && r.updateInfo ? r.updateInfo.version : null };
      } catch (err) {
        return { ok: false, message: String(err && err.message ? err.message : err) };
      }
    },
    async download() {
      try {
        await autoUpdater.downloadUpdate();
        return { ok: true };
      } catch (err) {
        return { ok: false, message: String(err && err.message ? err.message : err) };
      }
    },
    quitAndInstall() {
      // isSilent=false, isForceRunAfter=true → relaunch the app after updating.
      autoUpdater.quitAndInstall(false, true);
    },
  };
}

function makeDevStub() {
  return {
    async check() {
      return { ok: true, version: null, dev: true };
    },
    async download() {
      return { ok: false, message: "Updates are only available in the installed app." };
    },
    quitAndInstall() {},
  };
}

module.exports = { setupUpdater };
