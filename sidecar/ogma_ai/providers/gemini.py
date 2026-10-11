"""Google Gemini adapter, using the official `google-genai` SDK."""

from __future__ import annotations

from collections.abc import Iterator, Mapping

from google import genai
from google.genai import errors, types

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

REFUSAL_REASONS = {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"}


class GeminiProvider:
    id = "gemini"
    label = "Google Gemini"
    kind = "cloud"

    def __init__(self, env: Mapping[str, str]) -> None:
        self._api_key = env.get("GEMINI_API_KEY") or env.get("GOOGLE_API_KEY") or None
        self._base_url = env.get("GEMINI_BASE_URL") or None

    def health(self) -> ProviderHealth:
        return ProviderHealth(bool(self._api_key), None if self._api_key else "no API key")

    def stream(self, request: GenerateRequest, profile: Profile) -> Iterator[StreamEvent]:
        if not self._api_key:
            raise ProviderError("auth", "No Gemini API key is configured.")
        if not profile.model:
            raise ProviderError("bad_request", f"Profile “{profile.id}” has no model name.")
        http_options = types.HttpOptions(base_url=self._base_url) if self._base_url else None
        client = genai.Client(api_key=self._api_key, http_options=http_options)
        contents = [
            types.Content(role="user" if message.role == "user" else "model", parts=[types.Part(text=message.content)])
            for message in request.messages
        ]
        config = types.GenerateContentConfig(
            system_instruction=request.system or None,
            max_output_tokens=request.max_tokens,
            temperature=request.temperature,
        )

        stop_reason: str | None = None
        usage: tuple[int | None, int | None] = (None, None)
        try:
            for chunk in client.models.generate_content_stream(model=profile.model, contents=contents, config=config):
                for candidate in chunk.candidates or []:
                    for part in (candidate.content.parts if candidate.content else None) or []:
                        if part.text and not part.thought:
                            yield text_event(part.text)
                    if candidate.finish_reason:
                        stop_reason = str(getattr(candidate.finish_reason, "value", candidate.finish_reason))
                if chunk.usage_metadata is not None:
                    usage = (chunk.usage_metadata.prompt_token_count, chunk.usage_metadata.candidates_token_count)
        except errors.APIError as error:
            code = error.code if isinstance(error.code, int) else 500
            raise ProviderError(status_kind(code, str(error.message)), str(error.message or error)) from error
        except OSError as error:
            raise ProviderError("unavailable", f"Could not reach Gemini: {error}") from error

        if stop_reason in REFUSAL_REASONS:
            raise ProviderError("refusal", f"Gemini stopped for {stop_reason.lower()}.")
        yield usage_event(*usage)
        yield done_event(stop_reason)
