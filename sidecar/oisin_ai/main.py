"""FastAPI application factory.

Every route requires `Authorization: Bearer <token>`. The desktop app generates a
fresh token per launch and is the only intended client; the renderer never talks
to the sidecar directly.
"""

from __future__ import annotations

import hmac
import os
import platform
import sys
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from typing import Any, Protocol

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__
from .providers import provider_statuses
from .schemas import Health
from .system import GpuProbe, TorchProbe


class SnapshotProbe(Protocol):
    def snapshot(self) -> dict[str, Any]: ...


class StartableProbe(SnapshotProbe, Protocol):
    def start(self) -> None: ...


def create_app(
    token: str,
    *,
    gpu_probe: SnapshotProbe | None = None,
    torch_probe: StartableProbe | None = None,
    env: Mapping[str, str] | None = None,
) -> FastAPI:
    if not token:
        raise ValueError("a non-empty token is required")

    gpu = gpu_probe or GpuProbe()
    torch_status = torch_probe or TorchProbe()
    environment = os.environ if env is None else env
    expected_header = f"Bearer {token}".encode()
    started = time.monotonic()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        torch_status.start()
        yield

    app = FastAPI(
        title="Oisín AI sidecar",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.middleware("http")
    async def require_token(request: Request, call_next):  # type: ignore[no-untyped-def]
        supplied = request.headers.get("authorization", "").encode()
        if not hmac.compare_digest(supplied, expected_header):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)

    @app.get("/health", response_model=Health)
    def health() -> dict[str, Any]:
        torch_snapshot = torch_status.snapshot()
        return {
            "status": "ok",
            "version": __version__,
            "python": platform.python_version(),
            "python_prefix": sys.prefix,
            "in_virtualenv": sys.prefix != sys.base_prefix,
            "pid": os.getpid(),
            "uptime_s": round(time.monotonic() - started, 1),
            "gpu": gpu.snapshot(),
            "torch": torch_snapshot,
            "providers": provider_statuses(environment, torch_snapshot),
            "models_loaded": [],
        }

    return app
