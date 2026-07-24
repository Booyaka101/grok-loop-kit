"""grok-loop-kit: automatic Grok 4.5 context compaction for xAI Responses API agent loops."""

from .async_client import AsyncGrokLoopClient
from .client import (
    CompactionEvent,
    CompletionWithMeta,
    GrokLoopClient,
    GrokLoopKitMeta,
    build_compacted_transcript,
    extract_assistant_text,
    extract_compaction_text,
)

__all__ = [
    "GrokLoopClient",
    "AsyncGrokLoopClient",
    "CompletionWithMeta",
    "CompactionEvent",
    "GrokLoopKitMeta",
    "build_compacted_transcript",
    "extract_assistant_text",
    "extract_compaction_text",
]

__version__ = "1.0.0"
