"""Injeção de mouse/teclado para o Modo Ao Vivo.

Usa pynput (leve, baseado em ctypes/SendInput no Windows). Todas as funções são
síncronas e bloqueantes — devem ser chamadas via `run_in_threadpool` a partir das
rotas async, igual ao `suspend_computer`.

O import de pynput é tolerante a falhas: se a biblioteca não estiver instalada, o
restante do backend (login, screenshots, suspender) continua funcionando e apenas o
endpoint de input responde com erro claro.
"""

from __future__ import annotations

import ctypes
import platform
import re
import time

try:
    from pynput.keyboard import Controller as _KeyboardController, Key, KeyCode
    from pynput.mouse import Button, Controller as _MouseController

    _PYNPUT_OK = True
except Exception:  # pragma: no cover - ambiente sem pynput
    _PYNPUT_OK = False

_IS_WINDOWS = platform.system() == "Windows"


class InputUnavailable(RuntimeError):
    """pynput não está disponível neste servidor."""


_mouse = None
_keyboard = None

_BUTTONS: dict = {}
_MODIFIERS: dict = {}
_NAMED_KEYS: dict = {}

_MODIFIER_NAMES = {
    "ctrl",
    "control",
    "alt",
    "altgr",
    "shift",
    "win",
    "cmd",
    "super",
    "meta",
    "ctrl_l",
    "control_l",
    "ctrl_r",
    "control_r",
    "alt_l",
    "alt_r",
    "shift_l",
    "shift_r",
    "win_l",
    "cmd_l",
    "win_r",
    "cmd_r",
}

_SPECIAL_KEY_NAMES = {
    "esc",
    "escape",
    "enter",
    "return",
    "tab",
    "backspace",
    "delete",
    "del",
    "insert",
    "space",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "page_up",
    "arrowup",
    "pageup",
    "pgup",
    "page_down",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "pagedown",
    "pgdn",
    "print_screen",
    "printscreen",
    "caps_lock",
    "menu",
    *{f"f{i}" for i in range(1, 13)},
}

_KEY_NAME_ALIASES = {
    "ctl": "ctrl",
    "control": "ctrl",
    "windows": "win",
    "window": "win",
    "command": "cmd",
    "option": "alt",
    "escape": "esc",
    "return": "enter",
    "del": "delete",
    "pgup": "page_up",
    "pageup": "page_up",
    "pgdn": "page_down",
    "pagedown": "page_down",
    "prtsc": "print_screen",
    "printscreen": "print_screen",
}

_KEY_PHRASES = (
    (re.compile(r"\bpage\s+up\b", re.IGNORECASE), "page_up"),
    (re.compile(r"\bpage\s+down\b", re.IGNORECASE), "page_down"),
    (re.compile(r"\bprint\s+screen\b", re.IGNORECASE), "print_screen"),
    (re.compile(r"\bcaps\s+lock\b", re.IGNORECASE), "caps_lock"),
)

_KEY_SEPARATOR_RE = re.compile(r"[\s+\-\u2010-\u2015\u2212]+")
_KEY_FALLBACK_SEPARATOR_RE = re.compile(r"[_\s+\-\u2010-\u2015\u2212]+")
_HOTKEY_PAUSE_SECONDS = 0.05

