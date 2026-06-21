from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import platform
import re
import secrets
import shlex
import subprocess
import sys
import time
import uuid
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

from asyncio.subprocess import PIPE, Process

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from . import clipboard, connect, devices, privacy, remote_input
from .config import settings
from .power import suspend_computer
from .screenshot import capture_screen, list_monitors, monitor_for_id

app = FastAPI(title="Peek Remote")

BASE_DIR = Path(__file__).resolve().parent


def _frontend_dir() -> Path:
    """Localiza o build estático do frontend Next.js (web/out).

    No desenvolvimento ele fica em ../web/out. Quando empacotado pelo PyInstaller
    (app desktop Electron), os dados ficam em sys._MEIPASS/web/out.
    """
    if getattr(sys, "frozen", False):
        bundled = Path(getattr(sys, "_MEIPASS", BASE_DIR)) / "web" / "out"
        if bundled.exists():
            return bundled
    return BASE_DIR.parent / "web" / "out"


# Build estático do frontend Next.js (gerado por `npm run build` em web/).
FRONTEND_DIR = _frontend_dir()

logger = logging.getLogger(__name__)
TUNNEL_URL_RE = re.compile(r"https://[\w.-]*trycloudflare.com[\w./-]*")


def _host_os() -> str:
    """OS normalizado da MAQUINA controlada (host), exposto ao frontend para que
    os atalhos do Modo Ao Vivo facam sentido no sistema certo (ex.: Cmd no Mac
    em vez de Win/Ctrl)."""
    system = platform.system()
    if system == "Windows":
        return "windows"
    if system == "Darwin":
        return "mac"
    if system == "Linux":
        return "linux"
    return system.lower() or "unknown"


HOST_OS = _host_os()


def _hidden_subprocess_kwargs() -> dict:
    if platform.system() != "Windows":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return {
        "startupinfo": startupinfo,
        "creationflags": subprocess.CREATE_NO_WINDOW,
    }

AUTH_COOKIE_NAME = "remote_console_auth"
DEVICE_COOKIE_NAME = "remote_console_device"
SESSION_SECONDS = 12 * 60 * 60
DEVICE_COOKIE_SECONDS = 365 * 24 * 60 * 60
SESSION_SECRET = secrets.token_hex(32)
MAX_FAILED_ATTEMPTS = settings.max_failed_logins
# Atraso crescente apos cada PIN errado, para frear brute-force mesmo antes do
# bloqueio (cap em 3s para nao prender o servidor).
LOGIN_BACKOFF_STEP = 0.4
LOGIN_BACKOFF_MAX = 3.0

# Logger de auditoria dedicado: grava eventos de seguranca (logins, logouts,
# suspensoes) em arquivo proprio, separado do log operacional.
audit_logger = logging.getLogger("remote_console.audit")


def _setup_audit_log() -> None:
    if audit_logger.handlers:
        return
    audit_logger.setLevel(logging.INFO)
    audit_logger.propagate = False
    path = settings.audit_log_file
    if not path.is_absolute():
        path = BASE_DIR.parent / path
    try:
        handler: logging.Handler = logging.FileHandler(path, encoding="utf-8")
    except OSError as exc:  # pragma: no cover - fallback se o arquivo nao abrir
        logger.warning("Nao foi possivel abrir o log de auditoria (%s); usando stderr.", exc)
        handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    audit_logger.addHandler(handler)


def _audit(event: str, request: Request, **fields: object) -> None:
    parts = [event, f"ip={_client_key(request)}"]
    user_agent = request.headers.get("user-agent", "")
    if user_agent:
        parts.append(f'ua="{user_agent[:200]}"')
    parts.extend(f"{key}={value}" for key, value in fields.items())
    audit_logger.info(" ".join(parts))


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


class SuspendRequest(BaseModel):
    confirmation: str = Field(..., min_length=3)


class SuspendCancelRequest(BaseModel):
    job_id: uuid.UUID


class LoginRequest(BaseModel):
    pin: str = Field(..., pattern=r"^\d{6}$")

    @field_validator("pin")
    @classmethod
    def normalize_pin(cls, value: str) -> str:
        return value.strip()


class DeviceRenameRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        clean = re.sub(r"\s+", " ", value).strip()
        if not clean:
            raise ValueError("Device name cannot be empty.")
        return clean


