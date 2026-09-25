"""Contract tests: each adapter drives its real vendor SDK against a local mock
server that speaks that vendor's streaming wire format. No network, no keys."""

from __future__ import annotations

import json
import socket
import threading
import time
from collections.abc import Iterator
from typing import Any

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from oisin_ai.ai_types import ChatMessage, GenerateRequest, Profile, ProviderError
from oisin_ai.providers.claude import FALLBACK_BETA, ClaudeProvider
from oisin_ai.providers.gemini import GeminiProvider
from oisin_ai.providers.local_hf import LocalHFProvider
from oisin_ai.providers.openai_chat import compat_provider, openai_provider

REQUEST = GenerateRequest(
    system="You are terse.",
    messages=(ChatMessage("user", "Say hello"), ChatMessage("assistant", "Hi."), ChatMessage("user", "Again")),
    max_tokens=64,
)
SEEN: list[dict[str, Any]] = []


def sse(lines: list[str]) -> StreamingResponse:
    return StreamingResponse(iter(lines), media_type="text/event-stream")


def mock_app() -> FastAPI:
    app = FastAPI()

    @app.post("/v1/messages")
    async def anthropic_messages(request: Request):  # type: ignore[no-untyped-def]
        body = await request.json()
        SEEN.append({"vendor": "anthropic", "body": body, "headers": dict(request.headers)})
        if body["model"] == "bad-key":
            return JSONResponse({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}, status_code=401)
        stop = "refusal" if body["model"] == "refuse" else "end_turn"
        events = [
            ("message_start", {"type": "message_start", "message": {
                "id": "msg_1", "type": "message", "role": "assistant", "model": body["model"], "content": [],
                "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 12, "output_tokens": 1}}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": " there"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 5}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        return sse([f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events])

    @app.post("/v1/chat/completions")
    async def openai_chat(request: Request):  # type: ignore[no-untyped-def]
        body = await request.json()
        SEEN.append({"vendor": "openai", "body": body, "headers": dict(request.headers)})
        if body["model"] == "busy":
            return JSONResponse({"error": {"message": "Rate limit reached", "type": "requests", "code": "rate_limit_exceeded"}}, status_code=429)

        def chunk(delta: dict[str, Any], finish: str | None = None) -> str:
            data = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": body["model"],
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            return f"data: {json.dumps(data)}\n\n"

        usage = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": body["model"], "choices": [],
                 "usage": {"prompt_tokens": 9, "completion_tokens": 3, "total_tokens": 12}}
        return sse([chunk({"role": "assistant", "content": "Hel"}), chunk({"content": "lo"}), chunk({}, "stop"),
                    f"data: {json.dumps(usage)}\n\n", "data: [DONE]\n\n"])

    @app.post("/v1beta/models/{model_action}")
    async def gemini_stream(model_action: str, request: Request):  # type: ignore[no-untyped-def]
        body = await request.json()
        SEEN.append({"vendor": "gemini", "path": model_action, "body": body, "headers": dict(request.headers)})
        model = model_action.split(":")[0]
        if model == "bad-key":
            return JSONResponse({"error": {"code": 403, "message": "API key not valid", "status": "PERMISSION_DENIED"}}, status_code=403)
        finish = "SAFETY" if model == "unsafe" else "STOP"
        parts = [
            {"candidates": [{"content": {"parts": [{"text": "Hel"}], "role": "model"}, "index": 0}]},
            {"candidates": [{"content": {"parts": [{"text": "lo"}], "role": "model"}, "finishReason": finish, "index": 0}],
             "usageMetadata": {"promptTokenCount": 7, "candidatesTokenCount": 2, "totalTokenCount": 9}},
        ]
        return sse([f"data: {json.dumps(part)}\n\n" for part in parts])

    return app


@pytest.fixture(scope="module")
def server() -> Iterator[str]:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    config = uvicorn.Config(mock_app(), host="127.0.0.1", port=port, log_level="error")
    instance = uvicorn.Server(config)
    thread = threading.Thread(target=instance.run, daemon=True)
    thread.start()
    for _ in range(100):
        if instance.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    instance.should_exit = True
    thread.join(timeout=5)


def collect(provider: Any, profile: Profile) -> tuple[str, list[dict[str, Any]]]:
    events = list(provider.stream(REQUEST, profile))
    return "".join(event["text"] for event in events if event["type"] == "text"), events


def test_claude_streams_text_usage_and_uses_default_fallbacks(server: str) -> None:
    provider = ClaudeProvider({"ANTHROPIC_API_KEY": "sk-test", "ANTHROPIC_BASE_URL": server})
    text, events = collect(provider, Profile("claude-main", "anthropic", "claude-opus-5", {"effort": "high"}))
    assert text == "Hello there"
    assert events[-2] == {"type": "usage", "input_tokens": 12, "output_tokens": 5}
    assert events[-1] == {"type": "done", "stop_reason": "end_turn"}
    seen = SEEN[-1]
    assert seen["body"]["system"] == "You are terse."
    assert [m["role"] for m in seen["body"]["messages"]] == ["user", "assistant", "user"]
    assert seen["body"]["fallbacks"] == "default"
    assert seen["body"]["output_config"] == {"effort": "high"}
    assert FALLBACK_BETA in seen["headers"]["anthropic-beta"]
    assert "temperature" not in seen["body"]


def test_claude_only_adds_fallbacks_for_supported_models(server: str) -> None:
    provider = ClaudeProvider({"ANTHROPIC_API_KEY": "sk-test", "ANTHROPIC_BASE_URL": server})
    collect(provider, Profile("sonnet", "anthropic", "claude-sonnet-5"))
    assert "fallbacks" not in SEEN[-1]["body"]


def test_claude_maps_auth_errors_and_refusals(server: str) -> None:
    provider = ClaudeProvider({"ANTHROPIC_API_KEY": "sk-test", "ANTHROPIC_BASE_URL": server})
    with pytest.raises(ProviderError) as auth:
        collect(provider, Profile("x", "anthropic", "bad-key"))
    assert auth.value.kind == "auth"
    with pytest.raises(ProviderError) as refusal:
        collect(provider, Profile("x", "anthropic", "refuse"))
    assert refusal.value.kind == "refusal"
    assert not ClaudeProvider({}).health().configured


def test_openai_streams_through_chat_completions(server: str) -> None:
    provider = openai_provider({"OPENAI_API_KEY": "sk-test", "OPENAI_BASE_URL": f"{server}/v1"})
    text, events = collect(provider, Profile("gpt", "openai", "some-model"))
    assert text == "Hello"
    assert events[-2:] == [{"type": "usage", "input_tokens": 9, "output_tokens": 3}, {"type": "done", "stop_reason": "stop"}]
    body = SEEN[-1]["body"]
    assert body["messages"][0] == {"role": "system", "content": "You are terse."}
    assert body["max_completion_tokens"] == 64
    assert body["stream_options"] == {"include_usage": True}


def test_openai_compatible_host_needs_only_a_base_url(server: str) -> None:
    provider = compat_provider({"OISIN_COMPAT_BASE_URL": f"{server}/v1"})
    assert provider.health().configured
    text, _ = collect(provider, Profile("open", "openai_compat", "open-model"))
    assert text == "Hello"
    assert SEEN[-1]["body"]["max_tokens"] == 64
    with pytest.raises(ProviderError) as busy:
        collect(provider, Profile("open", "openai_compat", "busy"))
    assert busy.value.kind == "rate_limit"
    with pytest.raises(ProviderError) as missing:
        collect(provider, Profile("open", "openai_compat", ""))
    assert missing.value.kind == "bad_request"
    assert not compat_provider({}).health().configured


def test_gemini_streams_and_maps_roles(server: str) -> None:
    provider = GeminiProvider({"GEMINI_API_KEY": "key", "GEMINI_BASE_URL": server})
    text, events = collect(provider, Profile("gem", "gemini", "gemini-test"))
    assert text == "Hello"
    assert events[-2] == {"type": "usage", "input_tokens": 7, "output_tokens": 2}
    seen = SEEN[-1]
    assert seen["path"] == "gemini-test:streamGenerateContent"
    assert [c["role"] for c in seen["body"]["contents"]] == ["user", "model", "user"]
    assert seen["body"]["systemInstruction"]["parts"][0]["text"] == "You are terse."


def test_gemini_maps_errors_and_safety_stops(server: str) -> None:
    provider = GeminiProvider({"GEMINI_API_KEY": "key", "GEMINI_BASE_URL": server})
    with pytest.raises(ProviderError) as auth:
        collect(provider, Profile("gem", "gemini", "bad-key"))
    assert auth.value.kind == "auth"
    with pytest.raises(ProviderError) as safety:
        collect(provider, Profile("gem", "gemini", "unsafe"))
    assert safety.value.kind == "refusal"


def test_local_provider_reports_why_it_is_unavailable() -> None:
    no_torch = LocalHFProvider(lambda: {"state": "ready", "installed": False, "cuda_available": False, "error": None})
    assert no_torch.health().detail == "PyTorch not installed"
    with pytest.raises(ProviderError) as error:
        list(no_torch.stream(REQUEST, Profile("qwen", "local_hf", "")))
    assert error.value.kind == "unavailable"
    assert no_torch.loaded_models() == []
