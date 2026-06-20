"use strict";

// Regenerates the README walkthrough screenshots from the REAL renderer UI,
// driven by a stub bridge (capture-preload.js) that feeds only non-sensitive
// placeholder data — no real PIN, QR login token, or tailnet hostname.
//
// Run:  npx electron desktop/scripts/capture-readme.js
// Out:  docs/readme/01-welcome.png … 05-dashboard.png  (980x680)

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

// Match the existing README assets exactly (1x device pixels).
app.commandLine.appendSwitch("force-device-scale-factor", "1");

const REPO_ROOT = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "readme");
const RENDERER = path.join(__dirname, "..", "renderer", "index.html");

const W = 980;
const H = 680;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(win, name) {
  await sleep(120); // let the latest paint flush
  const img = await win.webContents.capturePage();
  const out = path.join(OUT_DIR, name);
  fs.writeFileSync(out, img.toPNG());
  console.log("saved", name);
}

const run = (win, js) => win.webContents.executeJavaScript(js, true);

async function main() {
  const win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    show: true,
    backgroundColor: "#08080a",
    webPreferences: {
      preload: path.join(__dirname, "capture-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  await win.loadFile(RENDERER);
  // boot() runs on load and shows onboarding at step 0 (Welcome).
  await sleep(1800); // welcome intro animation settles
  await capture(win, "01-welcome.png");

  // Step 1 — Install Tailscale (async status resolves to "Connected as …").
  await run(win, `document.getElementById('onb-next').click();`);
  await sleep(1100);
  await capture(win, "02-tailscale.png");

  // Step 2 — Set up your phone (the new step, between Tailscale and PIN).
  await run(win, `document.getElementById('onb-next').click();`);
  await sleep(900);
  await capture(win, "03-phone.png");

  // Step 3 — Set a PIN. Type a fabricated 6-digit PIN and let it mask to dots.
  await run(win, `document.getElementById('onb-next').click();`);
  await sleep(700);
  await run(
    win,
    `(() => {
       const i = document.getElementById('pin-input');
       i.value = '428190';
       i.dispatchEvent(new Event('input', { bubbles: true }));
     })();`
  );
  await sleep(2300); // per-digit reveal (2s) lapses → all cells show ●
  await capture(win, "04-pin.png");

  // Final — the panel / pairing dashboard (QR + settings). With the backend up
  // and Tailscale publishing, the real panel's status pill reads "Ready".
  await run(win, `showPanel(true); setStatus('dot-ok', 'Ready');`);
  await sleep(1300); // loadConnect() + panel-enter stagger
  await capture(win, "05-dashboard.png");

  win.destroy();
  app.quit();
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  })
);
