/**
 * HARD live test against the real xAI Responses API. Spends real money (small —
 * tiny prompts, no x_search; expect a few cents).
 *
 *   XAI_API_KEY=xai-...  node scripts/hardtest-live.mjs
 *
 * This is the test that actually proves the product works, not just that it runs:
 *
 *   A. NEEDLE RETENTION THROUGH COMPACTIONS — plant several unguessable secret
 *      codes early, run enough turns to force 3–4 real compactions, then demand
 *      exact recall. If compaction were lossy or the encrypted_content weren't
 *      fed back correctly, the model literally cannot know the codes. This is the
 *      core correctness proof.
 *   B. COMPACTION vs CONTROL — same conversation on a compacting client and a
 *      never-compacting one; compare per-turn input_tokens. Proves the context
 *      stays bounded (token savings) WHILE both still recall the needles (no
 *      fidelity loss).
 *   C. LIVE TOOL ROUND-TRIP — real function_call emitted by the model, executed,
 *      threaded back, and used in the final answer.
 *   D. LIVE STREAMING — real SSE deltas assembled into the final text.
 */
import { GrokLoopClient } from '../dist/index.js';

const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
if (!apiKey) {
  console.error('No XAI_API_KEY / GROK_API_KEY in env.');
  process.exit(1);
}
const model = process.env.GROK_MODEL || 'grok-4.5';

const results = [];
const rec = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// Unguessable needles: random label-code pairs the model cannot infer.
const rand = (n) => Math.floor(Math.random() * n);
const CODES = ['FALCON', 'VIOLET', 'GRANITE', 'NEBULA', 'ZEPHYR'].map((label) => ({
  label,
  code: `${rand(90000) + 10000}-${'QXZKVWJ'[rand(7)]}${'QXZKVWJ'[rand(7)]}${rand(900) + 100}`,
}));

// ~200-token padding so the raw transcript actually grows turn over turn —
// the regime where compaction is supposed to save tokens.
const PAD =
  ('The quarterly logistics review noted that regional throughput remained within ' +
    'expected variance while downstream inventory buffers absorbed the seasonal demand shift. ')
    .repeat(6);

async function needleTest(client, tag) {
  // Plant each needle in its own turn.
  for (const { label, code } of CODES) {
    await client.sendMessage(
      `Remember this exactly: the ${label} vault code is ${code}. Reply only "stored".`,
    );
  }
  // Filler turns carry a bulky payload to grow context and force compactions.
  const inputTokensPerTurn = [];
  for (let i = 0; i < 14; i++) {
    const r = await client.sendMessage(
      `Context note ${i + 1} (ignore, just reply "ok"): ${PAD}`,
    );
    inputTokensPerTurn.push(r.usage?.input_tokens ?? 0);
  }
  // Interrogate: ask for every code in one shot.
  const ask = await client.sendMessage(
    `Now recall the vault codes. For EACH of ${CODES.map((c) => c.label).join(', ')}, ` +
      `output one line "LABEL=CODE" using the exact codes I gave you earlier. No other text.`,
  );
  const text = ask.output?.find((o) => o.type === 'message')?.content?.[0]?.text ?? '';
  const found = CODES.filter(({ code }) => text.includes(code));
  const missing = CODES.filter(({ code }) => !text.includes(code)).map((c) => c.label);
  const pass = found.length === CODES.length;
  rec(
    `A. needle retention (${tag})`,
    pass,
    `${found.length}/${CODES.length} exact codes recalled after ${client.totalCompactions} compactions` +
      (missing.length ? ` [missing: ${missing.join(',')}]` : ''),
  );
  return { inputTokensPerTurn, recalledText: text, found: found.length };
}

