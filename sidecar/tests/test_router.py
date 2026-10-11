from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

from fastapi.testclient import TestClient

from ogma_ai.ai_types import (
    ChatMessage,
    GenerateRequest,
    Profile,
    ProviderError,
    ProviderHealth,
    StreamEvent,
    done_event,
    status_kind,
    ToolSpec,
    text_event,
)
from ogma_ai.main import create_app
from ogma_ai.router import RoutingConfig, candidates, run

REQUEST = GenerateRequest(system="be brief", messages=(ChatMessage("user", "hi"),))


class FakeProvider:
    def __init__(self, provider_id: str, kind: str = "cloud", *, configured: bool = True,
                 fail: str | None = None, fail_after_text: bool = False, text: str = "hello") -> None:
        self.id = provider_id
        self.label = provider_id.title()
        self.kind = kind
        self._configured = configured
        self._fail = fail
        self._fail_after_text = fail_after_text
        self._text = text
        self.calls: list[Profile] = []

    def health(self) -> ProviderHealth:
        return ProviderHealth(self._configured, None if self._configured else "no API key")

    def stream(self, request: GenerateRequest, profile: Profile) -> Iterator[StreamEvent]:
        self.calls.append(profile)
        if self._fail and not self._fail_after_text:
            raise ProviderError(self._fail, f"{self.id} failed")  # type: ignore[arg-type]
        yield text_event(self._text)
        if self._fail:
            raise ProviderError(self._fail, f"{self.id} broke mid-stream")  # type: ignore[arg-type]
        yield done_event("end_turn")


PROFILES = (
    Profile("claude-main", "cloud_a", "model-a"),
    Profile("gemini-alt", "cloud_b", "model-b"),
    Profile("qwen-local", "local", "qwen"),
)


def config(mode: str = "hybrid", routing: dict[str, tuple[str, ...]] | None = None) -> RoutingConfig:
    return RoutingConfig(mode=mode, profiles=PROFILES, routing=routing or {  # type: ignore[arg-type]
        "synthesize": ("claude-main", "gemini-alt", "qwen-local"),
        "lexical": ("qwen-local", "claude-main"),
    })


def providers(**overrides: FakeProvider) -> dict[str, FakeProvider]:
    base = {"cloud_a": FakeProvider("cloud_a"), "cloud_b": FakeProvider("cloud_b"), "local": FakeProvider("local", "local")}
    base.update(overrides)
    return base


def types_of(events: list[StreamEvent]) -> list[str]:
    return [event["type"] for event in events]


def test_mode_filters_candidates() -> None:
    registry = providers()
    assert [p.id for p in candidates("synthesize", config("hybrid"), registry)] == ["claude-main", "gemini-alt", "qwen-local"]
    assert [p.id for p in candidates("synthesize", config("cloud"), registry)] == ["claude-main", "gemini-alt"]
    assert [p.id for p in candidates("synthesize", config("local"), registry)] == ["qwen-local"]


def test_override_goes_first_and_unknown_tasks_use_default() -> None:
    registry = providers()
    assert [p.id for p in candidates("lexical", config(), registry, override="gemini-alt")][0] == "gemini-alt"
    routed = config(routing={"default": ("gemini-alt",)})
    assert [p.id for p in candidates("anything", routed, registry)] == ["gemini-alt"]


def test_only_uses_just_the_override_for_connection_tests() -> None:
    registry = providers(cloud_a=FakeProvider("cloud_a", configured=False))
    assert [p.id for p in candidates("synthesize", config(), registry, override="claude-main", only=True)] == ["claude-main"]
    events = list(run("synthesize", REQUEST, config(), registry, override="claude-main", only=True))
    assert types_of(events) == ["error"]
    assert "claude-main: no API key" in events[0]["message"]
    assert registry["cloud_b"].calls == []


def test_happy_path_reports_the_profile_that_ran() -> None:
    events = list(run("synthesize", REQUEST, config(), providers()))
    assert types_of(events) == ["start", "text", "done"]
    assert events[0] | {} == events[0] and events[0]["profile"] == "claude-main" and events[0]["fallback"] is False