class PrivacyRequest(BaseModel):
    enabled: bool


class ClipboardSyncRequest(BaseModel):
    enabled: bool


class InputRequest(BaseModel):
    action: Literal["click", "drag", "scroll", "key", "hotkey", "text"]
    x: int = 0
    y: int = 0
    x2: int = 0
    y2: int = 0
    monitor_id: int | None = Field(None, ge=1, le=64)
    button: Literal["left", "right", "middle"] = "left"
    double: bool = False
    duration_ms: int = Field(450, ge=50, le=5000)
    dy: int = Field(0, ge=-100, le=100)
    key: str | None = Field(None, max_length=32)
    keys: list[str] | None = None
    text: str | None = Field(None, max_length=2000)

    @field_validator("keys")
    @classmethod
    def limit_keys(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and len(value) > 6:
            raise ValueError("Too many keys in the combo.")
        return value


pending_jobs: dict[uuid.UUID, asyncio.Task] = {}

tunnel_process: Process | None = None
tunnel_tasks: set[asyncio.Task] = set()
tunnel_url: str | None = None
tunnel_lock = asyncio.Lock()
failed_login_attempts: dict[str, int] = {}
blocked_clients: set[str] = set()
consumed_qr_jtis: set[str] = set()


@dataclass
class SessionInfo:
    """Uma sessão autenticada viva no servidor.

    `token` é o valor secreto do cookie (alta entropia, nunca exposto na API).
    `pub_id` é um identificador público curto usado só para listar/expulsar.
    `is_owner` marca a sessão DONA — a primeira a entrar — que pode gerenciar as
    demais.
    """

    token: str
    pub_id: str
    created_at: float
    last_seen: float
    client_ip: str
    user_agent: str
    is_owner: bool
    device_id: str


# Registro de sessões vivas, indexado pelo token do cookie. Mantê-lo no servidor
# (em vez de cookie stateless) é o que permite LISTAR e EXPULSAR sessões.
active_sessions: dict[str, SessionInfo] = {}
capture_lock = asyncio.Lock()
latest_screenshot = None
latest_screenshot_key: tuple[str, int, int | None, int | None] | None = None
latest_screenshot_at = 0.0


def _session_secret() -> bytes:
    return SESSION_SECRET.encode("utf-8")


def _purge_expired_sessions() -> None:
    now = time.time()
    expired = [t for t, s in active_sessions.items() if now - s.created_at > SESSION_SECONDS]
    for token in expired:
        active_sessions.pop(token, None)
    _ensure_owner()


def _ensure_owner() -> None:
    """Garante que sempre haja um dono enquanto existir alguma sessão.

    Se a sessão dona sai (logout/expira/expulsa), promove a mais antiga restante,
    para que o controle das sessões nunca fique órfão.
    """
    if not active_sessions or any(s.is_owner for s in active_sessions.values()):
        return
    oldest = min(active_sessions.values(), key=lambda s: s.created_at)
    oldest.is_owner = True


def _create_session(request: Request) -> str:
    """Cria uma sessão. A primeira (quando não há dono) vira a dona."""
    _purge_expired_sessions()
    token = secrets.token_urlsafe(32)
    now = time.time()
    is_owner = not any(s.is_owner for s in active_sessions.values())
    user_agent = request.headers.get("user-agent", "") or ""
    client_ip = _client_key(request)
    device_id = request.cookies.get(DEVICE_COOKIE_NAME) or ""
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", device_id):
        # Sem cookie válido (ex.: primeiro acesso via QR não envia cookies
        # SameSite): tenta reconhecer o aparelho pela impressão IP + user-agent
        # antes de criar um id novo, senão o mesmo celular vira um aparelho
        # diferente a cada conexão.
        device_id = (
            devices.find_device_id_by_fingerprint(user_agent, client_ip)
            or secrets.token_urlsafe(12)
        )
    devices.touch_device(device_id, user_agent, client_ip)
    active_sessions[token] = SessionInfo(
        token=token,
        pub_id=secrets.token_urlsafe(6),
        created_at=now,
        last_seen=now,
        client_ip=client_ip,
        user_agent=user_agent[:200],
        is_owner=is_owner,
        device_id=device_id,
    )
    return token


def _current_session(request: Request) -> SessionInfo | None:
    token = request.cookies.get(AUTH_COOKIE_NAME)
    if not token:
        return None
    _purge_expired_sessions()
    session = active_sessions.get(token)
    if session is None:
        return None
    session.last_seen = time.time()
    return session


def _sign_qr_token(ttl_seconds: int) -> tuple[str, int]:
    """Gera um token de login de uso único (HMAC) com validade curta.

    Retorna (token, expira_em_epoch). O token autentica quem escaneia o QR sem
    digitar o PIN — por isso é curto, assinado e consumido na primeira utilização.
    """
    expires_at = int(time.time()) + ttl_seconds
    jti = secrets.token_urlsafe(9)
    payload = f"{expires_at}:{jti}"
    signature = hmac.new(_session_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}:{signature}", expires_at


def _verify_qr_token(token: str | None) -> bool:
    """Valida e CONSOME um token de QR (assinatura, validade e uso único)."""
    if not token:
        return False
    parts = token.split(":")
    if len(parts) != 3:
        return False
    expires_text, jti, signature = parts
    try:
        expires_at = int(expires_text)
    except ValueError:
        return False
    if time.time() > expires_at:
        return False
    expected = hmac.new(
        _session_secret(), f"{expires_at}:{jti}".encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return False
    if jti in consumed_qr_jtis:
        return False
    consumed_qr_jtis.add(jti)
    return True


def _client_key(request: Request) -> str:
    connecting_ip = request.headers.get("cf-connecting-ip")
    if connecting_ip:
        return connecting_ip.strip()
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


def _is_valid_pin(pin: str) -> bool:
    return secrets.compare_digest(pin, settings.auth_pin)


def _set_auth_cookie(response: Response, request: Request, token: str) -> None:
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(
        AUTH_COOKIE_NAME,
        token,
        max_age=SESSION_SECONDS,
        httponly=True,
        secure=secure,
        samesite="strict",
    )
    session = active_sessions.get(token)
    if session is not None:
        response.set_cookie(
            DEVICE_COOKIE_NAME,
            session.device_id,
            max_age=DEVICE_COOKIE_SECONDS,
            httponly=True,
            secure=secure,
            # "lax" (não "strict") para que o cookie volte numa navegação de topo
            # vinda de fora do site — é o caso do QR code. Com "strict" o cookie
            # não era enviado no /api/qr-login e cada acesso virava um aparelho novo.
            samesite="lax",
        )


def current_login(request: Request) -> str | None:
    return "authenticated" if _current_session(request) is not None else None


def require_auth(request: Request) -> str:
    if _current_session(request) is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Login required.")
    return "authenticated"


def require_owner(request: Request) -> SessionInfo:
    session = _current_session(request)
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Login required.")
    if not session.is_owner:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the owner session (the first to log in) can manage sessions.",
        )
    return session


def _desktop_authorized(request: Request) -> bool:
    token = settings.desktop_api_token
    provided = request.headers.get("x-peek-desktop-token", "")
    return bool(token) and secrets.compare_digest(token, provided)


def require_desktop_or_owner(request: Request) -> SessionInfo | None:
    if _desktop_authorized(request):
        return None
    return require_owner(request)


def require_desktop_or_auth(request: Request) -> SessionInfo | None:
    if _desktop_authorized(request):
        return None
    session = _current_session(request)
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Login required.")
    return session


def _capture_options(
    profile: Literal["photo", "live"], monitor_id: int | None = None
) -> tuple[str, int, int | None, int | None]:
    if profile == "live":
        return (
            settings.screenshot_format,
            settings.live_screenshot_quality,
            settings.live_max_width,
            monitor_id,
        )
    return (settings.screenshot_format, settings.screenshot_quality, None, monitor_id)


async def _capture_cached(
    profile: Literal["photo", "live"],
    monitor_id: int | None = None,
    *,
    use_cache: bool = True,
):
    """Captura serializada, com reuso curto para evitar frames duplicados.

    Captura de tela e codificacao sao o caminho mais caro do app. O lock evita
    duas capturas concorrentes brigando por CPU; o cache de poucos ms absorve
    cliques duplos/polling que chegam quase ao mesmo tempo.
    """
    global latest_screenshot, latest_screenshot_key, latest_screenshot_at

    key = _capture_options(profile, monitor_id)
    now = time.monotonic()
    cache_seconds = settings.screenshot_cache_ms / 1000
    if (
        use_cache
        and
        latest_screenshot is not None
        and latest_screenshot_key == key
        and cache_seconds > 0
        and now - latest_screenshot_at <= cache_seconds
    ):
        return latest_screenshot

    async with capture_lock:
        now = time.monotonic()
        if (
            use_cache
            and
            latest_screenshot is not None
            and latest_screenshot_key == key
            and cache_seconds > 0
            and now - latest_screenshot_at <= cache_seconds
        ):
            return latest_screenshot

        image_format, quality, max_width, selected_monitor = key
        screenshot = await run_in_threadpool(
            capture_screen,
            image_format=image_format,
            quality=quality,
            max_width=max_width,
            monitor_id=selected_monitor,
        )
        latest_screenshot = screenshot
        latest_screenshot_key = key
        latest_screenshot_at = time.monotonic()
        return screenshot


def _monitor_xy(x: int, y: int, monitor_id: int | None) -> tuple[int, int]:
    monitor = monitor_for_id(monitor_id)
    return int(x) + monitor.left, int(y) + monitor.top


def _perform_input(payload: InputRequest) -> None:
    if payload.action == "click":
        x, y = _monitor_xy(payload.x, payload.y, payload.monitor_id)
        remote_input.click(x, y, payload.button, payload.double)
    elif payload.action == "drag":
        x1, y1 = _monitor_xy(payload.x, payload.y, payload.monitor_id)
        x2, y2 = _monitor_xy(payload.x2, payload.y2, payload.monitor_id)
        remote_input.drag(
            x1,
            y1,
            x2,
            y2,
            payload.button,
            payload.duration_ms,
        )
    elif payload.action == "scroll":
        x, y = _monitor_xy(payload.x, payload.y, payload.monitor_id)
        remote_input.scroll(x, y, payload.dy)
    elif payload.action == "key":
        if not payload.key:
            raise ValueError("No key provided.")
        remote_input.press_key(payload.key)
    elif payload.action == "hotkey":
        if not payload.keys:
            raise ValueError("Empty combo.")
        remote_input.hotkey(payload.keys)
    elif payload.action == "text":
        if not payload.text:
            raise ValueError("Empty text.")
        remote_input.type_text(payload.text)


def _screenshot_headers(screenshot) -> dict[str, str]:
    return {
        "X-Screenshot-Timestamp": screenshot.timestamp.isoformat(timespec="seconds"),
        "X-Screenshot-Filename": screenshot.filename,
        "X-Screenshot-Width": str(screenshot.width),
        "X-Screenshot-Height": str(screenshot.height),
        "X-Screenshot-Monitor": str(screenshot.monitor_id),
        "X-Screenshot-Monitor-Left": str(screenshot.monitor_left),
        "X-Screenshot-Monitor-Top": str(screenshot.monitor_top),
    }


async def _monitor_tunnel_stream(stream: asyncio.StreamReader) -> None:
    global tunnel_url
    try:
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="ignore").strip()
            if not text:
                continue
            logger.info("cloudflared: %s", text)
            match = TUNNEL_URL_RE.search(text)
            if match:
                async with tunnel_lock:
                    tunnel_url = match.group(0)
    except asyncio.CancelledError:
        pass


