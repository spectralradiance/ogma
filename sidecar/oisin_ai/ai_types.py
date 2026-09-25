"""Vendor-neutral request, profile, event and error types (PLAN.md §2a).

Features never see a vendor SDK: they send a GenerateRequest, and every
provider streams back the same small set of JSON-ready events:

  {"type": "text", "text": "..."}
  {"type": "usage", "input_tokens": int | None, "output_tokens": int | None}
  {"type": "done", "stop_reason": str | None}

Failures raise ProviderError with one of a fixed set of kinds, which the
router uses to decide whether to try the next profile.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Role = Literal["user", "assistant"]
ErrorKind = Literal["auth", "rate_limit", "context_too_long", "unavailable", "bad_request", "refusal"]
StreamEvent = dict[str, Any]


@dataclass(frozen=True)
class ChatMessage:
    role: Role
    content: str


@dataclass(frozen=True)
class GenerateRequest:
    system: str
    messages: tuple[ChatMessage, ...]
    max_tokens: int = 4096
    temperature: float | None = None


@dataclass(frozen=True)
class Profile:
    """A named choice of provider, model and parameters, e.g. "claude-main"."""

    id: str
    provider: str
    model: str
    params: dict[str, Any] = field(default_factory=dict)


class ProviderError(Exception):
    def __init__(self, kind: ErrorKind, message: str) -> None:
        super().__init__(message)
        self.kind: ErrorKind = kind
        self.message = message


@dataclass(frozen=True)
class ProviderHealth:
    configured: bool
    detail: str | None = None


class Provider(Protocol):
    id: str
    label: str
    kind: Literal["cloud", "local"]

    def health(self) -> ProviderHealth: ...

    def stream(self, request: GenerateRequest, profile: Profile) -> Iterator[StreamEvent]: ...


def text_event(text: str) -> StreamEvent:
    return {"type": "text", "text": text}


def usage_event(input_tokens: int | None, output_tokens: int | None) -> StreamEvent:
    return {"type": "usage", "input_tokens": input_tokens, "output_tokens": output_tokens}


def done_event(stop_reason: str | None) -> StreamEvent:
    return {"type": "done", "stop_reason": stop_reason}


def status_kind(status: int, message: str = "") -> ErrorKind:
    """Maps an HTTP status (and error text) to an error kind."""
    lowered = message.lower()
    if status in (401, 403):
        return "auth"
    if status == 429:
        return "rate_limit"
    if status == 413 or (status == 400 and ("context" in lowered or "too long" in lowered or "token" in lowered and "limit" in lowered)):
        return "context_too_long"
    if status >= 500 or status in (408, 409):
        return "unavailable"
    return "bad_request"
