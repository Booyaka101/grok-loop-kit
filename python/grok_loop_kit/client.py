"""
GrokLoopClient — a thin wrapper over xAI's Responses API that transparently
applies Grok 4.5 context compaction inside an agent loop.

Mirrors the TypeScript implementation. Uses only the standard library
(urllib) so it has no runtime dependencies.

Docs:
  https://docs.x.ai/developers/grok-4-5
  https://docs.x.ai/developers/advanced-api-usage/context-compaction
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

InputItem = Dict[str, Any]
Tool = Dict[str, Any]

DEFAULT_COMPACT_EVERY = 8
DEFAULT_COMPACT_AT_TOKENS = 8000
DEFAULT_MODEL = "grok-4.5"
DEFAULT_BASE_URL = "https://api.x.ai/v1"
DEFAULT_MAX_RETRIES = 2
DEFAULT_RETRY_BASE_MS = 500
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


@dataclass
class GrokLoopKitMeta:
    """Bookkeeping attached to every completion GrokLoopClient returns."""

    turnsSinceCompact: int
    estimatedTokensSaved: int
    totalCompactions: int

    def as_dict(self) -> Dict[str, int]:
        return {
            "turnsSinceCompact": self.turnsSinceCompact,
            "estimatedTokensSaved": self.estimatedTokensSaved,
            "totalCompactions": self.totalCompactions,
        }


@dataclass
class CompactionEvent:
    """Details passed to the ``on_compact`` hook each time a compaction runs."""

    totalCompactions: int
    estimatedTokensSaved: int
    droppedMessageCount: int
    atTurn: int
    compaction: Dict[str, Any]


@dataclass
class CompletionWithMeta:
    """A raw Responses API completion plus grok-loop-kit bookkeeping."""

    raw: Dict[str, Any]
    _grokLoopKit: GrokLoopKitMeta

    @property
    def output(self) -> Any:
        return self.raw.get("output")

    @property
    def usage(self) -> Dict[str, Any]:
        return self.raw.get("usage", {})

    def tool_calls(self) -> List[Dict[str, Any]]:
        return [i for i in (self.raw.get("output") or []) if i.get("type") == "function_call"]

    def __getitem__(self, key: str) -> Any:
        if key == "_grokLoopKit":
            return self._grokLoopKit
        return self.raw[key]


# A pluggable HTTP POST returning (parsed_json). Signature:
#   (base_url, path, body, api_key, headers, timeout) -> dict
Poster = Callable[..., Dict[str, Any]]


class _RetryableHTTP(Exception):
    def __init__(self, status: int, retry_after: Optional[str], detail: str):
        super().__init__(detail)
        self.status = status
        self.retry_after = retry_after
        self.detail = detail


def _default_post(base_url, path, body, api_key, headers=None, timeout=None):
    data = json.dumps(body).encode("utf-8")
    hdrs = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(f"{base_url}{path}", data=data, method="POST", headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        if exc.code in RETRYABLE_STATUS:
            raise _RetryableHTTP(exc.code, exc.headers.get("retry-after"), detail) from exc
        raise RuntimeError(f"grok-loop-kit: POST {path} failed {exc.code}: {detail}") from exc


def _default_stream(base_url, path, body, api_key, headers=None, timeout=None):
    """POST with stream:true and yield parsed SSE event dicts as they arrive."""
    data = json.dumps({**body, "stream": True}).encode("utf-8")
    hdrs = {
        "content-type": "application/json",
        "accept": "text/event-stream",
        "authorization": f"Bearer {api_key}",
    }
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(f"{base_url}{path}", data=data, method="POST", headers=hdrs)
    resp = urllib.request.urlopen(req, timeout=timeout)  # noqa: S310
    try:
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                continue
    finally:
        resp.close()


class GrokLoopClient:
    """Auto-compacting client for xAI Responses API agent loops."""

    def __init__(
        self,
        api_key: str,
        *,
        compact_every: int = DEFAULT_COMPACT_EVERY,
        compact_at_tokens: int = DEFAULT_COMPACT_AT_TOKENS,
        model: str = DEFAULT_MODEL,
        base_url: str = DEFAULT_BASE_URL,
        instructions: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_base_ms: int = DEFAULT_RETRY_BASE_MS,
        on_compact: Optional[Callable[[CompactionEvent], None]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        poster: Optional[Poster] = None,
        stream_poster: Optional[Callable[..., Any]] = None,
    ) -> None:
        if not api_key:
            raise ValueError("grok-loop-kit: api_key is required")
        if compact_every < 1:
            raise ValueError("grok-loop-kit: compact_every must be >= 1")

        self.api_key = api_key
        self.compact_every = compact_every
        self.compact_at_tokens = compact_at_tokens
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.instructions = instructions
        self.headers = headers or {}
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_base_ms = retry_base_ms
        self.on_compact = on_compact
        self.extra_body = extra_body or {}
        self._post_impl: Poster = poster or _default_post
        self._stream_impl = stream_poster or _default_stream

        # State.
        self.messages: List[InputItem] = []
        self.turn_count = 0
        self.accumulated_tokens = 0
        self.turns_since_compact = 0
        self.total_compactions = 0
        self.estimated_tokens_saved = 0
        self._last_input_tokens = 0

    def send_message(
        self, user_content: str, tools: Optional[List[Tool]] = None
    ) -> CompletionWithMeta:
        """Send a user turn through the loop, auto-compacting when due."""
        self.messages.append({"role": "user", "content": user_content})
        return self._run_turn(tools)

    def send_tool_outputs(
        self, outputs: List[Dict[str, str]], tools: Optional[List[Tool]] = None
    ) -> CompletionWithMeta:
        """Submit tool-call results and continue the loop (counts as a turn)."""
        for o in outputs:
            self.messages.append(
                {"type": "function_call_output", "call_id": o["call_id"], "output": o["output"]}
            )
        return self._run_turn(tools)

    def stream_message(
        self,
        user_content: str,
        tools: Optional[List[Tool]] = None,
        on_token: Optional[Callable[[str], None]] = None,
    ) -> CompletionWithMeta:
        """Stream a user turn: deltas go to ``on_token``; returns the final completion."""
        self.messages.append({"role": "user", "content": user_content})
        self.turn_count += 1
        self.turns_since_compact += 1

        body: Dict[str, Any] = {"model": self.model, "input": self.messages}
        if self.instructions:
            body["instructions"] = self.instructions
        if tools:
            body["tools"] = tools
        body.update(self.extra_body)

        text_parts: List[str] = []
        final: Optional[Dict[str, Any]] = None
        for ev in self._stream_impl(
            self.base_url, "/responses", body, self.api_key, self.headers, self.timeout
        ):
            t = ev.get("type", "")
            if t.endswith("output_text.delta") and isinstance(ev.get("delta"), str):
                text_parts.append(ev["delta"])
                if on_token:
                    on_token(ev["delta"])
            elif t == "response.completed" and ev.get("response"):
                final = ev["response"]

        completion = final or {
            "object": "response",
            "status": "completed",
            "model": self.model,
            "output": [
                {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "".join(text_parts)}]}
            ],
            "usage": {},
        }
        return self._finalize_turn(completion)

    def get_tool_calls(self, completion: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Extract ``function_call`` items from a completion's output."""
        return [i for i in (completion.get("output") or []) if i.get("type") == "function_call"]

    def reset(self) -> None:
        """Clear all loop state (transcript and counters), keeping configuration."""
        self.messages = []
        self.turn_count = 0
        self.accumulated_tokens = 0
        self.turns_since_compact = 0
        self.total_compactions = 0
        self.estimated_tokens_saved = 0
        self._last_input_tokens = 0

    def get_state(self) -> Dict[str, Any]:
        """Snapshot the loop state for persistence (JSON-serializable)."""
        return {
            "version": 1,
            "messages": self.messages,
            "turn_count": self.turn_count,
            "accumulated_tokens": self.accumulated_tokens,
            "turns_since_compact": self.turns_since_compact,
            "total_compactions": self.total_compactions,
            "estimated_tokens_saved": self.estimated_tokens_saved,
            "last_input_tokens": self._last_input_tokens,
        }

    def load_state(self, state: Dict[str, Any]) -> None:
        """Restore loop state produced by ``get_state()``."""
        if state.get("version") != 1:
            raise ValueError(f"grok-loop-kit: unsupported state version {state.get('version')}")
        self.messages = state.get("messages", [])
        self.turn_count = state.get("turn_count", 0)
        self.accumulated_tokens = state.get("accumulated_tokens", 0)
        self.turns_since_compact = state.get("turns_since_compact", 0)
        self.total_compactions = state.get("total_compactions", 0)
        self.estimated_tokens_saved = state.get("estimated_tokens_saved", 0)
        self._last_input_tokens = state.get("last_input_tokens", 0)

    def compact(self) -> Dict[str, Any]:
        """Fold the current transcript into a compaction item."""
        compaction = self._post_compact(self.messages)
        usage = compaction.get("usage") or {}
        dropped = usage.get("dropped_message_count", len(self.messages))

        # Per xAI docs: usage.input_tokens = pre-compaction conversation tokens,
        # usage.output_tokens = compacted record size. Removed = input - output.
        pre_tokens = usage.get("input_tokens", self._last_input_tokens)
        compacted_record_tokens = usage.get("output_tokens", 0)
        self.estimated_tokens_saved += max(0, pre_tokens - compacted_record_tokens)
        # Reuse the compaction result the way the API expects: verbatim items.
        self.messages = build_compacted_transcript(compaction)
        self.accumulated_tokens = 0
        self.turns_since_compact = 0
        self.total_compactions += 1

        if self.on_compact:
            self.on_compact(
                CompactionEvent(
                    totalCompactions=self.total_compactions,
                    estimatedTokensSaved=self.estimated_tokens_saved,
                    droppedMessageCount=dropped,
                    atTurn=self.turn_count,
                    compaction=compaction,
                )
            )
        return compaction

    # --- internal ---

    def _run_turn(self, tools: Optional[List[Tool]]) -> CompletionWithMeta:
        self.turn_count += 1
        self.turns_since_compact += 1
        completion = self._post_responses(self.messages, tools)
        return self._finalize_turn(completion)

    def _finalize_turn(self, completion: Dict[str, Any]) -> CompletionWithMeta:
        """Shared post-completion bookkeeping: preserve output, tally tokens, compact."""
        # Preserve ALL output items verbatim (messages, reasoning, function_calls).
        output = completion.get("output")
        if isinstance(output, list) and output:
            self.messages.extend(output)

        # accumulated_tokens tracks the CURRENT rendered context size (what the
        # next request would send), per xAI's "rendered context above a threshold"
        # guidance — not a running sum. Resets to 0 when compaction shrinks context.
        usage = completion.get("usage") or {}
        in_tok = usage.get("input_tokens")
        if isinstance(in_tok, (int, float)):
            self._last_input_tokens = int(in_tok)
            self.accumulated_tokens = int(in_tok) + int(usage.get("output_tokens", 0))

        if (
            self.turn_count % self.compact_every == 0
            or self.accumulated_tokens > self.compact_at_tokens
        ):
            self.compact()

        return CompletionWithMeta(
            raw=completion,
            _grokLoopKit=GrokLoopKitMeta(
                turnsSinceCompact=self.turns_since_compact,
                estimatedTokensSaved=self.estimated_tokens_saved,
                totalCompactions=self.total_compactions,
            ),
        )

    def _post_responses(
        self, input_items: List[InputItem], tools: Optional[List[Tool]]
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"model": self.model, "input": input_items}
        if self.instructions:
            body["instructions"] = self.instructions
        if tools:
            body["tools"] = tools
        body.update(self.extra_body)
        return self._post("/responses", body)

    def _post_compact(self, input_items: List[InputItem]) -> Dict[str, Any]:
        return self._post("/responses/compact", {"model": self.model, "input": input_items})

    def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        attempt = 0
        while True:
            try:
                return self._post_impl(
                    self.base_url, path, body, self.api_key, self.headers, self.timeout
                )
            except _RetryableHTTP as exc:
                if attempt >= self.max_retries:
                    raise RuntimeError(
                        f"grok-loop-kit: POST {path} failed {exc.status}: {exc.detail}"
                    ) from exc
                time.sleep(self._backoff_s(attempt, exc.retry_after))
                attempt += 1
            except (urllib.error.URLError, TimeoutError):
                if attempt >= self.max_retries:
                    raise
                time.sleep(self._backoff_s(attempt, None))
                attempt += 1

    def _backoff_s(self, attempt: int, retry_after: Optional[str]) -> float:
        if retry_after is not None:
            try:
                return max(0.0, float(retry_after))
            except ValueError:
                pass
        return (self.retry_base_ms * (2 ** attempt)) / 1000.0


