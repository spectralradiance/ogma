"""Hardware and runtime probes reported by /health.

GPU facts come from nvidia-smi so they are available without PyTorch installed and
reflect memory used by every process, not just this one. The PyTorch probe runs once
in a background thread because importing torch takes several seconds.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import threading
import time
from typing import Any

NVIDIA_SMI_FIELDS = "index,name,memory.total,memory.used,memory.free,driver_version"
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def parse_nvidia_smi(output: str) -> list[dict[str, Any]]:
    """Parse `nvidia-smi --query-gpu=<NVIDIA_SMI_FIELDS> --format=csv,noheader,nounits`."""
    devices = []
    for line in output.strip().splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 6:
            continue
        index, name, total, used, free, driver = parts
        try:
            devices.append({
                "index": int(index),
                "name": name,
                "memory_total_mb": int(total),
                "memory_used_mb": int(used),
                "memory_free_mb": int(free),
                "driver_version": driver,
            })
        except ValueError:
            continue
    return devices


def query_gpus(timeout: float = 5.0) -> dict[str, Any]:
    executable = shutil.which("nvidia-smi")
    if executable is None:
        return {"available": False, "devices": [], "error": "nvidia-smi not found"}
    try:
        result = subprocess.run(
            [executable, f"--query-gpu={NVIDIA_SMI_FIELDS}", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=_CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "devices": [], "error": str(exc)}
    if result.returncode != 0:
        error = result.stderr.strip() or f"nvidia-smi exited with {result.returncode}"
        return {"available": False, "devices": [], "error": error}
    devices = parse_nvidia_smi(result.stdout)
    return {"available": bool(devices), "devices": devices, "error": None}


class GpuProbe:
    """Caches nvidia-smi results briefly so frequent health polls stay cheap."""

    def __init__(self, ttl_seconds: float = 5.0) -> None:
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._cached: dict[str, Any] | None = None
        self._cached_at = 0.0

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            now = time.monotonic()
            if self._cached is None or now - self._cached_at > self._ttl:
                self._cached = query_gpus()
                self._cached_at = now
            return self._cached


class TorchProbe:
    """Detects PyTorch and CUDA support once, off the request path."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._result: dict[str, Any] = {
            "state": "pending",
            "installed": None,
            "version": None,
            "cuda_available": False,
            "cuda_version": None,
            "error": None,
        }
        self._started = False

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
        threading.Thread(target=self._run, name="torch-probe", daemon=True).start()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._result)

    def _run(self) -> None:
        result: dict[str, Any] = {"state": "ready", "installed": False, "version": None,
                                  "cuda_available": False, "cuda_version": None, "error": None}
        if importlib.util.find_spec("torch") is not None:
            result["installed"] = True
            try:
                import torch

                result["version"] = torch.__version__
                result["cuda_available"] = bool(torch.cuda.is_available())
                result["cuda_version"] = torch.version.cuda
            except Exception as exc:  # a broken install must not take down the sidecar
                result["error"] = f"{type(exc).__name__}: {exc}"
        with self._lock:
            self._result = result
