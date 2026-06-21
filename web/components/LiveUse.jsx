"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  captureScreenshot,
  getClipboard,
  getPrivacyState,
  listMonitors,
  revokeScreenshot,
  screenshotStreamUrl,
  sendInput,
  sendInputAndCapture,
  setPrivacyMode,
} from "@/lib/api";
import {
  IconChevronLeft,
  IconRefresh,
  IconLive,
  IconMouse,
  IconKeyboard,
  IconCommand,
  IconChevronUp,
  IconChevronDown,
  IconLogout,
  IconUsers,
  IconLock,
  IconMonitor,
} from "@/components/icons";

const MIN = 1;
const MAX = 6;
// Small breathing gap between the bottom of the image and the top of the dock.
// Kept tiny so the screenshot (and the remote taskbar at its bottom edge) stays
// as large and visible as possible.
const SURFACE_GAP = 10;
const STREAM_FPS = 24;

// Ready-made combos — avoid typing and getting the syntax wrong. They're OS
// aware: the backend reports the HOST machine's OS (via /api/session → `os`) and
// we show/send the combo that actually exists there. `cmd` and `win` both map to
// the platform's super/command key on the backend, so the same key id works on
// either OS.
const PRESETS_WIN = [
  { label: "Copy", keys: ["ctrl", "c"] },
  { label: "Paste", keys: ["ctrl", "v"] },
  { label: "Cut", keys: ["ctrl", "x"] },
  { label: "Select all", keys: ["ctrl", "a"] },
  { label: "Undo", keys: ["ctrl", "z"] },
  { label: "Redo", keys: ["ctrl", "y"] },
  { label: "Save", keys: ["ctrl", "s"] },
  { label: "Alt+Tab", keys: ["alt", "tab"] },
  { label: "Alt+F4", keys: ["alt", "f4"] },
  { label: "Task Mgr", keys: ["ctrl", "shift", "esc"] },
  { label: "Win", keys: ["win"] },
  { label: "Win+D", keys: ["win", "d"] },
];

// macOS analogs — ⌘ replaces Ctrl for editing, app switch/close/quit differ, and
// there is no Alt+F4 / Task Manager / PrtSc.
const PRESETS_MAC = [
  { label: "Copy", keys: ["cmd", "c"] },
  { label: "Paste", keys: ["cmd", "v"] },
  { label: "Cut", keys: ["cmd", "x"] },
  { label: "Select all", keys: ["cmd", "a"] },
  { label: "Undo", keys: ["cmd", "z"] },
  { label: "Redo", keys: ["cmd", "shift", "z"] },
  { label: "Save", keys: ["cmd", "s"] },
  { label: "⌘+Tab", keys: ["cmd", "tab"] },
  { label: "Close", keys: ["cmd", "w"] },
  { label: "Quit", keys: ["cmd", "q"] },
  { label: "Force Quit", keys: ["cmd", "alt", "esc"] },
  { label: "Spotlight", keys: ["cmd", "space"] },
  { label: "Mission Ctrl", keys: ["ctrl", "up"] },
];

const MODS_WIN = [
  { id: "ctrl", label: "Ctrl" },
  { id: "alt", label: "Alt" },
  { id: "shift", label: "Shift" },
  { id: "win", label: "Win" },
];

const MODS_MAC = [
  { id: "ctrl", label: "⌃ Ctrl" },
  { id: "alt", label: "⌥ Option" },
  { id: "shift", label: "⇧ Shift" },
  { id: "cmd", label: "⌘ Cmd" },
];

// Special keys (sent immediately on tap) — shared on both, plus an OS tail.
const SPECIALS_BASE = [
  { label: "Esc", key: "esc" },
  { label: "Tab", key: "tab" },
  { label: "Enter", key: "enter" },
  { label: "⌫", key: "backspace" },
  { label: "Del", key: "delete" },
  { label: "Space", key: "space" },
  { label: "↑", key: "up" },
  { label: "↓", key: "down" },
  { label: "←", key: "left" },
  { label: "→", key: "right" },
  { label: "Home", key: "home" },
  { label: "End", key: "end" },
  { label: "PgUp", key: "page_up" },
  { label: "PgDn", key: "page_down" },
];

const SPECIALS_WIN = [
  ...SPECIALS_BASE,
  { label: "PrtSc", key: "print_screen" },
  { label: "Win", key: "win" },
];

const SPECIALS_MAC = [
  ...SPECIALS_BASE,
  { label: "⌘", key: "cmd" },
];

const FKEYS = Array.from({ length: 12 }, (_, i) => ({
  label: `F${i + 1}`,
  key: `f${i + 1}`,
}));

// Build the keymap for the host OS. Anything that isn't macOS uses the Windows
// set (also a reasonable default for Linux, where `win` = Super).
function makeKeymap(os) {
  const mac = os === "mac";
  return {
    presets: mac ? PRESETS_MAC : PRESETS_WIN,
    mods: mac ? MODS_MAC : MODS_WIN,
    specials: mac ? SPECIALS_MAC : SPECIALS_WIN,
  };
}

// All modifier ids the combo parser should recognize, regardless of OS, so a
// manually typed "cmd+space" or "win+e" is split correctly either way.
const ALL_MOD_IDS = new Set(["ctrl", "alt", "shift", "win", "cmd", "super", "meta"]);
const KEY_ALIASES = {
  ctl: "ctrl",
  control: "ctrl",
  windows: "win",
  window: "win",
  command: "cmd",
  option: "alt",
  escape: "esc",
  return: "enter",
  del: "delete",
  " ": "space",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  pageup: "page_up",
  pgup: "page_up",
  pagedown: "page_down",
  pgdn: "page_down",
  printscreen: "print_screen",
  prtsc: "print_screen",
};

