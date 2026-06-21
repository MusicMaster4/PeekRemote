from __future__ import annotations

import ctypes
import os
import platform
import threading
from dataclasses import dataclass


@dataclass
class PrivacyBlockState:
    enabled: bool
    input_blocked: bool
    platform: str
    message: str = ""


_LOCK = threading.RLock()
_BLOCKER = None
_ENABLED = False
_LAST = PrivacyBlockState(False, False, platform.system().lower() or "unknown")


def set_enabled(enabled: bool) -> PrivacyBlockState:
    global _ENABLED, _LAST
    with _LOCK:
        _ENABLED = bool(enabled)
        blocker = _blocker()
        if not blocker:
            _LAST = PrivacyBlockState(_ENABLED, False, _platform(), "Input blocking is not supported here.")
            return _LAST
        try:
            ok, message = blocker.set_enabled(_ENABLED)
        except Exception as exc:
            ok, message = False, str(exc)
        _LAST = PrivacyBlockState(_ENABLED, bool(ok), _platform(), message)
        return _LAST


def state() -> PrivacyBlockState:
    with _LOCK:
        return _LAST


def _platform() -> str:
    system = platform.system()
    if system == "Windows":
        return "windows"
    if system == "Darwin":
        return "mac"
    if system == "Linux":
        return "linux"
    return system.lower() or "unknown"


def _blocker():
    global _BLOCKER
    if _BLOCKER is not None:
        return _BLOCKER
    system = platform.system()
    if system == "Windows":
        _BLOCKER = _WindowsInputBlocker()
    elif system == "Darwin":
        _BLOCKER = _MacInputBlocker()
    else:
        _BLOCKER = None
    return _BLOCKER


