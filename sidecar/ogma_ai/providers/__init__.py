"""Provider registry.

Every AI request goes through one of these adapters behind the Provider
interface (see ai_types.py). Keys come from the environment the desktop app
starts the sidecar with; their values are never returned by any endpoint.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from ..ai_types import Provider
from .claude import ClaudeProvider
from .gemini import GeminiProvider
from .local_hf import LocalHFProvider
from .openai_chat import compat_provider, openai_provider


def build_providers(env: Mapping[str, str], torch_status: Callable[[], dict[str, Any]]) -> dict[str, Provider]:
    providers: list[Provider] = [
        ClaudeProvider(env),
        openai_provider(env),
        GeminiProvider(env),
        compat_provider(env),
        LocalHFProvider(torch_status),
    ]
    return {provider.id: provider for provider in providers}


def provider_statuses(providers: Mapping[str, Provider]) -> list[dict[str, Any]]:
    statuses = []
    for provider in providers.values():
        health = provider.health()
        statuses.append({
            "id": provider.id,
            "label": provider.label,
            "kind": provider.kind,
            "configured": health.configured,
            "detail": health.detail,
        })
    return statuses
