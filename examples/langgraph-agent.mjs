/**
 * Runnable example: a real LangGraph createReactAgent driven by GrokLoopChatModel,
 * against the bundled mock (no API key). Needs the dev deps installed:
 *   npm install @langchain/core @langchain/langgraph zod
 * Run: node examples/langgraph-agent.mjs
 */
import { GrokLoopChatModel } from '../dist/langgraph.js';
import { createMockServer } from '../test/mock-server.mjs';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';

const mock = createMockServer({ emitToolCall: true });
const port = await mock.listen();

const model = new GrokLoopChatModel({
  apiKey: 'demo-key',
  grokLoop: { baseUrl: `http://127.0.0.1:${port}/v1`, compactEvery: 8 },
});

const getWeather = tool(async ({ city }) => `It is 18°C and sunny in ${city}.`, {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  schema: z.object({ city: z.string() }),
});

const agent = createReactAgent({ llm: model, tools: [getWeather] });
const result = await agent.invoke({ messages: [new HumanMessage('What is the weather in Tokyo?')] });

for (const m of result.messages) {
  console.log(`${m.getType().padEnd(6)} | ${String(m.content).slice(0, 70)}${m.tool_calls?.length ? `  ->calls: ${m.tool_calls.map((t) => t.name)}` : ''}`);
}
console.log('\nadapter meta:', model.lastMeta);
await mock.close();
