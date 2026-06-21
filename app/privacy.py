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
        _LAST = PrivacyBlockState(_ENABLED, bool(ok) if _ENABLED else False, _platform(), message)
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

    for _name in ("HCURSOR", "HICON", "HBRUSH", "HFONT", "HGDIOBJ", "HMONITOR", "HMENU"):
        if not hasattr(wintypes, _name):
            setattr(wintypes, _name, wintypes.HANDLE)
    if not hasattr(wintypes, "LRESULT"):
        wintypes.LRESULT = wintypes.LPARAM
    if not hasattr(wintypes, "COLORREF"):
        wintypes.COLORREF = wintypes.DWORD

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

    class _PAINTSTRUCT(ctypes.Structure):
        _fields_ = [
            ("hdc", wintypes.HDC),
            ("fErase", wintypes.BOOL),
            ("rcPaint", wintypes.RECT),
            ("fRestore", wintypes.BOOL),
            ("fIncUpdate", wintypes.BOOL),
            ("rgbReserved", ctypes.c_byte * 32),
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
    _user32.CreateWindowExW.argtypes = (
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        wintypes.LPVOID,
    )
    _user32.CreateWindowExW.restype = wintypes.HWND
    _user32.DestroyWindow.argtypes = (wintypes.HWND,)
    _user32.DestroyWindow.restype = wintypes.BOOL
    _user32.DefWindowProcW.argtypes = (
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    )
    _user32.DefWindowProcW.restype = wintypes.LPARAM
    _user32.DispatchMessageW.argtypes = (ctypes.POINTER(wintypes.MSG),)
    _user32.DispatchMessageW.restype = wintypes.LPARAM
    _user32.TranslateMessage.argtypes = (ctypes.POINTER(wintypes.MSG),)
    _user32.TranslateMessage.restype = wintypes.BOOL
    _user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
    _user32.ShowWindow.restype = wintypes.BOOL
    _user32.SetWindowPos.argtypes = (
        wintypes.HWND,
        wintypes.HWND,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.UINT,
    )
    _user32.SetWindowPos.restype = wintypes.BOOL
    _user32.SetWindowDisplayAffinity.argtypes = (wintypes.HWND, wintypes.DWORD)
    _user32.SetWindowDisplayAffinity.restype = wintypes.BOOL
    _user32.BeginPaint.argtypes = (wintypes.HWND, ctypes.POINTER(_PAINTSTRUCT))
    _user32.BeginPaint.restype = wintypes.HDC
    _user32.EndPaint.argtypes = (wintypes.HWND, ctypes.POINTER(_PAINTSTRUCT))
    _user32.EndPaint.restype = wintypes.BOOL
    _user32.FillRect.argtypes = (wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.HBRUSH)
    _user32.FillRect.restype = ctypes.c_int
    _user32.GetClientRect.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.RECT))
    _user32.GetClientRect.restype = wintypes.BOOL
    _user32.RegisterClassW.argtypes = (ctypes.c_void_p,)
    _user32.RegisterClassW.restype = wintypes.ATOM
    _user32.EnumDisplayMonitors.argtypes = (
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        ctypes.c_void_p,
        wintypes.LPARAM,
    )
    _user32.EnumDisplayMonitors.restype = wintypes.BOOL
    _user32.SetCursor.argtypes = (wintypes.HCURSOR,)
    _user32.SetCursor.restype = wintypes.HCURSOR
    _kernel32.GetModuleHandleW.argtypes = (wintypes.LPCWSTR,)
    _kernel32.GetModuleHandleW.restype = wintypes.HMODULE
    _kernel32.GetCurrentThreadId.argtypes = ()
    _kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    _gdi32 = ctypes.windll.gdi32
    _gdi32.CreateSolidBrush.argtypes = (wintypes.COLORREF,)
    _gdi32.CreateSolidBrush.restype = wintypes.HBRUSH
    _gdi32.DeleteObject.argtypes = (wintypes.HGDIOBJ,)
    _gdi32.DeleteObject.restype = wintypes.BOOL
    _gdi32.SetBkMode.argtypes = (wintypes.HDC, ctypes.c_int)
    _gdi32.SetBkMode.restype = ctypes.c_int
    _gdi32.SetTextColor.argtypes = (wintypes.HDC, wintypes.COLORREF)
    _gdi32.SetTextColor.restype = wintypes.COLORREF
    _gdi32.CreateFontW.argtypes = (
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPCWSTR,
    )
    _gdi32.CreateFontW.restype = wintypes.HFONT
    _gdi32.SelectObject.argtypes = (wintypes.HDC, wintypes.HGDIOBJ)
    _gdi32.SelectObject.restype = wintypes.HGDIOBJ
    _user32.DrawTextW.argtypes = (
        wintypes.HDC,
        wintypes.LPCWSTR,
        ctypes.c_int,
        ctypes.POINTER(wintypes.RECT),
        wintypes.UINT,
    )
    _user32.DrawTextW.restype = ctypes.c_int

    _WNDPROC = ctypes.WINFUNCTYPE(
        wintypes.LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
    )

    class _WNDCLASSW(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT),
            ("lpfnWndProc", _WNDPROC),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON),
            ("hCursor", wintypes.HCURSOR),
            ("hbrBackground", wintypes.HBRUSH),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
        ]

    _MONITORENUMPROC = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HMONITOR,
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        wintypes.LPARAM,
    )

    _WM_PAINT = 0x000F
    _WM_SETCURSOR = 0x0020
    _WM_NCHITTEST = 0x0084
    _HTTRANSPARENT = -1
    _WS_POPUP = 0x80000000
    _WS_VISIBLE = 0x10000000
    _WS_EX_TOPMOST = 0x00000008
    _WS_EX_TRANSPARENT = 0x00000020
    _WS_EX_TOOLWINDOW = 0x00000080
    _WS_EX_NOACTIVATE = 0x08000000
    _SW_SHOWNOACTIVATE = 4
    _SWP_NOACTIVATE = 0x0010
    _SWP_SHOWWINDOW = 0x0040
    _HWND_TOPMOST = wintypes.HWND(-1)
    _TRANSPARENT = 1
    _FW_NORMAL = 400
    _FW_SEMIBOLD = 600
    _DT_CENTER = 0x00000001
    _DT_VCENTER = 0x00000004
    _DT_SINGLELINE = 0x00000020
    _WDA_MONITOR = 0x00000001
    _WDA_EXCLUDEFROMCAPTURE = 0x00000011


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
        self._overlay = _WindowsPrivacyOverlay()

    def set_enabled(self, enabled: bool) -> tuple[bool, str]:
        if platform.system() != "Windows":
            return False, "Windows hook unavailable."
        if enabled:
            overlay_ok, overlay_message = self._overlay.set_enabled(True)
            hook_ok, hook_message = self._start()
            messages = [msg for msg in (hook_message, overlay_message) if msg]
            return hook_ok and overlay_ok, " ".join(messages)
        self._overlay.set_enabled(False)
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


