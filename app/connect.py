"""Conexão privada via Tailscale + página de QR Code para parear o celular.

Fluxo: no startup o app garante que o `tailscale serve` esteja publicando o
servidor local na tailnet (HTTPS, só acessível pelos seus dispositivos), descobre
a URL MagicDNS da máquina e abre uma página local com um QR Code. O QR carrega um
token de login de uso único e curta validade — escanear já autentica o celular.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import shutil
import subprocess
from html import escape

import segno

from .config import settings

logger = logging.getLogger(__name__)

_DEFAULT_WINDOWS_PATH = r"C:\Program Files\Tailscale\tailscale.exe"
# Caminhos comuns do CLI do Tailscale fora do PATH em cada sistema.
_DEFAULT_MAC_PATHS = (
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
)
_DEFAULT_LINUX_PATHS = ("/usr/bin/tailscale", "/usr/local/bin/tailscale")


def tailscale_exe() -> str | None:
    """Resolve o executável do Tailscale (config explícita, caminhos padrão, PATH)."""
    candidates = [
        settings.tailscale_path,
        _DEFAULT_WINDOWS_PATH,
        *_DEFAULT_MAC_PATHS,
        *_DEFAULT_LINUX_PATHS,
        "tailscale",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        if os.path.isabs(candidate):
            if os.path.exists(candidate):
                return candidate
            continue
        found = shutil.which(candidate)
        if found:
            return found
    return None


def _run(args: list[str], timeout: float = 10.0) -> subprocess.CompletedProcess | None:
    exe = tailscale_exe()
    if not exe:
        logger.warning("Tailscale não encontrado; conexão privada indisponível.")
        return None
    try:
        return subprocess.run(
            [exe, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("Falha ao executar tailscale %s: %s", " ".join(args), exc)
        return None


def ensure_serve(port: int) -> None:
    """Garante que o app local esteja publicado na tailnet via `tailscale serve`.

    Idempotente: reaplicar o mesmo mapeamento não causa efeito colateral.
    """
    result = _run(["serve", "--bg", f"http://127.0.0.1:{port}"], timeout=20.0)
    if result is None:
        return
    if result.returncode != 0:
        logger.warning(
            "tailscale serve retornou código %s: %s",
            result.returncode,
            (result.stderr or result.stdout or "").strip(),
        )
    else:
        logger.info("tailscale serve ativo para http://127.0.0.1:%s", port)


def tailnet_url() -> str | None:
    """URL HTTPS pública-na-tailnet da máquina (ex.: https://maquina.tailnet.ts.net)."""
    result = _run(["status", "--json"], timeout=10.0)
    if result is None or result.returncode != 0 or not result.stdout:
        return None
    try:
        data = json.loads(result.stdout)
        dns_name = data["Self"]["DNSName"].rstrip(".")
    except (json.JSONDecodeError, KeyError, TypeError):
        return None
    if not dns_name:
        return None
    return f"https://{dns_name}"


def qr_svg(text: str) -> str:
    """QR Code do texto como SVG inline, no padrão legível: módulos PRETOS sobre
    fundo BRANCO e a borda (quiet zone) de 4 módulos exigida pela norma. Sem isso
    (ex.: módulos coloridos em fundo transparente) muitos leitores falham."""
    buffer = io.BytesIO()
    segno.make(text, error="m").save(
        buffer,
        kind="svg",
        scale=10,
        border=4,
        dark="#000000",
        light="#ffffff",
        xmldecl=False,
    )
    svg = buffer.getvalue().decode("utf-8")
    # O segno não emite viewBox; sem ele o SVG é RECORTADO ao caber num container
    # de tamanho fixo em vez de escalar. Injetamos um viewBox a partir do
    # width/height intrínsecos para que ele escale inteiro e nítido.
    match = re.search(r'<svg[^>]*?\bwidth="(\d+)"[^>]*?\bheight="(\d+)"', svg)
    if match and "viewBox" not in svg:
        width, height = match.group(1), match.group(2)
        svg = svg.replace("<svg ", f'<svg viewBox="0 0 {width} {height}" ', 1)
    return svg


def render_connect_page(
    *,
    app_url: str | None,
    connect_url: str | None,
    expires_at: int,
    ttl_seconds: int,
) -> str:
    """HTML of the local pairing page (QR + countdown)."""
    if not app_url or not connect_url:
        return _render_unavailable()

    svg = qr_svg(connect_url)
    safe_app_url = escape(app_url)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pair phone · Peek Remote</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: "Segoe UI", system-ui, sans-serif;
    background: #f3efe9; color: #1c1714;
  }}
  .card {{
    background: #fffdf9; border: 1px solid #e2d9cb; border-radius: 18px;
    padding: 32px 36px; max-width: 420px; text-align: center;
    box-shadow: 0 18px 40px -28px rgba(28,23,20,.5);
  }}
  h1 {{ font-size: 1.25rem; margin: 0 0 4px; }}
  p {{ margin: 6px 0; color: #6b5f50; font-size: .92rem; }}
  .qr {{
    width: 280px; height: 280px; margin: 18px auto; background: #ffffff;
    padding: 12px; border-radius: 12px; border: 1px solid #e2d9cb;
  }}
  .qr svg {{ width: 100%; height: 100%; display: block; image-rendering: pixelated; }}
  .url {{
    font-size: .8rem; word-break: break-all; color: #8a7c69;
    background: #f3efe9; border-radius: 8px; padding: 8px 10px; margin-top: 10px;
  }}
  .timer {{ font-variant-numeric: tabular-nums; font-weight: 600; color: #1c1714; }}
  .expired {{ color: #a23b2d; font-weight: 600; }}
  button {{
    margin-top: 18px; border: 0; border-radius: 10px; padding: 11px 18px;
    background: #1c1714; color: #fffdf9; font-size: .92rem; cursor: pointer;
  }}
  button:hover {{ background: #34291f; }}
  #stage.gone .qr {{ filter: grayscale(1) blur(2px); opacity: .35; }}
</style>
</head>
<body>
  <div class="card" id="stage">
    <h1>Scan to sign in</h1>
    <p>Private connection over Tailscale. Keep Tailscale on in the phone.</p>
    <div class="qr">{svg}</div>
    <p>Expires in <span class="timer" id="timer">--:--</span></p>
    <p id="expmsg" class="expired" hidden>Refreshing QR…</p>
    <div class="url">{safe_app_url}</div>
    <button id="refresh" type="button">Generate new QR</button>
  </div>
<script>
  var expiresAt = {expires_at} * 1000;
  var timerEl = document.getElementById("timer");
  var stage = document.getElementById("stage");
  var expmsg = document.getElementById("expmsg");
  var renewing = false;
  function tick() {{
    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    var m = String(Math.floor(left / 60)).padStart(2, "0");
    var s = String(left % 60).padStart(2, "0");
    timerEl.textContent = m + ":" + s;
    if (left <= 0) {{
      // Expired: the previous token is no longer valid; fetch a fresh QR automatically.
      if (!renewing) {{ renewing = true; stage.classList.add("gone"); expmsg.hidden = false; setTimeout(function () {{ location.reload(); }}, 600); }}
      return;
    }}
    requestAnimationFrame(function () {{ setTimeout(tick, 250); }});
  }}
  tick();
  document.getElementById("refresh").addEventListener("click", function () {{ location.reload(); }});
</script>
</body>
</html>"""


def _render_unavailable() -> str:
    exe = tailscale_exe()
    hint = (
        "Tailscale is installed, but the tailnet URL couldn't be resolved. "
        "Make sure you logged in (tailscale up) and that MagicDNS is enabled."
        if exe
        else "Tailscale not found. Install it from https://tailscale.com/download."
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Peek Remote</title>
<style>body{{font-family:system-ui,sans-serif;background:#f3efe9;color:#1c1714;
display:grid;place-items:center;min-height:100vh;margin:0}}
.card{{background:#fffdf9;border:1px solid #e2d9cb;border-radius:16px;padding:28px;
max-width:420px;text-align:center}}</style></head>
<body><div class="card"><h1>Private connection unavailable</h1>
<p>{escape(hint)}</p>
<button onclick="location.reload()">Try again</button></div></body></html>"""
