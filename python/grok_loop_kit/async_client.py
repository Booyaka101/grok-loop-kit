"""
AsyncGrokLoopClient — an asyncio-friendly facade over GrokLoopClient.

Zero extra dependencies: each network-bound call runs the synchronous client in
a worker thread via ``asyncio.to_thread``, so it never blocks the event loop.
State (messages, turn_count, compaction counters) lives on the wrapped sync
client and is exposed here as read-through properties.

Note: like the sync client, a single instance is not safe to drive with
concurrent overlapping calls — its transcript is shared mutable state. Use one
client per conversation.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Dict, List, Optional

from .client import CompletionWithMeta, GrokLoopClient


class AsyncGrokLoopClient:
    def __init__(self, api_key: str, **kwargs: Any) -> None:
        self._c = GrokLoopClient(api_key, **kwargs)

    # --- async API ---

    async def send_message(
        self, user_content: str, tools: Optional[List[Dict[str, Any]]] = None
    ) -> CompletionWithMeta:
        return await asyncio.to_thread(self._c.send_message, user_content, tools)

    async def send_tool_outputs(
        self, outputs: List[Dict[str, str]], tools: Optional[List[Dict[str, Any]]] = None
    ) -> CompletionWithMeta:
        return await asyncio.to_thread(self._c.send_tool_outputs, outputs, tools)

    async def stream_message(
        self,
        user_content: str,
        tools: Optional[List[Dict[str, Any]]] = None,
        on_token: Optional[Callable[[str], None]] = None,
    ) -> CompletionWithMeta:
        # The sync generator yields tokens as they arrive; on_token fires from the
        # worker thread in real time. Returns the assembled final completion.
        return await asyncio.to_thread(self._c.stream_message, user_content, tools, on_token)

    async def compact(self) -> Dict[str, Any]:
        return await asyncio.to_thread(self._c.compact)

    # --- passthroughs ---

    def get_tool_calls(self, completion: Dict[str, Any]) -> List[Dict[str, Any]]:
        return self._c.get_tool_calls(completion)

    def reset(self) -> None:
        self._c.reset()

    def get_state(self) -> Dict[str, Any]:
        return self._c.get_state()

    def load_state(self, state: Dict[str, Any]) -> None:
        self._c.load_state(state)

    @property
    def messages(self) -> List[Dict[str, Any]]:
        return self._c.messages

    @property
    def turn_count(self) -> int:
        return self._c.turn_count

    @property
    def total_compactions(self) -> int:
        return self._c.total_compactions

    @property
    def accumulated_tokens(self) -> int:
        return self._c.accumulated_tokens

    @property
    def estimated_tokens_saved(self) -> int:
        return self._c.estimated_tokens_saved

    @property
    def sync(self) -> GrokLoopClient:
        """Access the underlying synchronous client."""
        return self._c
