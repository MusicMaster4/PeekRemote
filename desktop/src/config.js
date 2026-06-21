"use strict";

const path = require("path");
const fs = require("fs");
const { app } = require("electron");

// Config lives in userData (e.g. %APPDATA%/Peek Remote on Windows,
// ~/Library/Application Support/Peek Remote on macOS). This directory persists
// across app updates, so the user's PIN and preferences are kept automatically.
const CONFIG_PATH = () => path.join(app.getPath("userData"), "config.json");

const DEFAULTS = {
  pin: "",
  onboardingComplete: false,
  autoStart: false,
  autoCheckUpdates: true,
  clipboardSync: false,
  serverPort: 1739,
};

let cache = null;

// Port 8000 was the old default. It's heavily contended (dev servers grab it),
// and since the app auto-starts at boot it would squat on 8000 before the user
// could use it. The port is never user-configurable, so any persisted 8000 is
// just the stale default — migrate it forward to the current default.
const LEGACY_DEFAULT_PORT = 8000;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), "utf-8");
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
    if (cache.serverPort === LEGACY_DEFAULT_PORT) {
      cache.serverPort = DEFAULTS.serverPort;
    }
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  cache = next;
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    console.error("[config] failed to save:", err);
  }
  return next;
}

function get(key) {
  return load()[key];
}

// The PIN is a secret; never hand it to the renderer. `publicState` is what the
// UI is allowed to see.
function publicState() {
  const c = load();
  return {
    hasPin: Boolean(c.pin && /^\d{6}$/.test(c.pin)),
    onboardingComplete: Boolean(c.onboardingComplete),
    autoStart: Boolean(c.autoStart),
    autoCheckUpdates: Boolean(c.autoCheckUpdates),
    clipboardSync: Boolean(c.clipboardSync),
    serverPort: c.serverPort || DEFAULTS.serverPort,
  };
}

module.exports = { load, save, get, publicState, CONFIG_PATH, DEFAULTS };
