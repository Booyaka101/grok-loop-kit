import {
  BaseChatModel,
  type BaseChatModelParams,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, type ToolMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { AIMessageChunk } from '@langchain/core/messages';

import { GrokLoopClient, buildCompactedTranscript, extractAssistantText } from './client.js';
import type { GrokLoopKitMeta, GrokLoopOptions, ResponsesInputItem, Tool } from './types.js';

/** Call options for GrokLoopChatModel (adds `tools` to the base options). */
export interface GrokLoopCallOptions extends BaseChatModelCallOptions {
  tools?: Tool[];
}

export interface GrokLoopChatModelFields extends BaseChatModelParams {
  /** xAI API key. Falls back to XAI_API_KEY / GROK_API_KEY. */
  apiKey?: string;
  /** Model id (default 'grok-4.5'). */
  model?: string;
  /** grok-loop-kit compaction options (compactEvery, compactAtTokens, baseUrl, ...). */
  grokLoop?: GrokLoopOptions;
}

/**
 * A LangChain chat model that runs completions through xAI's Responses API with
 * automatic Grok 4.5 context compaction. Drop it into a LangGraph agent (e.g.
 * `createReactAgent`) and long runs stay within the context window.
 *
 * It extends `BaseChatModel` (not `ChatOpenAI`) so `withConfig`/`bindTools`
 * preserve this model and route through our `_generate` — we never touch the
 * OpenAI SDK. The model is invoked with the full message history each turn (the
 * LangChain contract); it maps that history to Responses API items, compacts it
 * when long or over the token budget, then generates. `function_call`s are parsed
 * back onto the returned AIMessage's `tool_calls`, so tool-using agents work.
 */
export class GrokLoopChatModel extends BaseChatModel<GrokLoopCallOptions> {
  readonly engine: GrokLoopClient;
  readonly compactEvery: number;
  readonly compactAtTokens: number;

  /** Compactions performed across generations of this model instance. */
  totalCompactions = 0;
  /** Cumulative estimate of context tokens removed by compaction. */
  estimatedTokensSaved = 0;
  /** Bookkeeping from the most recent generation. */
  lastMeta: GrokLoopKitMeta | null = null;

  private genCount = 0;
  private boundTools?: Tool[];

  constructor(fields: GrokLoopChatModelFields = {}) {
    super(fields);
    const apiKey =
      fields.apiKey ?? process.env.XAI_API_KEY ?? process.env.GROK_API_KEY ?? '';
    const grokOpts = fields.grokLoop ?? {};
    const baseUrl = grokOpts.baseUrl ?? 'https://api.x.ai/v1';
    const model = grokOpts.model ?? fields.model ?? 'grok-4.5';

    this.engine = new GrokLoopClient(apiKey || 'grok-loop-kit-placeholder', {
      ...grokOpts,
      baseUrl,
      model,
    });
    this.compactEvery = grokOpts.compactEvery ?? 8;
    this.compactAtTokens = grokOpts.compactAtTokens ?? 8000;
  }

  override _llmType(): string {
    return 'grok-loop-kit';
  }

  /** Bind tools (LangChain tool objects or JSON schemas) for subsequent calls. */
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<GrokLoopCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, GrokLoopCallOptions> {
    this.boundTools = tools.map((t) => toXaiTool(t));
    // A RunnableBinding around THIS model — invoking it routes through _generate,
    // which reads boundTools. (BaseChatModel.withConfig preserves the instance.)
    return this.withConfig(kwargs ?? {});
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this.genCount += 1;
    let input = messages.flatMap(messageToInput);

    // Compact the incoming history when it's long or over the token budget.
    const overBudget = estimateTokens(input) > this.compactAtTokens;
    const onSchedule = this.genCount % this.compactEvery === 0;
    if (input.length > 1 && (onSchedule || overBudget)) {
      const head = input.slice(0, -1);
      const tail = input.slice(-1);
      const compaction = await this.engine.compactInput(head, { signal: options?.signal });
      const preTokens = compaction.usage?.input_tokens ?? estimateTokens(head);
      const recordTokens = compaction.usage?.output_tokens ?? 0;
      this.estimatedTokensSaved += Math.max(0, preTokens - recordTokens);
      this.totalCompactions += 1;
      input = [...buildCompactedTranscript(compaction), ...tail];
    }

    const tools = options?.tools?.map(maybeXai) ?? this.boundTools;
    const completion = await this.engine.createResponse(input, {
      tools,
      signal: options?.signal,
    });

    const text = extractAssistantText(completion);
    const toolCalls = this.engine.getToolCalls(completion).map((c) => ({
      id: c.call_id ?? c.id ?? '',
      name: c.name ?? '',
      args: safeJson(c.arguments),
      type: 'tool_call' as const,
    }));

    this.lastMeta = {
      turnsSinceCompact: this.genCount % this.compactEvery,
      estimatedTokensSaved: this.estimatedTokensSaved,
      totalCompactions: this.totalCompactions,
    };

    const message = new AIMessage({
      content: text,
      tool_calls: toolCalls,
      response_metadata: { _grokLoopKit: this.lastMeta, usage: completion.usage },
      usage_metadata: {
        input_tokens: completion.usage?.input_tokens ?? 0,
        output_tokens: completion.usage?.output_tokens ?? 0,
        total_tokens: completion.usage?.total_tokens ?? 0,
      },
    });

    await runManager?.handleLLMNewToken(text);

    return {
      generations: [{ text, message }],
      llmOutput: {
        tokenUsage: {
          promptTokens: completion.usage?.input_tokens,
          completionTokens: completion.usage?.output_tokens,
          totalTokens: completion.usage?.total_tokens,
        },
        _grokLoopKit: this.lastMeta,
      },
    };
  }
}

/** Map one LangChain message to zero or more Responses API input items. */
function messageToInput(msg: BaseMessage): ResponsesInputItem[] {
  const type = msg.getType();
  if (type === 'system') return [{ role: 'system', content: messageToText(msg) }];
  if (type === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: (msg as ToolMessage).tool_call_id,
        output: messageToText(msg),
      },
    ];
  }
  if (type === 'ai') {
    const ai = msg as AIMessage;
    const items: ResponsesInputItem[] = [];
    const text = messageToText(msg);
    if (text) items.push({ role: 'assistant', content: text });
    for (const tc of ai.tool_calls ?? []) {
      items.push({
        type: 'function_call',
        call_id: tc.id ?? '',
        name: tc.name,
        arguments: JSON.stringify(tc.args ?? {}),
      });
    }
    return items.length ? items : [{ role: 'assistant', content: '' }];
  }
  // Human and everything else.
  return [{ role: 'user', content: messageToText(msg) }];
}

/** Flatten a LangChain message's content down to plain text. */
function messageToText(msg: BaseMessage): string {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) =>
        typeof part === 'string' ? part : 'text' in part && typeof part.text === 'string' ? part.text : '',
      )
      .join('');
  }
  return '';
}

/** Convert a LangChain/JSON-schema tool to xAI's flat function-tool shape. */
function toXaiTool(tool: BindToolsInput): Tool {
  const openai = convertToOpenAITool(tool as Parameters<typeof convertToOpenAITool>[0]);
  return flattenOpenAiTool(openai);
}

/** Accept a tool already in xAI/OpenAI shape and normalize to xAI flat shape. */
function maybeXai(tool: Tool): Tool {
  if (tool && typeof tool === 'object' && 'function' in tool) return flattenOpenAiTool(tool);
  return tool;
}

function flattenOpenAiTool(tool: unknown): Tool {
  const t = tool as { type?: string; function?: { name?: string; description?: string; parameters?: unknown } };
  if (t.function) {
    return {
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    } as Tool;
  }
  return t as Tool;
}

function estimateTokens(input: ResponsesInputItem[]): number {
  return Math.ceil(JSON.stringify(input).length / 4);
}

function safeJson(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