def test_unconfigured_provider_is_skipped_and_reported() -> None:
    events = list(run("synthesize", REQUEST, config(), providers(cloud_a=FakeProvider("cloud_a", configured=False))))
    assert events[0]["profile"] == "gemini-alt"
    assert events[0]["fallback"] is True
    assert events[0]["skipped"] == ["claude-main: no API key"]


def test_retryable_failure_before_text_falls_back() -> None:
    registry = providers(cloud_a=FakeProvider("cloud_a", fail="rate_limit"))
    events = list(run("synthesize", REQUEST, config(), registry))
    assert types_of(events) == ["start", "notice", "start", "text", "done"]
    assert events[2]["profile"] == "gemini-alt"


def test_failure_after_text_is_reported_not_retried() -> None:
    registry = providers(cloud_a=FakeProvider("cloud_a", fail="unavailable", fail_after_text=True))
    events = list(run("synthesize", REQUEST, config(), registry))
    assert types_of(events) == ["start", "text", "error"]
    assert events[-1]["partial"] is True
    assert registry["cloud_b"].calls == []


def test_non_retryable_failure_stops() -> None:
    events = list(run("synthesize", REQUEST, config(), providers(cloud_a=FakeProvider("cloud_a", fail="bad_request"))))
    assert types_of(events) == ["start", "error"]
    assert events[-1]["kind"] == "bad_request"


def test_nothing_available_ends_with_an_error() -> None:
    down = {name: FakeProvider(name, kind, configured=False) for name, kind in (("cloud_a", "cloud"), ("cloud_b", "cloud"), ("local", "local"))}
    events = list(run("synthesize", REQUEST, config(), down))
    assert types_of(events) == ["error"]
    assert "claude-main" in events[0]["message"]
    assert types_of(list(run("synthesize", REQUEST, config("local", {"synthesize": ("claude-main",)}), providers()))) == ["error"]


def test_status_kinds() -> None:
    assert status_kind(401) == "auth"
    assert status_kind(429) == "rate_limit"
    assert status_kind(400, "prompt is too long: 250000 tokens") == "context_too_long"
    assert status_kind(529) == "unavailable"
    assert status_kind(404) == "bad_request"


class Probe:
    def start(self) -> None:
        pass

    def snapshot(self) -> dict[str, Any]:
        return {"available": False, "devices": [], "error": None}


def test_run_endpoint_streams_server_sent_events() -> None:
    token = "t" * 64
    app = create_app(token, gpu_probe=Probe(), torch_probe=Probe(), env={}, providers=providers())  # type: ignore[arg-type]
    body = {
        "task": "synthesize",
        "system": "be brief",
        "messages": [{"role": "user", "content": "hi"}],
        "mode": "cloud",
        "profiles": [{"id": p.id, "provider": p.provider, "model": p.model} for p in PROFILES],
        "routing": {"synthesize": ["claude-main", "gemini-alt"]},
    }
    with TestClient(app) as client:
        response = client.post("/ai/run", json=body, headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert types_of(events) == ["start", "text", "done"]

        assert client.post("/ai/run", json={**body, "messages": []}, headers={"Authorization": f"Bearer {token}"}).status_code == 422
        assert client.post("/ai/run", json=body).status_code == 401


def test_tool_runs_skip_providers_without_tool_support() -> None:
    tooled = FakeProvider("cloud_b")
    tooled.supports_tools = True  # type: ignore[attr-defined]
    registry = providers(cloud_b=tooled)
    assert [p.id for p in candidates("synthesize", config(), registry, needs_tools=True)] == ["gemini-alt"]
    request = GenerateRequest(system="", messages=(ChatMessage("user", "hi"),), tools=(ToolSpec("t", "a tool", {"type": "object"}),))
    events = list(run("synthesize", request, config("local"), registry))
    assert events[-1]["kind"] == "unavailable" and "tool support" in events[-1]["message"]
