# Peek Remote

Peek Remote is a private web console for remotely accessing your own computer through Tailscale. It captures the host screen, shows recent captures in the browser, provides a live mode with periodic refresh, and sends mouse/keyboard commands back to the machine. It also includes a delayed sleep action with a short cancellation window.

This project is designed for personal, private use. It controls the computer running the server, so it should not be exposed directly to the public internet.

## How It Works

The app has two main parts:

- `app/`: FastAPI backend. It authenticates users, captures screenshots, injects mouse/keyboard input, manages sessions, publishes the service to the tailnet with `tailscale serve`, and generates the pairing QR code.
- `web/`: Next.js frontend exported as a static site. The build output goes to `web/out` and is served by FastAPI.

Main flow:

1. The backend starts on `127.0.0.1:8000` by default.
2. On startup, the app runs `tailscale serve --bg http://127.0.0.1:8000`.
3. The app tries to discover the computer's MagicDNS URL, such as `https://my-pc.my-tailnet.ts.net`.
4. The local `/connect` page opens on the PC and shows a QR code.
5. Scanning the QR code opens the tailnet URL on the phone and logs in with a one-time HMAC token.
6. After login, the browser calls the backend APIs using an HTTP-only cookie.

Manual login with the configured 6-digit PIN is also supported.

## Features

- 6-digit PIN login.
- QR pairing with a one-time token and configurable expiration.
- On-demand screen capture.
- Live mode with manual or automatic refresh.
- Remote mouse control: click, double-click, drag, and scroll.
- Remote keyboard control: text input, special keys, and shortcuts.
- Session management: the first authenticated session becomes the owner and can revoke other sessions.
- Sleep computer action with a 10-second cancellation window.
- Local audit log for logins, logouts, blocks, revoked sessions, and sleep actions.
- Security headers and disabled response caching.

## Requirements

- Windows 10/11 recommended.
- Python 3.11 or 3.12.
- Node.js LTS with npm.
- Tailscale installed on the PC and phone.
- A Tailscale account with both devices in the same tailnet.
- MagicDNS enabled in the tailnet.

The backend has partial macOS/Linux support for sleep, but screen capture and remote input have primarily been built and tested for Windows.

## Quick Setup On Windows

1. Clone the repository.

```powershell
git clone <repository-url>
cd "Remote Screenshot to email"
```

