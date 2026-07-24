import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GrokLoopChatModel } from '../dist/langgraph.js';
import { createMockServer } from './mock-server.mjs';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';

async function withModel(mockOpts, grokLoop, fn) {
  const mock = createMockServer(mockOpts);
  const port = await mock.listen();
  const model = new GrokLoopChatModel({
    apiKey: 'test-key',
    grokLoop: { baseUrl: `http://127.0.0.1:${port}/v1`, ...grokLoop },
  });
  try {
    await fn(model, mock);
  } finally {
    await mock.close();
  }
}

test('basic invoke returns an AIMessage with text', async () => {
  await withModel({}, {}, async (model) => {
    const res = await model.invoke([new HumanMessage('hello')]);
    assert.ok(res instanceof AIMessage);
    assert.match(res.content, /Assistant reply #1/);
    assert.equal(res.response_metadata._grokLoopKit.totalCompactions, 0);
    assert.ok(res.usage_metadata.input_tokens >= 0);
  });
});

test('function_call output is parsed onto AIMessage.tool_calls', async () => {
  await withModel({ emitToolCall: true }, {}, async (model, mock) => {
    const res = await model.invoke([new HumanMessage('weather in Tokyo?')]);
    assert.equal(res.tool_calls.length, 1);
    assert.equal(res.tool_calls[0].name, 'get_weather');
    assert.deepEqual(res.tool_calls[0].args, { city: 'Tokyo' });
    assert.equal(res.tool_calls[0].type, 'tool_call');
    // No tools were bound, but the call still surfaced from the mock.
    assert.ok(mock.requests.length >= 1);
  });
});

test('history maps AIMessage.tool_calls and ToolMessage to Responses items', async () => {
  await withModel({}, {}, async (model, mock) => {
    const history = [
      new SystemMessage('You are helpful.'),
      new HumanMessage('weather?'),
      new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } }] }),
      new ToolMessage({ content: '18C sunny', tool_call_id: 'call_1' }),
    ];
    await model.invoke(history);
    const sent = mock.requests.at(-1).input;
    assert.equal(sent[0].role, 'system');
    assert.equal(sent[1].role, 'user');
    assert.equal(sent[2].type, 'function_call');
    assert.equal(sent[2].call_id, 'call_1');
    assert.equal(sent[3].type, 'function_call_output');
    assert.equal(sent[3].output, '18C sunny');
  });
});

test('bindTools forwards a flattened xAI function tool', async () => {
  await withModel({ emitToolCall: true }, {}, async (model, mock) => {
    const bound = model.bindTools([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ]);
    await bound.invoke([new HumanMessage('weather?')]);
    const sentTools = mock.requests.at(-1).tools;
    assert.ok(Array.isArray(sentTools) && sentTools.length === 1);
    assert.equal(sentTools[0].type, 'function');
    assert.equal(sentTools[0].name, 'get_weather'); // flattened (not nested under .function)
    assert.ok(sentTools[0].parameters);
  });
});

test('long/over-budget history triggers compaction of the incoming messages', async () => {
  await withModel({}, { compactAtTokens: 50 }, async (model, mock) => {
    // A multi-message history estimated well over 50 tokens -> compaction on first gen.
    const history = [
      new HumanMessage('This is a reasonably long first user message to exceed the tiny budget.'),
      new AIMessage('And a reasonably long assistant reply that adds more tokens to the context.'),
      new HumanMessage('Now the newest question that should follow the compacted context.'),
    ];
    await model.invoke(history);
    assert.equal(model.totalCompactions, 1);
    // The request that generated the answer must start with the compaction result.
    const sent = mock.requests.at(-1).input;
    assert.match(sent[0].content ?? '', /^\[COMPACTED:/); // string-mock compaction => user message
    assert.ok(model.estimatedTokensSaved > 0);
  });
});

test('compactEvery schedule compacts every Nth generation', async () => {
  await withModel({}, { compactEvery: 2 }, async (model) => {
    const hist = () => [new HumanMessage('a'), new AIMessage('b'), new HumanMessage('c')];
    await model.invoke(hist()); // gen 1
    assert.equal(model.totalCompactions, 0);
    await model.invoke(hist()); // gen 2 -> compaction
    assert.equal(model.totalCompactions, 1);
  });
});
