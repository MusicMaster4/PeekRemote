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
  screen,
} = require("electron");

const config = require("./config");
const tailscale = require("./tailscale");
const elevation = require("./elevation");
const { Backend } = require("./backend");
const { setupUpdater } = require("./updater");

const backend = new Backend();
let win = null;
let tray = null;
let updater = null;
let isQuitting = false;
let crashRestarts = 0;
let singleInstanceHandlerRegistered = false;

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
const shouldBridgeToElevated = elevation.shouldRelaunchElevated();
if (!shouldBridgeToElevated && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (!shouldBridgeToElevated) registerSingleInstanceHandler();
  app.whenReady().then(init);
}

function registerSingleInstanceHandler() {
  if (singleInstanceHandlerRegistered) return;
  singleInstanceHandlerRegistered = true;
  app.on("second-instance", () => showWindow());
}

async function init() {
  app.setAppUserModelId("com.peekremote.desktop");
  if (elevation.shouldRelaunchElevated()) {
    const relaunched = await elevation.relaunchElevatedSelf();
    if (relaunched) {
      app.quit();
      return;
    }
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    registerSingleInstanceHandler();
  }

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
  if (c.autoStart) {
    applyAutoStart(true).catch((err) => console.error("[main] auto-start repair failed:", err));
  }

  if (c.autoCheckUpdates && app.isPackaged) {
    setTimeout(() => updater.check(), 4000);
  }
}

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  // Open at ~60% of the screen, kept in a comfortable landscape ratio and
  // clamped so it never gets tiny on small displays or huge on large ones.
  const winWidth = clamp(Math.round(sw * 0.6), 880, 1500);
  const winHeight = clamp(
    Math.round(winWidth / 1.5),
    580,
    Math.round(sh * 0.85)
  );

  win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 840,
    minHeight: 560,
    center: true,
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
      // Idle-CPU rule: let Chromium fully throttle timers/paint when the window
      // is hidden to the tray (the common steady state for this app).
      backgroundThrottling: true,
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
  // Windows tray: load the multi-resolution .ico so Windows renders the icon
  // sharply at small sizes (resizing the 1024px PNG down to ~16px was producing
  // a blank slot on some setups). PNG elsewhere.
  const trayPath = process.platform === "win32" ? ICON_PATH : TRAY_ICON_PATH;
  let image = nativeImage.createFromPath(trayPath);
  if (!image.isEmpty()) {
    const size = process.platform === "darwin" ? 18 : 16;
    image = image.resize({ width: size, height: size });
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
async function applyAutoStart(enabled) {
  if (process.platform === "win32" && app.isPackaged) {
    const result = await elevation.configureAutoStart(Boolean(enabled), process.execPath);
    if (!result.ok) return result;
    // Remove any old Electron login item created by previous builds. The
    // scheduled task is the Windows startup path because it runs elevated.
    app.setLoginItemSettings({ openAtLogin: false });
  } else {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true, // start to tray, no popping window on boot
      args: ["--hidden"],
    });
  }
  config.save({ autoStart: enabled });
  return { ok: true, autoStart: Boolean(enabled) };
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
    elevation: {
      usesElevatedTasks: process.platform === "win32" && app.isPackaged,
      isElevatedTaskLaunch: elevation.isElevatedTaskLaunch(),
    },
  }));

  ipcMain.handle("tailscale:status", () => tailscale.status());

  ipcMain.handle("onboarding:complete", async (_e, { pin, autoStart }) => {
    if (!/^\d{6}$/.test(String(pin || ""))) {
      return { ok: false, message: "PIN must be exactly 6 digits." };
    }
    if (["000000", "111111", "123456", "654321", "121212", "112233"].includes(pin)) {
      return { ok: false, message: "Choose a less predictable 6-digit PIN." };
    }
    // Onboarding succeeds when the PIN is saved and the backend starts.
    // Start-on-boot is a convenience: if Windows refuses to register the task,
    // we record the preference but never block finishing (and never surface raw
    // PowerShell output to the UI).
    config.save({ pin, onboardingComplete: true });
    const autoStartResult = await applyAutoStart(Boolean(autoStart));
    if (!autoStartResult.ok) {
      console.warn("[main] auto-start not configured:", autoStartResult.message);
    }
    try {
      await backend.stop();
      await startBackend();
      return { ok: true, autoStartConfigured: autoStartResult.ok };
    } catch (err) {
      return { ok: false, message: String(err.message || err) };
    }
  });

  ipcMain.handle("onboarding:restart", () => {
    config.save({ onboardingComplete: false });
    return { ok: true };
  });

  ipcMain.handle("config:setAutoStart", (_e, enabled) => applyAutoStart(Boolean(enabled)));

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
    return updater.quitAndInstall();
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
