from __future__ import annotations

import ctypes
import hashlib
import os
import platform
import subprocess
import threading
import time
from dataclasses import dataclass


MAX_TEXT = 8000


@dataclass
class ClipboardState:
    text: str = ""
    hash: str = ""
    updated_at: float = 0.0


_LOCK = threading.RLock()
_STATE = ClipboardState()
_STOP = threading.Event()
_THREAD: threading.Thread | None = None
_SYNC_ENABLED = False


def set_enabled(enabled: bool) -> bool:
    global _SYNC_ENABLED, _STATE
    with _LOCK:
        _SYNC_ENABLED = bool(enabled)
        if not _SYNC_ENABLED:
            _STATE = ClipboardState()
        return _SYNC_ENABLED


def is_enabled() -> bool:
    with _LOCK:
        return _SYNC_ENABLED


def start_monitor() -> None:
    global _THREAD
    if _THREAD and _THREAD.is_alive():
        return
    _STOP.clear()
    _THREAD = threading.Thread(target=_monitor_loop, name="peek-clipboard", daemon=True)
    _THREAD.start()


def stop_monitor() -> None:
    _STOP.set()


def latest() -> dict:
    with _LOCK:
        if not _SYNC_ENABLED:
            return {
                "enabled": False,
                "has_text": False,
                "text": "",
                "hash": "",
                "updated_at": 0,
            }
        return {
            "enabled": True,
            "has_text": bool(_STATE.text),
            "text": _STATE.text,
            "hash": _STATE.hash,
            "updated_at": _STATE.updated_at,
        }


def read_now() -> dict:
    """Lê o clipboard do SO imediatamente (sob demanda).

    Usado logo apos um Copy remoto, para o celular pegar o texto recem-copiado
    sem esperar o tick (~1s) do monitor. Tambem atualiza o estado monitorado para
    o poller de fundo nao re-anunciar o mesmo valor logo em seguida.
    """
    with _LOCK:
        enabled = _SYNC_ENABLED
    if not enabled:
        return {"enabled": False, "has_text": False, "text": "", "hash": "", "updated_at": 0}
    text = (_read_text() or "")[:MAX_TEXT]
    digest = (
        hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest() if text else ""
    )
    if text:
        with _LOCK:
            _STATE.text = text
            _STATE.hash = digest
            _STATE.updated_at = time.time()
    return {
        "enabled": True,
        "has_text": bool(text),
        "text": text,
        "hash": digest,
        "updated_at": _STATE.updated_at,
    }


def _monitor_loop() -> None:
    last_hash = ""
    while not _STOP.wait(1.0):
        if not is_enabled():
            last_hash = ""
            continue
        text = _read_text()
        if not text:
            continue
        text = text[:MAX_TEXT]
        digest = hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()
        if digest == last_hash:
            continue
        last_hash = digest
        with _LOCK:
            _STATE.text = text
            _STATE.hash = digest
            _STATE.updated_at = time.time()


def _read_text() -> str:
    system = platform.system()
    try:
        if system == "Windows":
            return _read_windows_text()
        if system == "Darwin":
            return _read_pbpaste()
    except Exception:
        return ""
    return ""


if platform.system() == "Windows":
    from ctypes import wintypes

    _user32 = ctypes.windll.user32
    _kernel32 = ctypes.windll.kernel32
    _CF_UNICODETEXT = 13
    _GMEM_MOVEABLE = 0x0002

    _user32.OpenClipboard.argtypes = (wintypes.HWND,)
    _user32.OpenClipboard.restype = wintypes.BOOL
    _user32.CloseClipboard.argtypes = ()
    _user32.CloseClipboard.restype = wintypes.BOOL
    _user32.IsClipboardFormatAvailable.argtypes = (wintypes.UINT,)
    _user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
    _user32.GetClipboardData.argtypes = (wintypes.UINT,)
    _user32.GetClipboardData.restype = wintypes.HANDLE
    _kernel32.GlobalLock.argtypes = (wintypes.HGLOBAL,)
    _kernel32.GlobalLock.restype = wintypes.LPWSTR
    _kernel32.GlobalUnlock.argtypes = (wintypes.HGLOBAL,)
    _kernel32.GlobalUnlock.restype = wintypes.BOOL


def _read_windows_text() -> str:
    if platform.system() != "Windows":
        return ""
    if not _user32.IsClipboardFormatAvailable(_CF_UNICODETEXT):
        return ""
    if not _user32.OpenClipboard(None):
        return ""
    handle = None
    ptr = None
    try:
        handle = _user32.GetClipboardData(_CF_UNICODETEXT)
        if not handle:
            return ""
        ptr = _kernel32.GlobalLock(handle)
        if not ptr:
            return ""
        return ctypes.wstring_at(ptr).strip()
    finally:
        if handle and ptr:
            _kernel32.GlobalUnlock(handle)
        _user32.CloseClipboard()


def _read_pbpaste() -> str:
    if platform.system() != "Darwin":
        return ""
    env = {**os.environ, "LC_CTYPE": "UTF-8"}
    result = subprocess.run(
        ["pbpaste"],
        capture_output=True,
        text=True,
        timeout=1.5,
        env=env,
        check=False,
    )
    if result.returncode != 0:
        return ""
    return (result.stdout or "").strip()
