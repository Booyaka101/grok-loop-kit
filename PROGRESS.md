# PROGRESS — grok-loop-kit

Status: **1.0.0 — shippable.** Node + Python packages build, typecheck, and pass full
suites (25 Node + 16 Python) against a local mock. Core AND the LangGraph adapter are
verified against the REAL xAI API. Names available on npm + PyPI.

## 1.0.0 push (2026-07-24) — what changed since 0.1
- **Native LangChain adapter**: `GrokLoopChatModel` re-based on `BaseChatModel` (was
  `ChatOpenAI`). Root cause found live: LangChain 1.x `ChatOpenAI.withConfig`/`bindTools`
  clone into a plain `ChatOpenAI`, silently dropping a subclass's `_generate` (the bound
  runnable hit the OpenAI SDK → 404). BaseChatModel preserves the instance. Bidirectional
  message mapping, `tool_calls` parsing, `bindTools`, history compaction. **Verified live
  in a real `createReactAgent` loop** (model called get_weather → tool ran → correct answer)
  AND in unit tests. `@langchain/openai` dependency removed; works on core 0.3 and 1.x.
- **Production features**: `getState`/`loadState`/`reset` (both langs, + async passthrough),
  per-call `AbortSignal` (combined with timeout), `extraBody` passthrough.
- **Edge cases**: refusal → text, reasoning items preserved verbatim, `incomplete` status
  surfaced. All unit-tested.
- **CI**: `.github/workflows/ci.yml` (Node 18/20/22 + Python 3.8/3.11/3.12).
- Version bumped to 1.0.0 (package.json, pyproject, __version__).

## Live re-verification at 1.0 (owner's key)
- `scripts/hardtest-live.mjs`: 7/7 — needle retention through 4 real compactions, savings
  vs control, live tool round-trip, live streaming.
- `scripts/langgraph-live.mjs`: PASS — invoke→"PONG"; real createReactAgent tool loop
  (Grok called get_weather, tool ran, answered "It is 12°C and raining in Paris").
- Consumer installs: npm tarball (core imports with no LangChain; adapter imports with only
  `@langchain/core`, base=BaseChatModel); Python wheel imports in a fresh venv.

## Phase 0 — resource verification (done)
- ✅ Compaction API `POST /v1/responses/compact` verified live at
  https://docs.x.ai/developers/advanced-api-usage/context-compaction — body `{model, input}`,
  response `{output, usage.input_tokens, ...}`, "call the Compaction API every N turns".
- ✅ Grok 4.5 verified at https://docs.x.ai/developers/grok-4-5 — model id `grok-4.5`,
  OpenAI-compatible, base `https://api.x.ai/v1`, has `/v1/responses`.
- ✅ LESSONS.md consistent: Grok is BYOK, develop against mock. No cost/geo/hardware block.

## What is VERIFIED working
- **Node core** (`src/client.ts`): `GrokLoopClient(apiKey, {compactEvery, compactAtTokens, model, baseUrl, instructions, fetch})`.
  `sendMessage()` appends user turn → `POST /responses` → auto `POST /responses/compact`
  on `turnCount % compactEvery === 0` OR `accumulatedTokens > compactAtTokens` → returns
  completion with `_grokLoopKit {turnsSinceCompact, estimatedTokensSaved, totalCompactions}`.
- **Acceptance (Node)**: 20-turn loop compacts **exactly at turns 8 & 16**,
  `messages.length` resets to 1 after each, `totalCompactions === 2`. 4/4 tests pass (`npm test`).
- **TypeScript strict**: `tsc --noEmit` clean with `strict: true` + `noUncheckedIndexedAccess`.
- **Dual build**: tsup emits CJS (`dist/*.cjs`) + ESM (`dist/*.js`) + `.d.ts`/`.d.cts`.
  Verified both `import` and `require` load `GrokLoopClient` and `GrokLoopChatModel`.
- **LangGraph** (`src/langgraph.ts`): `GrokLoopChatModel extends ChatOpenAI`, overrides
  `_generate`. Verified live: 6-turn `.invoke()` loop against mock → 2 compactions at
  compactEvery=3, context resets confirmed (input msg count drops after compaction).
- **Python** (`python/grok_loop_kit`): `from grok_loop_kit import GrokLoopClient` works;
  same 20-turn acceptance passes (compact at 8 & 16, totalCompactions==2); zero runtime deps
  (stdlib urllib). Verified BOTH the injected-poster path and the real `urllib` HTTP path
  against a live `http.server`.
- **Self-contained mock** (`test/mock-server.mjs`): serves `/v1/responses` (grokscope-accurate
  shape) + `/v1/responses/compact` (returns `[COMPACTED: {N} turns condensed]`, `usage.input_tokens=floor(N/4)`).
- **Example**: `node examples/basic.mjs` prints the context flatlining across 20 turns.

## Deviation from brief (intentional, documented)
- Brief said to add `/compact` to `D:\Repos\ideas\grokscope\test\mock-server.mjs`. That file is
  OUTSIDE this project folder; per the autonomous build rules I did NOT modify it. Instead I
  shipped an equivalent self-contained mock inside `test/` (better: hermetic tests, no cross-repo
  coupling). README includes a copy-paste patch snippet for anyone who wants it in grokscope.

