import uvicorn

from app.config import settings


def main() -> None:
    # Lean runtime: single in-process server (uvicorn's default — no worker
    # supervisor), no per-request access log, warnings only. The app is fully
    # event-driven (it does no polling), so while idle it costs the host
    # machine essentially nothing.
    uvicorn.run(
        "app.main:app",
        host=settings.server_host,
        port=settings.server_port,
        access_log=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