async def _start_cloudflared() -> None:
    global tunnel_process
    if tunnel_process and tunnel_process.returncode is None:
        return
    command = [
        settings.cloudflared_path,
        "tunnel",
        "--url",
        f"http://{settings.server_host}:{settings.server_port}",
    ]
    if settings.cloudflared_args:
        command.extend(shlex.split(settings.cloudflared_args))
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=PIPE,
            stderr=PIPE,
            **_hidden_subprocess_kwargs(),
        )
    except FileNotFoundError:
        logger.error("cloudflared não encontrado. Ajuste CLOUDFLARED_PATH ou instale o utilitário.")
        return
    tunnel_process = process
    logger.info("cloudflared iniciado com PID %s", process.pid)
    for stream in (process.stdout, process.stderr):
        if stream:
            task = asyncio.create_task(_monitor_tunnel_stream(stream))
            tunnel_tasks.add(task)
            task.add_done_callback(lambda t: tunnel_tasks.discard(t))


async def _stop_cloudflared() -> None:
    global tunnel_process
    tasks = list(tunnel_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    if tunnel_process:
        tunnel_process.terminate()
        try:
            await asyncio.wait_for(tunnel_process.wait(), timeout=5)
        except asyncio.TimeoutError:
            tunnel_process.kill()
        tunnel_process = None


async def _prepare_connect() -> None:
    """Publica o app na tailnet e abre a página local do QR no navegador do PC."""
    port = settings.server_port
    await run_in_threadpool(connect.ensure_serve, port)
    if not settings.qr_open_browser:
        return
    # Pequeno atraso para o servidor já estar aceitando conexões quando o
    # navegador abrir a página /connect.
    await asyncio.sleep(1.5)
    try:
        await run_in_threadpool(webbrowser.open, f"http://127.0.0.1:{port}/connect")
    except Exception as exc:  # pragma: no cover - abertura é best-effort
        logger.warning("Não consegui abrir o navegador automaticamente: %s", exc)


@app.on_event("startup")
async def on_startup() -> None:
    _setup_audit_log()
    remote_input.ensure_dpi_aware()
    clipboard.set_enabled(settings.clipboard_sync_enabled)
    clipboard.start_monitor()
    asyncio.create_task(_prepare_connect())
    if settings.cloudflared_path:
        asyncio.create_task(_start_cloudflared())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    privacy.set_enabled(False)
    clipboard.stop_monitor()
    await _stop_cloudflared()


@app.get("/api/session")
async def session_status(request: Request) -> JSONResponse:
    """Informa ao frontend se a sessão atual está autenticada e se é a dona.

    `os` é o sistema da máquina controlada; o frontend usa isso para mostrar e
    enviar os atalhos certos (Cmd/Option no Mac, Ctrl/Win no Windows)."""
    session = _current_session(request)
    return JSONResponse(
        {
            "authenticated": session is not None,
            "is_owner": bool(session and session.is_owner),
            "os": HOST_OS,
        }
    )


def _active_device_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for session in active_sessions.values():
        counts[session.device_id] = counts.get(session.device_id, 0) + 1
    return counts


def _privacy_payload() -> dict:
    current = privacy.state()
    return {
        "enabled": current.enabled,
        "input_blocked": current.input_blocked,
        "platform": current.platform,
        "message": current.message,
    }


@app.get("/api/devices")
async def list_paired_devices(
    request: Request, _: SessionInfo | None = Depends(require_desktop_or_owner)
) -> JSONResponse:
    return JSONResponse({"devices": devices.list_devices(_active_device_counts())})


@app.patch("/api/devices/{device_id}")
async def rename_paired_device(
    device_id: str,
    payload: DeviceRenameRequest,
    request: Request,
    _: SessionInfo | None = Depends(require_desktop_or_owner),
) -> JSONResponse:
    device = devices.rename_device(device_id, payload.name)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found.")
    device["active_sessions"] = _active_device_counts().get(device_id, 0)
    _audit("DEVICE_RENAMED", request, device=device_id)
    return JSONResponse({"device": device})


@app.delete("/api/devices/{device_id}")
async def delete_paired_device(
    device_id: str,
    request: Request,
    _: SessionInfo | None = Depends(require_desktop_or_owner),
) -> JSONResponse:
    """Remove um aparelho da lista (apenas apaga o registro; não bane nem bloqueia)."""
    if not devices.delete_device(device_id):
        raise HTTPException(status_code=404, detail="Device not found.")
    _audit("DEVICE_REMOVED", request, device=device_id)
    return JSONResponse({"removed": device_id})


@app.get("/api/monitors")
async def monitors(_: str = Depends(require_auth)) -> JSONResponse:
    return JSONResponse(
        {
            "monitors": [
                {
                    "id": monitor.id,
                    "label": f"Monitor {monitor.id}",
                    "left": monitor.left,
                    "top": monitor.top,
                    "width": monitor.width,
                    "height": monitor.height,
                    "primary": monitor.primary,
                }
                for monitor in list_monitors()
            ]
        }
    )


@app.get("/api/clipboard")
async def latest_clipboard(_: str = Depends(require_auth)) -> JSONResponse:
    return JSONResponse(clipboard.latest())


@app.post("/api/clipboard/read")
async def read_clipboard_now(_: str = Depends(require_auth)) -> JSONResponse:
    """Le o clipboard do PC na hora (acionado pelo botao Copy do celular), para o
    texto recem-copiado ir ao clipboard do celular sem esperar o monitor."""
    return JSONResponse(await run_in_threadpool(clipboard.read_now))


@app.get("/api/clipboard-sync")
async def get_clipboard_sync(
    request: Request, _: SessionInfo | None = Depends(require_desktop_or_owner)
) -> JSONResponse:
    return JSONResponse({"enabled": clipboard.is_enabled()})


@app.post("/api/clipboard-sync")
async def set_clipboard_sync(
    payload: ClipboardSyncRequest,
    request: Request,
    _: SessionInfo | None = Depends(require_desktop_or_owner),
) -> JSONResponse:
    enabled = await run_in_threadpool(clipboard.set_enabled, payload.enabled)
    _audit("CLIPBOARD_SYNC_CHANGED", request, enabled=enabled)
    return JSONResponse({"enabled": enabled})


@app.get("/api/privacy")
async def get_privacy(
    request: Request, _: SessionInfo | None = Depends(require_desktop_or_auth)
) -> JSONResponse:
    return JSONResponse(_privacy_payload())


@app.post("/api/privacy")
async def set_privacy(
    payload: PrivacyRequest, request: Request, _: SessionInfo = Depends(require_owner)
) -> JSONResponse:
    current = await run_in_threadpool(privacy.set_enabled, payload.enabled)
    _audit("PRIVACY_CHANGED", request, enabled=current.enabled, input_blocked=current.input_blocked)
    return JSONResponse(_privacy_payload())


@app.post("/api/login")
async def login(payload: LoginRequest, request: Request) -> JSONResponse:
    client_key = _client_key(request)
    if client_key in blocked_clients:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This computer is blocked until the server restarts.",
        )

    if not _is_valid_pin(payload.pin):
        attempts = failed_login_attempts.get(client_key, 0) + 1
        failed_login_attempts[client_key] = attempts
        if attempts >= MAX_FAILED_ATTEMPTS:
            blocked_clients.add(client_key)
            _audit("LOGIN_BLOCKED", request, attempts=attempts)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This computer has been blocked until the server restarts.",
            )
        # Rising backoff: each wrong PIN costs the attacker a bit more time.
        await asyncio.sleep(min(LOGIN_BACKOFF_STEP * attempts, LOGIN_BACKOFF_MAX))
        _audit("LOGIN_FAILED", request, attempts=attempts)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid PIN.")

    failed_login_attempts.pop(client_key, None)
    token = _create_session(request)
    _audit("LOGIN_SUCCESS", request, owner=active_sessions[token].is_owner)
    response = JSONResponse({"message": "Access granted."})
    _set_auth_cookie(response, request, token)
    return response


