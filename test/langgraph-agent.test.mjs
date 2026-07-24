import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GrokLoopChatModel } from '../dist/langgraph.js';
import { createMockServer } from './mock-server.mjs';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { HumanMessage, isToolMessage, isAIMessage } from '@langchain/core/messages';
import { z } from 'zod';

test('GrokLoopChatModel drives a real LangGraph createReactAgent tool loop', async () => {
  // Mock emits a get_weather function_call for a fresh user turn, then a normal
  // message once a tool result comes back — exactly a ReAct step.
  const mock = createMockServer({ emitToolCall: true });
  const port = await mock.listen();

  const model = new GrokLoopChatModel({
    apiKey: 'test-key',
    grokLoop: { baseUrl: `http://127.0.0.1:${port}/v1` },
  });

  const getWeather = tool(
    async ({ city }) => `It is 18C and sunny in ${city}.`,
    {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      schema: z.object({ city: z.string() }),
    },
  );

  try {
    const agent = createReactAgent({ llm: model, tools: [getWeather] });
    const result = await agent.invoke({ messages: [new HumanMessage('What is the weather in Tokyo?')] });

    const msgs = result.messages;
    // The agent executed the tool...
    assert.ok(msgs.some((m) => isToolMessage(m)), 'a ToolMessage is present (tool was executed)');
    assert.ok(
      msgs.some((m) => isToolMessage(m) && String(m.content).includes('18C')),
      'tool returned the weather',
    );
    // ...and produced a final assistant answer with no pending tool calls.
    const last = msgs[msgs.length - 1];
    assert.ok(isAIMessage(last), 'final message is an AIMessage');
    assert.equal((last.tool_calls ?? []).length, 0, 'no dangling tool calls at the end');
    assert.ok(String(last.content).length > 0, 'final answer has text');
  } finally {
    await mock.close();
  }
});