if _PYNPUT_OK:
    _BUTTONS = {
        "left": Button.left,
        "right": Button.right,
        "middle": Button.middle,
    }

    # Modificadores que ficam pressionados enquanto a tecla final é acionada.
    _MODIFIERS = {
        "ctrl": Key.ctrl_l,
        "control": Key.ctrl_l,
        "alt": Key.alt_l,
        "altgr": Key.alt_gr,
        "shift": Key.shift_l,
        "win": Key.cmd_l,
        "cmd": Key.cmd_l,
        "super": Key.cmd_l,
        "meta": Key.cmd_l,
        "ctrl_l": Key.ctrl_l,
        "control_l": Key.ctrl_l,
        "ctrl_r": Key.ctrl_r,
        "control_r": Key.ctrl_r,
        "alt_l": Key.alt_l,
        "alt_r": Key.alt_r,
        "shift_l": Key.shift_l,
        "shift_r": Key.shift_r,
        "win_l": Key.cmd_l,
        "cmd_l": Key.cmd_l,
        "win_r": Key.cmd_r,
        "cmd_r": Key.cmd_r,
    }

    # Teclas nomeadas (não imprimíveis) — enviáveis sozinhas ou como tecla final.
    _NAMED_KEYS = {
        "esc": Key.esc,
        "escape": Key.esc,
        "enter": Key.enter,
        "return": Key.enter,
        "tab": Key.tab,
        "backspace": Key.backspace,
        "delete": Key.delete,
        "del": Key.delete,
        "insert": Key.insert,
        "space": Key.space,
        "up": Key.up,
        "down": Key.down,
        "left": Key.left,
        "right": Key.right,
        "home": Key.home,
        "end": Key.end,
        "page_up": Key.page_up,
        "arrowup": Key.up,
        "pageup": Key.page_up,
        "pgup": Key.page_up,
        "page_down": Key.page_down,
        "arrowdown": Key.down,
        "arrowleft": Key.left,
        "arrowright": Key.right,
        "pagedown": Key.page_down,
        "pgdn": Key.page_down,
        "print_screen": Key.print_screen,
        "printscreen": Key.print_screen,
        "caps_lock": Key.caps_lock,
        "menu": Key.menu,
    }
    _NAMED_KEYS.update(_MODIFIERS)
    _NAMED_KEYS.update({f"f{i}": getattr(Key, f"f{i}") for i in range(1, 13)})


def _normalize_key_name(name: str) -> str:
    key = name.strip()
    if len(key) == 1 and key.isalpha():
        return key.lower()
    normalized = key.lower().replace(" ", "_").replace("-", "_")
    return _KEY_NAME_ALIASES.get(normalized, normalized)


def _protect_key_phrases(value: str) -> str:
    text = value.strip()
    for pattern, replacement in _KEY_PHRASES:
        text = pattern.sub(replacement, text)
    return text


def _is_resolvable_key_name(name: str) -> bool:
    key = _normalize_key_name(name)
    return key in _SPECIAL_KEY_NAMES or key in _MODIFIER_NAMES or len(key) == 1


def _expand_key_names(names: list[str]) -> list[str]:
    """Accepts combos like 'ctrl+t', 'ctrl-t', and 'ctrl shift d'."""
    expanded: list[str] = []
    for name in names:
        raw = _protect_key_phrases(str(name))
        if not raw:
            continue
        if _is_resolvable_key_name(raw):
            expanded.append(_normalize_key_name(raw))
            continue

        parts = [part for part in _KEY_SEPARATOR_RE.split(raw) if part]
        if len(parts) <= 1:
            parts = [part for part in _KEY_FALLBACK_SEPARATOR_RE.split(raw) if part]
        expanded.extend(_normalize_key_name(part) for part in parts)
    return expanded


def _normalize_hotkey_names(names: list[str]) -> list[str]:
    keys = _expand_key_names(names)
    if not keys:
        return []

    modifiers: list[str] = []
    final_keys: list[str] = []
    for key in keys:
        if key in _MODIFIER_NAMES:
            if key not in modifiers:
                modifiers.append(key)
        else:
            final_keys.append(key)

    if not final_keys:
        return modifiers
    if len(final_keys) > 1:
        raise ValueError("Combinacao deve ter apenas uma tecla final.")
    return [*modifiers, final_keys[0]]


def is_available() -> bool:
    return _IS_WINDOWS or _PYNPUT_OK


def _require() -> None:
    if not (_IS_WINDOWS or _PYNPUT_OK):
        raise InputUnavailable(
            "Biblioteca de input (pynput) não instalada no servidor."
        )


def _controllers():
    """Instancia os controllers sob demanda (evita efeitos no import)."""
    global _mouse, _keyboard
    if _mouse is None:
        _mouse = _MouseController()
        _keyboard = _KeyboardController()
    return _mouse, _keyboard