class _WindowsPrivacyOverlay:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._thread_id = 0
        self._windows: list[int] = []
        self._wnd_proc = None
        self._class_name = "PeekRemotePrivacyOverlay"
        self._registered = False
        self._message = ""

    def set_enabled(self, enabled: bool) -> tuple[bool, str]:
        if platform.system() != "Windows":
            return False, "Windows overlay unavailable."
        if enabled:
            return self._start()
        self._stop_overlay()
        return True, ""

    def _start(self) -> tuple[bool, str]:
        if self._thread and self._thread.is_alive():
            return True, self._message
        self._ready.clear()
        self._stop.clear()
        self._message = ""
        self._thread = threading.Thread(target=self._run, name="peek-privacy-overlay", daemon=True)
        self._thread.start()
        if not self._ready.wait(2.0):
            return False, "Privacy overlay did not start."
        return bool(self._windows), self._message

    def _stop_overlay(self) -> None:
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
        self._windows = []

    def _monitors(self) -> list[tuple[int, int, int, int]]:
        monitors: list[tuple[int, int, int, int]] = []

        @_MONITORENUMPROC
        def callback(_monitor, _dc, rect, _data):
            r = rect.contents
            monitors.append((int(r.left), int(r.top), int(r.right - r.left), int(r.bottom - r.top)))
            return True

        if not _user32.EnumDisplayMonitors(None, None, callback, 0):
            return [(0, 0, 1920, 1080)]
        return monitors or [(0, 0, 1920, 1080)]

    def _register_class(self, instance) -> None:
        if self._registered:
            return

        @_WNDPROC
        def wnd_proc(hwnd, msg, w_param, l_param):
            if msg == _WM_PAINT:
                self._paint(hwnd)
                return 0
            if msg == _WM_NCHITTEST:
                return _HTTRANSPARENT
            if msg == _WM_SETCURSOR:
                _user32.SetCursor(None)
                return 1
            return _user32.DefWindowProcW(hwnd, msg, w_param, l_param)

        self._wnd_proc = wnd_proc
        wc = _WNDCLASSW()
        wc.lpfnWndProc = wnd_proc
        wc.hInstance = instance
        wc.hbrBackground = _gdi32.CreateSolidBrush(0x000000)
        wc.lpszClassName = self._class_name
        atom = _user32.RegisterClassW(ctypes.byref(wc))
        if not atom:
            # The class can already exist after a quick enable/disable cycle.
            self._registered = True
            return
        self._registered = True

    def _paint(self, hwnd) -> None:
        ps = _PAINTSTRUCT()
        hdc = _user32.BeginPaint(hwnd, ctypes.byref(ps))
        if not hdc:
            return
        try:
            rect = wintypes.RECT()
            _user32.GetClientRect(hwnd, ctypes.byref(rect))
            brush = _gdi32.CreateSolidBrush(0x080808)
            try:
                _user32.FillRect(hdc, ctypes.byref(rect), brush)
            finally:
                _gdi32.DeleteObject(brush)

            _gdi32.SetBkMode(hdc, _TRANSPARENT)
            _gdi32.SetTextColor(hdc, 0xF8F7F7)
            center_y = int((rect.bottom - rect.top) / 2)
            title_rect = wintypes.RECT(rect.left, center_y - 70, rect.right, center_y - 38)
            body_rect = wintypes.RECT(rect.left, center_y - 18, rect.right, center_y + 10)
            foot_rect = wintypes.RECT(rect.left, center_y + 42, rect.right, center_y + 68)

            title_font = _gdi32.CreateFontW(
                20, 0, 0, 0, _FW_SEMIBOLD, 0, 0, 0, 0, 0, 0, 0, 0, "Segoe UI"
            )
            body_font = _gdi32.CreateFontW(
                13, 0, 0, 0, _FW_NORMAL, 0, 0, 0, 0, 0, 0, 0, 0, "Segoe UI"
            )
            try:
                old = _gdi32.SelectObject(hdc, title_font)
                _user32.DrawTextW(hdc, "Peek Remote", -1, ctypes.byref(title_rect), _DT_CENTER | _DT_VCENTER | _DT_SINGLELINE)
                _gdi32.SelectObject(hdc, body_font)
                _gdi32.SetTextColor(hdc, 0xA8A8A8)
                _user32.DrawTextW(
                    hdc,
                    "This computer is being remotely operated.",
                    -1,
                    ctypes.byref(body_rect),
                    _DT_CENTER | _DT_VCENTER | _DT_SINGLELINE,
                )
                _gdi32.SetTextColor(hdc, 0xD0D0D0)
                _user32.DrawTextW(hdc, "standby", -1, ctypes.byref(foot_rect), _DT_CENTER | _DT_VCENTER | _DT_SINGLELINE)
                _gdi32.SelectObject(hdc, old)
            finally:
                _gdi32.DeleteObject(title_font)
                _gdi32.DeleteObject(body_font)
        finally:
            _user32.EndPaint(hwnd, ctypes.byref(ps))

    def _create_window(self, instance, x: int, y: int, width: int, height: int) -> int:
        ex_style = _WS_EX_TOPMOST | _WS_EX_TOOLWINDOW | _WS_EX_NOACTIVATE | _WS_EX_TRANSPARENT
        hwnd = _user32.CreateWindowExW(
            ex_style,
            self._class_name,
            "Peek Remote Privacy",
            _WS_POPUP | _WS_VISIBLE,
            x,
            y,
            width,
            height,
            None,
            None,
            instance,
            None,
        )
        if not hwnd:
            return 0
        if not _user32.SetWindowDisplayAffinity(hwnd, _WDA_EXCLUDEFROMCAPTURE):
            _user32.SetWindowDisplayAffinity(hwnd, _WDA_MONITOR)
            self._message = "Capture exclusion fallback is active."
        _user32.SetWindowPos(
            hwnd,
            _HWND_TOPMOST,
            x,
            y,
            width,
            height,
            _SWP_NOACTIVATE | _SWP_SHOWWINDOW,
        )
        _user32.ShowWindow(hwnd, _SW_SHOWNOACTIVATE)
        return int(hwnd)

    def _run(self) -> None:
        self._thread_id = int(_kernel32.GetCurrentThreadId())
        instance = _kernel32.GetModuleHandleW(None)
        try:
            self._register_class(instance)
            self._windows = [
                hwnd
                for hwnd in (
                    self._create_window(instance, x, y, width, height)
                    for x, y, width, height in self._monitors()
                )
                if hwnd
            ]
        finally:
            self._ready.set()

        msg = wintypes.MSG()
        while not self._stop.is_set() and _user32.GetMessageW(ctypes.byref(msg), None, 0, 0):
            _user32.TranslateMessage(ctypes.byref(msg))
            _user32.DispatchMessageW(ctypes.byref(msg))

        for hwnd in self._windows:
            try:
                _user32.DestroyWindow(wintypes.HWND(hwnd))
            except Exception:
                pass
        self._windows = []


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
