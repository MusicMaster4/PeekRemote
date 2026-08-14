import re
from pathlib import Path
from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Sem default de seguranca: o app SE RECUSA a subir sem um PIN proprio de 6
    # digitos definido em APP_PIN (ou AUTH_PIN). Isso elimina o antigo PIN padrao
    # hardcoded, que qualquer um com acesso ao codigo conhecia.
    auth_pin: str = Field(
        default="",
        validation_alias=AliasChoices("APP_PIN", "AUTH_PIN"),
    )

    @field_validator("auth_pin")
    @classmethod
    def _require_strong_pin(cls, value: str) -> str:
        pin = value.strip()
        if not re.fullmatch(r"\d{6}", pin):
            raise ValueError(
                "Defina um PIN proprio de 6 digitos em APP_PIN no arquivo .env "
                "(ex.: escolha 6 digitos aleatorios). O servidor nao sobe sem PIN por "
                "seguranca. Evite sequencias obvias como 123456 ou 000000."
            )
        if pin in {"000000", "111111", "123456", "654321", "121212", "112233"}:
            raise ValueError(
                "Esse PIN e uma sequencia obvia. Escolha 6 digitos menos "
                "previsiveis em APP_PIN no .env."
            )
        return pin

    server_host: str = Field(
        default="127.0.0.1",
        validation_alias=AliasChoices("SERVER_HOST"),
    )
    server_port: int = Field(
        default=1739,
        ge=1,
        le=65535,
        validation_alias=AliasChoices("SERVER_PORT"),
    )
    cloudflared_path: str = Field(
        default="",
        validation_alias=AliasChoices("CLOUDFLARED_PATH"),
    )
    cloudflared_args: str = Field(
        default="--no-autoupdate",
        validation_alias=AliasChoices("CLOUDFLARED_ARGS"),
    )
    # Quantas tentativas de PIN erradas por cliente antes de bloquear ate o
    # restart. Apertado para 5 (era 100) para tornar inviavel adivinhar o PIN.
    max_failed_logins: int = Field(
        default=5,
        ge=1,
        le=50,
        validation_alias=AliasChoices("MAX_FAILED_LOGINS"),
    )
    # Arquivo de log de auditoria (logins, logouts, suspensoes). Relativo a raiz
    # do projeto se nao for caminho absoluto.
    audit_log_file: Path = Field(
        default=Path("audit.log"),
        validation_alias=AliasChoices("AUDIT_LOG_FILE"),
    )
    # Writable app data directory passed by the Electron shell. Used for
    # persistent paired-device names and other local-only state.
    app_data_dir: Path = Field(
        default=Path(".peek-remote-data"),
        validation_alias=AliasChoices("APP_DATA_DIR"),
    )
    # Random secret shared only between Electron main and the backend. It lets
    # the desktop panel manage local state without exposing those endpoints to
    # authenticated phones or the tailnet proxy.
    desktop_api_token: str = Field(
        default="",
        validation_alias=AliasChoices("DESKTOP_API_TOKEN"),
    )
    # Caminho do executavel do Tailscale. Vazio = autodetecta (Program Files / PATH).
    tailscale_path: str = Field(
        default="",
        validation_alias=AliasChoices("TAILSCALE_PATH"),
    )
    # Caminho publico em que o app fica montado no Tailscale Serve. Por padrao
    # libera a raiz do host Tailscale para outro servico.
    public_base_path: str = Field(
        default="/peekremote",
        validation_alias=AliasChoices("PUBLIC_BASE_PATH", "APP_BASE_PATH", "TAILSCALE_SERVE_PATH"),
    )
    # Validade do QR de conexao (token de login de uso unico), em segundos.
    # 30 min: o link da tailnet e fixo, entao nao ha motivo de girar rapido.
    qr_ttl_seconds: int = Field(
        default=1800,
        ge=30,
        le=86400,
        validation_alias=AliasChoices("QR_TTL_SECONDS"),
    )
    # Abrir a pagina do QR no navegador do PC automaticamente ao iniciar.
    qr_open_browser: bool = Field(
        default=True,
        validation_alias=AliasChoices("QR_OPEN_BROWSER"),
    )
    # Capturas: JPEG evita o custo alto de PNG + base64 no uso remoto. A captura
    # "photo" usa qualidade maior; o modo ao vivo usa qualidade menor para
    # reduzir latencia e CPU mantendo texto legivel.
    screenshot_format: str = Field(
        default="jpeg",
        validation_alias=AliasChoices("SCREENSHOT_FORMAT"),
    )
    screenshot_quality: int = Field(
        default=82,
        ge=1,
        le=95,
        validation_alias=AliasChoices("SCREENSHOT_QUALITY"),
    )
    live_screenshot_quality: int = Field(
        default=52,
        ge=1,
        le=95,
        validation_alias=AliasChoices("LIVE_SCREENSHOT_QUALITY"),
    )
    live_max_width: int = Field(
        default=1280,
        ge=640,
        le=7680,
        validation_alias=AliasChoices("LIVE_MAX_WIDTH"),
    )
    screenshot_cache_ms: int = Field(
        default=120,
        ge=0,
        le=1000,
        validation_alias=AliasChoices("SCREENSHOT_CACHE_MS"),
    )
    post_input_capture_delay_ms: int = Field(
        default=120,
        ge=0,
        le=1000,
        validation_alias=AliasChoices("POST_INPUT_CAPTURE_DELAY_MS"),
    )
    clipboard_sync_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices("CLIPBOARD_SYNC_ENABLED"),
    )
    stream_fps: int = Field(
        default=10,
        ge=1,
        le=30,
        validation_alias=AliasChoices("STREAM_FPS"),
    )

    @field_validator("screenshot_format")
    @classmethod
    def _normalize_screenshot_format(cls, value: str) -> str:
        fmt = value.strip().lower()
        if fmt not in {"jpeg", "jpg", "png", "webp"}:
            raise ValueError("SCREENSHOT_FORMAT deve ser jpeg, png ou webp.")
        return "jpeg" if fmt == "jpg" else fmt

    @field_validator("public_base_path")
    @classmethod
    def _normalize_public_base_path(cls, value: str) -> str:
        path = value.strip()
        if path in {"", "/"}:
            return ""
        if not path.startswith("/"):
            path = f"/{path}"
        path = path.rstrip("/")
        if not re.fullmatch(r"(?:/[A-Za-z0-9._~-]+)+", path):
            raise ValueError("PUBLIC_BASE_PATH deve ser um caminho de URL, ex.: /peekremote.")
        return path


settings = Settings()
