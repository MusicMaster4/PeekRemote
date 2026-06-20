"use strict";

const path = require("path");
const fs = require("fs");
const { app } = require("electron");

const IS_WIN = process.platform === "win32";

// Repo root (two levels up from desktop/src) — only meaningful in dev.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Resolve how to launch the FastAPI backend.
 *
 * - Packaged: the PyInstaller one-folder bundle ships under
 *   resources/backend/peek-backend[.exe].
 * - Dev: run serve.py with the project's virtualenv Python (falls back to
 *   `python` on PATH), so the Electron shell can be iterated without building
 *   the PyInstaller bundle. Override with PEEK_BACKEND_PYTHON.
 */
function resolveBackend() {
  if (app.isPackaged) {
    const exe = IS_WIN ? "peek-backend.exe" : "peek-backend";
    const bin = path.join(process.resourcesPath, "backend", exe);
    return { command: bin, args: [], cwd: path.dirname(bin), mode: "frozen" };
  }

  const venvPython = IS_WIN
    ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(REPO_ROOT, ".venv", "bin", "python");
  const python =
    process.env.PEEK_BACKEND_PYTHON ||
    (fs.existsSync(venvPython) ? venvPython : IS_WIN ? "python" : "python3");

  return {
    command: python,
    args: [path.join(REPO_ROOT, "serve.py")],
    cwd: REPO_ROOT,
    mode: "dev",
  };
}

module.exports = { resolveBackend, REPO_ROOT, IS_WIN };
