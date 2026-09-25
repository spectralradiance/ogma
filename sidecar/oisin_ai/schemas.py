"""API contracts. Mirrored in app/src/shared/ipc.ts."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class GpuDevice(BaseModel):
    index: int
    name: str
    memory_total_mb: int
    memory_used_mb: int
    memory_free_mb: int
    driver_version: str


class GpuStatus(BaseModel):
    available: bool
    devices: list[GpuDevice]
    error: str | None


class TorchStatus(BaseModel):
    state: Literal["pending", "ready"]
    installed: bool | None
    version: str | None
    cuda_available: bool
    cuda_version: str | None
    error: str | None


class ProviderStatus(BaseModel):
    id: str
    label: str
    kind: Literal["cloud", "local"]
    configured: bool
    detail: str | None


class Health(BaseModel):
    status: Literal["ok"]
    version: str
    python: str
    python_prefix: str
    in_virtualenv: bool
    pid: int
    uptime_s: float
    gpu: GpuStatus
    torch: TorchStatus
    providers: list[ProviderStatus]
    models_loaded: list[str]


class RunMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class RunProfile(BaseModel):
    id: str
    provider: str
    model: str = ""
    params: dict[str, Any] = Field(default_factory=dict)


class RunRequest(BaseModel):
    """One AI run: the rendered prompt plus the routing configuration to use."""

    task: str
    system: str = ""
    messages: list[RunMessage] = Field(min_length=1)
    max_tokens: int = Field(default=4096, ge=1, le=128_000)
    temperature: float | None = Field(default=None, ge=0, le=2)
    mode: Literal["local", "cloud", "hybrid"] = "hybrid"
    profile_id: str | None = None
    # Use only profile_id, with no fallback (connection tests).
    profile_only: bool = False
    profiles: list[RunProfile]
    routing: dict[str, list[str]]