@app.post("/api/logout")
async def logout(request: Request, _: str = Depends(require_auth)) -> JSONResponse:
    token = request.cookies.get(AUTH_COOKIE_NAME)
    if token:
        active_sessions.pop(token, None)
        _ensure_owner()
    _audit("LOGOUT", request)
    response = JSONResponse({"message": "Session ended."})
    response.delete_cookie(AUTH_COOKIE_NAME)
    return response


async def _execute_suspend(job_id: uuid.UUID) -> None:
    try:
        await asyncio.sleep(10)
        await run_in_threadpool(suspend_computer)
    finally:
        pending_jobs.pop(job_id, None)


@app.post("/api/suspend")
async def schedule_suspend(
    payload: SuspendRequest, request: Request, _: str = Depends(require_auth)
) -> JSONResponse:
    if payload.confirmation.strip().lower() not in {"suspend", "suspenso"}:
        raise HTTPException(status_code=400, detail="Incorrect confirmation.")

    job_id = uuid.uuid4()
    task = asyncio.create_task(_execute_suspend(job_id))
    pending_jobs[job_id] = task
    _audit("SUSPEND_SCHEDULED", request, job_id=job_id)
    return JSONResponse({"job_id": str(job_id), "message": "Sleeping in 10 seconds."})


@app.post("/api/suspend/cancel")
async def cancel_suspend(
    payload: SuspendCancelRequest, request: Request, _: str = Depends(require_auth)
) -> JSONResponse:
    job = pending_jobs.pop(payload.job_id, None)
    if not job:
        raise HTTPException(status_code=404, detail="Schedule not found or already executed.")
    job.cancel()
    _audit("SUSPEND_CANCELLED", request, job_id=payload.job_id)
    return JSONResponse({"message": "Sleep cancelled."})


