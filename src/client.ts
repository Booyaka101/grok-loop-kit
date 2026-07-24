import type {
  CallOptions,
  CompactionItem,
  CompletionWithMeta,
  FunctionCallItem,
  GrokLoopOptions,
  GrokLoopState,
  RawCompaction,
  RawCompletion,
  ResponsesInputItem,
  Tool,
  ToolOutput,
} from './types.js';

/** Per-request overrides threaded through the HTTP layer. */
type PerCall = { signal?: AbortSignal; extraBody?: Record<string, unknown> };

const DEFAULTS = {
  compactEvery: 8,
  compactAtTokens: 8000,
  model: 'grok-4.5',
  baseUrl: 'https://api.x.ai/v1',
  maxRetries: 2,
  retryBaseMs: 500,
} as const;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A thin wrapper over xAI's Responses API that transparently applies
 * Grok 4.5 context compaction inside an agent loop.
 *
 * Each `sendMessage` appends the user turn, calls POST /v1/responses, and —
 * when the turn count hits a `compactEvery` boundary or accumulated tokens
 * exceed `compactAtTokens` — folds the running transcript into a compaction
 * item via POST /v1/responses/compact. The compaction item is spread back into
 * `input` VERBATIM on the next request, exactly as the xAI docs require.
 *
 * Tool-calling loops are supported: assistant output items (including
 * `function_call`s) are preserved verbatim in the transcript, and tool results
 * are submitted with `sendToolOutputs`.
 */
export class GrokLoopClient {
  readonly compactEvery: number;
  readonly compactAtTokens: number;
  readonly model: string;
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly retryBaseMs: number;

  /** Rolling transcript sent to the API. Reset to the compaction item on compaction. */
  messages: ResponsesInputItem[] = [];
  /** Total turns (model round-trips) processed over this client's lifetime. */
  turnCount = 0;
  /** Estimated CURRENT rendered-context size in tokens (reset to 0 on compaction). */
  accumulatedTokens = 0;
  /** Turns elapsed since the last compaction. */
  turnsSinceCompact = 0;
  /** Compactions performed over this client's lifetime. */
  totalCompactions = 0;
  /** Cumulative estimate of context tokens removed by compaction. */
  estimatedTokensSaved = 0;

  private readonly apiKey: string;
  private readonly instructions?: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs?: number;
  private readonly onCompact?: GrokLoopOptions['onCompact'];
  private readonly extraBody?: Record<string, unknown>;
  private readonly fetchImpl: typeof fetch;
  /** input_tokens reported by the most recent completion (context-size proxy). */
  private lastInputTokens = 0;

