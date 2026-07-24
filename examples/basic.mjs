/**
 * Runnable example: a 20-turn agent loop with automatic compaction, against the
 * bundled mock (no API key needed). Run: `node examples/basic.mjs`
 *
 * For a real run, drop the mock and construct:
 *   new GrokLoopClient(process.env.XAI_API_KEY)   // defaults to https://api.x.ai/v1
 */
import { GrokLoopClient } from '../dist/index.js';
import { createMockServer } from '../test/mock-server.mjs';

const mock = createMockServer();
const port = await mock.listen();

const client = new GrokLoopClient('demo-key', {
  baseUrl: `http://127.0.0.1:${port}/v1`,
  compactEvery: 8,
});

for (let turn = 1; turn <= 20; turn++) {
  const res = await client.sendMessage(`Tell me fact #${turn} about the ocean.`);
  const m = res._grokLoopKit;
  const flag = client.messages.length === 1 ? '  <-- COMPACTED (context reset)' : '';
  console.log(
    `turn ${String(turn).padStart(2)} | ctx msgs=${String(client.messages.length).padStart(2)} | ` +
      `compactions=${m.totalCompactions} | saved~${m.estimatedTokensSaved} tok${flag}`,
  );
}

await mock.close();
console.log('\nWithout grok-loop-kit the context would grow to ~40 messages; here it stays flat.');
