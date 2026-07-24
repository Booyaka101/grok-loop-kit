/**
 * Runnable example: a tool-calling agent loop with automatic compaction.
 * The model asks for a tool, we execute it and feed the result back, and the
 * loop keeps compacting on schedule. Run: `node examples/tool-loop.mjs`
 */
import { GrokLoopClient } from '../dist/index.js';
import { createMockServer } from '../test/mock-server.mjs';

const mock = createMockServer({ emitToolCall: true });
const port = await mock.listen();

const client = new GrokLoopClient('demo-key', {
  baseUrl: `http://127.0.0.1:${port}/v1`,
  onCompact: (e) => console.log(`  · compaction #${e.totalCompactions} at turn ${e.atTurn}`),
});

const tools = [
  { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
];

// Fake tool registry.
const registry = { get_weather: (args) => `It is 18°C and sunny in ${JSON.parse(args).city}.` };

let res = await client.sendMessage('What is the weather in Tokyo?', tools);
let toolCalls = client.getToolCalls(res);

let step = 0;
while (toolCalls.length && step++ < 5) {
  console.log(`model requested tool(s): ${toolCalls.map((c) => c.name).join(', ')}`);
  const outputs = toolCalls.map((c) => ({
    call_id: c.call_id,
    output: registry[c.name]?.(c.arguments) ?? 'unknown tool',
  }));
  res = await client.sendToolOutputs(outputs, tools);
  toolCalls = client.getToolCalls(res);
}

console.log('final answer:', res.output?.[0]?.content?.[0]?.text ?? '(tool call pending)');
console.log('turns:', client.turnCount, '| compactions:', client.totalCompactions);
await mock.close();
