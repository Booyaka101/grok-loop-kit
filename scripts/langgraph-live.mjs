/**
 * LIVE test of the LangGraph adapter against real Grok 4.5. Spends a few cents.
 *   XAI_API_KEY=xai-...  node scripts/langgraph-live.mjs
 * Needs: npm install @langchain/core @langchain/langgraph zod
 */
import { GrokLoopChatModel } from '../dist/langgraph.js';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { HumanMessage, isToolMessage } from '@langchain/core/messages';
import { z } from 'zod';

const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
if (!apiKey) {
  console.error('No XAI_API_KEY / GROK_API_KEY in env.');
  process.exit(1);
}

const model = new GrokLoopChatModel({ apiKey, grokLoop: { compactEvery: 8 } });

// 1) Plain invoke.
const reply = await model.invoke([new HumanMessage('Reply with exactly: PONG')]);
console.log('1) invoke ->', JSON.stringify(String(reply.content).trim()));

// 2) Real ReAct tool loop: the model must call the tool, we run it, it answers.
let toolWasCalled = false;
const getWeather = tool(
  async ({ city }) => {
    toolWasCalled = true;
    return `It is 12°C and raining in ${city}.`;
  },
  {
    name: 'get_weather',
    description: 'Get the current weather for a given city.',
    schema: z.object({ city: z.string() }),
  },
);

const agent = createReactAgent({ llm: model, tools: [getWeather] });
const out = await agent.invoke({
  messages: [new HumanMessage('Use the get_weather tool to tell me the weather in Paris, then answer in one sentence.')],
});

const final = out.messages[out.messages.length - 1];
const ranTool = out.messages.some((m) => isToolMessage(m));
console.log('2) react agent ->', JSON.stringify(String(final.content).trim().slice(0, 120)));
console.log('   tool executed:', ranTool && toolWasCalled);
console.log('   mentions 12°C/raining:', /12|rain/i.test(String(final.content)));

const pass =
  /PONG/.test(String(reply.content)) &&
  ranTool &&
  toolWasCalled &&
  /12|rain/i.test(String(final.content));
console.log(`\n=== LangGraph live: ${pass ? 'PASS ✅' : 'FAIL ❌'} ===`);
console.log('adapter meta:', model.lastMeta);
if (!pass) process.exitCode = 1;
