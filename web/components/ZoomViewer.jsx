"use client";

import { useEffect, useRef, useState } from "react";
import { IconClose, IconPlus, IconMinus, IconExpand } from "@/components/icons";

const MIN = 1;
const MAX = 6;

/**
 * Full-screen image viewer with REAL gesture handling.
 *
 * The whole point: the zoom is applied to the <img> via a CSS transform, not
 * to the page. So the page itself never zooms, which means:
 *   • one-finger drag pans (when zoomed in)
 *   • two-finger pinch zooms the image around the pinch point
 *   • double-tap toggles zoom at the tapped point
 *   • the close button + info bar live OUTSIDE the transformed image, pinned
 *     on top, so they never disappear no matter how far you zoom.
 *
 * We talk to the DOM through refs and mutate `transform` directly so a pinch
 * doesn't trigger a React re-render on every frame.
 */
export default function ZoomViewer({ image, timestamp, width, height, onClose }) {
  const containerRef = useRef(null);
  const imgRef = useRef(null);
  const view = useRef({ scale: 1, tx: 0, ty: 0 });
  const [pct, setPct] = useState(100);

  // animate=true gives a quick eased glide (used by double-tap and the +/-
  // buttons). During pinch/pan we call apply() with no transition so the image
  // tracks the finger 1:1.
  const apply = (animate = false) => {
    const el = imgRef.current;
    if (!el) return;
    const { scale, tx, ty } = view.current;
    el.style.transition = animate
      ? "transform 240ms cubic-bezier(0.2,0.8,0.2,1)"
      : "none";
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    el.style.cursor = scale > 1 ? "grab" : "default";
  };

  // Double-tap zoom level: roughly 1:1 actual pixels, kept in a sane band so a
  // huge screenshot doesn't fly to 5×, and a small one still zooms in usefully.
  const doubleTapTarget = () => {
    const el = imgRef.current;
    if (el && el.naturalWidth && el.offsetWidth) {
      return Math.min(3.5, Math.max(2, el.naturalWidth / el.offsetWidth));
    }
    return 2.6;
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

  // Zoom to a scale while keeping a focal client-point fixed on screen.
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

  // Lock body scroll while the viewer is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const cont = containerRef.current;
    if (!cont) return;

    let gesture = null; // { type, ... }
    let lastTap = 0;
    let lastTapPos = null;

    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

    // ---- Touch (phone) ------------------------------------------------
    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        gesture = { type: "pinch", d: dist(a, b), m: mid(a, b), s0: view.current.scale };
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        gesture = {
          type: "pan",
          startX: t.clientX,
          startY: t.clientY,
          lastX: t.clientX,
          lastY: t.clientY,
          moved: false,
        };
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
        // Zoom around the pinch midpoint AND pan with it (two-finger drag).
        view.current.tx = view.current.tx * k + px * (1 - k) + (m.x - gesture.m.x);
        view.current.ty = view.current.ty * k + py * (1 - k) + (m.y - gesture.m.y);
        view.current.scale = ns;
        gesture.m = m;
        clampPan();
        apply();
        setPct(Math.round(ns * 100));
      } else if (gesture.type === "pan" && e.touches.length === 1) {
        const t = e.touches[0];
        const dx = t.clientX - gesture.lastX;
        const dy = t.clientY - gesture.lastY;
        gesture.lastX = t.clientX;
        gesture.lastY = t.clientY;
        if (Math.abs(t.clientX - gesture.startX) + Math.abs(t.clientY - gesture.startY) > 10)
          gesture.moved = true;
        if (view.current.scale > 1) {
          // One-finger pan while zoomed in.
          e.preventDefault();
          view.current.tx += dx;
          view.current.ty += dy;
          clampPan();
          apply();
        }
        // At fit scale we let the swipe go (used for swipe-down-to-close on end).
      }
    };

    const onTouchEnd = (e) => {
      const g = gesture;
      if (g && g.type === "pan" && !g.moved) {
        // Tap — check for double-tap. preventDefault here stops the browser
        // from also synthesizing a click/dblclick from this same tap; without
        // it, at fit-scale the synthetic dblclick would fire onDblClick and
        // undo (toggle back) the zoom this handler just applied.
        e.preventDefault();
        const t = e.changedTouches[0];
        const now = Date.now();
        if (
          now - lastTap < 300 &&
          lastTapPos &&
          Math.hypot(t.clientX - lastTapPos.x, t.clientY - lastTapPos.y) < 30
        ) {
          if (view.current.scale > 1.05) zoomTo(1, undefined, undefined, true);
          else zoomTo(doubleTapTarget(), t.clientX, t.clientY, true);
          lastTap = 0;
          lastTapPos = null;
        } else {
          lastTap = now;
          lastTapPos = { x: t.clientX, y: t.clientY };
        }
      } else if (g && g.type === "pan" && view.current.scale <= 1.001) {
        // Swipe down to dismiss when not zoomed.
        const dy = g.lastY - g.startY;
        const dx = Math.abs(g.lastX - g.startX);
        if (dy > 90 && dx < 70) onClose();
      }

      if (e.touches.length === 0) {
        gesture = null;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        gesture = {
          type: "pan",
          startX: t.clientX,
          startY: t.clientY,
          lastX: t.clientX,
          lastY: t.clientY,
          moved: true,
        };
      }
    };

    // ---- Mouse / trackpad (desktop) -----------------------------------
    let dragging = false;
    let mx = 0;
    let my = 0;

    const onWheel = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      zoomTo(view.current.scale * factor, e.clientX, e.clientY);
    };
    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      mx = e.clientX;
      my = e.clientY;
      if (view.current.scale > 1 && imgRef.current) imgRef.current.style.cursor = "grabbing";
    };
    const onMouseMove = (e) => {
      if (!dragging) return;
      if (view.current.scale > 1) {
        view.current.tx += e.clientX - mx;
        view.current.ty += e.clientY - my;
        clampPan();
        apply();
      }
      mx = e.clientX;
      my = e.clientY;
    };
    const onMouseUp = () => {
      dragging = false;
      if (imgRef.current && view.current.scale > 1) imgRef.current.style.cursor = "grab";
    };
    const onDblClick = (e) => {
      e.preventDefault();
      if (view.current.scale > 1.05) zoomTo(1, undefined, undefined, true);
      else zoomTo(doubleTapTarget(), e.clientX, e.clientY, true);
    };

    // Stop Safari's own pinch-to-zoom-the-page gesture.
    const preventGesture = (e) => e.preventDefault();

    cont.addEventListener("touchstart", onTouchStart, { passive: false });
    cont.addEventListener("touchmove", onTouchMove, { passive: false });
    cont.addEventListener("touchend", onTouchEnd, { passive: false });
    cont.addEventListener("touchcancel", onTouchEnd, { passive: false });
    cont.addEventListener("wheel", onWheel, { passive: false });
    cont.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    cont.addEventListener("dblclick", onDblClick);
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
      cont.removeEventListener("wheel", onWheel);
      cont.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      cont.removeEventListener("dblclick", onDblClick);
      cont.removeEventListener("gesturestart", preventGesture);
      cont.removeEventListener("gesturechange", preventGesture);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 select-none bg-[#050505]">
      {/* The image surface — owns all gestures. touch-action:none means the
          browser hands us every touch instead of page-zooming/scrolling. */}
      <div
        ref={containerRef}
        className="absolute inset-0 grid touch-none place-items-center overflow-hidden"
        style={{ touchAction: "none", overscrollBehavior: "none" }}
      >
        <img
          ref={imgRef}
          src={image}
          alt="Enlarged screenshot"
          draggable={false}
          onLoad={() => {
            clampPan();
            apply();
          }}
          className="max-h-full max-w-full origin-center animate-fadein will-change-transform"
        />
      </div>

      {/* Info bar + close — pinned ABOVE the image, never transformed. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 bg-gradient-to-b from-black/85 to-transparent px-4 pb-6 pt-[calc(0.7rem+env(safe-area-inset-top))] sm:px-6">
        <div className="pointer-events-auto flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-[0.72rem] text-silver">
            {timestamp} · {width} × {height}px
          </span>
        </div>
        <button
          onClick={onClose}
          className="pointer-events-auto flex h-11 shrink-0 items-center gap-1.5 rounded-[2px] border border-line-strong bg-black/70 pl-2.5 pr-3.5 font-mono text-[0.7rem] uppercase tracking-stamp text-silver transition-colors hover:text-ink active:scale-95"
          aria-label="Close"
        >
          <IconClose className="h-[18px] w-[18px]" />
          Close
        </button>
      </div>

      {/* Zoom controls — also pinned, also always reachable. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-[calc(1rem+env(safe-area-inset-bottom))] pt-6">
        <div className="pointer-events-auto flex items-center gap-1 rounded-[2px] border border-line bg-black/60 p-1">
          <button
            onClick={() => zoomTo(view.current.scale / 1.5, undefined, undefined, true)}
            className="grid h-10 w-10 place-items-center rounded-[2px] text-silver transition-colors hover:bg-panel-strong hover:text-ink"
            aria-label="Zoom out"
          >
            <IconMinus className="h-[18px] w-[18px]" />
          </button>
          <button
            onClick={() => zoomTo(1, undefined, undefined, true)}
            className="min-w-[58px] px-2 font-mono text-[0.72rem] tracking-stamp text-silver transition-colors hover:text-ink"
            aria-label="Fit to screen"
          >
            {pct}%
          </button>
          <button
            onClick={() => zoomTo(view.current.scale * 1.5, undefined, undefined, true)}
            className="grid h-10 w-10 place-items-center rounded-[2px] text-silver transition-colors hover:bg-panel-strong hover:text-ink"
            aria-label="Zoom in"
          >
            <IconPlus className="h-[18px] w-[18px]" />
          </button>
          <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
          <button
            onClick={onClose}
            className="hidden h-10 items-center gap-2 rounded-[2px] px-3 font-mono text-[0.68rem] uppercase tracking-stamp text-silver transition-colors hover:bg-panel-strong hover:text-ink sm:flex"
          >
            <IconExpand className="h-4 w-4 rotate-180" />
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
