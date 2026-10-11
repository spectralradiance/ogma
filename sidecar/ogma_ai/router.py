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


def candidates(
    task: str,
    config: RoutingConfig,
    providers: Mapping[str, Provider],
    override: str | None = None,
    only: bool = False,
    needs_tools: bool = False,
) -> list[Profile]:
    """Profiles to try, in order. With `only`, just the override (used by connection tests).
    With `needs_tools`, providers that cannot pass tools to the model are left out."""
    by_id = {profile.id: profile for profile in config.profiles}
    order = list(config.routing.get(task) or config.routing.get("default") or ())
    if override:
        order = [override] if only else [override, *[profile_id for profile_id in order if profile_id != override]]
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
        if needs_tools and not getattr(provider, "supports_tools", False):
            continue
        chosen.append(profile)
    return chosen


def run(
    task: str,
    request: GenerateRequest,
    config: RoutingConfig,
    providers: Mapping[str, Provider],
    override: str | None = None,
    only: bool = False,
) -> Iterator[StreamEvent]:
    """Streams events for one run. Always ends with a "done" or "error" event."""
    needs_tools = bool(request.tools)
    options = candidates(task, config, providers, override, only, needs_tools)
    if not options:
        what = "with tool support (Claude or an OpenAI-style model) " if needs_tools else ""
        yield {"type": "error", "kind": "unavailable", "message": f"No profile {what}is set up for “{task}” in {config.mode} mode."}
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
                if event["type"] in ("text", "tool_call"):
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
