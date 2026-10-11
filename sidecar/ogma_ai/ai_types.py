"""Vendor-neutral request, profile, event and error types (PLAN.md §2a).

Features never see a vendor SDK: they send a GenerateRequest, and every
provider streams back the same small set of JSON-ready events:

  {"type": "text", "text": "..."}
  {"type": "usage", "input_tokens": int | None, "output_tokens": int | None}
  {"type": "done", "stop_reason": str | None}

With tools, a run can also stream:

  {"type": "tool_call", "id": str, "name": str, "input": dict}
  {"type": "assistant_message", "provider": str, "content": list}

and ends with stop_reason "tool_use". The app runs the tools and starts the next
run with the results; the sidecar keeps no state between runs. The
assistant_message event is the turn in the provider's own format (for Claude,
including thinking blocks), which the app hands back unchanged on the next run
so the model sees exactly what it produced.

Message content is either a string or a list of neutral blocks:

  {"type": "text", "text": str}
  {"type": "tool_call", "id": str, "name": str, "input": dict}
  {"type": "tool_result", "tool_call_id": str, "content": str, "is_error": bool}

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


ContentBlock = dict[str, Any]


@dataclass(frozen=True)
class ChatMessage:
    role: Role
    content: str | tuple[ContentBlock, ...]
    # The provider's own form of an assistant turn, replayed as-is to that provider.
    native: dict[str, Any] | None = None


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class GenerateRequest:
    system: str
    messages: tuple[ChatMessage, ...]
    max_tokens: int = 4096
    temperature: float | None = None
    tools: tuple[ToolSpec, ...] = ()


def blocks_of(message: ChatMessage) -> tuple[ContentBlock, ...]:
    """A message's content as neutral blocks."""
    if isinstance(message.content, str):
        return ({"type": "text", "text": message.content},) if message.content else ()
    return message.content


def plain_text(message: ChatMessage) -> str:
    """A message flattened to text, for providers without tool support."""
    if isinstance(message.content, str):
        return message.content
    parts: list[str] = []
    for block in message.content:
        if block.get("type") == "text":
            parts.append(str(block.get("text", "")))
        elif block.get("type") == "tool_result":
            parts.append(str(block.get("content", "")))
    return "\n\n".join(part for part in parts if part)


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
    # Whether the adapter can pass tools to the model (agent mode).
    supports_tools: bool

    def health(self) -> ProviderHealth: ...

    def stream(self, request: GenerateRequest, profile: Profile) -> Iterator[StreamEvent]: ...


def text_event(text: str) -> StreamEvent:
    return {"type": "text", "text": text}


def usage_event(input_tokens: int | None, output_tokens: int | None) -> StreamEvent:
    return {"type": "usage", "input_tokens": input_tokens, "output_tokens": output_tokens}


def done_event(stop_reason: str | None) -> StreamEvent:
    return {"type": "done", "stop_reason": stop_reason}


def tool_call_event(call_id: str, name: str, tool_input: dict[str, Any], input_error: str | None = None) -> StreamEvent:
    event: StreamEvent = {"type": "tool_call", "id": call_id, "name": name, "input": tool_input}
    if input_error is not None:
        event["input_error"] = input_error
    return event


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
