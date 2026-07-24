/**
 * LIVE smoke test against the real xAI API. THIS SPENDS MONEY (Grok 4.5 is
 * $2/$6 per 1M tokens; this run is a few hundred tokens, well under $0.01).
 *
 * grok-loop-kit itself never runs this for you — you run it, with YOUR funded
 * key, when you want to confirm real end-to-end behavior:
 *
 *   XAI_API_KEY=xai-...  node scripts/smoke-live.mjs
 *
 * It runs a 10-turn loop (compactEvery=4) so you see two real compactions and
 * the real `{type:'compaction', encrypted_content}` items flowing back in.
 */
import { GrokLoopClient } from '../dist/index.js';

const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
if (!apiKey) {
  console.error('No XAI_API_KEY / GROK_API_KEY in env. Set one and re-run.');
  console.error('(Grok grants no free credits — the key must belong to a funded team.)');
  process.exit(1);
}

const client = new GrokLoopClient(apiKey, {
  compactEvery: 4,
  model: process.env.GROK_MODEL || 'grok-4.5',
  onCompact: (e) =>
    console.log(`  · compaction #${e.totalCompactions} at turn ${e.atTurn}, dropped ${e.droppedMessageCount} msgs`),
});

const prompts = [
  'In one short sentence, name a color.',
  'Now name an animal, one sentence.',
  'A country, one sentence.',
  'A fruit, one sentence.',
  'A number between 1 and 10.',
  'A day of the week.',
  'A planet.',
  'A musical instrument.',
  'A sport.',
  'Summarize everything you have told me so far in one line.',
];

for (let i = 0; i < prompts.length; i++) {
  const res = await client.sendMessage(prompts[i]);
  const text = res.output?.find((o) => o.type === 'message')?.content?.[0]?.text ?? '(no text)';
  console.log(`turn ${i + 1}: ${text.trim().slice(0, 80)}`);
}

console.log('\n--- live smoke complete ---');
console.log('total compactions:', client.totalCompactions);
console.log('estimated tokens saved:', client.estimatedTokensSaved);
console.log('transcript size now:', client.messages.length, 'items');
