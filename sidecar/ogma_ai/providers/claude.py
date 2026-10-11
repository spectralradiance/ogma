"""Anthropic (Claude) adapter, using the official `anthropic` SDK."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

import anthropic

from ..ai_types import (
    ChatMessage,
    GenerateRequest,
    Profile,
    ProviderError,
    ProviderHealth,
    StreamEvent,
    blocks_of,
    done_event,
    status_kind,
    text_event,
    tool_call_event,
    usage_event,
)

DEFAULT_MODEL = "claude-opus-5"
# Models where Anthropic recommends server-side refusal fallbacks by default.
FALLBACK_MODELS = {"claude-opus-5", "claude-fable-5-1"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"


def to_anthropic(message: ChatMessage) -> dict[str, Any]:
    """A neutral message in the Messages API's shape. An assistant turn Claude produced is
    replayed exactly as it came back (thinking blocks included), as the API requires."""
    if message.native and message.native.get("provider") == ClaudeProvider.id:
        return {"role": message.role, "content": message.native["content"]}
    if isinstance(message.content, str):
        return {"role": message.role, "content": message.content}
    content: list[dict[str, Any]] = []
    for block in blocks_of(message):
        kind = block.get("type")
        if kind == "text" and block.get("text"):
            content.append({"type": "text", "text": block["text"]})
        elif kind == "tool_call":
            content.append({"type": "tool_use", "id": block["id"], "name": block["name"], "input": block.get("input") or {}})
        elif kind == "tool_result":
            content.append({
                "type": "tool_result",
                "tool_use_id": block["tool_call_id"],
                "content": str(block.get("content", "")),
                "is_error": bool(block.get("is_error", False)),
            })
    return {"role": message.role, "content": content}


class ClaudeProvider:
    id = "anthropic"
    label = "Anthropic (Claude)"
    kind = "cloud"
    supports_tools = True

    def __init__(self, env: Mapping[str, str]) -> None:
        self._api_key = env.get("ANTHROPIC_API_KEY") or None
        self._base_url = env.get("ANTHROPIC_BASE_URL") or None

    def health(self) -> ProviderHealth:
        return ProviderHealth(bool(self._api_key), None if self._api_key else "no API key")

    def stream(self, request: GenerateRequest, profile: Profile) -> Iterator[StreamEvent]:
        if not self._api_key:
            raise ProviderError("auth", "No Anthropic API key is configured.")
        client = anthropic.Anthropic(api_key=self._api_key, base_url=self._base_url)
        model = profile.model or DEFAULT_MODEL
        params: dict = {
            "model": model,
            "max_tokens": request.max_tokens,
            "messages": [to_anthropic(message) for message in request.messages],
        }
        if request.tools:
            # Tool inputs are only used once the turn is complete, so they are left buffered
            # (no eager_input_streaming) and the API validates them against the schema.
            params["tools"] = [
                {"name": tool.name, "description": tool.description, "input_schema": tool.input_schema} for tool in request.tools
            ]
        if request.system:
            params["system"] = request.system
        # Current Claude models reject sampling parameters; depth is set with effort instead.
        if profile.params.get("effort"):
            params["output_config"] = {"effort": profile.params["effort"]}
        if model in FALLBACK_MODELS and profile.params.get("fallbacks", True):
            params["extra_headers"] = {"anthropic-beta": FALLBACK_BETA}
            params["extra_body"] = {"fallbacks": "default"}

        try:
            with client.messages.stream(**params) as stream:
                for text in stream.text_stream:
                    yield text_event(text)
                final = stream.get_final_message()
        except anthropic.APIStatusError as error:
            raise ProviderError(status_kind(error.status_code, str(error.message)), str(error.message)) from error
        except (anthropic.APIConnectionError, anthropic.APITimeoutError) as error:
            raise ProviderError("unavailable", f"Could not reach Anthropic: {error}") from error

        if final.stop_reason == "refusal":
            raise ProviderError("refusal", "Claude declined this request.")
        if request.tools:
            # A turn cut off at max_tokens may hold a truncated tool call; the app only runs
            # tools when the stop reason is "tool_use".
            for block in final.content:
                if block.type == "tool_use":
                    yield tool_call_event(block.id, block.name, dict(block.input) if isinstance(block.input, dict) else {})
            yield {"type": "assistant_message", "provider": self.id, "content": [block.to_dict() for block in final.content]}
        yield usage_event(final.usage.input_tokens, final.usage.output_tokens)
        yield done_event(final.stop_reason)
