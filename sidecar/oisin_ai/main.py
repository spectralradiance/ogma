"""FastAPI application factory.

Every route requires `Authorization: Bearer <token>`. The desktop app generates a
fresh token per launch and is the only intended client; the renderer never talks
to the sidecar directly.
"""

from __future__ import annotations

import hmac
import json
import os
import platform
import sys
import time
from collections.abc import AsyncIterator, Iterator, Mapping
from contextlib import asynccontextmanager
from typing import Any, Protocol

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import __version__
from .ai_types import ChatMessage, GenerateRequest, Profile, Provider
from .providers import build_providers, provider_statuses
from .router import RoutingConfig, run
from .schemas import Health, RunRequest
from .system import GpuProbe, TorchProbe


class SnapshotProbe(Protocol):
    def snapshot(self) -> dict[str, Any]: ...


class StartableProbe(SnapshotProbe, Protocol):
    def start(self) -> None: ...


def sse(events: Iterator[dict[str, Any]]) -> Iterator[str]:
    for event in events:
        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def create_app(
    token: str,
    *,
    gpu_probe: SnapshotProbe | None = None,
    torch_probe: StartableProbe | None = None,
    env: Mapping[str, str] | None = None,
    providers: Mapping[str, Provider] | None = None,
) -> FastAPI:
    if not token:
        raise ValueError("a non-empty token is required")

    gpu = gpu_probe or GpuProbe()
    torch_status = torch_probe or TorchProbe()
    environment = os.environ if env is None else env
    registry = providers if providers is not None else build_providers(environment, torch_status.snapshot)
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

    def loaded_models() -> list[str]:
        local = registry.get("local_hf")
        return list(getattr(local, "loaded_models", lambda: [])())

    @app.get("/health", response_model=Health)
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "version": __version__,
            "python": platform.python_version(),
            "python_prefix": sys.prefix,
            "in_virtualenv": sys.prefix != sys.base_prefix,
            "pid": os.getpid(),
            "uptime_s": round(time.monotonic() - started, 1),
            "gpu": gpu.snapshot(),
            "torch": torch_status.snapshot(),
            "providers": provider_statuses(registry),
            "models_loaded": loaded_models(),
        }

    @app.post("/ai/run")
    def ai_run(body: RunRequest) -> StreamingResponse:
        """Streams one AI run as server-sent events (one JSON event per `data:` line)."""
        request = GenerateRequest(
            system=body.system,
            messages=tuple(ChatMessage(role=message.role, content=message.content) for message in body.messages),
            max_tokens=body.max_tokens,
            temperature=body.temperature,
        )
        config = RoutingConfig(
            mode=body.mode,
            profiles=tuple(Profile(p.id, p.provider, p.model, dict(p.params)) for p in body.profiles),
            routing={task: tuple(ids) for task, ids in body.routing.items()},
        )
        events = run(body.task, request, config, registry, override=body.profile_id)
        return StreamingResponse(sse(events), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.post("/ai/local/unload")
    def unload_local() -> dict[str, Any]:
        local = registry.get("local_hf")
        if local is not None and hasattr(local, "unload"):
            local.unload()
        return {"models_loaded": loaded_models()}

    return app
