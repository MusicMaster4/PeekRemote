from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any

from .config import settings


_LOCK = threading.RLock()
_CACHE: dict[str, dict[str, Any]] | None = None


def _data_dir() -> Path:
    path = settings.app_data_dir
    if not path.is_absolute():
        path = Path.cwd() / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def _path() -> Path:
    return _data_dir() / "paired-devices.json"


def _load() -> dict[str, dict[str, Any]]:
    global _CACHE
    with _LOCK:
        if _CACHE is not None:
            return _CACHE
        try:
            raw = json.loads(_path().read_text(encoding="utf-8"))
            devices = raw.get("devices", {}) if isinstance(raw, dict) else {}
            _CACHE = {
                str(k): v for k, v in devices.items() if isinstance(v, dict) and str(k)
            }
        except (OSError, json.JSONDecodeError):
            _CACHE = {}
        return _CACHE


def _save() -> None:
    with _LOCK:
        path = _path()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"devices": _CACHE or {}}, ensure_ascii=True, indent=2),
            encoding="utf-8",
        )
        tmp.replace(path)


def default_device_info(user_agent: str) -> dict[str, str]:
    ua = user_agent or ""
    lowered = ua.lower()

    if "iphone" in lowered:
        return {"type": "phone", "model": "iPhone", "default_name": "iPhone"}
    if "ipad" in lowered:
        return {"type": "tablet", "model": "iPad", "default_name": "iPad"}
    if "android" in lowered:
        model = _android_model(ua)
        device_type = "tablet" if "tablet" in lowered or "mobile" not in lowered else "phone"
        fallback = "Android tablet" if device_type == "tablet" else "Android phone"
        return {
            "type": device_type,
            "model": model or fallback,
            "default_name": model or fallback,
        }
    if "windows" in lowered:
        return {"type": "computer", "model": "Windows PC", "default_name": "Windows PC"}
    if "macintosh" in lowered or "mac os x" in lowered:
        return {"type": "computer", "model": "Mac", "default_name": "Mac"}
    if "linux" in lowered:
        return {"type": "computer", "model": "Linux device", "default_name": "Linux device"}
    return {"type": "device", "model": "Device", "default_name": "Device"}


def _android_model(user_agent: str) -> str:
    # Common Android UA shape:
    # Mozilla/5.0 (Linux; Android 14; SM-S911B Build/...) ...
    match = re.search(r"Android\s+[^;)]*;\s*([^;)]+?)(?:\s+Build/|;|\))", user_agent, re.I)
    if not match:
        return ""
    model = match.group(1).strip()
    model = re.sub(r"\s+wv$", "", model, flags=re.I).strip()
    if not model or model.lower() in {"mobile", "tablet"}:
        return ""
    return model[:48]


def find_device_id_by_fingerprint(user_agent: str, client_ip: str) -> str | None:
    """Encontra um aparelho já conhecido pelo par (IP + user-agent).

    Usado como rede de segurança quando o cookie de aparelho não chega (ex.: o
    primeiro acesso vindo de um QR code não envia cookies `SameSite`). Dentro do
    Tailscale cada aparelho tem um IP estável e único, então IP + user-agent é uma
    impressão digital confiável para reconhecer "o mesmo aparelho reconectando" e
    evitar criar uma entrada duplicada a cada conexão.
    """
    ip = (client_ip or "").strip()
    ua = (user_agent or "")[:500]
    if not ip or not ua:
        return None
    best_id: str | None = None
    best_seen = -1.0
    with _LOCK:
        for device_id, device in _load().items():
            if device.get("last_ip") != ip:
                continue
            if device.get("user_agent") != ua:
                continue
            seen = float(device.get("last_seen") or 0)
            if seen > best_seen:
                best_seen = seen
                best_id = device_id
    return best_id


def delete_device(device_id: str) -> bool:
    """Remove um aparelho da lista. Não bane nem bloqueia — só apaga o registro."""
    with _LOCK:
        devices = _load()
        if device_id not in devices:
            return False
        del devices[device_id]
        _save()
        return True


def touch_device(device_id: str, user_agent: str, client_ip: str) -> dict[str, Any]:
    now = time.time()
    info = default_device_info(user_agent)
    with _LOCK:
        devices = _load()
        existing = devices.get(device_id, {})
        device = {
            "id": device_id,
            "name": existing.get("name") or info["default_name"],
            "custom_name": existing.get("custom_name") or "",
            "default_name": info["default_name"],
            "type": info["type"],
            "model": info["model"],
            "user_agent": (user_agent or "")[:500],
            "first_seen": existing.get("first_seen") or now,
            "last_seen": now,
            "last_ip": client_ip,
        }
        devices[device_id] = device
        _save()
        return dict(device)


def rename_device(device_id: str, name: str) -> dict[str, Any] | None:
    clean = re.sub(r"\s+", " ", name).strip()[:60]
    if not clean:
        raise ValueError("Device name cannot be empty.")
    with _LOCK:
        devices = _load()
        device = devices.get(device_id)
        if not device:
            return None
        device["name"] = clean
        device["custom_name"] = clean
        _save()
        return dict(device)


def get_device(device_id: str | None) -> dict[str, Any] | None:
    if not device_id:
        return None
    device = _load().get(device_id)
    return dict(device) if device else None


def list_devices(active_counts: dict[str, int] | None = None) -> list[dict[str, Any]]:
    counts = active_counts or {}
    devices = []
    for device in _load().values():
        item = dict(device)
        item["active_sessions"] = int(counts.get(item.get("id"), 0))
        devices.append(item)
    return sorted(devices, key=lambda d: float(d.get("last_seen") or 0), reverse=True)