@app.post("/api/screenshots")
async def handle_screenshots(
    _: str = Depends(require_auth),
    profile: Literal["photo", "live"] = Query("photo"),
    monitor: int | None = Query(None, ge=1, le=64),
) -> JSONResponse:
    screenshot = await _capture_cached(profile, monitor)
    image_base64 = base64.b64encode(screenshot.data).decode("ascii")
    return JSONResponse(
        {
            "message": "Screen captured.",
            "image": f"data:{screenshot.media_type};base64,{image_base64}",
            "timestamp": screenshot.timestamp.isoformat(timespec="seconds"),
            "filename": screenshot.filename,
            "width": screenshot.width,
            "height": screenshot.height,
            "monitor_id": screenshot.monitor_id,
            "monitor_left": screenshot.monitor_left,
            "monitor_top": screenshot.monitor_top,
        }
    )


@app.post("/api/screenshots/raw")
async def handle_raw_screenshot(
    _: str = Depends(require_auth),
    profile: Literal["photo", "live"] = Query("photo"),
    monitor: int | None = Query(None, ge=1, le=64),
) -> Response:
    screenshot = await _capture_cached(profile, monitor)
    return Response(
        screenshot.data,
        media_type=screenshot.media_type,
        headers=_screenshot_headers(screenshot),
    )


