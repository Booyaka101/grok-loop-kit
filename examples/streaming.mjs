/**
 * Runnable example: streaming tokens with automatic compaction, against the
 * bundled mock (no API key needed). Run: `node examples/streaming.mjs`
 */
import { GrokLoopClient } from '../dist/index.js';
import { createMockServer } from '../test/mock-server.mjs';

const mock = createMockServer();
const port = await mock.listen();

const client = new GrokLoopClient('demo-key', {
  baseUrl: `http://127.0.0.1:${port}/v1`,
  compactEvery: 4,
  onCompact: (e) => process.stdout.write(`\n[compaction #${e.totalCompactions} at turn ${e.atTurn}]\n`),
});

for (let turn = 1; turn <= 8; turn++) {
  process.stdout.write(`turn ${turn}: `);
  await client.streamMessage(`Tell me fact #${turn}.`, {
    onToken: (delta) => process.stdout.write(delta),
  });
  process.stdout.write('\n');
}

await mock.close();
console.log(`\ndone — ${client.totalCompactions} compactions, transcript now ${client.messages.length} items`);