if platform.system() == "Windows":
    from ctypes import wintypes

    _WH_KEYBOARD_LL = 13
    _WH_MOUSE_LL = 14
    _WM_QUIT = 0x0012
    _LLKHF_INJECTED = 0x10
    _LLMHF_INJECTED = 0x00000001

    class _KBDLLHOOKSTRUCT(ctypes.Structure):
        _fields_ = [
            ("vkCode", wintypes.DWORD),
            ("scanCode", wintypes.DWORD),
            ("flags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class _MSLLHOOKSTRUCT(ctypes.Structure):
        _fields_ = [
            ("pt", wintypes.POINT),
            ("mouseData", wintypes.DWORD),
            ("flags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    _HOOKPROC = ctypes.WINFUNCTYPE(
        wintypes.LPARAM, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM
    )

    _user32 = ctypes.windll.user32
    _kernel32 = ctypes.windll.kernel32
    _user32.SetWindowsHookExW.argtypes = (
        ctypes.c_int,
        _HOOKPROC,
        wintypes.HINSTANCE,
        wintypes.DWORD,
    )
    _user32.SetWindowsHookExW.restype = wintypes.HHOOK
    _user32.UnhookWindowsHookEx.argtypes = (wintypes.HHOOK,)
    _user32.UnhookWindowsHookEx.restype = wintypes.BOOL
    _user32.CallNextHookEx.argtypes = (
        wintypes.HHOOK,
        ctypes.c_int,
        wintypes.WPARAM,
        wintypes.LPARAM,
    )
    _user32.CallNextHookEx.restype = wintypes.LPARAM
    _user32.GetMessageW.argtypes = (
        ctypes.POINTER(wintypes.MSG),
        wintypes.HWND,
        wintypes.UINT,
        wintypes.UINT,
    )
    _user32.GetMessageW.restype = wintypes.BOOL
    _user32.PostThreadMessageW.argtypes = (
        wintypes.DWORD,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    )
    _user32.PostThreadMessageW.restype = wintypes.BOOL
    _kernel32.GetModuleHandleW.argtypes = (wintypes.LPCWSTR,)
    _kernel32.GetModuleHandleW.restype = wintypes.HMODULE
    _kernel32.GetCurrentThreadId.argtypes = ()
    _kernel32.GetCurrentThreadId.restype = wintypes.DWORD


class _WindowsInputBlocker:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._thread_id = 0
        self._keyboard_hook = None
        self._mouse_hook = None
        self._keyboard_proc = None
        self._mouse_proc = None

    def set_enabled(self, enabled: bool) -> tuple[bool, str]:
        if platform.system() != "Windows":
            return False, "Windows hook unavailable."
        if enabled:
            return self._start()
        self._stop_hooks()
        return True, ""

    def _start(self) -> tuple[bool, str]:
        if self._thread and self._thread.is_alive():
            return True, ""
        self._ready.clear()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="peek-privacy-input", daemon=True)
        self._thread.start()
        if not self._ready.wait(2.0):
            return False, "Windows input hook did not start."
        return bool(self._keyboard_hook and self._mouse_hook), ""

    def _stop_hooks(self) -> None:
        self._stop.set()
        if self._thread_id:
            try:
                _user32.PostThreadMessageW(self._thread_id, _WM_QUIT, 0, 0)
            except Exception:
                pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._thread = None
        self._thread_id = 0

    def _run(self) -> None:
        self._thread_id = int(_kernel32.GetCurrentThreadId())

        @_HOOKPROC
        def keyboard_proc(n_code, w_param, l_param):
            if n_code >= 0:
                event = ctypes.cast(l_param, ctypes.POINTER(_KBDLLHOOKSTRUCT)).contents
                if not (event.flags & _LLKHF_INJECTED):
                    return 1
            return _user32.CallNextHookEx(self._keyboard_hook, n_code, w_param, l_param)

        @_HOOKPROC
        def mouse_proc(n_code, w_param, l_param):
            if n_code >= 0:
                event = ctypes.cast(l_param, ctypes.POINTER(_MSLLHOOKSTRUCT)).contents
                if not (event.flags & _LLMHF_INJECTED):
                    return 1
            return _user32.CallNextHookEx(self._mouse_hook, n_code, w_param, l_param)

        self._keyboard_proc = keyboard_proc
        self._mouse_proc = mouse_proc
        module = _kernel32.GetModuleHandleW(None)
        self._keyboard_hook = _user32.SetWindowsHookExW(_WH_KEYBOARD_LL, keyboard_proc, module, 0)
        self._mouse_hook = _user32.SetWindowsHookExW(_WH_MOUSE_LL, mouse_proc, module, 0)
        self._ready.set()

        msg = wintypes.MSG()
        while not self._stop.is_set() and _user32.GetMessageW(ctypes.byref(msg), None, 0, 0):
            pass

        if self._keyboard_hook:
            _user32.UnhookWindowsHookEx(self._keyboard_hook)
        if self._mouse_hook:
            _user32.UnhookWindowsHookEx(self._mouse_hook)
        self._keyboard_hook = None
        self._mouse_hook = None
        self._keyboard_proc = None
        self._mouse_proc = None


class _MacInputBlocker:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._run_loop = None
        self._tap = None
        self._callback = None

    def set_enabled(self, enabled: bool) -> tuple[bool, str]:
        if platform.system() != "Darwin":
            return False, "macOS event tap unavailable."
        if enabled:
            return self._start()
        self._stop_tap()
        return True, ""

    def _start(self) -> tuple[bool, str]:
        if self._thread and self._thread.is_alive():
            return True, ""
        self._ready.clear()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="peek-privacy-input", daemon=True)
        self._thread.start()
        if not self._ready.wait(2.5):
            return False, "macOS input tap did not start."
        return bool(self._tap), ""

    def _stop_tap(self) -> None:
        self._stop.set()
        try:
            if self._run_loop:
                self._quartz().CFRunLoopStop(self._run_loop)
        except Exception:
            pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._thread = None
        self._run_loop = None
        self._tap = None
        self._callback = None

    def _quartz(self):
        import Quartz  # type: ignore

        return Quartz

    def _run(self) -> None:
        try:
            Quartz = self._quartz()
        except Exception:
            self._ready.set()
            return

        event_types = [
            Quartz.kCGEventLeftMouseDown,
            Quartz.kCGEventLeftMouseUp,
            Quartz.kCGEventRightMouseDown,
            Quartz.kCGEventRightMouseUp,
            Quartz.kCGEventMouseMoved,
            Quartz.kCGEventLeftMouseDragged,
            Quartz.kCGEventRightMouseDragged,
            Quartz.kCGEventScrollWheel,
            Quartz.kCGEventKeyDown,
            Quartz.kCGEventKeyUp,
            Quartz.kCGEventFlagsChanged,
        ]
        mask = 0
        for event_type in event_types:
            mask |= Quartz.CGEventMaskBit(event_type)

        own_pid = os.getpid()

        def callback(proxy, event_type, event, refcon):
            try:
                source_pid = Quartz.CGEventGetIntegerValueField(
                    event, Quartz.kCGEventSourceUnixProcessID
                )
                if int(source_pid) == own_pid:
                    return event
            except Exception:
                pass
            return None

        self._callback = callback
        self._tap = Quartz.CGEventTapCreate(
            Quartz.kCGHIDEventTap,
            Quartz.kCGHeadInsertEventTap,
            Quartz.kCGEventTapOptionDefault,
            mask,
            callback,
            None,
        )
        if not self._tap:
            self._ready.set()
            return

        source = Quartz.CFMachPortCreateRunLoopSource(None, self._tap, 0)
        self._run_loop = Quartz.CFRunLoopGetCurrent()
        Quartz.CFRunLoopAddSource(self._run_loop, source, Quartz.kCFRunLoopCommonModes)
        Quartz.CGEventTapEnable(self._tap, True)
        self._ready.set()
        Quartz.CFRunLoopRun()
