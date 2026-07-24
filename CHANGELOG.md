# Changelog

## 1.0.0

First stable release.

- **Native LangChain/LangGraph adapter.** `GrokLoopChatModel` now extends
  `BaseChatModel` (not `ChatOpenAI`) — so it never touches the OpenAI SDK and
  survives `bindTools`/`withConfig`, which on LangChain 1.x clone-and-drop a
  `ChatOpenAI` subclass. Bidirectional message mapping (AIMessage `tool_calls`
  ↔ `function_call` items, ToolMessage ↔ `function_call_output`), tool calls
  parsed onto the returned `AIMessage.tool_calls`, `bindTools` with JSON-schema/
  LangChain tools, and history compaction. Verified end-to-end against a real
  `createReactAgent` tool loop. Works on `@langchain/core` 0.3 and 1.x;
  `@langchain/openai` is no longer required.
- **State persistence**: `getState()` / `loadState()` (Node) and `get_state()` /
  `load_state()` (Python) to snapshot and resume a conversation across processes;
  `reset()` to clear and reuse a client.
- **Per-call controls**: `AbortSignal` (combined with `timeoutMs`) and `extraBody`
  passthrough (temperature, max_output_tokens, …) at construction or per call.
- **Edge cases hardened**: refusal content surfaced as text, reasoning items
  preserved verbatim in the transcript, `incomplete` status passed through.
- Added CI (Node 18/20/22 + Python 3.8/3.11/3.12), 25 Node + 16 Python tests.

## 0.1.0

Initial release.

- `GrokLoopClient` (Node/TS + Python): auto-compaction for xAI Responses API
  agent loops — compacts every `compactEvery` turns or when accumulated tokens
  exceed `compactAtTokens`.
- Verbatim compaction reuse: compaction `output` items are spread back into the
  next request's `input` unmodified, exactly as the xAI docs require. Plain-string
  compaction replies (mocks/gateways) collapse to a single user message.
- Tool-calling loops: assistant output items (incl. `function_call`) are preserved
  verbatim; `getToolCalls()` / `sendToolOutputs()` thread tool results back.
- Resilience: retry with exponential backoff on 429/5xx/network errors (honors
  `Retry-After`), per-request timeout, custom headers.
- Streaming: `streamMessage` (Node) / `stream_message` (Python) parse the SSE
  event stream, deliver text deltas to an `onToken`/`on_token` callback, and
  compact on the same schedule.
- Async Python: `AsyncGrokLoopClient` — non-blocking asyncio facade (send, tool
  outputs, stream, compact), zero extra dependencies.
- `onCompact` hook with drop count, turn, and cumulative savings.
- `_grokLoopKit` bookkeeping on every completion:
  `{ turnsSinceCompact, estimatedTokensSaved, totalCompactions }`.
- `compactAtTokens` compares against the **current rendered context size** (last
  completion's input+output tokens), per xAI's "compact when rendered context is
  above a threshold" guidance — not a cumulative running sum (which fired far too
  eagerly on a 500K-context model). Surfaced by the live hard test.
- `estimatedTokensSaved` computed from the compaction reply's own `usage`
  (pre-compaction `input_tokens` − compacted-record `output_tokens`).
- Live hard test (`scripts/hardtest-live.mjs`): needle-retention through 4 real
  compactions, 22% cumulative-token savings vs a no-compaction control with
  identical recall, live tool round-trip, and live streaming — all verified 7/7.
- LangChain/LangGraph adapter: `GrokLoopChatModel extends ChatOpenAI`.
- Dual CJS + ESM builds with `.d.ts` types; Python package ships `py.typed`.
