"use strict";

const { app } = require("electron");

/**
 * Thin wrapper over electron-updater. The wrapper owns the update state so the
 * renderer cannot show a stale "available" banner while electron-updater has no
 * checked update ready to download.
 */
function setupUpdater(getWindow) {
  if (!app.isPackaged) {
    return makeDevStub();
  }

  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  let status = { state: "idle" };
  let availableInfo = null;
  let downloadedInfo = null;

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const emitStatus = (payload) => {
    status = payload;
    send("update:status", payload);
  };

  const messageOf = (err) => String(err && err.message ? err.message : err);

  autoUpdater.on("checking-for-update", () => emitStatus({ state: "checking" }));

  autoUpdater.on("update-available", (info) => {
    availableInfo = info;
    downloadedInfo = null;
    emitStatus({ state: "available", version: info.version, notes: info.releaseNotes });
  });

  autoUpdater.on("update-not-available", (info) => {
    availableInfo = null;
    downloadedInfo = null;
    autoUpdater.updateInfoAndProvider = null;
    emitStatus({ state: "none", version: info.version });
  });

  autoUpdater.on("error", (err) => {
    emitStatus({ state: "error", message: messageOf(err) });
  });

  autoUpdater.on("download-progress", (p) => {
    emitStatus({
      state: "downloading",
      version: availableInfo && availableInfo.version,
      percent: Math.round(p.percent || 0),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    downloadedInfo = info;
    emitStatus({ state: "downloaded", version: info.version });
  });

  return {
    async check() {
      try {
        const result = await autoUpdater.checkForUpdates();
        const updateInfo = result && result.updateInfo ? result.updateInfo : null;
        return {
          ok: true,
          updateAvailable: Boolean(result && result.isUpdateAvailable),
          version: updateInfo ? updateInfo.version : null,
          state: status.state,
        };
      } catch (err) {
        return { ok: false, message: messageOf(err), state: status.state };
      }
    },

    async download() {
      try {
        if (downloadedInfo) {
          emitStatus({ state: "downloaded", version: downloadedInfo.version });
          return { ok: true, alreadyDownloaded: true, version: downloadedInfo.version };
        }

        if (!availableInfo) {
          const checkResult = await this.check();
          if (!checkResult.ok) return checkResult;
          if (!checkResult.updateAvailable) {
            return {
              ok: false,
              noUpdate: true,
              message: "No update is available. You're on the latest version.",
              state: status.state,
            };
          }
        }

        await autoUpdater.downloadUpdate();
        return {
          ok: true,
          version: downloadedInfo ? downloadedInfo.version : availableInfo && availableInfo.version,
        };
      } catch (err) {
        if (availableInfo) {
          emitStatus({
            state: "available",
            version: availableInfo.version,
            notes: availableInfo.releaseNotes,
            error: messageOf(err),
          });
        }
        return { ok: false, message: messageOf(err), state: status.state };
      }
    },

    quitAndInstall() {
      if (!downloadedInfo) {
        const message = "No downloaded update is ready to install.";
        emitStatus({ state: "error", message });
        return { ok: false, message };
      }
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    },

    status() {
      return status;
    },
  };
}

function makeDevStub() {
  return {
    async check() {
      return { ok: true, version: null, updateAvailable: false, dev: true, state: "dev" };
    },
    async download() {
      return { ok: false, message: "Updates are only available in the installed app." };
    },
    quitAndInstall() {
      return { ok: false, message: "Updates are only available in the installed app." };
    },
    status() {
      return { state: "dev" };
    },
  };
}

module.exports = { setupUpdater };