def extract_assistant_text(completion: Dict[str, Any]) -> str:
    """Pull the assistant's text out of a Responses API completion."""
    parts: List[str] = []
    for item in completion.get("output") or []:
        if item.get("type") != "message":
            continue
        for c in item.get("content") or []:
            text = c.get("text")
            if isinstance(text, str):
                parts.append(text)
            elif c.get("type") == "refusal" and isinstance(c.get("refusal"), str):
                parts.append(c["refusal"])
    return "".join(parts)


def extract_compaction_text(compaction: Dict[str, Any]) -> str:
    """
    Pull the compacted text out of a compaction reply. The real API returns an
    array of items with ``encrypted_content``; mocks/gateways may return a str.
    """
    out = compaction.get("output")
    if isinstance(out, str):
        return out
    if isinstance(out, list):
        parts: List[str] = []
        for item in out:
            enc = item.get("encrypted_content")
            if isinstance(enc, str):
                parts.append(enc)
            for c in item.get("content") or []:
                text = c.get("text")
                if isinstance(text, str):
                    parts.append(text)
        if parts:
            return "".join(parts)
    return "[COMPACTED]"


def build_compacted_transcript(compaction: Dict[str, Any]) -> List[InputItem]:
    """
    Build the post-compaction transcript. Per xAI docs, compaction ``output``
    items are spread back into ``input`` verbatim. Gateways/mocks that return a
    plain string become a single user message.
    """
    out = compaction.get("output")
    if isinstance(out, list) and out:
        return list(out)
    text = out if isinstance(out, str) else extract_compaction_text(compaction)
    return [{"role": "user", "content": text}]
