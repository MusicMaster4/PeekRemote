"use strict";

const { execFile } = require("child_process");
const fs = require("fs");

const CANDIDATES = {
  win32: [
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
  ],
  darwin: [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
  ],
  linux: ["/usr/bin/tailscale", "/usr/local/bin/tailscale"],
};

function exePath() {
  const list = CANDIDATES[process.platform] || [];
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  // Fall back to PATH lookup.
  return process.platform === "win32" ? "tailscale.exe" : "tailscale";
}

function run(args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(exePath(), args, { timeout, windowsHide: true }, (err, stdout) => {
      resolve({ err, stdout: stdout || "" });
    });
  });
}

/**
 * Inspect the local Tailscale state for onboarding:
 *   found     — the CLI is installed/reachable
 *   running   — the daemon is up and the node is Running (connected)
 *   loggedIn  — the user has authenticated (not "NeedsLogin")
 *   dnsName   — this machine's MagicDNS name (the URL the phone will use)
 */
async function status() {
  const { err, stdout } = await run(["status", "--json"]);
  if (err && !stdout) {
    return { found: false, running: false, loggedIn: false, dnsName: null, backendState: null };
  }
  try {
    const data = JSON.parse(stdout);
    const backendState = data.BackendState || null;
    const dnsName = data.Self && data.Self.DNSName ? data.Self.DNSName.replace(/\.$/, "") : null;
    return {
      found: true,
      running: backendState === "Running",
      loggedIn: backendState !== "NeedsLogin" && backendState !== "NoState",
      dnsName,
      backendState,
    };
  } catch {
    // CLI exists but output wasn't parseable (e.g. needs login text).
    return { found: true, running: false, loggedIn: false, dnsName: null, backendState: null };
  }
}

module.exports = { status, exePath };
