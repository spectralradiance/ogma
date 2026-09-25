"""API contracts. Mirrored in app/src/shared/ipc.ts."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


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
    pid: int
    uptime_s: float
    gpu: GpuStatus
    torch: TorchStatus
    providers: list[ProviderStatus]
    models_loaded: list[str]
