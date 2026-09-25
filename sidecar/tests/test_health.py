from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from oisin_ai.__main__ import main
from oisin_ai.main import create_app
from oisin_ai.system import parse_nvidia_smi

TOKEN = "a" * 64
AUTH = {"Authorization": f"Bearer {TOKEN}"}

GPU = {
    "available": True,
    "devices": [{
        "index": 0,
        "name": "NVIDIA GeForce RTX 4070 Laptop GPU",
        "memory_total_mb": 8188,
        "memory_used_mb": 1200,
        "memory_free_mb": 6988,
        "driver_version": "610.88",
    }],
    "error": None,
}


class FakeGpu:
    def snapshot(self) -> dict[str, Any]:
        return GPU


class FakeTorch:
    def __init__(self, **overrides: Any) -> None:
        self.started = False
        self.result = {"state": "ready", "installed": True, "version": "2.14.0", "cuda_available": True,
                       "cuda_version": "12.6", "error": None, **overrides}

    def start(self) -> None:
        self.started = True

    def snapshot(self) -> dict[str, Any]:
        return self.result


def make_client(env: dict[str, str] | None = None, torch: FakeTorch | None = None) -> TestClient:
    app = create_app(TOKEN, gpu_probe=FakeGpu(), torch_probe=torch or FakeTorch(), env=env or {})
    return TestClient(app)


def providers_by_id(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {provider["id"]: provider for provider in body["providers"]}


def test_missing_token_is_rejected() -> None:
    assert make_client().get("/health").status_code == 401


def test_wrong_token_is_rejected() -> None:
    response = make_client().get("/health", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_health_reports_gpu_torch_and_providers() -> None:
    response = make_client().get("/health", headers=AUTH)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["gpu"]["devices"][0]["memory_free_mb"] == 6988
    assert body["torch"]["cuda_available"] is True
    assert set(providers_by_id(body)) == {"anthropic", "openai", "gemini", "openai_compat", "local_hf"}


def test_lifespan_starts_torch_probe() -> None:
    torch = FakeTorch()
    with make_client(torch=torch):
        pass
    assert torch.started


def test_api_keys_are_reported_but_never_echoed() -> None:
    env = {"ANTHROPIC_API_KEY": "sk-ant-secret-value", "GOOGLE_API_KEY": "google-secret-value"}
    response = make_client(env=env).get("/health", headers=AUTH)
    providers = providers_by_id(response.json())
    assert providers["anthropic"]["configured"] is True
    assert providers["gemini"]["configured"] is True
    assert providers["openai"]["configured"] is False
    assert "secret-value" not in response.text


def test_local_provider_requires_cuda() -> None:
    torch = FakeTorch(cuda_available=False)
    providers = providers_by_id(make_client(torch=torch).get("/health", headers=AUTH).json())
    assert providers["local_hf"]["configured"] is False
    assert providers["local_hf"]["detail"] == "CUDA unavailable"


def test_local_provider_reports_missing_torch() -> None:
    torch = FakeTorch(installed=False, version=None, cuda_available=False, cuda_version=None)
    providers = providers_by_id(make_client(torch=torch).get("/health", headers=AUTH).json())
    assert providers["local_hf"]["detail"] == "PyTorch not installed"


def test_parse_nvidia_smi_skips_malformed_lines() -> None:
    output = "0, NVIDIA GeForce RTX 4070 Laptop GPU, 8188, 1200, 6988, 610.88\nnot a gpu line\n1, X, n/a, 0, 0, 1\n"
    devices = parse_nvidia_smi(output)
    assert len(devices) == 1
    assert devices[0]["name"] == "NVIDIA GeForce RTX 4070 Laptop GPU"
    assert devices[0]["memory_total_mb"] == 8188


def test_create_app_requires_token() -> None:
    with pytest.raises(ValueError):
        create_app("")


def test_refuses_non_loopback_host() -> None:
    with pytest.raises(SystemExit):
        main(["--host", "0.0.0.0"])