async function main() {
  console.log(`\n=== HARD LIVE TEST (model=${model}) ===`);
  console.log(`needles: ${CODES.map((c) => `${c.label}=${c.code}`).join('  ')}\n`);

  // --- A + B: compacting client vs never-compacting control, same script ---
  const compacting = new GrokLoopClient(apiKey, {
    model,
    compactEvery: 5, // 5 needles + 14 filler + 1 ask = 20 turns => compactions at 5,10,15,20
    onCompact: (e) => console.log(`   · [compacting] compaction #${e.totalCompactions} at turn ${e.atTurn}, dropped ${e.droppedMessageCount}`),
  });
  // A TRUE control: never compacts (neither turn-count nor token budget fires).
  const control = new GrokLoopClient(apiKey, {
    model,
    compactEvery: 100000,
    compactAtTokens: Number.MAX_SAFE_INTEGER,
  });

  console.log('running compacting client...');
  const cRes = await needleTest(compacting, 'compacting');
  console.log('running control (no compaction) client...');
  const ctrlRes = await needleTest(control, 'control');

  // B: cumulative input-token cost over the 14 filler turns (the real cost metric).
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const cSum = sum(cRes.inputTokensPerTurn);
  const ctrlSum = sum(ctrlRes.inputTokensPerTurn);
  const cLast = cRes.inputTokensPerTurn.at(-1) ?? 0;
  const ctrlLast = ctrlRes.inputTokensPerTurn.at(-1) ?? 0;
  rec(
    'B. compaction cuts cumulative context cost vs control',
    cSum < ctrlSum,
    `cumulative filler input_tokens — compacting ${cSum} vs control ${ctrlSum} ` +
      `(${Math.round((1 - cSum / ctrlSum) * 100)}% less); last turn ${cLast} vs ${ctrlLast}`,
  );
  rec(
    'B. compaction preserved fidelity (both recall)',
    cRes.found === CODES.length && ctrlRes.found === CODES.length,
    `compacting ${cRes.found}/${CODES.length}, control ${ctrlRes.found}/${CODES.length}`,
  );
  rec(
    'B. reported savings > 0',
    compacting.estimatedTokensSaved > 0,
    `estimatedTokensSaved=${compacting.estimatedTokensSaved}`,
  );

  // --- C: live tool round-trip ---
  try {
    const toolClient = new GrokLoopClient(apiKey, { model });
    const tools = [
      {
        type: 'function',
        name: 'multiply',
        description: 'Multiply two integers a and b.',
        parameters: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
      },
    ];
    let res = await toolClient.sendMessage(
      'Use the multiply tool to compute 237 * 468. Call the tool; do not compute it yourself.',
      tools,
    );
    let calls = toolClient.getToolCalls(res);
    let emitted = calls.length > 0;
    let finalText = '';
    let steps = 0;
    while (calls.length && steps++ < 3) {
      const outputs = calls.map((c) => {
        const { a, b } = JSON.parse(c.arguments || '{}');
        return { call_id: c.call_id, output: String(a * b) };
      });
      res = await toolClient.sendToolOutputs(outputs, tools);
      calls = toolClient.getToolCalls(res);
    }
    finalText = res.output?.find((o) => o.type === 'message')?.content?.[0]?.text ?? '';
    rec(
      'C. live tool round-trip',
      emitted && finalText.includes('110916'),
      `model ${emitted ? 'emitted function_call' : 'did NOT call tool'}; final answer ${finalText.includes('110916') ? 'contains 110916 ✓' : 'missing product'} ("${finalText.trim().slice(0, 60)}")`,
    );
  } catch (e) {
    rec('C. live tool round-trip', false, `threw: ${e.message}`);
  }

  // --- D: live streaming ---
  try {
    const sc = new GrokLoopClient(apiKey, { model });
    const deltas = [];
    const res = await sc.streamMessage('Count from 1 to 10, space-separated, digits only.', {
      onToken: (d) => deltas.push(d),
    });
    const text = res.output?.find((o) => o.type === 'message')?.content?.[0]?.text ?? '';
    rec(
      'D. live streaming (SSE)',
      deltas.length > 1 && deltas.join('') === text && text.includes('10'),
      `${deltas.length} deltas, assembled==final:${deltas.join('') === text}, has "10":${text.includes('10')}`,
    );
  } catch (e) {
    rec('D. live streaming (SSE)', false, `threw: ${e.message}`);
  }

  // --- summary ---
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('harness error:', e);
  process.exit(1);
});