def ensure_dpi_aware() -> None:
    """Alinha a resolução capturada ao espaço de coordenadas do cursor.

    Sem isso, em telas com escala (ex.: 150%) o screenshot sai reduzido e o clique
    cairia no lugar errado. Como captura e input rodam no mesmo processo, basta
    declarar o processo ciente de DPI uma vez no startup.
    """
    if platform.system() != "Windows":
        return
    try:
        # Per-Monitor v2, quando disponível (Win 10+).
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except (AttributeError, OSError):
            pass


def screen_bounds() -> tuple[int, int, int, int]:
    if platform.system() == "Windows":
        user32 = ctypes.windll.user32
        return (
            int(user32.GetSystemMetrics(76)),  # SM_XVIRTUALSCREEN
            int(user32.GetSystemMetrics(77)),  # SM_YVIRTUALSCREEN
            int(user32.GetSystemMetrics(78)),  # SM_CXVIRTUALSCREEN
            int(user32.GetSystemMetrics(79)),  # SM_CYVIRTUALSCREEN
        )
    # Fallback: let non-Windows coordinate spaces include secondary displays
    # with negative origins instead of forcing everything into the primary.
    return (-(1 << 29), -(1 << 29), 1 << 30, 1 << 30)


def screen_size() -> tuple[int, int]:
    _, _, width, height = screen_bounds()
    return width, height


def _clamp_xy(x: int, y: int) -> tuple[int, int]:
    left, top, width, height = screen_bounds()
    return (
        max(left, min(int(x), left + width - 1)),
        max(top, min(int(y), top + height - 1)),
    )


def _resolve_key(name: str):
    key = _normalize_key_name(name)
    if key in _NAMED_KEYS:
        return _NAMED_KEYS[key]
    if len(key) == 1:
        return KeyCode.from_char(key)
    raise ValueError(f"Tecla desconhecida: {name!r}")


def click(x: int, y: int, button: str = "left", double: bool = False) -> None:
    _require()
    if _IS_WINDOWS:
        _win_click(x, y, button, double)
        return
    mouse, _ = _controllers()
    btn = _BUTTONS.get(button, Button.left)
    mouse.position = _clamp_xy(x, y)
    mouse.click(btn, 2 if double else 1)


def drag(
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    button: str = "left",
    duration_ms: int = 450,
) -> None:
    """Segura o botao do mouse em (x1, y1), arrasta ate (x2, y2) e solta."""
    _require()
    if _IS_WINDOWS:
        _win_drag(x1, y1, x2, y2, button, duration_ms)
        return

    mouse, _ = _controllers()
    btn = _BUTTONS.get(button, Button.left)
    start = _clamp_xy(x1, y1)
    end = _clamp_xy(x2, y2)
    duration = max(0.05, min(float(duration_ms) / 1000, 5.0))
    steps = max(1, min(120, int(duration / 0.016)))
    interval = duration / steps

    mouse.position = start
    time.sleep(0.05)
    mouse.press(btn)
    try:
        for index in range(1, steps + 1):
            t = index / steps
            mouse.position = (
                round(start[0] + (end[0] - start[0]) * t),
                round(start[1] + (end[1] - start[1]) * t),
            )
            time.sleep(interval)
    finally:
        mouse.release(btn)


def scroll(x: int, y: int, dy: int) -> None:
    """Rola sobre o ponto (x, y). dy > 0 sobe, dy < 0 desce."""
    _require()
    if _IS_WINDOWS:
        _win_scroll(x, y, dy)
        return
    mouse, _ = _controllers()
    mouse.position = _clamp_xy(x, y)
    mouse.scroll(0, int(dy))


