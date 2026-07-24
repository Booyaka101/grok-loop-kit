/**
 * Types for the xAI Responses API surface that grok-loop-kit touches.
 * Kept intentionally small — we only model the fields the loop reads/writes.
 * See https://docs.x.ai/developers/grok-4-5 and
 * https://docs.x.ai/developers/advanced-api-usage/context-compaction
 */

/** A plain chat message in the Responses API `input` array. */
export interface ResponsesMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/**
 * A compaction item, returned by /responses/compact and passed back VERBATIM
 * into the next /responses `input`. `encrypted_content` is opaque — never modify.
 */
export interface CompactionItem {
  type: 'compaction';
  id?: string;
  encrypted_content?: string;
  [key: string]: unknown;
}

/** A tool/function call emitted by the model in a completion's `output`. */
export interface FunctionCallItem {
  type: 'function_call';
  call_id?: string;
  name?: string;
  arguments?: string;
  id?: string;
  [key: string]: unknown;
}

/** The result of executing a tool call, fed back into `input`. */
export interface FunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

/** One item in a Responses API `output` array. */
export interface ResponseOutputItem {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Any item that may appear in the Responses API `input` array. The transcript
 * grok-loop-kit maintains is heterogeneous: user/assistant messages, verbatim
 * assistant output items (incl. tool calls), compaction items, and tool results.
 */
export type ResponsesInputItem =
  | ResponsesMessage
  | ResponseOutputItem
  | CompactionItem
  | FunctionCallOutputItem;

/** A tool definition passed through to the Responses API untouched. */
export interface Tool {
  type: string;
  [key: string]: unknown;
}

/** The result of executing one tool call, submitted via `sendToolOutputs`. */
export interface ToolOutput {
  call_id: string;
  output: string;
}

/** Token accounting returned by both /responses and /responses/compact. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** compaction only: number of messages folded into the compaction record */
  dropped_message_count?: number;
  [key: string]: unknown;
}

/** The raw POST /v1/responses reply. */
export interface RawCompletion {
  id?: string;
  object?: string;
  status?: string;
  created_at?: number;
  model?: string;
  output?: ResponseOutputItem[];
  usage?: Usage;
  [key: string]: unknown;
}

/**
 * The raw POST /v1/responses/compact reply. Per the docs the real API returns
 * `output` as an array of compaction items carrying `encrypted_content`; some
 * gateways / mocks return a plain string. We accept both.
 */
export interface RawCompaction {
  id?: string;
  object?: string;
  model?: string;
  output?: string | ResponseOutputItem[];
  usage?: Usage;
  [key: string]: unknown;
}

/** Bookkeeping attached to every completion GrokLoopClient returns. */
export interface GrokLoopKitMeta {
  /** Turns elapsed since the most recent compaction (0 on a turn that compacted). */
  turnsSinceCompact: number;
  /** Cumulative estimate of context tokens removed by compaction so far. */
  estimatedTokensSaved: number;
  /** Number of compactions performed over this client's lifetime. */
  totalCompactions: number;
}

/** Details passed to the `onCompact` hook each time a compaction runs. */
export interface CompactionEvent {
  totalCompactions: number;
  estimatedTokensSaved: number;
  /** Messages folded into this compaction (from usage.dropped_message_count). */
  droppedMessageCount: number;
  /** Turn number at which this compaction occurred. */
  atTurn: number;
  /** The raw compaction reply. */
  compaction: RawCompaction;
}

/** A Responses API completion with grok-loop-kit bookkeeping attached. */
export type CompletionWithMeta = RawCompletion & {
  _grokLoopKit: GrokLoopKitMeta;
};

/**
 * Serializable snapshot of a client's loop state. Use `getState()`/`loadState()`
 * to persist and resume a conversation across processes (e.g. a durable agent).
 */
export interface GrokLoopState {
  version: 1;
  messages: ResponsesInputItem[];
  turnCount: number;
  accumulatedTokens: number;
  turnsSinceCompact: number;
  totalCompactions: number;
  estimatedTokensSaved: number;
  lastInputTokens: number;
}

/** Per-call options for send/stream methods. */
export interface CallOptions {
  /** Tools available to the model this turn. */
  tools?: Tool[];
  /** Abort this request (combined with the client's `timeoutMs`). */
  signal?: AbortSignal;
  /** Extra top-level body fields merged into this request (e.g. temperature). */
  extraBody?: Record<string, unknown>;
}

/** Constructor options for GrokLoopClient. */
export interface GrokLoopOptions {
  /** Compact every this many turns. Default 8. */
  compactEvery?: number;
  /** Compact once accumulated tokens exceed this. Default 8000. */
  compactAtTokens?: number;
  /** Model id. Default 'grok-4.5'. */
  model?: string;
  /** API base URL. Default 'https://api.x.ai/v1'. */
  baseUrl?: string;
  /** Optional system prompt sent as `instructions`. */
  instructions?: string;
  /** Extra HTTP headers merged into every request. */
  headers?: Record<string, string>;
  /** Per-request timeout in ms. Omit for no timeout. */
  timeoutMs?: number;
  /** Retries on 429/5xx/network errors. Default 2. */
  maxRetries?: number;
  /** Base backoff in ms for retries (exponential). Default 500. */
  retryBaseMs?: number;
  /** Called synchronously each time a compaction completes. */
  onCompact?: (event: CompactionEvent) => void;
  /** Extra top-level body fields merged into every request (e.g. temperature, max_output_tokens). */
  extraBody?: Record<string, unknown>;
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetch?: typeof fetch;
}
