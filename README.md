# grok-loop-kit

**Automatic [Grok 4.5 context compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction) for xAI Responses API agent loops.**

Long-running agents blow past the context window. xAI ships a compaction endpoint
(`POST /v1/responses/compact`) that folds a transcript into a compact record — but
you have to call it yourself, on the right cadence. `grok-loop-kit` is a drop-in
client that does it for you: it compacts **every N turns** or whenever accumulated
tokens cross a budget, and hands back the same completion object plus a small
bookkeeping field so you can see what it did.

Ships for **Node (CJS + ESM + types)** and **Python**, with a **LangChain/LangGraph**
chat-model adapter.

> Requires your own xAI API key (BYOK). Grok 4.5 is `$2 / $6` per 1M input/output
> tokens. This repo develops and tests entirely against a local mock — **no key or
> spend needed to build or run the tests.**

---

## Install

```bash
npm install grok-loop-kit          # Node
pip install grok-loop-kit          # Python (from ./python)
```

The LangChain adapter needs `@langchain/core` (an optional peer, `>=0.3 <2` — works
on both the 0.3 and 1.x lines). For LangGraph agents also install `@langchain/langgraph`:

```bash
npm install @langchain/core @langchain/langgraph
```

## Feature matrix

| | Node | Python |
|---|---|---|
| Auto-compaction (turns + token budget) | ✅ | ✅ |
| Verbatim `encrypted_content` reuse | ✅ | ✅ |
| Tool-calling loop (`sendToolOutputs`) | ✅ | ✅ |
| Streaming (SSE) | ✅ | ✅ |
| Retries + timeout + custom headers | ✅ | ✅ |
| `onCompact` hook | ✅ | ✅ |
| State persistence (`getState`/`loadState`) | ✅ | ✅ |
| Per-call abort signal / `extraBody` | ✅ | ✅ (`extra_body`) |
| asyncio client | — | ✅ (`AsyncGrokLoopClient`) |
| LangChain / LangGraph adapter | ✅ | — |

## Node usage

```ts
import { GrokLoopClient } from 'grok-loop-kit';

const client = new GrokLoopClient(process.env.XAI_API_KEY!, {
  compactEvery: 8,        // compact on every 8th turn (default)
  compactAtTokens: 8000,  // ...or when the CURRENT rendered context exceeds this (default)
  model: 'grok-4.5',      // default
});

for (const turn of userTurns) {
  const res = await client.sendMessage(turn, tools);
  console.log(res.output);              // raw xAI Responses API output
  console.log(res._grokLoopKit);        // { turnsSinceCompact, estimatedTokensSaved, totalCompactions }
}
```

`sendMessage(userContent, tools?)`:
1. appends the user message to the rolling transcript,
2. calls `POST /v1/responses` with the current messages (+ any tools),
3. if `turnCount % compactEvery === 0` **or** `accumulatedTokens > compactAtTokens`
   (where `accumulatedTokens` is the **current rendered context size**, per xAI's
   "compact when the rendered context is above a threshold" guidance — not a running
   sum), calls `POST /v1/responses/compact`, rebuilds the transcript from the
   compaction result, and resets the counter,
4. returns the completion with an extra `_grokLoopKit` field.

### When does compaction actually save tokens?

Compaction replaces the transcript with one dense `encrypted_content` record. That's
a win **once the raw transcript outweighs the record** — i.e. long conversations. With
very short messages the record can cost more than the messages it replaced, so keep
`compactAtTokens` at a realistic size (thousands, not hundreds). Measured on a live
20-turn run with padded context: **22% fewer cumulative input tokens vs a
never-compacting control, with identical recall** (see `scripts/hardtest-live.mjs`).

### Correct compaction reuse (the important bit)

The [xAI docs](https://docs.x.ai/developers/advanced-api-usage/context-compaction)
require the compaction result to be fed back into the next request's `input`
**verbatim** — as a `{ type: 'compaction', id, encrypted_content }` item, never
modified. grok-loop-kit does exactly that. (A plain-string compaction reply, as
some gateways and the bundled mock return, collapses to a single `user` message.)
So this works unchanged against the real Grok 4.5 API, not just the mock.

### Tool-calling loops

Assistant output items — including `function_call`s — are preserved in the
transcript verbatim, so tool continuations reference the right `call_id`s:

```ts
let res = await client.sendMessage('weather in Tokyo?', tools);
for (const call of client.getToolCalls(res)) {
  const output = await runTool(call.name, call.arguments);
  res = await client.sendToolOutputs([{ call_id: call.call_id, output }], tools);
}
```

`sendToolOutputs` counts as a turn and compacts on the same schedule. See
`examples/tool-loop.mjs`.

### Streaming

```ts
const res = await client.streamMessage('write a haiku', {
  onToken: (delta) => process.stdout.write(delta),
});
// res is the assembled final completion (+ _grokLoopKit); compaction runs on the
// same schedule as sendMessage. See examples/streaming.mjs.
```

### Resilience & hooks

```ts
new GrokLoopClient(key, {
  maxRetries: 2,          // retry 429/5xx/network with exponential backoff (honors Retry-After)
  retryBaseMs: 500,
  timeoutMs: 30_000,      // per-request timeout (AbortSignal)
  headers: { 'x-team': 'agents' },
  onCompact: (e) => log(`compacted #${e.totalCompactions} at turn ${e.atTurn}, dropped ${e.droppedMessageCount}`),
});
```

### Examples & scripts

- `examples/basic.mjs` — 20-turn loop, context flatlining
- `examples/tool-loop.mjs` — tool-calling agent loop
- `examples/streaming.mjs` — streamed tokens with compaction
- `scripts/smoke-live.mjs` — LIVE smoke against real Grok (needs a funded key; spends < $0.01)
- `scripts/hardtest-live.mjs` — LIVE adversarial test: needle-retention through 4 real
  compactions, cost vs a no-compaction control, live tool round-trip, live streaming

### State persistence (durable agents)

Snapshot the loop and resume it later — in another process, after a restart, per user:

```ts
const state = client.getState();      // JSON-serializable
await kv.set(userId, JSON.stringify(state));
// ...later / elsewhere...
const resumed = new GrokLoopClient(key);
resumed.loadState(JSON.parse(await kv.get(userId)));
await resumed.sendMessage('continue where we left off');
// also: client.reset() to clear state and reuse the client
```

### LangGraph / LangChain

`GrokLoopChatModel` is a first-class `BaseChatModel` — use it anywhere a LangChain
chat model goes, including LangGraph's `createReactAgent`. Tool calls are parsed onto
the returned `AIMessage.tool_calls`, and the incoming history is compacted when it's
long or over the token budget.

```ts
import { GrokLoopChatModel } from 'grok-loop-kit/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const model = new GrokLoopChatModel({
  apiKey: process.env.XAI_API_KEY,
  grokLoop: { compactEvery: 8, compactAtTokens: 120_000 },
});