const normalizeKeyName = (value) => {
  const raw = value.trim();
  if (!raw) return "";
  const key = raw.length === 1 ? raw.toLowerCase() : raw.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  return KEY_ALIASES[key] || key;
};

const NAMED_KEY_IDS = new Set([
  ...ALL_MOD_IDS,
  ...SPECIALS_WIN.map((s) => s.key),
  ...SPECIALS_MAC.map((s) => s.key),
  ...FKEYS.map((s) => s.key),
]);

const COMBO_SEPARATOR_RE = /[\s+\-‐-―−]+/;
const COMBO_FALLBACK_SEPARATOR_RE = /[_\s+\-‐-―−]+/;

const protectKeyPhrases = (value) =>
  value
    .replace(/\bpage\s+up\b/gi, "page_up")
    .replace(/\bpage\s+down\b/gi, "page_down")
    .replace(/\bprint\s+screen\b/gi, "print_screen")
    .replace(/\bcaps\s+lock\b/gi, "caps_lock");

const isResolvableKeyName = (value) => {
  const key = normalizeKeyName(value);
  return NAMED_KEY_IDS.has(key) || key.length === 1;
};

const splitComboKeys = (value) => {
  const raw = protectKeyPhrases(value.trim());
  if (!raw) return [];
  if (isResolvableKeyName(raw)) return [normalizeKeyName(raw)];

  let parts = raw.split(COMBO_SEPARATOR_RE).filter(Boolean);
  if (parts.length <= 1) {
    parts = raw.split(COMBO_FALLBACK_SEPARATOR_RE).filter(Boolean);
  }
  return parts.map(normalizeKeyName).filter(Boolean);
};

/**
 * Live mode — remote control of the PC from the phone.
 *
 * Reuses the ZoomViewer gesture engine (scale/tx/ty refs + DOM transform, no
 * per-frame re-render), but changes what the touches mean:
 *   • 1 finger  → move the AIM (the click point)
 *   • 2 fingers → pan + pinch-zoom the image
 *
 * The aim is kept as a fraction (fx, fy) ∈ [0,1] of the image. Because the
 * <img> getBoundingClientRect() already reflects the transform, the on-screen
 * position is trivial and the click we send is round(fx * real_width),
 * round(fy * real_height).
 *
 * Layout goal: keep the screenshot as large as possible. The control dock can
 * be hidden (so the full remote screen, including its taskbar, is visible), and
 * the soft keyboard is tracked via the VisualViewport API so it never covers
 * the image while typing.
 */