@app.get("/api/screenshots/stream")
async def stream_screenshots(
    _: str = Depends(require_auth),
    profile: Literal["live"] = Query("live"),
    monitor: int | None = Query(None, ge=1, le=64),
    fps: int = Query(settings.stream_fps, ge=1, le=30),
) -> StreamingResponse:
    interval = 1 / max(1, min(int(fps), 30))

    async def frames():
        while True:
            screenshot = await run_in_threadpool(
                capture_screen,
                image_format="jpeg",
                quality=min(settings.live_screenshot_quality, 68),
                max_width=settings.live_max_width,
                monitor_id=monitor,
            )
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n"
                + f"X-Screenshot-Width: {screenshot.width}\r\n".encode("ascii")
                + f"X-Screenshot-Height: {screenshot.height}\r\n".encode("ascii")
                + f"X-Screenshot-Monitor: {screenshot.monitor_id}\r\n\r\n".encode("ascii")
                + screenshot.data
                + b"\r\n"
            )
            await asyncio.sleep(interval)

    return StreamingResponse(
        frames(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/input")
async def handle_input(payload: InputRequest, _: str = Depends(require_auth)) -> JSONResponse:
    """Injeta uma ação de mouse/teclado no computador (Modo Ao Vivo)."""
    try:
        await run_in_threadpool(_perform_input, payload)
    except remote_input.InputUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return JSONResponse({"ok": True})


@app.post("/api/input/screenshot/raw")
async def handle_input_screenshot(
    payload: InputRequest,
    _: str = Depends(require_auth),
) -> Response:
    """Executa input, espera a UI reagir e devolve a tela nova em um request."""
    try:
        await run_in_threadpool(_perform_input, payload)
        if settings.post_input_capture_delay_ms:
            await asyncio.sleep(settings.post_input_capture_delay_ms / 1000)
        screenshot = await _capture_cached("live", payload.monitor_id)
    except remote_input.InputUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return Response(
        screenshot.data,
        media_type=screenshot.media_type,
        headers={**_screenshot_headers(screenshot), "X-Input-Applied": "1"},
    )


@app.get("/api/tunnel")
async def get_tunnel(_: str = Depends(require_auth)) -> JSONResponse:
    return JSONResponse({"url": tunnel_url})


@app.get("/connect", response_class=HTMLResponse)
async def connect_page() -> HTMLResponse:
    """Página local (aberta no PC) com o QR Code para parear o celular."""
    app_url = await run_in_threadpool(connect.tailnet_url)
    token, expires_at = _sign_qr_token(settings.qr_ttl_seconds)
    connect_url = f"{app_url}/api/qr-login?t={token}" if app_url else None
    html = connect.render_connect_page(
        app_url=app_url,
        connect_url=connect_url,
        expires_at=expires_at,
        ttl_seconds=settings.qr_ttl_seconds,
    )
    return HTMLResponse(html)


@app.get("/api/health")
async def health() -> JSONResponse:
    """Sinal simples de "backend pronto" para o app desktop (Electron) poder
    aguardar a inicialização antes de mostrar a tela de pareamento."""
    return JSONResponse({"ok": True, "os": HOST_OS})


@app.get("/api/connect-info")
async def connect_info(request: Request) -> JSONResponse:
    """Dados de pareamento para o painel desktop (Electron) desenhar o QR no tema
    do app: URL da tailnet, link de login de uso único e quando ele expira.

    Mesma confiança do `/connect`: emite um token de login para quem alcança o
    app — adequado para uma tailnet pessoal de um único usuário.
    """
    app_url = await run_in_threadpool(connect.tailnet_url)
    tailscale_ready = app_url is not None
    if not tailscale_ready:
        return JSONResponse(
            {
                "tailscale_ready": False,
                "tailscale_found": connect.tailscale_exe() is not None,
                "app_url": None,
                "connect_url": None,
                "expires_at": 0,
                "ttl_seconds": settings.qr_ttl_seconds,
                "os": HOST_OS,
            }
        )
    token, expires_at = _sign_qr_token(settings.qr_ttl_seconds)
    connect_url = f"{app_url}/api/qr-login?t={token}"
    return JSONResponse(
        {
            "tailscale_ready": True,
            "tailscale_found": True,
            "app_url": app_url,
            "connect_url": connect_url,
            # SVG pronto (preto/branco, alto contraste) para o painel desktop
            "qr_svg": connect.qr_svg(connect_url),
            "expires_at": expires_at,
            "ttl_seconds": settings.qr_ttl_seconds,
            "os": HOST_OS,
        }
    )


@app.get("/api/qr-login")
async def qr_login(request: Request, t: str | None = None) -> RedirectResponse:
    """Consome o token do QR e autentica a sessão (login sem PIN, uso único)."""
    if not _verify_qr_token(t):
        # Inválido/expirado/já usado: cai na tela normal de PIN.
        return RedirectResponse(url="/", status_code=303)
    token = _create_session(request)
    _audit("QR_LOGIN", request, owner=active_sessions[token].is_owner)
    response = RedirectResponse(url="/", status_code=303)
    _set_auth_cookie(response, request, token)
    return response


def _session_payload(session: SessionInfo, current_token: str) -> dict:
    device = devices.get_device(session.device_id) or {}
    return {
        "id": session.pub_id,
        "device_id": session.device_id,
        "device_name": device.get("name") or device.get("default_name") or "",
        "device_default_name": device.get("default_name") or "",
        "device_type": device.get("type") or "device",
        "device_model": device.get("model") or "",
        "created_at": datetime.fromtimestamp(session.created_at).isoformat(timespec="seconds"),
        "last_seen": datetime.fromtimestamp(session.last_seen).isoformat(timespec="seconds"),
        "client_ip": session.client_ip,
        "user_agent": session.user_agent,
        "is_owner": session.is_owner,
        "is_current": session.token == current_token,
    }


@app.get("/api/sessions")
async def list_sessions(request: Request, owner: SessionInfo = Depends(require_owner)) -> JSONResponse:
    """Lista as sessões ativas (só a sessão dona enxerga)."""
    _purge_expired_sessions()
    sessions = sorted(active_sessions.values(), key=lambda s: s.created_at)
    return JSONResponse(
        {"sessions": [_session_payload(s, owner.token) for s in sessions]}
    )


@app.post("/api/sessions/{pub_id}/revoke")
async def revoke_session(
    pub_id: str, request: Request, owner: SessionInfo = Depends(require_owner)
) -> JSONResponse:
    """Expulsa uma sessão pelo seu id público (só a sessão dona pode)."""
    target = next((s for s in active_sessions.values() if s.pub_id == pub_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    active_sessions.pop(target.token, None)
    _ensure_owner()
    _audit("SESSION_REVOKED", request, target=pub_id, was_owner=target.is_owner)
    return JSONResponse({"ok": True, "revoked_self": target.token == owner.token})


# O frontend Next.js (export estático) é servido na raiz. Precisa ser montado
# por último para que as rotas /api acima tenham prioridade no roteamento.
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    logger.warning(
        "Frontend nao compilado em %s. Rode 'npm install' e 'npm run build' em web/.",
        FRONTEND_DIR,
    )