const getWeather = tool(async ({ city }) => `18°C, sunny in ${city}`, {
  name: 'get_weather',
  description: 'Get the weather for a city',
  schema: z.object({ city: z.string() }),
});

const agent = createReactAgent({ llm: model, tools: [getWeather] });
const out = await agent.invoke({ messages: [new HumanMessage('weather in Tokyo?')] });
console.log(model.lastMeta); // { turnsSinceCompact, estimatedTokensSaved, totalCompactions }
```

Because LangChain invokes a model with the **full history** each turn, the adapter
compacts *that* history (a pure function of the incoming messages) rather than
keeping a parallel transcript — so it never double-counts. Verified end-to-end
against a real `createReactAgent` tool loop (see `test/langgraph-agent.test.mjs`).
Extends `BaseChatModel` (not `ChatOpenAI`), so it never touches the OpenAI SDK and
survives `bindTools`/`withConfig`. Works on `@langchain/core` 0.3 and 1.x.

## Python usage

```python
from grok_loop_kit import GrokLoopClient

client = GrokLoopClient(
    api_key,
    compact_every=8,
    compact_at_tokens=8000,
    model="grok-4.5",
)

res = client.send_message("hello", tools=None)
print(res.output)          # raw output
print(res["_grokLoopKit"]) # GrokLoopKitMeta(turnsSinceCompact=..., estimatedTokensSaved=..., totalCompactions=...)

# Tool loop
res = client.send_message("weather in Tokyo?", tools=tools)
for call in client.get_tool_calls(res.raw):
    out = run_tool(call["name"], call["arguments"])
    res = client.send_tool_outputs([{"call_id": call["call_id"], "output": out}], tools)
```

Streaming and asyncio too:

```python
# sync streaming
client.stream_message("write a haiku", on_token=lambda d: print(d, end=""))

# asyncio (non-blocking; wraps the sync client in a worker thread, zero deps)
from grok_loop_kit import AsyncGrokLoopClient
aclient = AsyncGrokLoopClient(api_key)
res = await aclient.send_message("hello")
await aclient.stream_message("stream this", on_token=print)
```

Same feature set as the Node client: verbatim compaction reuse, tool round-trips,
streaming, retries (`max_retries`, `retry_base_ms`), `timeout`, custom `headers`,
and an `on_compact` hook. Zero runtime dependencies (stdlib `urllib`); pass
`poster=` / `stream_poster=` to inject a custom transport (used by the tests).
Ships `py.typed`. Live smoke: `python python/smoke_live.py` (needs a funded key).

## What `_grokLoopKit` reports

| field | meaning |
|-------|---------|
| `turnsSinceCompact` | turns elapsed since the last compaction (`0` on a turn that just compacted) |
| `estimatedTokensSaved` | cumulative estimate of context tokens removed, from each compaction reply's `usage` (pre-compaction `input_tokens` − compacted-record `output_tokens`). An idealized figure — the net on-wire saving also depends on later turns; see the hard-test's measured 22%. |
| `totalCompactions` | compactions performed over this client's lifetime |

## Develop & test

```bash
npm install
npm run build       # tsup -> dist/ (CJS + ESM + .d.ts)
npm run typecheck   # tsc --noEmit, strict: true
npm test            # node --test -> 20-turn loop compacts at turns 8 & 16

# Python
cd python && python -m venv .venv && ./.venv/Scripts/python -m pip install -e .
./.venv/Scripts/python test_loop.py
```

Everything runs against `test/mock-server.mjs`, a self-contained mock of xAI's
`POST /v1/responses` and `POST /v1/responses/compact`.

### Using it with the grokscope mock

The brief referenced adding a compact endpoint to
`D:\Repos\ideas\grokscope\test\mock-server.mjs`. To keep this package hermetic we
ship our **own** mock instead. If you want the grokscope mock to answer
`/v1/responses/compact`, add this branch before its `/responses` handler:

```js
if (req.method === 'POST' && req.url?.endsWith('/responses/compact')) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const n = (JSON.parse(raw).input ?? []).length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: `[COMPACTED: ${n} turns condensed]`, usage: { input_tokens: Math.floor(n / 4) } }));
  });
  return;
}
```

## First distribution step

Publish to npm (`npm publish`, package name `grok-loop-kit`) and post a short
before/after on X showing an agent loop's context size flatlining across 20 turns
instead of growing linearly — tag the xAI dev account. The one-liner hook: *"drop-in
Grok 4.5 client that keeps your agent's context flat — compaction on autopilot."*

## License

MIT