# ---------------------------------------------------------------------------
# Injeção de teclado nativa no Windows (SendInput com scan codes).
#
# O pynput envia eventos de teclado usando apenas o *virtual key code*. Muitos
# aplicativos — terminais (Warp), jogos e qualquer app que use low-level hooks
# (WH_KEYBOARD_LL) ou DirectInput — só reagem ao *scan code* do hardware. Por
# isso atalhos como Ctrl+Shift+D no Warp eram ignorados. Aqui montamos o evento
# com KEYEVENTF_SCANCODE (e KEYEVENTF_EXTENDEDKEY para teclas estendidas), o
# formato que praticamente todos os apps reconhecem.
#
# OBS.: isto NÃO contorna o UIPI. Para enviar input a janelas elevadas (ex.:
# Gerenciador de Tarefas) o próprio servidor precisa rodar como Administrador.
# ---------------------------------------------------------------------------
if _IS_WINDOWS:
    from ctypes import wintypes

    _KEYEVENTF_EXTENDEDKEY = 0x0001
    _KEYEVENTF_KEYUP = 0x0002
    _KEYEVENTF_UNICODE = 0x0004
    _KEYEVENTF_SCANCODE = 0x0008
    _MOUSEEVENTF_LEFTDOWN = 0x0002
    _MOUSEEVENTF_LEFTUP = 0x0004
    _MOUSEEVENTF_RIGHTDOWN = 0x0008
    _MOUSEEVENTF_RIGHTUP = 0x0010
    _MOUSEEVENTF_MIDDLEDOWN = 0x0020
    _MOUSEEVENTF_MIDDLEUP = 0x0040
    _MOUSEEVENTF_MOVE = 0x0001
    _MOUSEEVENTF_WHEEL = 0x0800
    _MOUSEEVENTF_ABSOLUTE = 0x8000
    _MOUSEEVENTF_VIRTUALDESK = 0x4000
    _WHEEL_DELTA = 120
    _INPUT_MOUSE = 0
    _INPUT_KEYBOARD = 1
    _MAPVK_VK_TO_VSC = 0

    _PUL = ctypes.POINTER(ctypes.c_ulong)
    _WIN_INPUT_EXTRA = ctypes.c_ulong(0x51504B52)
    _WIN_INPUT_EXTRA_PTR = ctypes.pointer(_WIN_INPUT_EXTRA)

    class _KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", _PUL),
        ]

    class _MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", _PUL),
        ]

    class _INPUTUNION(ctypes.Union):
        _fields_ = [("ki", _KEYBDINPUT), ("mi", _MOUSEINPUT)]

    class _INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("union", _INPUTUNION)]

    _user32 = ctypes.windll.user32
    _user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(_INPUT), ctypes.c_int)
    _user32.SendInput.restype = wintypes.UINT
    _user32.MapVirtualKeyW.argtypes = (wintypes.UINT, wintypes.UINT)
    _user32.MapVirtualKeyW.restype = wintypes.UINT
    _user32.VkKeyScanW.argtypes = (wintypes.WCHAR,)
    _user32.VkKeyScanW.restype = wintypes.SHORT

    # Nome normalizado -> virtual key code.
    _WIN_VK: dict[str, int] = {
        "ctrl": 0x11,
        "control": 0x11,
        "ctrl_l": 0xA2,
        "control_l": 0xA2,
        "ctrl_r": 0xA3,
        "control_r": 0xA3,
        "alt": 0x12,
        "alt_l": 0xA4,
        "alt_r": 0xA5,
        "altgr": 0xA5,
        "shift": 0x10,
        "shift_l": 0xA0,
        "shift_r": 0xA1,
        "win": 0x5B,
        "cmd": 0x5B,
        "super": 0x5B,
        "meta": 0x5B,
        "win_l": 0x5B,
        "cmd_l": 0x5B,
        "win_r": 0x5C,
        "cmd_r": 0x5C,
        "esc": 0x1B,
        "escape": 0x1B,
        "enter": 0x0D,
        "return": 0x0D,
        "tab": 0x09,
        "backspace": 0x08,
        "delete": 0x2E,
        "del": 0x2E,
        "insert": 0x2D,
        "space": 0x20,
        "up": 0x26,
        "down": 0x28,
        "left": 0x25,
        "right": 0x27,
        "arrowup": 0x26,
        "arrowdown": 0x28,
        "arrowleft": 0x25,
        "arrowright": 0x27,
        "home": 0x24,
        "end": 0x23,
        "page_up": 0x21,
        "pageup": 0x21,
        "pgup": 0x21,
        "page_down": 0x22,
        "pagedown": 0x22,
        "pgdn": 0x22,
        "print_screen": 0x2C,
        "printscreen": 0x2C,
        "caps_lock": 0x14,
        "menu": 0x5D,
    }
    _WIN_VK.update({f"f{i}": 0x70 + (i - 1) for i in range(1, 13)})

    # Teclas estendidas precisam do flag KEYEVENTF_EXTENDEDKEY no SendInput.
    _WIN_EXTENDED_VKS = {
        0xA3,  # ctrl direito
        0xA5,  # alt direito / altgr
        0x5B,  # win esquerdo
        0x5C,  # win direito
        0x5D,  # menu (apps)
        0x2E,  # delete
        0x2D,  # insert
        0x24,  # home
        0x23,  # end
        0x21,  # page up
        0x22,  # page down
        0x25,  # left
        0x26,  # up
        0x27,  # right
        0x28,  # down
        0x2C,  # print screen
    }

    _WIN_MOUSE_BUTTON_FLAGS = {
        "left": (_MOUSEEVENTF_LEFTDOWN, _MOUSEEVENTF_LEFTUP),
        "right": (_MOUSEEVENTF_RIGHTDOWN, _MOUSEEVENTF_RIGHTUP),
        "middle": (_MOUSEEVENTF_MIDDLEDOWN, _MOUSEEVENTF_MIDDLEUP),
    }

    def _send_input(inp: _INPUT) -> None:
        sent = _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT))
        if sent != 1:
            code = ctypes.GetLastError()
            raise InputUnavailable(
                f"Windows recusou o envio do comando de input (erro {code})."
            )

    def _win_vk_for(name: str) -> int | None:
        key = _normalize_key_name(name)
        if key in _WIN_VK:
            return _WIN_VK[key]
        if len(key) == 1:
            res = _user32.VkKeyScanW(key)
            if res == -1:
                return None
            return res & 0xFF
        return None

    def _win_key_event(vk: int, keyup: bool) -> None:
        scan = _user32.MapVirtualKeyW(vk, _MAPVK_VK_TO_VSC)
        flags = _KEYEVENTF_SCANCODE
        if vk in _WIN_EXTENDED_VKS:
            flags |= _KEYEVENTF_EXTENDEDKEY
        if keyup:
            flags |= _KEYEVENTF_KEYUP
        inp = _INPUT()
        inp.type = _INPUT_KEYBOARD
        inp.union.ki = _KEYBDINPUT(0, scan, flags, 0, _WIN_INPUT_EXTRA_PTR)
        _send_input(inp)

    def _win_mouse_event(flags: int, mouse_data: int = 0, dx: int = 0, dy: int = 0) -> None:
        inp = _INPUT()
        inp.type = _INPUT_MOUSE
        inp.union.mi = _MOUSEINPUT(dx, dy, mouse_data, flags, 0, _WIN_INPUT_EXTRA_PTR)
        _send_input(inp)

    def _win_move_mouse(x: int, y: int) -> None:
        left, top, width, height = screen_bounds()
        cx, cy = _clamp_xy(x, y)
        abs_x = round((cx - left) * 65535 / max(1, width - 1))
        abs_y = round((cy - top) * 65535 / max(1, height - 1))
        _win_mouse_event(
            _MOUSEEVENTF_MOVE | _MOUSEEVENTF_ABSOLUTE | _MOUSEEVENTF_VIRTUALDESK,
            dx=abs_x,
            dy=abs_y,
        )

    def _win_click(x: int, y: int, button: str = "left", double: bool = False) -> None:
        down, up = _WIN_MOUSE_BUTTON_FLAGS.get(button, _WIN_MOUSE_BUTTON_FLAGS["left"])
        _win_move_mouse(x, y)
        count = 2 if double else 1
        for index in range(count):
            _win_mouse_event(down)
            time.sleep(0.025)
            _win_mouse_event(up)
            if index + 1 < count:
                time.sleep(0.04)

    def _win_drag(
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        button: str = "left",
        duration_ms: int = 450,
    ) -> None:
        down, up = _WIN_MOUSE_BUTTON_FLAGS.get(button, _WIN_MOUSE_BUTTON_FLAGS["left"])
        start = _clamp_xy(x1, y1)
        end = _clamp_xy(x2, y2)
        duration = max(0.05, min(float(duration_ms) / 1000, 5.0))
        steps = max(1, min(120, int(duration / 0.016)))
        interval = duration / steps

        _win_move_mouse(*start)
        time.sleep(0.05)
        _win_mouse_event(down)
        try:
            for index in range(1, steps + 1):
                t = index / steps
                _win_move_mouse(
                    round(start[0] + (end[0] - start[0]) * t),
                    round(start[1] + (end[1] - start[1]) * t),
                )
                time.sleep(interval)
        finally:
            _win_mouse_event(up)

    def _win_scroll(x: int, y: int, dy: int) -> None:
        _win_move_mouse(x, y)
        _win_mouse_event(_MOUSEEVENTF_WHEEL, int(dy) * _WHEEL_DELTA)

    def _win_press(name: str) -> None:
        vk = _win_vk_for(name)
        if vk is None:
            raise ValueError(f"Tecla desconhecida: {name!r}")
        _win_key_event(vk, False)
        _win_key_event(vk, True)

    def _win_hotkey(keys: list[str]) -> None:
        names = _normalize_hotkey_names(keys)
        vks: list[int] = []
        for name in names:
            vk = _win_vk_for(name)
            if vk is None:
                raise ValueError(f"Tecla desconhecida: {name!r}")
            vks.append(vk)
        if not vks:
            return
        *mods, final = vks
        for mod in mods:
            _win_key_event(mod, False)
            time.sleep(_HOTKEY_PAUSE_SECONDS)
        try:
            _win_key_event(final, False)
            time.sleep(_HOTKEY_PAUSE_SECONDS)
            _win_key_event(final, True)
        finally:
            for mod in reversed(mods):
                _win_key_event(mod, True)

    def _win_unicode_code_unit(code_unit: int, keyup: bool) -> None:
        flags = _KEYEVENTF_UNICODE
        if keyup:
            flags |= _KEYEVENTF_KEYUP
        inp = _INPUT()
        inp.type = _INPUT_KEYBOARD
        inp.union.ki = _KEYBDINPUT(0, code_unit, flags, 0, _WIN_INPUT_EXTRA_PTR)
        _send_input(inp)

    def _win_type_text(text: str) -> None:
        utf16 = text.encode("utf-16-le")
        for i in range(0, len(utf16), 2):
            code_unit = int.from_bytes(utf16[i : i + 2], "little")
            _win_unicode_code_unit(code_unit, False)
            _win_unicode_code_unit(code_unit, True)


def press_key(name: str) -> None:
    if _IS_WINDOWS:
        _win_press(name)
        return
    _require()
    _, keyboard = _controllers()
    key = _resolve_key(name)
    keyboard.press(key)
    keyboard.release(key)


def hotkey(keys: list[str]) -> None:
    """Combinação: segura todas menos a última e aciona a última."""
    if _IS_WINDOWS:
        _win_hotkey(keys)
        return
    _require()
    _, keyboard = _controllers()
    resolved = [_resolve_key(k) for k in _normalize_hotkey_names(keys)]
    if not resolved:
        return
    *mods, final = resolved
    for mod in mods:
        keyboard.press(mod)
    try:
        time.sleep(_HOTKEY_PAUSE_SECONDS)
        keyboard.press(final)
        time.sleep(_HOTKEY_PAUSE_SECONDS)
        keyboard.release(final)
    finally:
        for mod in reversed(mods):
            keyboard.release(mod)


def type_text(text: str) -> None:
    if _IS_WINDOWS:
        _win_type_text(text)
        return
    _require()
    _, keyboard = _controllers()
    keyboard.type(text)
