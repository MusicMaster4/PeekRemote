# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Peek Remote backend.

Produces a self-contained `peek-backend` (one-folder) bundle so the Electron
desktop app can ship and run the FastAPI backend WITHOUT the end user having
Python installed. The built Next.js frontend (web/out) is bundled as data so the
backend can serve the phone UI over Tailscale.

Build:  pyinstaller peek-backend.spec --noconfirm
Output: dist/peek-backend/   (peek-backend[.exe] + _internal/)
"""

import os
import sys

from PyInstaller.utils.hooks import collect_all, collect_submodules

# App icon (Windows uses .ico; other platforms ignore it here — the headless
# backend has no window, and the Electron app carries the real platform icons).
_icon = "peekremotelogo.ico" if sys.platform == "win32" and os.path.exists("peekremotelogo.ico") else None

datas = []
binaries = []
hiddenimports = []


def _add(pkg, optional=False):
    """Collect everything for a package; skip quietly if it's optional/missing."""
    global datas, binaries, hiddenimports
    try:
        d, b, h = collect_all(pkg)
    except Exception:
        if optional:
            return
        raise
    datas += d
    binaries += b
    hiddenimports += h


# Bundle the built Next.js static frontend so the backend serves it when frozen.
_web_out = os.path.join("web", "out")
if os.path.isdir(_web_out):
    datas.append((_web_out, os.path.join("web", "out")))

# uvicorn + its dynamically-imported loop/http/ws backends (uvicorn[standard]).
_add("uvicorn")
_add("anyio")
_add("h11")
_add("httptools", optional=True)
_add("websockets", optional=True)
_add("pydantic")
_add("pydantic_settings", optional=True)
_add("Quartz", optional=True)

# Our own package is imported via the `app` namespace.
hiddenimports += collect_submodules("app")

a = Analysis(
    ["serve.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "PyQt5", "PySide2", "matplotlib"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="peek-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # headless: no console window when spawned by Electron
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=_icon,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="peek-backend",
)