## How to run
```
npm install && npm run typecheck && npm run build && npm test
node examples/basic.mjs
cd python && python -m venv .venv && ./.venv/Scripts/python -m pip install -e . && ./.venv/Scripts/python test_loop.py
```

## Hardening added (post-Phase-1, "leave no stone unturned")
- **Verbatim compaction reuse** — VERIFIED via docs re-fetch: real API returns a
  `{type:'compaction', id, encrypted_content}` item that must be spread back into
  `input` unmodified. Implemented + tested (Node test 5, Py `test_verbatim_compaction_items`,
  and a live-HTTP Python e2e). String-shaped replies still collapse to one user message.
- **Tool-calling loop** — assistant output items preserved verbatim; `getToolCalls()` +
  `sendToolOutputs()`/`send_tool_outputs()`. Tested both langs + `examples/tool-loop.mjs`.
- **Retries** — exponential backoff on 429/5xx/network, honors `Retry-After`. Tested (retry-then-
  success + give-up-and-throw) both langs.
- **Timeout** (AbortSignal / urllib timeout), **custom headers**, **`onCompact` hook**. Tested.
- **Packaging**: `py.typed`, LICENSE, CHANGELOG, `files` allowlist. `npm pack --dry-run` clean.

## Optional next steps — DONE (2026-07-24)
- **Streaming (SSE)** — `streamMessage`/`stream_message` parse the SSE stream, deliver
  deltas to a callback, compact on schedule. Node test 9–10; Python `test_stream_*`.
  VERIFIED over real HTTP in BOTH languages (TS test 9 uses live fetch; Python live SSE e2e).
- **Async Python** — `AsyncGrokLoopClient` (non-blocking asyncio facade, zero deps).
  Python `test_async_client` (send + stream) passes.
- **Live smoke scripts** — `scripts/smoke-live.mjs` + `python/smoke_live.py`, ready to run
  with a funded key (guard exits cleanly with no key; NO paid call made here — env has no key).
- **Publish prep** — `PUBLISHING.md`; `npm pack --dry-run` clean; `python -m build` produces
  wheel+sdist; fresh-venv wheel install imports both clients. NOT published (no accounts/spend, per rules).

## Test totals: 11 Node + 11 Python, all green. 4 examples + 2 live-smoke scripts.

## LIVE-VERIFIED against real Grok 4.5 (2026-07-24, owner's funded key)
- `node scripts/smoke-live.mjs` ran a real 10-turn loop (compactEvery=4). Result:
  - Real completions returned; compaction fired at turns 4 and 8 with real
    `dropped_message_count` (7, then 8 messages).
  - **Context preserved across compactions**: turn-10 summary correctly recalled all
    facts from turns 1–9 — proving the verbatim `{type:'compaction', encrypted_content}`
    reuse actually works on the live API, not just the mock.
  - **Bug caught & fixed by the live run**: `estimatedTokensSaved` was 0. Root cause —
    the compaction reply's `usage.input_tokens` is *pre-compaction* tokens and
    `output_tokens` is the *compacted record* size (per docs), so savings =
    input−output, computed from the compaction reply itself (was subtracting the wrong
    field). Fixed in both languages; mock usage made doc-accurate. Re-run showed
    `estimated tokens saved: 362`.
- Cost: a few hundred tokens (no x_search), well under $0.01. Key was passed inline via
  env only — never written to any file in the repo.

## HARD live test — `scripts/hardtest-live.mjs` (2026-07-24, owner's key) — 7/7
Adversarial, measured proof (not toy prompts):
- **A. Needle retention through compactions**: planted 5 unguessable random vault codes
  early, ran 20 turns forcing **4 real compactions** (dropping 9–10 msgs each), then
  demanded exact recall → **5/5 exact codes** recalled. Since the codes are unguessable,
  this proves the verbatim `encrypted_content` reuse actually preserves information.
- **B. Compaction vs true control** (control = never compacts): with realistic padded
  turns, compacting used **16,461 vs 21,182** cumulative input tokens (**22% less**) while
  BOTH clients still recalled 5/5 — savings with zero fidelity loss.
- **C. Live tool round-trip**: real `function_call` emitted, executed, threaded back;
  final answer "The product is 110916." ✓
- **D. Live streaming**: 19 real SSE deltas, assembled == final text. ✓

## Semantics fix the hard test forced (both languages)
- `accumulatedTokens` now tracks the **current rendered context size** (last completion's
  input+output tokens), NOT a cumulative running sum. The old sum hit `compactAtTokens`
  absurdly fast on a 500K-context model (compacting every few turns, wasting money).
  New behavior matches xAI's guidance: compact when "rendered context [is] above a
  threshold". Mock made context-scaled; token-budget unit tests rewritten. All 11+11 green.
- **Honest nuance documented**: compaction is a LARGE-context optimization — with tiny
  messages the `encrypted_content` blob can outweigh the raw transcript. It saves tokens
  once the transcript exceeds the blob (shown in B).

## Genuinely remaining (needs owner / out of sandbox scope)
- `npm publish` / `twine upload` (needs accounts + 2FA).
```
