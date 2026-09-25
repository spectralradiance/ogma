"""Provider registry.

Phase 0 only reports which providers are configured. The adapters themselves
(anthropic, openai, gemini, openai_compat, local_hf) arrive in Phase 4 behind a
single Provider interface — see PLAN.md §2a. Key values are never returned.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# (id, label, environment variables that can hold the key)
CLOUD_PROVIDERS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("anthropic", "Anthropic (Claude)", ("ANTHROPIC_API_KEY",)),
    ("openai", "OpenAI", ("OPENAI_API_KEY",)),
    ("gemini", "Google Gemini", ("GEMINI_API_KEY", "GOOGLE_API_KEY")),
)
COMPAT_BASE_URL_ENV = "OISIN_COMPAT_BASE_URL"


def _local_detail(torch_status: Mapping[str, Any]) -> str | None:
    if torch_status.get("state") == "pending":
        return "checking PyTorch…"
    if torch_status.get("error"):
        return "PyTorch failed to load"
    if not torch_status.get("installed"):
        return "PyTorch not installed"
    if not torch_status.get("cuda_available"):
        return "CUDA unavailable"
    return None


def provider_statuses(env: Mapping[str, str], torch_status: Mapping[str, Any]) -> list[dict[str, Any]]:
    statuses: list[dict[str, Any]] = []
    for provider_id, label, keys in CLOUD_PROVIDERS:
        configured = any(env.get(key) for key in keys)
        statuses.append({
            "id": provider_id,
            "label": label,
            "kind": "cloud",
            "configured": configured,
            "detail": None if configured else f"set {keys[0]}",
        })

    compat_configured = bool(env.get(COMPAT_BASE_URL_ENV))
    statuses.append({
        "id": "openai_compat",
        "label": "OpenAI-compatible",
        "kind": "cloud",
        "configured": compat_configured,
        "detail": None if compat_configured else f"set {COMPAT_BASE_URL_ENV}",
    })

    local_detail = _local_detail(torch_status)
    statuses.append({
        "id": "local_hf",
        "label": "Local (transformers)",
        "kind": "local",
        "configured": local_detail is None,
        "detail": local_detail,
    })
    return statuses