export default function LiveUse({
  initialShot,
  onClose,
  onLogout,
  onSignOut,
  onSessions,
  isOwner = false,
  os = "windows",
}) {
  // OS-aware shortcuts: labels + keys match the machine being controlled.
  const keymap = useMemo(() => makeKeymap(os), [os]);
  const containerRef = useRef(null);
  const imgRef = useRef(null);
  const hLineRef = useRef(null);
  const vLineRef = useRef(null);
  const dotRef = useRef(null);
  const dragLineRef = useRef(null);
  const dragStartMarkerRef = useRef(null);
  const coordRef = useRef(null);

  const view = useRef({ scale: 1, tx: 0, ty: 0 });
  const crosshair = useRef({ fx: 0.5, fy: 0.5 });
  const dragStartRef = useRef(null);

  const [shot, setShot] = useState(initialShot || null);
  const shotRef = useRef(shot);
  const [pct, setPct] = useState(100);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [streamUrl, setStreamUrl] = useState("");
  const [privacyOn, setPrivacyOn] = useState(false);
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [monitors, setMonitors] = useState([]);
  const [monitorId, setMonitorId] = useState(initialShot?.monitorId || 1);
  const monitorIdRef = useRef(initialShot?.monitorId || 1);
  const [status, setStatus] = useState({ text: "Ready.", state: "idle" });
  const [showHint, setShowHint] = useState(true);

  // Controls
  const [tab, setTab] = useState("mouse"); // mouse | keyboard | special
  // Start with the dock minimized so opening the link shows the full screen
  // first; the user taps the "Controls" pill to reveal the controls.
  const [dockHidden, setDockHidden] = useState(true);
  const [mouseAction, setMouseAction] = useState("click"); // click | drag
  const [button, setButton] = useState("left");
  const [doubleClick, setDoubleClick] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [scrollAmount, setScrollAmount] = useState(3);
  const [kbMode, setKbMode] = useState("command"); // command | type
  const [activeMods, setActiveMods] = useState([]);
  const [comboKey, setComboKey] = useState("");
  const [textValue, setTextValue] = useState("");
  const [enterAfter, setEnterAfter] = useState(false);
  const [showFkeys, setShowFkeys] = useState(false);

  const busyRef = useRef(false);
  const autoRef = useRef(false);
  const mountedRef = useRef(true);
  const refreshTimer = useRef(null);
  const ownedShotUrlsRef = useRef(new Set());

  const topbarRef = useRef(null);
  const dockRef = useRef(null);
  const [dockH, setDockH] = useState(0);
  const [kbInset, setKbInset] = useState(0);
  const kbInsetRef = useRef(0);
  const [surfaceInsets, setSurfaceInsets] = useState({ top: 0, bottom: 0 });

  useEffect(() => {
    shotRef.current = shot;
  }, [shot]);

  useEffect(() => {
    monitorIdRef.current = monitorId;
  }, [monitorId]);

  const replaceShot = (nextShot) => {
    if (nextShot?.image?.startsWith("blob:")) {
      ownedShotUrlsRef.current.add(nextShot.image);
    }
    setShot((prev) => {
      if (prev?.image && ownedShotUrlsRef.current.has(prev.image)) {
        revokeScreenshot(prev);
        ownedShotUrlsRef.current.delete(prev.image);
      }
      return nextShot;
    });
  };

  // First-run gesture hint fades out on its own (one-shot, no looping anim).
  useEffect(() => {
    const t = setTimeout(() => setShowHint(false), 4500);
    return () => clearTimeout(t);
  }, []);

  // Measure the fixed bars so the image lives inside the truly clickable area.
  useEffect(() => {
    const dock = dockRef.current;
    const topbar = topbarRef.current;
    if (!dock || !topbar) return;
    const measure = () => {
      const nextDockH = Math.ceil(dock.offsetHeight);
      const nextTop = Math.ceil(topbar.offsetHeight);
      const viewportH = window.innerHeight || 0;
      const desiredBottom = nextDockH + SURFACE_GAP + kbInsetRef.current;
      const maxBottom = Math.max(nextDockH, viewportH - nextTop - 80);
      const nextBottom = viewportH ? Math.min(desiredBottom, maxBottom) : desiredBottom;
      setDockH(nextDockH);
      setSurfaceInsets((prev) =>
        prev.top === nextTop && prev.bottom === nextBottom
          ? prev
          : { top: nextTop, bottom: nextBottom },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(dock);
    ro.observe(topbar);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbInset]);

  // Track the on-screen keyboard via VisualViewport: when it opens, the dock
  // (which holds the text input) rides above it and the image shrinks just
  // enough to stay fully visible instead of being hidden behind the keyboard.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const onChange = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // Ignore tiny browser-chrome jitter.
      const next = overlap > 90 ? Math.round(overlap) : 0;
      kbInsetRef.current = next;
      setKbInset((prev) => (prev === next ? prev : next));
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    onChange();
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, []);

  // The dock changes height (hide, tab, keyboard); reposition image + aim into
  // the usable area whenever those insets move.
  useEffect(() => {
    clampPan();
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceInsets.top, surfaceInsets.bottom, kbInset]);

  useEffect(() => {
    if (!dockHidden) requestAnimationFrame(placeCrosshair);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockHidden]);

  // ---- Aim + transform ---------------------------------------------------
  const placeCrosshair = () => {
    const img = imgRef.current;
    const cont = containerRef.current;
    if (!img || !cont) return;
    const ir = img.getBoundingClientRect();
    const cr = cont.getBoundingClientRect();
    const { fx, fy } = crosshair.current;
    const cx = ir.left - cr.left + fx * ir.width;
    const cy = ir.top - cr.top + fy * ir.height;
    if (hLineRef.current) hLineRef.current.style.transform = `translateY(${cy}px)`;
    if (vLineRef.current) vLineRef.current.style.transform = `translateX(${cx}px)`;
    if (dotRef.current) dotRef.current.style.transform = `translate(${cx}px, ${cy}px)`;
    if (dragStartRef.current && dragLineRef.current && dragStartMarkerRef.current) {
      const sx = ir.left - cr.left + dragStartRef.current.fx * ir.width;
      const sy = ir.top - cr.top + dragStartRef.current.fy * ir.height;
      const dx = cx - sx;
      const dy = cy - sy;
      dragStartMarkerRef.current.style.transform = `translate(${sx}px, ${sy}px)`;
      dragLineRef.current.style.width = `${Math.hypot(dx, dy)}px`;
      dragLineRef.current.style.transform = `translate(${sx}px, ${sy}px) rotate(${Math.atan2(dy, dx)}rad)`;
    }
    const s = shotRef.current;
    if (coordRef.current && s) {
      coordRef.current.textContent = `${Math.round(fx * s.width)}, ${Math.round(fy * s.height)}`;
    }
  };

  const updateDragStart = (point) => {
    dragStartRef.current = point;
    setDragStart(point);
    requestAnimationFrame(placeCrosshair);
  };

  const apply = (animate = false) => {
    const el = imgRef.current;
    if (!el) return;
    const { scale, tx, ty } = view.current;
    el.style.transition = animate ? "transform 200ms cubic-bezier(0.2,0.8,0.2,1)" : "none";
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    placeCrosshair();
  };

  const clampPan = () => {
    const img = imgRef.current;
    const cont = containerRef.current;
    if (!img || !cont) return;
    const s = view.current.scale;
    const maxX = Math.max(0, (img.offsetWidth * s - cont.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * s - cont.clientHeight) / 2);
    view.current.tx = Math.min(maxX, Math.max(-maxX, view.current.tx));
    view.current.ty = Math.min(maxY, Math.max(-maxY, view.current.ty));
  };

  const centerPoint = () => {
    const r = containerRef.current.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  const zoomTo = (next, fx, fy, animate = false) => {
    const ns = Math.min(MAX, Math.max(MIN, next));
    const c = centerPoint();
    const px = (fx ?? c.x) - c.x;
    const py = (fy ?? c.y) - c.y;
    const k = ns / view.current.scale;
    view.current.tx = view.current.tx * k + px * (1 - k);
    view.current.ty = view.current.ty * k + py * (1 - k);
    view.current.scale = ns;
    if (ns <= MIN + 0.001) {
      view.current.tx = 0;
      view.current.ty = 0;
    }
    clampPan();
    apply(animate);
    setPct(Math.round(ns * 100));
  };

  // Relative joystick: the aim does NOT jump to the finger. A drag of N pixels
  // on screen moves the aim N pixels (1:1) from where it already is. Since the
  // aim is stored as a fraction of the image, we convert the screen delta to a
  // fraction by dividing by the current <img> width/height (which reflects zoom).
  const nudgeAim = (dxScreen, dyScreen) => {
    const img = imgRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const fx = Math.min(1, Math.max(0, crosshair.current.fx + dxScreen / r.width));
    const fy = Math.min(1, Math.max(0, crosshair.current.fy + dyScreen / r.height));
    crosshair.current = { fx, fy };
    placeCrosshair();
  };

  // ---- Screenshot refresh ------------------------------------------------
  const doRefresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const data = await captureScreenshot("live", monitorIdRef.current);
      if (!mountedRef.current) return;
      replaceShot(data);
    } catch (err) {
      if (!mountedRef.current) return;
      if (err.unauthorized) return onLogout();
      setStatus({ text: err.message || "Failed to refresh.", state: "error" });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const toggleAuto = () => {
    setAuto((prev) => {
      const next = !prev;
      autoRef.current = next;
      clearTimeout(refreshTimer.current);
      setStreamUrl(
        next
          ? screenshotStreamUrl({
              profile: "live",
              monitor: monitorIdRef.current,
              fps: STREAM_FPS,
              nonce: Date.now(),
            })
          : "",
      );
      setStatus({
        text: next ? `Streaming at ${STREAM_FPS} fps.` : "Auto stream off.",
        state: "idle",
      });
      if (!next) setTimeout(doRefresh, 0);
      return next;
    });
  };

  // ---- Sending actions ---------------------------------------------------
  const send = async (payload, label) => {
    const withMonitor = { ...payload, monitor_id: monitorIdRef.current };
    setStatus({ text: "Sending…", state: "busy" });
    try {
      if (autoRef.current) {
        await sendInput(withMonitor);
        if (!mountedRef.current) return;
        setStatus({ text: label || "Sent.", state: "idle" });
        return true;
      }
      const data = await sendInputAndCapture(withMonitor);
      if (!mountedRef.current) return;
      replaceShot(data);
      setStatus({ text: label || "Sent.", state: "idle" });
      return true;
    } catch (err) {
      if (!mountedRef.current) return;
      if (err.unauthorized) {
        onLogout();
        return false;
      }
      setStatus({ text: err.message || "Send failed.", state: "error" });
      return false;
    }
  };

  const pointXY = (point) => {
    const s = shotRef.current;
    if (!s || !point) return null;
    return {
      x: Math.round(point.fx * s.width),
      y: Math.round(point.fy * s.height),
    };
  };

  const aimXY = () => pointXY(crosshair.current);

  const sendClick = () => {
    const xy = aimXY();
    if (!xy) return;
    send(
      { action: "click", x: xy.x, y: xy.y, button, double: doubleClick },
      doubleClick ? "Double-click sent." : "Click sent.",
    );
  };

  const sendDrag = async () => {
    if (!dragStartRef.current) {
      updateDragStart({ ...crosshair.current });
      setStatus({ text: "Drag start marked. Move the aim to the target.", state: "idle" });
      return;
    }

    const from = pointXY(dragStartRef.current);
    const to = aimXY();
    if (!from || !to) return;
    const ok = await send(
      {
        action: "drag",
        x: from.x,
        y: from.y,
        x2: to.x,
        y2: to.y,
        button,
        duration_ms: 450,
      },
      "Drag sent.",
    );
    if (ok) updateDragStart(null);
  };

  const sendScroll = (dir) => {
    const xy = aimXY();
    if (!xy) return;
    const dy = dir === "up" ? scrollAmount : -scrollAmount;
    send({ action: "scroll", x: xy.x, y: xy.y, dy }, "Scroll sent.");
  };

  const sendPreset = (preset) => send({ action: "hotkey", keys: preset.keys }, preset.label);

  const sendCombo = () => {
    const typedKeys = splitComboKeys(comboKey);
    if (!typedKeys.length && !activeMods.length) {
      setStatus({ text: "Enter a key or modifier.", state: "error" });
      return;
    }
    const mods = [...activeMods];
    const finalKeys = [];
    for (const key of typedKeys) {
      if (ALL_MOD_IDS.has(key)) {
        if (!mods.includes(key)) mods.push(key);
      } else {
        finalKeys.push(key);
      }
    }
    if (finalKeys.length > 1) {
      setStatus({ text: "Use only one final key in the command.", state: "error" });
      return;
    }
    const keys = [...mods, ...finalKeys];
    send({ action: "hotkey", keys }, keys.join(" + "));
  };

  const sendTyped = () => {
    if (!textValue) return;
    const text = enterAfter ? `${textValue}\n` : textValue;
    send({ action: "text", text }, "Text sent.");
    setTextValue("");
  };

  const sendSpecial = (item) => send({ action: "key", key: item.key }, item.label);

  const toggleMod = (id) =>
    setActiveMods((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));

  const handleMonitorChange = (nextId) => {
    const parsed = Number(nextId) || 1;
    setMonitorId(parsed);
    monitorIdRef.current = parsed;
    crosshair.current = { fx: 0.5, fy: 0.5 };
    view.current = { scale: 1, tx: 0, ty: 0 };
    setPct(100);
    if (autoRef.current) {
      setStreamUrl(
        screenshotStreamUrl({
          profile: "live",
          monitor: parsed,
          fps: STREAM_FPS,
          nonce: Date.now(),
        }),
      );
    }
    requestAnimationFrame(() => {
      apply(true);
      doRefresh();
    });
  };

  const togglePrivacy = async () => {
    if (!isOwner || privacyBusy) return;
    const next = !privacyOn;
    setPrivacyBusy(true);
    setStatus({ text: next ? "Enabling Privacy Mode..." : "Disabling Privacy Mode...", state: "busy" });
    try {
      const state = await setPrivacyMode(next);
      setPrivacyOn(Boolean(state.enabled));
      setStatus({
        text: state.enabled ? "Privacy Mode on." : "Privacy Mode off.",
        state: state.input_blocked || !state.enabled ? "idle" : "error",
      });
    } catch (err) {
      if (err.unauthorized) return onLogout();
      setStatus({ text: err.message || "Privacy Mode failed.", state: "error" });
    } finally {
      setPrivacyBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    listMonitors()
      .then((items) => {
        if (!active) return;
        const next = items.length ? items : [];
        setMonitors(next);
        if (next.length && !next.some((m) => Number(m.id) === Number(monitorIdRef.current))) {
          handleMonitorChange(next[0].id);
        }
      })
      .catch((err) => {
        if (err.unauthorized) onLogout();
      });
    getPrivacyState()
      .then((state) => active && setPrivacyOn(Boolean(state.enabled)))
      .catch(() => {});
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    let lastHash = "";
    let primed = false;
    const poll = async () => {
      try {
        const data = await getClipboard();
        if (!active) return;
        if (!data.enabled) {
          lastHash = "";
          primed = false;
          return;
        }
        if (data.hash && data.hash !== lastHash && data.text) {
          const shouldOffer = primed;
          lastHash = data.hash;
          primed = true;
          if (shouldOffer && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(data.text);
          }
        }
      } catch (err) {
        if (err.unauthorized) onLogout();
      }
    };
    const timer = setInterval(poll, 1800);
    poll();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [onLogout]);

  // ---- Gestures (touch + mouse for desktop testing) ----------------------
  useEffect(() => {
    const cont = containerRef.current;
    if (!cont) return;

    let gesture = null;
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        gesture = { type: "pinch", d: dist(a, b), m: mid(a, b), s0: view.current.scale };
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        // Aim as a joystick: store the last point and move by delta.
        gesture = { type: "aim", lastX: t.clientX, lastY: t.clientY };
      }
    };

    const onTouchMove = (e) => {
      if (!gesture) return;
      if (gesture.type === "pinch" && e.touches.length >= 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        const d = dist(a, b);
        const m = mid(a, b);
        const ns = Math.min(MAX, Math.max(MIN, gesture.s0 * (d / gesture.d)));
        const c = centerPoint();
        const px = m.x - c.x;
        const py = m.y - c.y;
        const k = ns / view.current.scale;
        view.current.tx = view.current.tx * k + px * (1 - k) + (m.x - gesture.m.x);
        view.current.ty = view.current.ty * k + py * (1 - k) + (m.y - gesture.m.y);
        view.current.scale = ns;
        gesture.m = m;
        clampPan();
        apply();
        setPct(Math.round(ns * 100));
      } else if (gesture.type === "aim" && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        nudgeAim(t.clientX - gesture.lastX, t.clientY - gesture.lastY);
        gesture.lastX = t.clientX;
        gesture.lastY = t.clientY;
      }
    };

    const onTouchEnd = (e) => {
      if (e.touches.length === 0) {
        gesture = null;
      } else if (e.touches.length === 1) {
        // Back to one finger from a pinch: re-anchor without jumping the aim.
        const t = e.touches[0];
        gesture = { type: "aim", lastX: t.clientX, lastY: t.clientY };
      }
    };

    // Mouse (desktop testing): drag = move aim (relative), wheel = zoom.
    let dragging = null;
    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      dragging = { x: e.clientX, y: e.clientY };
    };
    const onMouseMove = (e) => {
      if (!dragging) return;
      nudgeAim(e.clientX - dragging.x, e.clientY - dragging.y);
      dragging.x = e.clientX;
      dragging.y = e.clientY;
    };
    const onMouseUp = () => {
      dragging = null;
    };
    const onWheel = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1 / 1.18 : 1.18;
      zoomTo(view.current.scale * factor, e.clientX, e.clientY);
    };
    const preventGesture = (e) => e.preventDefault();

    cont.addEventListener("touchstart", onTouchStart, { passive: false });
    cont.addEventListener("touchmove", onTouchMove, { passive: false });
    cont.addEventListener("touchend", onTouchEnd, { passive: false });
    cont.addEventListener("touchcancel", onTouchEnd, { passive: false });
    cont.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    cont.addEventListener("wheel", onWheel, { passive: false });
    cont.addEventListener("gesturestart", preventGesture);
    cont.addEventListener("gesturechange", preventGesture);

    const onResize = () => {
      clampPan();
      apply();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cont.removeEventListener("touchstart", onTouchStart);
      cont.removeEventListener("touchmove", onTouchMove);
      cont.removeEventListener("touchend", onTouchEnd);
      cont.removeEventListener("touchcancel", onTouchEnd);
      cont.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      cont.removeEventListener("wheel", onWheel);
      cont.removeEventListener("gesturestart", preventGesture);
      cont.removeEventListener("gesturechange", preventGesture);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Lifecycle ---------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    doRefresh(); // first fresh frame
    return () => {
      mountedRef.current = false;
      autoRef.current = false;
      document.body.style.overflow = prevOverflow;
      clearTimeout(refreshTimer.current);
      ownedShotUrlsRef.current.forEach((url) => revokeScreenshot({ image: url }));
      ownedShotUrlsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const spark =
    status.state === "error" ? "bg-danger" : status.state === "busy" ? "bg-ink" : "bg-faint";

  return (
    <div className="fixed inset-0 z-50 select-none bg-[#050505]">
      {/* Image surface — receives all gestures. */}
      <div
        ref={containerRef}
        className="absolute inset-x-0 top-0 grid touch-none place-items-center overflow-hidden"
        style={{
          top: `${surfaceInsets.top}px`,
          bottom: `${surfaceInsets.bottom}px`,
          touchAction: "none",
          overscrollBehavior: "none",
        }}
      >
        {shot ? (
          <img
            ref={imgRef}
            src={streamUrl || shot.image}
            alt="Live computer screen"
            draggable={false}
            onError={() => {
              if (autoRef.current) {
                setAuto(false);
                autoRef.current = false;
                setStreamUrl("");
                setStatus({ text: "Stream stopped.", state: "error" });
              }
            }}
            onLoad={() => {
              clampPan();
              apply();
            }}
            className="max-h-full max-w-full origin-center will-change-transform"
          />
        ) : (
          <span className="font-mono text-[0.7rem] uppercase tracking-stamp text-faint">
            Loading screen…
          </span>
        )}

        {/* Aim — lines crossing at the click point (don't receive touch). */}
        {!dockHidden && (
          <>
            <div ref={hLineRef} className="pointer-events-none absolute inset-x-0 top-0 h-px bg-ink/50 shadow-[0_0_0_0.5px_rgba(0,0,0,0.55)]" />
            <div ref={vLineRef} className="pointer-events-none absolute inset-y-0 left-0 w-px bg-ink/50 shadow-[0_0_0_0.5px_rgba(0,0,0,0.55)]" />
            <div
              ref={dotRef}
              className="pointer-events-none absolute left-0 top-0 -ml-[7px] -mt-[7px] h-3.5 w-3.5 rounded-full border border-ink bg-ink/20 opacity-25 shadow-[0_0_0_0.5px_rgba(0,0,0,0.55)]"
            />
            {mouseAction === "drag" && dragStart && (
              <>
                <div
                  ref={dragLineRef}
                  className="pointer-events-none absolute left-0 top-0 h-px origin-left bg-ink/65 shadow-[0_0_0_0.5px_rgba(0,0,0,0.65)]"
                />
                <div
                  ref={dragStartMarkerRef}
                  className="pointer-events-none absolute left-0 top-0 -ml-[9px] -mt-[9px] h-[18px] w-[18px] rounded-full border border-ink/80 bg-black/20 shadow-[0_0_0_1px_rgba(0,0,0,0.65)]"
                />
              </>
            )}
          </>
        )}
      </div>

      {/* Top bar — outside the transform, always reachable. */}
      <div
        ref={topbarRef}
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-1.5 bg-gradient-to-b from-black/90 via-black/55 to-transparent px-3 pb-6 pt-[calc(0.55rem+env(safe-area-inset-top))] sm:px-5"
      >
        <div className="flex items-center justify-between gap-2">
          {onClose ? (
            <button
              onClick={onClose}
              className="pointer-events-auto flex h-11 shrink-0 items-center gap-1 rounded-[2px] border border-line bg-black/50 pl-2 pr-3.5 font-mono text-[0.7rem] uppercase tracking-stamp text-silver transition-colors hover:text-ink active:scale-95"
              aria-label="Back"
            >
              <IconChevronLeft className="h-[19px] w-[19px]" />
              Back
            </button>
          ) : (
            <div className="pointer-events-auto hidden h-11 shrink-0 items-center gap-2 rounded-[2px] border border-line bg-black/50 px-3 font-mono text-[0.68rem] uppercase tracking-stamp text-silver sm:flex">
              <IconLive className="h-[15px] w-[15px]" />
              Live
            </div>
          )}
          <div className="pointer-events-auto flex shrink-0 items-center gap-2">
            {isOwner && onSessions && (
              <button
                onClick={onSessions}
                className="grid h-11 w-11 place-items-center rounded-[2px] border border-line bg-black/50 text-silver transition-colors hover:text-ink"
                aria-label="Active sessions"
                title="Active sessions"
              >
                <IconUsers className="h-[18px] w-[18px]" />
              </button>
            )}
            {onSignOut && (
              <button
                onClick={onSignOut}
                className="grid h-11 w-11 place-items-center rounded-[2px] border border-line bg-black/50 text-silver transition-colors hover:border-danger/50 hover:text-danger"
                aria-label="Sign out"
                title="Sign out"
              >
                <IconLogout className="h-[18px] w-[18px]" />
              </button>
            )}
            {monitors.length > 1 && (
              <label className="flex h-11 items-center gap-1.5 rounded-[2px] border border-line bg-black/50 px-2 text-silver">
                <IconMonitor className="h-[16px] w-[16px] shrink-0" />
                <select
                  value={monitorId}
                  onChange={(e) => handleMonitorChange(e.target.value)}
                  className="h-full max-w-[112px] bg-transparent font-mono text-[0.66rem] uppercase tracking-stamp text-silver outline-none"
                  aria-label="Monitor"
                >
                  {monitors.map((monitor) => (
                    <option key={monitor.id} value={monitor.id} className="bg-black text-ink">
                      {monitor.label || `Monitor ${monitor.id}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              onClick={() => zoomTo(1, undefined, undefined, true)}
              className="grid h-11 min-w-[54px] place-items-center rounded-[2px] border border-line bg-black/50 px-2 font-mono text-[0.68rem] tracking-stamp text-silver transition-colors hover:text-ink"
              aria-label="Reset zoom to 100%"
            >
              {pct}%
            </button>
            <button
              onClick={doRefresh}
              disabled={busy}
              className="grid h-12 w-16 place-items-center rounded-[2px] border border-line-strong bg-ink/10 text-ink transition-colors hover:bg-ink/15 disabled:opacity-50"
              aria-label="Refresh screen now"
              title="Refresh screen now"
            >
              <IconRefresh className={`h-[26px] w-[26px] ${busy ? "animate-spin [animation-direction:reverse]" : ""}`} />
            </button>
            <button
              onClick={toggleAuto}
              className={`grid h-11 w-11 place-items-center rounded-[2px] border transition-colors ${
                auto
                  ? "border-ink/60 bg-ink/10 text-ink"
                  : "border-line bg-black/50 text-silver hover:text-ink"
              }`}
              aria-pressed={auto}
              aria-label="Auto stream"
              title="Auto stream"
            >
              <IconLive className="h-[17px] w-[17px]" />
            </button>
            {isOwner && (
              <button
                onClick={togglePrivacy}
                disabled={privacyBusy}
                className={`grid h-11 w-11 place-items-center rounded-[2px] border transition-colors disabled:opacity-50 ${
                  privacyOn
                    ? "border-ink bg-ink text-[#08080a]"
                    : "border-line bg-black/50 text-silver hover:text-ink"
                }`}
                aria-pressed={privacyOn}
                aria-label="Privacy Mode"
                title="Privacy Mode"
              >
                <IconLock className="h-[17px] w-[17px]" />
              </button>
            )}
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2 font-mono text-[0.66rem] text-silver">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${spark}`} />
          <span className="truncate">{status.text}</span>
          {!dockHidden && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 uppercase tracking-stamp text-faint">
              <span>aim</span>
              <span ref={coordRef} className="tabular-nums text-silver">
                —
              </span>
            </span>
          )}
        </div>
      </div>

      {/* First-run gesture hint — fades out, never overlaps controls for long. */}
      {showHint && !dockHidden && (
        <div
          className="pointer-events-none absolute left-1/2 top-[calc(env(safe-area-inset-top)+5.2rem)] z-10 -translate-x-1/2 animate-fadein whitespace-nowrap rounded-full border border-line bg-black/70 px-3 py-1.5 font-mono text-[0.58rem] uppercase tracking-stamp text-silver"
        >
          1 finger: move aim · 2 fingers: zoom
        </div>
      )}

      {/* Show-controls pill — appears when the dock is hidden so you can see
          the whole remote screen (including its taskbar). */}
      {dockHidden && (
        <button
          onClick={() => setDockHidden(false)}
          className="absolute inset-x-0 z-20 mx-auto flex w-max animate-rise items-center gap-2 rounded-full border border-line-strong bg-panel-solid px-5 py-3 font-mono text-[0.66rem] uppercase tracking-stamp text-silver shadow-[0_10px_30px_rgba(0,0,0,0.5)] transition-colors hover:text-ink"
          style={{ bottom: `calc(0.9rem + env(safe-area-inset-bottom) + ${kbInset}px)` }}
          aria-label="Show controls"
        >
          <IconChevronUp className="h-4 w-4" />
          Controls
        </button>
      )}

      {/* Control dock. */}
      <div
        ref={dockRef}
        className="absolute inset-x-0 bottom-0 z-20 overflow-x-hidden border-t border-line-strong bg-panel-solid pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-1"
        style={{
          transform: `translateY(${kbInset ? -kbInset : 0}px)`,
          display: dockHidden ? "none" : undefined,
        }}
      >
        {/* Grab handle — tap to hide the dock and reveal the full screen. */}
        <button
          onClick={() => setDockHidden(true)}
          className="mx-auto flex w-full max-w-[640px] items-center justify-center gap-2 px-3 py-1.5 text-muted transition-colors hover:text-ink sm:px-5"
          aria-label="Hide controls"
        >
          <span className="h-1 w-9 rounded-full bg-line-strong" />
          <IconChevronDown className="h-3.5 w-3.5" />
        </button>

        <div className="mx-auto w-full max-w-[640px] px-3 sm:px-5">
          {/* Tabs */}
          <div className="mb-2.5 grid grid-cols-3 gap-1.5">
            <TabButton active={tab === "mouse"} onClick={() => setTab("mouse")} icon={<IconMouse className="h-4 w-4" />}>
              Mouse
            </TabButton>
            <TabButton
              active={tab === "keyboard"}
              onClick={() => {
                updateDragStart(null);
                setTab("keyboard");
              }}
              icon={<IconKeyboard className="h-4 w-4" />}
            >
              Keyboard
            </TabButton>
            <TabButton
              active={tab === "special"}
              onClick={() => {
                updateDragStart(null);
                setTab("special");
              }}
              icon={<IconCommand className="h-4 w-4" />}
            >
              Special
            </TabButton>
          </div>

          {tab === "mouse" && (
            <div className="flex flex-col gap-2.5">
              <Segmented
                options={[
                  { id: "click", label: "Click" },
                  { id: "drag", label: "Drag" },
                ]}
                value={mouseAction}
                onChange={(value) => {
                  setMouseAction(value);
                  if (value !== "drag") updateDragStart(null);
                }}
                full
              />

              <div className="flex items-center gap-1.5">
                <span className="shrink-0 font-mono text-[0.62rem] uppercase tracking-stamp text-muted">
                  Button
                </span>
                <Segmented
                  options={[
                    { id: "left", label: "Left" },
                    { id: "right", label: "Right" },
                    { id: "middle", label: "Mid" },
                  ]}
                  value={button}
                  onChange={setButton}
                />
                {mouseAction === "click" && (
                  <Chip active={doubleClick} onClick={() => setDoubleClick((v) => !v)}>
                    Double
                  </Chip>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <span className="shrink-0 font-mono text-[0.62rem] uppercase tracking-stamp text-muted">
                  Scroll
                </span>
                <Stepper value={scrollAmount} min={1} max={50} onChange={setScrollAmount} />
                <button onClick={() => sendScroll("up")} className="btn-mini" aria-label="Scroll up">
                  <IconChevronUp className="h-4 w-4" />
                </button>
                <button onClick={() => sendScroll("down")} className="btn-mini" aria-label="Scroll down">
                  <IconChevronDown className="h-4 w-4" />
                </button>
              </div>

              {mouseAction === "drag" && (
                <div className="flex items-center gap-2 border-t border-line pt-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.62rem] uppercase tracking-stamp text-muted">
                    {dragStart ? "Start marked. Aim at the target." : "Aim at the drag start."}
                  </span>
                  {dragStart && (
                    <button
                      onClick={() => updateDragStart(null)}
                      className="shrink-0 font-mono text-[0.62rem] uppercase tracking-stamp text-silver transition-colors hover:text-ink"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}

              <button onClick={mouseAction === "drag" ? sendDrag : sendClick} className="btn-primary w-full">
                {mouseAction === "drag"
                  ? dragStart
                    ? "Drag to aim"
                    : "Mark start"
                  : doubleClick
                    ? "Send double-click"
                    : "Send click"}
              </button>
            </div>
          )}

          {tab === "keyboard" && (
            <div className="flex flex-col gap-2.5">
              <Segmented
                options={[
                  { id: "command", label: "Command" },
                  { id: "type", label: "Type" },
                ]}
                value={kbMode}
                onChange={setKbMode}
                full
              />

              {kbMode === "command" ? (
                <>
                  <div className="no-scrollbar flex max-h-[88px] flex-wrap gap-1.5 overflow-y-auto">
                    {keymap.presets.map((p) => (
                      <button key={p.label} onClick={() => sendPreset(p)} className="chip-action">
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
                    {keymap.mods.map((m) => (
                      <Chip key={m.id} active={activeMods.includes(m.id)} onClick={() => toggleMod(m.id)}>
                        {m.label}
                      </Chip>
                    ))}
                    <input
                      value={comboKey}
                      onChange={(e) => setComboKey(e.target.value.slice(0, 48))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          sendCombo();
                        }
                      }}
                      placeholder="Ctrl+T"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-9 w-[104px] rounded-[2px] border border-line bg-bg-soft px-2 text-center font-mono text-[0.9rem] text-ink outline-none focus:border-line-strong sm:w-[132px]"
                    />
                    <button onClick={sendCombo} className="btn-solid h-9 flex-1 px-3 text-[0.72rem]">
                      Send
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <input
                    value={textValue}
                    onChange={(e) => setTextValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        sendTyped();
                      }
                    }}
                    placeholder="Type the text to send…"
                    autoComplete="off"
                    className="h-11 w-full rounded-[2px] border border-line bg-bg-soft px-3 text-[1rem] text-ink outline-none focus:border-line-strong"
                  />
                  <div className="flex items-center gap-2">
                    <Chip active={enterAfter} onClick={() => setEnterAfter((v) => !v)}>
                      Enter at end
                    </Chip>
                    <button onClick={sendTyped} className="btn-solid ml-auto h-10 flex-1 px-4">
                      Send text
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "special" && (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-4 gap-1.5">
                {keymap.specials.map((s) => (
                  <button key={s.key} onClick={() => sendSpecial(s)} className="chip-key">
                    {s.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowFkeys((v) => !v)}
                className="font-mono text-[0.62rem] uppercase tracking-stamp text-muted transition-colors hover:text-ink"
              >
                {showFkeys ? "− Hide F1–F12" : "+ F1–F12 keys"}
              </button>
              {showFkeys && (
                <div className="grid grid-cols-6 gap-1.5">
                  {FKEYS.map((s) => (
                    <button key={s.key} onClick={() => sendSpecial(s)} className="chip-key">
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-[2px] border px-1 font-mono text-[0.64rem] uppercase tracking-[0.12em] transition-colors ${
        active
          ? "border-ink/60 bg-ink/10 text-ink"
          : "border-line bg-panel text-muted hover:text-ink"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

function Segmented({ options, value, onChange, full }) {
  return (
    <div className={`flex gap-1 rounded-[2px] border border-line bg-bg-soft p-1 ${full ? "w-full" : ""}`}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`h-8 flex-1 rounded-[2px] px-2.5 font-mono text-[0.7rem] uppercase tracking-stamp transition-colors ${
            value === o.id ? "bg-ink text-[#08080a]" : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`h-9 shrink-0 rounded-[2px] border px-3 font-mono text-[0.7rem] uppercase tracking-stamp transition-colors ${
        active ? "border-ink bg-ink/15 text-ink" : "border-line bg-panel text-muted hover:text-ink"
      }`}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function Stepper({ value, min, max, onChange }) {
  return (
    <div className="flex h-9 items-center rounded-[2px] border border-line bg-bg-soft">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        className="grid h-full w-8 place-items-center text-muted transition-colors hover:text-ink"
        aria-label="Decrease"
      >
        −
      </button>
      <span className="min-w-[1.6ch] text-center font-mono text-[0.8rem] tabular-nums text-ink">
        {value}
      </span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        className="grid h-full w-8 place-items-center text-muted transition-colors hover:text-ink"
        aria-label="Increase"
      >
        +
      </button>
    </div>
  );
}
