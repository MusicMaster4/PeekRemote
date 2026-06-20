import multiprocessing

import uvicorn

# Importa o objeto `app` diretamente (em vez da string "app.main:app") para que o
# PyInstaller consiga rastrear estaticamente toda a árvore de dependências quando
# o backend é empacotado no app desktop (Electron).
from app.config import settings
from app.main import app


def main() -> None:
    # Lean runtime: single in-process server (uvicorn's default — no worker
    # supervisor), no per-request access log, warnings only. The app is fully
    # event-driven (it does no polling), so while idle it costs the host
    # machine essentially nothing.
    uvicorn.run(
        app,
        host=settings.server_host,
        port=settings.server_port,
        access_log=False,
        log_level="warning",
    )


if __name__ == "__main__":
    # Necessário quando empacotado pelo PyInstaller (evita re-spawn do processo
    # em plataformas que usam 'spawn').
    multiprocessing.freeze_support()
    main()
