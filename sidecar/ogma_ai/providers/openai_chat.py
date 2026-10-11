"""OpenAI Chat Completions adapter, using the official `openai` SDK.

Serves two providers: OpenAI itself, and "openai_compat" — any host with an
OpenAI-style API (OpenRouter, privacy-focused open-model hosts, or a local
server), selected by base URL.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from typing import Any

import openai

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

# The app runs tools only on the neutral "tool_use" stop reason.
FINISH_REASONS = {"tool_calls": "tool_use"}


def to_openai(message: ChatMessage) -> list[dict[str, Any]]:
    """A neutral message as Chat Completions messages: tool calls ride on the assistant
    message, and each tool result is its own "tool" message."""
    if isinstance(message.content, str):
        return [{"role": message.role, "content": message.content}]
    blocks = blocks_of(message)
    text = "".join(str(block.get("text", "")) for block in blocks if block.get("type") == "text")
    if message.role == "assistant":
        calls = [
            {"id": block["id"], "type": "function", "function": {"name": block["name"], "arguments": json.dumps(block.get("input") or {})}}
            for block in blocks
            if block.get("type") == "tool_call"
        ]
        out: dict[str, Any] = {"role": "assistant", "content": text or None}
        if calls:
            out["tool_calls"] = calls
        return [out]
    messages: list[dict[str, Any]] = [
        {"role": "tool", "tool_call_id": block["tool_call_id"], "content": str(block.get("content", ""))}
        for block in blocks
        if block.get("type") == "tool_result"
    ]
    if text:
        messages.append({"role": "user", "content": text})
    return messages


class OpenAIChatProvider:
    kind = "cloud"
    supports_tools = True

    def __init__(
        self,
        env: Mapping[str, str],
        *,
        provider_id: str,
        label: str,
        key_env: str,
        base_url_env: str,
        require_base_url: bool,
        token_parameter: str,
    ) -> None:
        self.id = provider_id
        self.label = label
        self._api_key = env.get(key_env) or None
        self._base_url = env.get(base_url_env) or None
        self._key_env = key_env
        self._base_url_env = base_url_env
        self._require_base_url = require_base_url
        # OpenAI's own API uses max_completion_tokens; most compatible hosts still expect max_tokens.
        self._token_parameter = token_parameter

    def health(self) -> ProviderHealth:
        if self._require_base_url and not self._base_url:
            return ProviderHealth(False, "no base URL")
        if not self._require_base_url and not self._api_key:
            return ProviderHealth(False, "no API key")
        return ProviderHealth(True)

    def stream(self, request: GenerateRequest, profile: Profile) -> Iterator[StreamEvent]:
        health = self.health()
        if not health.configured:
            raise ProviderError("auth", f"{self.label} is not configured ({health.detail}).")
        if not profile.model:
            raise ProviderError("bad_request", f"Profile “{profile.id}” has no model name.")
        # Compatible hosts often need no key; the SDK still requires a non-empty string.
        client = openai.OpenAI(api_key=self._api_key or "not-needed", base_url=profile.params.get("base_url") or self._base_url)
        messages = [{"role": "system", "content": request.system}] if request.system else []
        for message in request.messages:
            messages += to_openai(message)
        params: dict = {
            "model": profile.model,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
            self._token_parameter: request.max_tokens,
        }
        if request.temperature is not None:
            params["temperature"] = request.temperature
        if request.tools:
            params["tools"] = [
                {"type": "function", "function": {"name": tool.name, "description": tool.description, "parameters": tool.input_schema}}
                for tool in request.tools
            ]
        # Streamed tool calls arrive in fragments, keyed by index.
        calls: dict[int, dict[str, str]] = {}

        stop_reason: str | None = None
        usage: tuple[int | None, int | None] = (None, None)
        try:
            stream = client.chat.completions.create(**params)
            try:
                for chunk in stream:
                    if chunk.choices:
                        choice = chunk.choices[0]
                        if choice.delta is not None and choice.delta.content:
                            yield text_event(choice.delta.content)
                        for fragment in (choice.delta.tool_calls if choice.delta is not None else None) or []:
                            call = calls.setdefault(fragment.index, {"id": "", "name": "", "arguments": ""})
                            if fragment.id:
                                call["id"] = fragment.id
                            if fragment.function is not None:
                                call["name"] += fragment.function.name or ""
                                call["arguments"] += fragment.function.arguments or ""
                        if choice.finish_reason:
                            stop_reason = choice.finish_reason
                    if chunk.usage is not None:
                        usage = (chunk.usage.prompt_tokens, chunk.usage.completion_tokens)
            finally:
                stream.close()
        except openai.APIStatusError as error:
            raise ProviderError(status_kind(error.status_code, str(error.message)), str(error.message)) from error
        except (openai.APIConnectionError, openai.APITimeoutError) as error:
            raise ProviderError("unavailable", f"Could not reach {self.label}: {error}") from error

        if stop_reason == "content_filter":
            raise ProviderError("refusal", f"{self.label} filtered this response.")
        for index in sorted(calls):
            call = calls[index]
            try:
                parsed = json.loads(call["arguments"] or "{}")
                yield tool_call_event(call["id"] or f"call_{index}", call["name"], parsed if isinstance(parsed, dict) else {})
            except json.JSONDecodeError:
                # Handed to the app, which answers it with an error result instead of running it.
                yield tool_call_event(call["id"] or f"call_{index}", call["name"], {}, call["arguments"])
        yield usage_event(*usage)
        yield done_event(FINISH_REASONS.get(stop_reason or "", stop_reason))


def openai_provider(env: Mapping[str, str]) -> OpenAIChatProvider:
    return OpenAIChatProvider(
        env,
        provider_id="openai",
        label="OpenAI",
        key_env="OPENAI_API_KEY",
        base_url_env="OPENAI_BASE_URL",
        require_base_url=False,
        token_parameter="max_completion_tokens",
    )


def compat_provider(env: Mapping[str, str]) -> OpenAIChatProvider:
    return OpenAIChatProvider(
        env,
        provider_id="openai_compat",
        label="OpenAI-compatible",
        key_env="OGMA_COMPAT_API_KEY",
        base_url_env="OGMA_COMPAT_BASE_URL",
        require_base_url=True,
        token_parameter="max_tokens",
    )
