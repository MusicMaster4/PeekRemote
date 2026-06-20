"use strict";

const path = require("path");
const http = require("http");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  clipboard,
  shell,
} = require("electron");

const config = require("./config");
const tailscale = require("./tailscale");
const { Backend } = require("./backend");
const { setupUpdater } = require("./updater");

const backend = new Backend();
let win = null;
let tray = null;
let updater = null;
let isQuitting = false;
let crashRestarts = 0;

// Window/taskbar icon: the multi-res .ico is sharpest on Windows; PNG elsewhere.
const ICON_PATH = path.join(
  __dirname,
  "..",
  "build",
  process.platform === "win32" ? "icon.ico" : "icon.png"
);
// Tray reads the PNG so it downscales cleanly to menu-bar size.
const TRAY_ICON_PATH = path.join(__dirname, "..", "build", "icon.png");

// Single instance: a second launch just focuses the existing window so we never
// run two backends on the same machine.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(init);
}

function init() {
  app.setAppUserModelId("com.peekremote.desktop");
  createWindow();
  createTray();
  updater = setupUpdater(() => win);
  registerIpc();

  backend.on("log", (line) => sendToRenderer("backend:log", line));
  backend.on("ready", ({ port }) => sendToRenderer("backend:state", { running: true, port }));
  backend.on("exit", onBackendExit);

  const c = config.load();
  if (c.onboardingComplete && c.pin) {
    startBackend().catch((err) => console.error("[main] backend start failed:", err));
  }

  if (c.autoCheckUpdates && app.isPackaged) {
    setTimeout(() => updater.check(), 4000);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 400,
    minHeight: 620,
    backgroundColor: "#08080a",
    title: "Peek Remote",
    icon: ICON_PATH,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // When launched at login we start straight to the tray (no window popping up
  // on boot). The login item passes --hidden; macOS also reports it directly.
  const startHidden =
    process.argv.includes("--hidden") ||
    (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAsHidden);
  win.once("ready-to-show", () => {
    if (!startHidden) win.show();
  });

  // Closing the window hides to tray so the backend keeps serving the phone.
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Open external links in the system browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function createTray() {
  let image = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (!image.isEmpty()) {
    image = image.resize({ width: 18, height: 18 });
    if (process.platform === "darwin") image.setTemplateImage(false);
  }
  try {
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  } catch {
    return;
  }
  tray.setToolTip("Peek Remote");
  const menu = Menu.buildFromTemplate([
    { label: "Open Peek Remote", click: () => showWindow() },
    { type: "separator" },
    {
      label: "Quit (stops remote access)",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => showWindow());
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function startBackend() {
  const c = config.load();
  crashRestarts = 0;
  await backend.start({
    pin: c.pin,
    port: c.serverPort,
    dataDir: app.getPath("userData"),
    tailscalePath: tailscale.exePath(),
  });
}

function onBackendExit({ code }) {
  sendToRenderer("backend:state", { running: false, code });
  const c = config.load();
  // Auto-recover from an unexpected crash a few times (not while quitting).
  if (!isQuitting && c.onboardingComplete && c.pin && crashRestarts < 3) {
    crashRestarts += 1;
    setTimeout(() => {
      backend
        .start({
          pin: c.pin,
          port: c.serverPort,
          dataDir: app.getPath("userData"),
          tailscalePath: tailscale.exePath(),
        })
        .catch((err) => console.error("[main] restart failed:", err));
    }, 1500 * crashRestarts);
  }
}

// ---- Auto-start at login -------------------------------------------------
function applyAutoStart(enabled) {
  // Built-in login item. Note: launches non-elevated; controlling elevated
  // (admin) windows on Windows still requires running the app as administrator.
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true, // start to tray, no popping window on boot
    args: ["--hidden"],
  });
  config.save({ autoStart: enabled });
}

// ---- Connection info (QR) ------------------------------------------------
function fetchConnectInfo() {
  return new Promise((resolve) => {
    const port = backend.port;
    if (!port || !backend.isRunning()) {
      resolve({ ok: false, reason: "backend_down" });
      return;
    }
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/connect-info", timeout: 8000 },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve({ ok: true, info: JSON.parse(body) });
          } catch {
            resolve({ ok: false, reason: "bad_response" });
          }
        });
      }
    );
    req.on("error", () => resolve({ ok: false, reason: "request_failed" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, reason: "timeout" });
    });
  });
}

// ---- IPC -----------------------------------------------------------------
function registerIpc() {
  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    config: config.publicState(),
    backend: { running: backend.isRunning(), port: backend.port },
  }));

  ipcMain.handle("tailscale:status", () => tailscale.status());

  ipcMain.handle("onboarding:complete", async (_e, { pin, autoStart }) => {
    if (!/^\d{6}$/.test(String(pin || ""))) {
      return { ok: false, message: "PIN must be exactly 6 digits." };
    }
    if (["000000", "111111", "123456", "654321", "121212", "112233"].includes(pin)) {
      return { ok: false, message: "Choose a less predictable 6-digit PIN." };
    }
    config.save({ pin, onboardingComplete: true });
    applyAutoStart(Boolean(autoStart));
    try {
      await backend.stop();
      await startBackend();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err.message || err) };
    }
  });

  ipcMain.handle("onboarding:restart", () => {
    config.save({ onboardingComplete: false });
    return { ok: true };
  });

  ipcMain.handle("config:setAutoStart", (_e, enabled) => {
    applyAutoStart(Boolean(enabled));
    return { ok: true, autoStart: Boolean(enabled) };
  });

  ipcMain.handle("config:setAutoCheckUpdates", (_e, enabled) => {
    config.save({ autoCheckUpdates: Boolean(enabled) });
    return { ok: true };
  });

  ipcMain.handle("backend:restart", async () => {
    await backend.stop();
    await startBackend();
    return { ok: true, port: backend.port };
  });

  ipcMain.handle("backend:logs", () => backend.recentLogs());

  ipcMain.handle("connect:info", () => fetchConnectInfo());

  ipcMain.handle("update:check", () => updater.check());
  ipcMain.handle("update:download", () => updater.download());
  ipcMain.handle("update:install", async () => {
    // Stop the backend first so before-quit lets the updater's installer run
    // (it relies on a normal quit).
    isQuitting = true;
    await backend.stop();
    updater.quitAndInstall();
  });

  ipcMain.handle("app:openExternal", (_e, url) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle("app:copy", (_e, text) => {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  });
}

// ---- Lifecycle -----------------------------------------------------------
app.on("window-all-closed", () => {
  // Do nothing: keep running in the tray so remote access stays available.
});

app.on("activate", () => showWindow());

app.on("before-quit", async (e) => {
  if (backend.isRunning()) {
    e.preventDefault();
    isQuitting = true;
    await backend.stop();
    app.exit(0);
  }
});
