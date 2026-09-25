"""Task → profile → provider routing with mode filtering and fallback (PLAN.md §2a).

The app sends the routing configuration with every request, so the sidecar
holds no settings of its own. A task's routing entry lists profile ids in
order of preference; the mode filters them (local = local providers only,
cloud = remote only, hybrid = all). A profile is skipped when its provider is
not configured, and the next one is tried when a run fails *before any text
arrived* with a retryable kind of error. Once text has streamed, a failure is
reported rather than silently restarted on another model.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Literal

from .ai_types import ErrorKind, GenerateRequest, Profile, Provider, ProviderError, StreamEvent

Mode = Literal["local", "cloud", "hybrid"]
FALLBACK_KINDS: set[ErrorKind] = {"auth", "rate_limit", "unavailable", "refusal"}


@dataclass(frozen=True)
class RoutingConfig:
    mode: Mode
    profiles: tuple[Profile, ...]
    routing: Mapping[str, tuple[str, ...]]


def candidates(task: str, config: RoutingConfig, providers: Mapping[str, Provider], override: str | None = None) -> list[Profile]:
    by_id = {profile.id: profile for profile in config.profiles}
    order = list(config.routing.get(task) or config.routing.get("default") or ())
    if override:
        order = [override, *[profile_id for profile_id in order if profile_id != override]]
    chosen: list[Profile] = []
    for profile_id in order:
        profile = by_id.get(profile_id)
        provider = providers.get(profile.provider) if profile else None
        if profile is None or provider is None:
            continue
        if config.mode == "local" and provider.kind != "local":
            continue
        if config.mode == "cloud" and provider.kind != "cloud":
            continue
        chosen.append(profile)
    return chosen


def run(
    task: str,
    request: GenerateRequest,
    config: RoutingConfig,
    providers: Mapping[str, Provider],
    override: str | None = None,
) -> Iterator[StreamEvent]:
    """Streams events for one run. Always ends with a "done" or "error" event."""
    options = candidates(task, config, providers, override)
    if not options:
        yield {"type": "error", "kind": "unavailable", "message": f"No profile is set up for “{task}” in {config.mode} mode."}
        return

    problems: list[str] = []
    for attempt, profile in enumerate(options):
        provider = providers[profile.provider]
        health = provider.health()
        if not health.configured:
            problems.append(f"{profile.id}: {health.detail or 'not configured'}")
            continue
        yield {
            "type": "start",
            "profile": profile.id,
            "provider": provider.id,
            "provider_label": provider.label,
            "model": profile.model,
            "fallback": attempt > 0,
            "skipped": list(problems),
        }
        streamed_text = False
        try:
            for event in provider.stream(request, profile):
                if event["type"] == "text":
                    streamed_text = True
                yield event
            return
        except ProviderError as error:
            if streamed_text or error.kind not in FALLBACK_KINDS:
                yield {"type": "error", "kind": error.kind, "message": error.message, "partial": streamed_text}
                return
            problems.append(f"{profile.id}: {error.message}")
            yield {"type": "notice", "message": f"{provider.label} failed ({error.kind}); trying the next profile."}

    yield {"type": "error", "kind": "unavailable", "message": "No provider could run this. " + "; ".join(problems)}
