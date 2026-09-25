"""OpenAI Chat Completions adapter, using the official `openai` SDK.

Serves two providers: OpenAI itself, and "openai_compat" — any host with an
OpenAI-style API (OpenRouter, privacy-focused open-model hosts, or a local
server), selected by base URL.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping

import openai

from ..ai_types import (
    GenerateRequest,
    Profile,
    ProviderError,
    ProviderHealth,
    StreamEvent,
    done_event,
    status_kind,
    text_event,
    usage_event,
)


class OpenAIChatProvider:
    kind = "cloud"

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
        messages += [{"role": message.role, "content": message.content} for message in request.messages]
        params: dict = {
            "model": profile.model,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
            self._token_parameter: request.max_tokens,
        }
        if request.temperature is not None:
            params["temperature"] = request.temperature

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
        yield usage_event(*usage)
        yield done_event(stop_reason)


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
        key_env="OISIN_COMPAT_API_KEY",
        base_url_env="OISIN_COMPAT_BASE_URL",
        require_base_url=True,
        token_parameter="max_tokens",
    )
