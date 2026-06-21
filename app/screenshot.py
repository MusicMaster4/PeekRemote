from __future__ import annotations

import platform
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO

from PIL import Image, ImageGrab

try:
    import mss

    _MSS_OK = True
except Exception:  # pragma: no cover - optional fast path
    _MSS_OK = False


@dataclass(frozen=True)
class Screenshot:
    data: bytes
    filename: str
    timestamp: datetime
    width: int
    height: int
    media_type: str
    monitor_id: int
    monitor_left: int
    monitor_top: int


@dataclass(frozen=True)
class Monitor:
    id: int
    left: int
    top: int
    width: int
    height: int
    primary: bool = False


def _monitors_mss() -> list[Monitor]:
    if not _MSS_OK:
        return []
    with mss.mss() as sct:
        monitors = []
        for index, raw in enumerate(sct.monitors[1:], start=1):
            monitors.append(
                Monitor(
                    id=index,
                    left=int(raw["left"]),
                    top=int(raw["top"]),
                    width=int(raw["width"]),
                    height=int(raw["height"]),
                    primary=index == 1,
                )
            )
        return monitors


def list_monitors() -> list[Monitor]:
    monitors = _monitors_mss()
    if monitors:
        return monitors
    image = ImageGrab.grab()
    width, height = image.size
    return [Monitor(id=1, left=0, top=0, width=width, height=height, primary=True)]


def monitor_for_id(monitor_id: int | None = None) -> Monitor:
    monitors = list_monitors()
    if not monitors:
        return Monitor(id=1, left=0, top=0, width=0, height=0, primary=True)
    if monitor_id is not None:
        for monitor in monitors:
            if monitor.id == monitor_id:
                return monitor
    return monitors[0]


def _privacy_capture_enabled() -> bool:
    if platform.system() != "Windows":
        return False
    try:
        from . import privacy

        return bool(privacy.state().enabled)
    except Exception:
        return False


def _grab_imagegrab_monitor(monitor_id: int | None = None) -> tuple[Image.Image, Monitor]:
    monitor = monitor_for_id(monitor_id)
    bbox = (
        monitor.left,
        monitor.top,
        monitor.left + monitor.width,
        monitor.top + monitor.height,
    )
    image = ImageGrab.grab(
        bbox=bbox,
        include_layered_windows=False,
        all_screens=True,
    )
    if image.mode != "RGB":
        image = image.convert("RGB")
    return image, monitor


def _grab_image(monitor_id: int | None = None) -> tuple[Image.Image, Monitor]:
    if _privacy_capture_enabled():
        try:
            return _grab_imagegrab_monitor(monitor_id)
        except Exception:
            pass

    if _MSS_OK:
        with mss.mss() as sct:
            index = monitor_id if monitor_id and 0 < monitor_id < len(sct.monitors) else 1
            if index >= len(sct.monitors):
                index = 1
            raw = sct.monitors[index] if len(sct.monitors) > 1 else sct.monitors[0]
            shot = sct.grab(raw)
            monitor = Monitor(
                id=index if len(sct.monitors) > 1 else 1,
                left=int(raw["left"]),
                top=int(raw["top"]),
                width=int(raw["width"]),
                height=int(raw["height"]),
                primary=index == 1,
            )
            return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX"), monitor
    image = ImageGrab.grab()
    return image, Monitor(id=1, left=0, top=0, width=image.size[0], height=image.size[1], primary=True)


def _normalize_format(image_format: str) -> tuple[str, str, str]:
    fmt = image_format.strip().lower()
    if fmt in {"jpg", "jpeg"}:
        return "JPEG", "jpg", "image/jpeg"
    if fmt == "webp":
        return "WEBP", "webp", "image/webp"
    return "PNG", "png", "image/png"


def capture_screen(
    *,
    image_format: str = "jpeg",
    quality: int = 72,
    max_width: int | None = None,
    monitor_id: int | None = None,
) -> Screenshot:
    timestamp = datetime.now()
    image, monitor = _grab_image(monitor_id)
    width, height = image.size

    if max_width and width > max_width:
        ratio = max_width / width
        image = image.resize((max_width, max(1, round(height * ratio))))
        width, height = image.size

    fmt, extension, media_type = _normalize_format(image_format)
    if fmt in {"JPEG", "WEBP"} and image.mode != "RGB":
        image = image.convert("RGB")

    buffer = BytesIO()
    if fmt == "PNG":
        image.save(buffer, fmt, compress_level=3)
    else:
        image.save(buffer, fmt, quality=max(1, min(int(quality), 95)), optimize=False)

    return Screenshot(
        data=buffer.getvalue(),
        filename=f"screenshot_{timestamp.strftime('%Y%m%d_%H%M%S')}.{extension}",
        timestamp=timestamp,
        width=width,
        height=height,
        media_type=media_type,
        monitor_id=monitor.id,
        monitor_left=monitor.left,
        monitor_top=monitor.top,
    )