  constructor(apiKey: string, opts: GrokLoopOptions = {}) {
    if (!apiKey) throw new Error('grok-loop-kit: apiKey is required');
    this.apiKey = apiKey;
    this.compactEvery = opts.compactEvery ?? DEFAULTS.compactEvery;
    this.compactAtTokens = opts.compactAtTokens ?? DEFAULTS.compactAtTokens;
    this.model = opts.model ?? DEFAULTS.model;
    this.baseUrl = (opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, '');
    this.maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
    this.retryBaseMs = opts.retryBaseMs ?? DEFAULTS.retryBaseMs;
    this.instructions = opts.instructions;
    this.headers = opts.headers ?? {};
    this.timeoutMs = opts.timeoutMs;
    this.onCompact = opts.onCompact;
    this.extraBody = opts.extraBody;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('grok-loop-kit: no fetch available; pass opts.fetch on older runtimes');
    }
    if (this.compactEvery < 1) throw new Error('grok-loop-kit: compactEvery must be >= 1');
  }

  /**
   * Send a user message through the agent loop, auto-compacting when due.
   * Returns the raw Responses API completion with a `_grokLoopKit` field.
   */
  async sendMessage(
    userContent: string,
    tools?: Tool[],
    opts?: Pick<CallOptions, 'signal' | 'extraBody'>,
  ): Promise<CompletionWithMeta> {
    this.messages.push({ role: 'user', content: userContent });
    return this.runTurn(tools, opts);
  }

  /**
   * Submit the results of tool calls the model requested, continuing the loop.
   * Counts as a turn (and may trigger compaction) like any other model round-trip.
   */
  async sendToolOutputs(
    outputs: ToolOutput[],
    tools?: Tool[],
    opts?: Pick<CallOptions, 'signal' | 'extraBody'>,
  ): Promise<CompletionWithMeta> {
    for (const o of outputs) {
      this.messages.push({ type: 'function_call_output', call_id: o.call_id, output: o.output });
    }
    return this.runTurn(tools, opts);
  }

  /** Clear all loop state (transcript and counters), keeping configuration. */
  reset(): void {
    this.messages = [];
    this.turnCount = 0;
    this.accumulatedTokens = 0;
    this.turnsSinceCompact = 0;
    this.totalCompactions = 0;
    this.estimatedTokensSaved = 0;
    this.lastInputTokens = 0;
  }

  /** Snapshot the loop state for persistence (JSON-serializable). */
  getState(): GrokLoopState {
    return {
      version: 1,
      messages: this.messages,
      turnCount: this.turnCount,
      accumulatedTokens: this.accumulatedTokens,
      turnsSinceCompact: this.turnsSinceCompact,
      totalCompactions: this.totalCompactions,
      estimatedTokensSaved: this.estimatedTokensSaved,
      lastInputTokens: this.lastInputTokens,
    };
  }

  /** Restore loop state produced by `getState()` (e.g. to resume a conversation). */
  loadState(state: GrokLoopState): void {
    if (state.version !== 1) throw new Error(`grok-loop-kit: unsupported state version ${state.version}`);
    this.messages = state.messages ?? [];
    this.turnCount = state.turnCount ?? 0;
    this.accumulatedTokens = state.accumulatedTokens ?? 0;
    this.turnsSinceCompact = state.turnsSinceCompact ?? 0;
    this.totalCompactions = state.totalCompactions ?? 0;
    this.estimatedTokensSaved = state.estimatedTokensSaved ?? 0;
    this.lastInputTokens = state.lastInputTokens ?? 0;
  }

  /**
   * Stateless one-shot: run a completion against arbitrary `input` items without
   * touching this client's transcript. Used by the LangChain adapter. Honors
   * retries, timeout, headers, instructions, and extraBody.
   */
  async createResponse(input: ResponsesInputItem[], opts: CallOptions = {}): Promise<RawCompletion> {
    return this.postResponses(input, opts.tools, opts);
  }

  /** Stateless one-shot: compact arbitrary `input` items (no transcript mutation). */
  async compactInput(input: ResponsesInputItem[], opts: PerCall = {}): Promise<RawCompaction> {
    return this.postCompact(input, opts);
  }

  /** Extract the tool calls (`function_call` items) from a completion's output. */
  getToolCalls(completion: RawCompletion): FunctionCallItem[] {
    return (completion.output ?? []).filter(
      (i): i is FunctionCallItem => i.type === 'function_call',
    );
  }

  /** Force a compaction of the current transcript right now. */
  async compact(): Promise<RawCompaction> {
    const compaction = await this.postCompact(this.messages);
    const droppedMessageCount = compaction.usage?.dropped_message_count ?? this.messages.length;

    // Per xAI docs, the compaction reply's usage reports pre-compaction
    // conversation tokens (`input_tokens`) and the compacted record size
    // (`output_tokens`). Tokens removed from context = input - output. Fall back
    // to the last request's context size if the reply omits usage.
    const preTokens = compaction.usage?.input_tokens ?? this.lastInputTokens;
    const compactedRecordTokens = compaction.usage?.output_tokens ?? 0;
    this.estimatedTokensSaved += Math.max(0, preTokens - compactedRecordTokens);

    // Reuse the compaction result the way the API expects: spread items back
    // VERBATIM. String-shaped replies (mocks/gateways) become a single message.
    this.messages = buildCompactedTranscript(compaction);
    this.accumulatedTokens = 0;
    this.turnsSinceCompact = 0;
    this.totalCompactions += 1;

    this.onCompact?.({
      totalCompactions: this.totalCompactions,
      estimatedTokensSaved: this.estimatedTokensSaved,
      droppedMessageCount,
      atTurn: this.turnCount,
      compaction,
    });
    return compaction;
  }

  /**
   * Stream a user message: tokens are delivered to `onToken` as they arrive,
   * and the resolved value is the final completion (with `_grokLoopKit`), after
   * the same transcript/compaction bookkeeping as `sendMessage`.
   */
  async streamMessage(
    userContent: string,
    opts: {
      tools?: Tool[];
      onToken?: (delta: string) => void;
      signal?: AbortSignal;
      extraBody?: Record<string, unknown>;
    } = {},
  ): Promise<CompletionWithMeta> {
    this.messages.push({ role: 'user', content: userContent });
    this.turnCount += 1;
    this.turnsSinceCompact += 1;
    const completion = await this.streamResponses(this.messages, opts.tools, opts.onToken, {
      signal: opts.signal,
      extraBody: opts.extraBody,
    });
    return this.finalizeTurn(completion);
  }

  /** One model round-trip against the current transcript + optional compaction. */
  private async runTurn(tools?: Tool[], perCall?: PerCall): Promise<CompletionWithMeta> {
    this.turnCount += 1;
    this.turnsSinceCompact += 1;
    const completion = await this.postResponses(this.messages, tools, perCall);
    return this.finalizeTurn(completion);
  }

  /** Shared post-completion bookkeeping: preserve output, tally tokens, compact. */
  private async finalizeTurn(completion: RawCompletion): Promise<CompletionWithMeta> {
    // Preserve ALL output items verbatim (messages, reasoning, function_calls)
    // so tool-calling continuations reference the right call ids.
    if (Array.isArray(completion.output) && completion.output.length) {
      this.messages.push(...completion.output);
    }

    // `accumulatedTokens` tracks the CURRENT rendered context size — the tokens
    // the next request would send — not a running sum. This matches xAI's
    // guidance to compact "whenever your bookkeeping shows the rendered context
    // above a threshold", and resets naturally when compaction shrinks context.
    const inTok = completion.usage?.input_tokens;
    if (typeof inTok === 'number') {
      this.lastInputTokens = inTok;
      this.accumulatedTokens = inTok + (completion.usage?.output_tokens ?? 0);
    }

    // Compaction is due on a `compactEvery` boundary OR over the token budget.
    if (this.turnCount % this.compactEvery === 0 || this.accumulatedTokens > this.compactAtTokens) {
      await this.compact();
    }

    return {
      ...completion,
      _grokLoopKit: {
        turnsSinceCompact: this.turnsSinceCompact,
        estimatedTokensSaved: this.estimatedTokensSaved,
        totalCompactions: this.totalCompactions,
      },
    };
  }

  private async postResponses(
    input: ResponsesInputItem[],
    tools?: Tool[],
    perCall?: PerCall,
  ): Promise<RawCompletion> {
    const body: Record<string, unknown> = { model: this.model, input };
    if (this.instructions) body.instructions = this.instructions;
    if (tools && tools.length) body.tools = tools;
    Object.assign(body, this.extraBody, perCall?.extraBody);
    return this.post<RawCompletion>('/responses', body, perCall);
  }

  private async postCompact(input: ResponsesInputItem[], perCall?: PerCall): Promise<RawCompaction> {
    return this.post<RawCompaction>('/responses/compact', { model: this.model, input }, perCall);
  }

  /**
   * POST /responses with `stream: true`, parse the SSE event stream, forward
   * text deltas to `onToken`, and resolve the assembled final completion.
   */
  private async streamResponses(
    input: ResponsesInputItem[],
    tools: Tool[] | undefined,
    onToken?: (delta: string) => void,
    perCall?: PerCall,
  ): Promise<RawCompletion> {
    const body: Record<string, unknown> = { model: this.model, input, stream: true };
    if (this.instructions) body.instructions = this.instructions;
    if (tools && tools.length) body.tools = tools;
    Object.assign(body, this.extraBody, perCall?.extraBody);

    const res = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: this.buildSignal(perCall?.signal),
    });
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text().catch(() => '') : '';
      throw new Error(`grok-loop-kit: POST /responses (stream) failed ${res.status}: ${text.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final: RawCompletion | null = null;
    const textParts: string[] = [];

    const handle = (json: Record<string, unknown>): void => {
      const type = typeof json.type === 'string' ? json.type : '';
      if (type.endsWith('output_text.delta') && typeof json.delta === 'string') {
        textParts.push(json.delta);
        onToken?.(json.delta);
      } else if (type === 'response.completed' && json.response) {
        final = json.response as RawCompletion;
      }
    };

    // eslint-disable-next-line no-constant-condition
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const ev of events) {
        for (const line of ev.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            handle(JSON.parse(data) as Record<string, unknown>);
          } catch {
            /* ignore keep-alives / partial frames */
          }
        }
      }
    }

    if (final) return final;
    // No terminal event: assemble a completion from accumulated deltas.
    return {
      object: 'response',
      status: 'completed',
      model: this.model,
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textParts.join('') }] },
      ],
      usage: {},
    };
  }

  private async post<T>(path: string, body: unknown, perCall?: PerCall): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const payload = JSON.stringify(body);
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
            ...this.headers,
          },
          body: payload,
          signal: this.buildSignal(perCall?.signal),
        });
        if (res.ok) return (await res.json()) as T;

        // Retry transient statuses; surface everything else immediately.
        if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
          await sleep(this.backoffMs(attempt, res.headers.get('retry-after')));
          continue;
        }
        const text = await res.text().catch(() => '');
        throw new Error(`grok-loop-kit: POST ${path} failed ${res.status}: ${text.slice(0, 500)}`);
      } catch (err) {
        lastErr = err;
        // Network/timeout error: retry if attempts remain, else rethrow.
        const isHttpError = err instanceof Error && err.message.startsWith('grok-loop-kit: POST');
        if (isHttpError || attempt >= this.maxRetries) throw err;
        await sleep(this.backoffMs(attempt, null));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Combine the client timeout with an optional per-call abort signal. */
  private buildSignal(userSignal?: AbortSignal): AbortSignal | undefined {
    const timeout = this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined;
    if (timeout && userSignal) {
      // AbortSignal.any is available on Node 20+/modern runtimes.
      const anyFn = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
      return anyFn ? anyFn([timeout, userSignal]) : userSignal;
    }
    return timeout ?? userSignal;
  }

  /** Exponential backoff, honoring a numeric Retry-After header when present. */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    }
    return this.retryBaseMs * 2 ** attempt;
  }
}

/**
 * Pull the assistant's text out of a Responses API completion. Handles
 * `output_text` parts and `refusal` parts; ignores reasoning/other item types.
 */
export function extractAssistantText(completion: RawCompletion): string {
  const parts: string[] = [];
  for (const item of completion.output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) {
      if (typeof c.text === 'string') parts.push(c.text);
      else if (c.type === 'refusal' && typeof c.refusal === 'string') parts.push(c.refusal);
    }
  }
  return parts.join('');
}

/**
 * Pull the compacted text out of a compaction reply. The real API returns an
 * array of items with `encrypted_content`; mocks/gateways may return a string.
 */
export function extractCompactionText(compaction: RawCompaction): string {
  const out = compaction.output;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) {
    const parts: string[] = [];
    for (const item of out) {
      if (typeof item.encrypted_content === 'string') parts.push(item.encrypted_content);
      for (const c of item.content ?? []) {
        if (typeof c.text === 'string') parts.push(c.text);
      }
    }
    if (parts.length) return parts.join('');
  }
  return '[COMPACTED]';
}

/**
 * Build the post-compaction transcript. Per xAI docs, compaction `output` items
 * are spread back into `input` verbatim (each `{type:'compaction', id,
 * encrypted_content}`). Gateways/mocks that return a plain string become a
 * single user message carrying that string.
 */
export function buildCompactedTranscript(compaction: RawCompaction): ResponsesInputItem[] {
  const out = compaction.output;
  if (Array.isArray(out) && out.length) {
    return out.map((item) => item as unknown as CompactionItem);
  }
  const text = typeof out === 'string' ? out : extractCompactionText(compaction);
  return [{ role: 'user', content: text }];
}
