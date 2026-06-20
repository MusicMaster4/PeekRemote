from __future__ import annotations

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


def _grab_image():
    if _MSS_OK:
        with mss.mss() as sct:
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            shot = sct.grab(monitor)
            return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    return ImageGrab.grab()


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
) -> Screenshot:
    timestamp = datetime.now()
    image = _grab_image()
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
    )
