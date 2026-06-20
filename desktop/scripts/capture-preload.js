"use strict";

// Stub bridge used ONLY to capture README screenshots. It mirrors the shape of
// src/preload.js but returns fixed, non-sensitive placeholder data so the
// screenshots never leak a real PIN, QR login token, or tailnet hostname.
const { contextBridge } = require("electron");
const fs = require("fs");
const path = require("path");

const QR_SVG = fs.readFileSync(path.join(__dirname, "_qr_placeholder.svg"), "utf-8");

// Generic, obviously-fake values.
const FAKE_HOST = "your-pc.tailnet.ts.net";
const APP_URL = `https://${FAKE_HOST}`;
const now = () => Math.floor(Date.now() / 1000);

contextBridge.exposeInMainWorld("peek", {
  appInfo: async () => ({
    version: "1.0.3",
    platform: "win32",
    isPackaged: false,
    config: {
      onboardingComplete: false,
      hasPin: false,
      autoStart: true,
      autoCheckUpdates: true,
    },
    backend: { running: false, port: null },
    elevation: { usesElevatedTasks: false, isElevatedTaskLaunch: false },
  }),
  tailscaleStatus: async () => ({
    found: true,
    loggedIn: true,
    running: true,
    dnsName: FAKE_HOST,
  }),
  connectInfo: async () => ({
    ok: true,
    info: {
      tailscale_ready: true,
      tailscale_found: true,
      app_url: APP_URL,
      connect_url: `${APP_URL}/connect`,
      qr_svg: QR_SVG,
      expires_at: now() + 1500, // shows "25:00" on the timer
      ttl_seconds: 1800,
      os: "windows",
    },
  }),
  backendLogs: async () => [],
  completeOnboarding: async () => ({ ok: true }),
  restartOnboarding: async () => ({ ok: true }),
  setAutoStart: async () => ({ ok: true, autoStart: true }),
  setAutoCheckUpdates: async () => ({ ok: true }),
  restartBackend: async () => ({ ok: true }),
  checkForUpdate: async () => ({ ok: true, updateAvailable: false, version: "1.0.3" }),
  downloadUpdate: async () => ({ ok: true }),
  installUpdate: async () => ({ ok: true }),
  openExternal: async () => {},
  copy: async () => ({ ok: true }),
  onBackendState: () => () => {},
  onBackendLog: () => () => {},
  onUpdateStatus: () => () => {},
});
