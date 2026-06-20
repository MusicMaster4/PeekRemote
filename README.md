# Peek Remote

See and control your computer from your phone — privately, over your own
Tailscale network. No public links, no accounts to create, no cloud in the
middle. Open the app, scan a QR code with your phone, and you're in.

---

## Install (the easy way)

**Just want to use it? Download the installer — you don't need anything else
technical.**

➡️ **[Download from the Releases page](https://github.com/MusicMaster4/PeekRemote/releases/latest)**

- **Windows** — download `Peek-Remote-...-Setup.exe` and run it.
- **macOS (Apple Silicon)** — download `Peek-Remote-...-arm64.dmg`, open it, and
  drag the app to Applications. The build is currently unsigned, so the first
  time you open it, **right-click the app → Open** (or allow it in System
  Settings → Privacy & Security).

The app updates itself from inside (see [Updates](#updates)), so you only ever
download it once.

### The one thing you need: Tailscale

Peek Remote uses [Tailscale](https://tailscale.com/download) to create a private
tunnel between your computer and your phone. It's free for personal use.

1. Install Tailscale on **this computer** and sign in.
2. Install Tailscale on **your phone** and sign in to the **same account**.
3. Keep it connected on both.

That's it — the in-app setup guide walks you through this the first time you open
Peek Remote.

---

## First time you open it

A short setup guide appears and helps you:

1. **Check Tailscale** is installed and connected.
2. **Pick a 6-digit PIN** (a fallback login for your phone).
3. **Choose whether to start Peek Remote automatically** when your computer
   turns on.

You can re-run this guide anytime from **Settings → Re-run setup**.

---

## Using it

1. Open Peek Remote on your computer. It shows a **QR code**.
2. On your phone, **scan the QR code** (just the camera app works). It opens your
   private link and logs in automatically — no typing.
3. You're now looking at your computer's screen. From there you can:
   - **Move and click** by dragging a crosshair, with pinch-to-zoom.
   - **Type** and send keyboard shortcuts.
   - **Use ready-made shortcuts** (Copy, Paste, switch apps, etc.).
   - **Put the computer to sleep** with a short cancel window.

The QR refreshes on a timer for safety. If it expires, tap **New QR** or just
reopen the app — it generates a fresh one.

> **Shortcuts adapt to your computer.** If the computer you're controlling is a
> Mac, the buttons show ⌘ Cmd / ⌥ Option and Mac shortcuts (Spotlight, ⌘+Tab,
> Force Quit…). On Windows you get Ctrl / Alt / Win and Windows shortcuts
> (Alt+Tab, Task Manager…). You don't have to think about it.

Peek Remote keeps running quietly in the **tray / menu bar** so your phone can
connect even when the window is closed. To fully stop remote access, use the tray
icon → **Quit**.

---

## Settings

Open the app window to find:

- **Start on login** — launch Peek Remote (to the tray) when your computer boots.
- **Auto-check for updates** — look for a new version on launch.
- **Re-run setup** — go through the guide again to change your PIN or options.

### Updates

When a new version is available, Peek Remote tells you right inside the app.
Click **Download**, then **Install & Restart** — it updates itself and keeps all
your settings (your PIN and preferences are preserved). No reinstalling.

---

## A note on privacy

Peek Remote can see your screen and control your mouse and keyboard, so treat it
like a key to your computer:

- It's only reachable through **your** Tailscale network — never the public
  internet.
- Use a PIN you don't use anywhere else.
- Don't share your QR code or screenshots.
- If you think someone saw your QR or PIN, reopen the app (a new key is created)
  or remove unknown sessions from the sessions screen on your phone.

> **Windows tip:** to control administrator windows (like Task Manager), right
> click Peek Remote and choose **Run as administrator**.
>
> **macOS tip:** the first time you control your Mac, approve **Screen
> Recording** and **Accessibility** for Peek Remote in System Settings → Privacy
> & Security.

---
---

## For developers (building from source)

Everything below is optional — only needed if you want to build the app yourself
or hack on it.

### How it's built

Peek Remote is an **Electron desktop app** that bundles a **Python (FastAPI)
backend**:

- **`desktop/`** — the Electron control panel (onboarding, QR pairing, settings,
  in-app updates). It spawns and supervises the backend.
- **`app/`** — the FastAPI backend. It captures the screen, injects mouse and
  keyboard input, publishes the service to your tailnet with `tailscale serve`,
  and serves the phone UI. The OS-level work (screen capture, input, sleep) is
  why it stays in Python.
- **`web/`** — the phone UI (Next.js, exported as a static site and served by the
  backend). It adapts its shortcuts to the host OS reported by the backend.

In a release build, the backend is compiled to a standalone executable with
**PyInstaller** and shipped inside the Electron app, so end users never install
Python.

### Run it from source

Clone into a folder named after the app:

```bash
git clone https://github.com/MusicMaster4/PeekRemote.git peek-remote
cd peek-remote
```

**1. Backend (Python 3.11/3.12):**

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

**2. Frontend (Node LTS):**

```bash
cd web
npm install
npm run build      # outputs web/out, served by the backend
cd ..
```

**3. Desktop shell (Electron):**

```bash
cd desktop
npm install
npm start          # runs Electron; in dev it launches the backend via the .venv
```

In dev mode the Electron app runs the backend with the project's virtualenv
Python (override with the `PEEK_BACKEND_PYTHON` environment variable).

### Build installers locally

```bash
# from the repo root, with web/out already built:
pip install pyinstaller
pyinstaller peek-backend.spec --noconfirm      # -> dist/peek-backend/

cd desktop
npm install
npm run dist                                    # -> dist-electron/
```

### Releasing (automated + self-versioning)

Releases build and **bump their own version** — you don't edit any version by
hand. In GitHub: **Actions → "Build & Release" → Run workflow**.

- Each run computes the next version automatically: **latest release + 0.0.1**
  (choose `minor`/`major` from the dropdown to jump further).
- It then builds the Next.js frontend, the PyInstaller backend, and the Electron
  installers for Windows and macOS, and publishes a GitHub Release with
  auto-update metadata. Clients see the update in-app.
- Need an **exact** version once? Set it in `desktop/package.json` (higher than
  the latest release) and run the workflow — that version is used as-is.
- Uncheck **publish** in the dropdown for a test build (uploads installers as
  workflow artifacts, no release, no version bump).

`.github/workflows/release.yml` drives all of this.

- **Windows** auto-update works out of the box (unsigned is fine).
- **macOS** auto-update requires a signed, notarized build. Add the signing
  secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) to the repo to enable it;
  otherwise distribute the new `.dmg` manually.

### Backend configuration (advanced)

The desktop app passes configuration to the backend automatically (PIN, port,
data directory). When running the backend directly, it reads the same values from
the environment or a `.env` file:

| Variable | Default | Description |
| --- | --- | --- |
| `APP_PIN` | required | 6-digit numeric PIN. The server refuses to start without it. |
| `SERVER_HOST` | `127.0.0.1` | Local host. Never bind to `0.0.0.0`. |
| `SERVER_PORT` | `8000` | Local port and Tailscale Serve target. |
| `TAILSCALE_PATH` | empty | Path to the Tailscale CLI. Empty = autodetect. |
| `QR_TTL_SECONDS` | `1800` | QR login token lifetime. |
| `QR_OPEN_BROWSER` | `true` | Open the `/connect` page on start (the desktop app sets this to `false`). |
| `AUDIT_LOG_FILE` | `audit.log` | Local audit log path. |
| `MAX_FAILED_LOGINS` | `5` | Wrong PIN attempts before blocking until restart. |

### Troubleshooting

- **"Tailscale offline" in the app** — open Tailscale, sign in, make sure it's
  connected and that MagicDNS is enabled in the Tailscale admin console.
- **Phone can't open the link** — confirm the phone is on the same tailnet and
  connected.
- **Input doesn't work in some windows (Windows)** — run Peek Remote as
  administrator.
- **Input/capture blocked (macOS)** — grant Screen Recording and Accessibility
  permissions.

## License

Custom non-commercial license — you may use, copy, modify, and distribute it for
personal, educational, evaluation, or internal purposes, but not sell or
monetize it without written permission. See [LICENSE](LICENSE).