2. Create the Python virtual environment.

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt
```

3. Install frontend dependencies and build the static UI.

```powershell
cd web
npm install
npm run build
cd ..
```

4. Create the `.env` file.

```powershell
Copy-Item .env.example .env
notepad .env
```

Replace `APP_PIN=CHANGE_ME` with your own 6-digit PIN. The example value is intentionally invalid.

5. Start the app.

```powershell
.\start_remote_console.bat
```

The script asks for Administrator permission through UAC. This is required to send input to elevated Windows windows. Without Administrator mode, the app can still work with normal windows, but Windows blocks input into elevated apps.

## Tailscale Setup

1. Install Tailscale on the PC: https://tailscale.com/download
2. Sign in on the PC.
3. Install Tailscale on the phone and sign in to the same account or tailnet.
4. Enable MagicDNS in the Tailscale admin console if it is not already enabled.
5. Keep Tailscale connected on both devices.

When Peek Remote starts, it runs:

```powershell
tailscale serve --bg http://127.0.0.1:8000
```

This publishes the local server only inside your tailnet. The URL looks similar to:

```text
https://my-pc.my-tailnet.ts.net
```

On the PC, the local `/connect` page shows a QR code. Scan it with the phone to open the tailnet URL and authenticate automatically. If the QR code expires, the page generates a new one.

## Configuration

Configuration lives in `.env`, which must not be committed.

| Variable | Default | Description |
| --- | --- | --- |
| `APP_PIN` or `AUTH_PIN` | required | 6-digit numeric PIN. The server refuses to start without it. |
| `SERVER_HOST` | `127.0.0.1` | Local FastAPI host. |
| `SERVER_PORT` | `8000` | Local FastAPI port and Tailscale Serve target. |
| `TAILSCALE_PATH` | empty | Path to `tailscale.exe`. Empty means autodetect. |
| `QR_TTL_SECONDS` | `1800` | QR login token lifetime in seconds. |
| `QR_OPEN_BROWSER` | `true` | Automatically opens `/connect` in the PC browser. |
| `AUDIT_LOG_FILE` | `audit.log` | Local audit log file. Ignored by git. |
| `MAX_FAILED_LOGINS` | `5` | Wrong PIN attempts per client before blocking until restart. |
| `CLOUDFLARED_PATH` | empty | Optional. Enables Cloudflare Quick Tunnel if set. Leave empty to keep the app private in the tailnet. |
| `CLOUDFLARED_ARGS` | `--no-autoupdate` | Extra arguments for `cloudflared`, if used. |

## Running Manually

Backend:

```powershell
.\.venv\Scripts\activate
python serve.py
```

Frontend development server:

```powershell
cd web
$env:NEXT_PUBLIC_API_BASE="http://127.0.0.1:8000"
npm run dev
```

Static production build:

```powershell
cd web
npm run build
```

After the build, FastAPI serves `web/out` at the root path.

## Security And Privacy

This app has high privilege: it can see your screen and send mouse/keyboard input to the PC. Use it only with trusted devices and networks.

Recommended practices:

- Do not expose the FastAPI port directly to the public internet.
- Prefer Tailscale Serve over public tunnels.
- Use a unique, non-obvious PIN that is not reused elsewhere.
- Do not share screenshots, logs, or the `.env` file.
- Revoke unknown sessions from the sessions screen.
- Restart the server if you suspect someone saw the QR code or PIN.
- Before publishing to GitHub, run `git status --short` and verify that no sensitive files are included.

Files that should stay out of git:

- `.env` and real `.env.*` files.
- `.gmail/`, `token.json`, `credentials.json`, `client_secret*.json`.
- `audit.log` and other logs.
- `.venv/`.
- `web/node_modules/`, `web/.next/`, `web/out/`.
- local screenshots and test screenshots.
- private keys, certificates, and `.pem`, `.key`, `.p12` files.

## Pre-Publish Checklist

1. Confirm `.env` is ignored:

```powershell
git check-ignore -v .env
```

2. Confirm Gmail/OAuth tokens are ignored:

```powershell
git check-ignore -v .gmail/token.json
```

3. Search tracked files for secrets:

```powershell
git grep -n -i "password\|secret\|token\|api_key\|client_secret\|APP_PIN"
```

4. Review what will be committed:

```powershell
git status --short
git diff --cached
```

5. Do not publish repository history if a real secret was ever committed. Rotate the secret and clean the history before making the repository public.

## Troubleshooting

### The QR Page Says The Private Connection Is Unavailable

Check whether Tailscale is installed, signed in, and connected:

```powershell
tailscale status
```

If the command does not exist, install Tailscale or configure `TAILSCALE_PATH` in `.env`.

### The Phone Cannot Open The Tailnet URL

Confirm that the phone is signed in to the same tailnet and that Tailscale is connected. Also confirm that MagicDNS is enabled in the Tailscale admin console.

### Mouse Or Keyboard Input Does Not Work In Some Windows

On Windows, a normal process cannot control elevated windows. Run `start_remote_console.bat` and accept the UAC prompt to start as Administrator.

### The Frontend Does Not Appear

Generate the static build:

```powershell
cd web
npm install
npm run build
cd ..
python serve.py
```

### Port Already In Use

Change `SERVER_PORT` in `.env` and restart the app. Tailscale Serve will use the new port on the next startup.

## License

This project uses a custom non-commercial license. You may use, copy, modify, and distribute it for personal, educational, evaluation, or internal purposes, but you may not sell it, resell it, host it as a paid service, include it in a paid product, or otherwise monetize it without written permission.

See [LICENSE](LICENSE).
