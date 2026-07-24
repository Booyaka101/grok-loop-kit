import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GrokLoopClient } from '../dist/index.js';
import { createMockServer } from './mock-server.mjs';

/** Spin up the mock, run `fn` with a configured client, always close the server. */
async function withClient(opts, fn) {
  const mock = createMockServer(opts.mock);
  const port = await mock.listen();
  const client = new GrokLoopClient('test-key', {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    ...opts.client,
  });
  try {
    await fn(client, mock);
  } finally {
    await mock.close();
  }
}

test('20-turn loop compacts exactly at turn 8 and turn 16', async () => {
  await withClient({}, async (client, mock) => {
    /** turn number -> compactions performed by the end of that turn */
    const compactionAfterTurn = [];

    for (let turn = 1; turn <= 20; turn++) {
      const before = client.totalCompactions;
      const res = await client.sendMessage(`user message ${turn}`);

      // The completion carries the bookkeeping field.
      assert.ok(res._grokLoopKit, 'completion has _grokLoopKit');
      assert.equal(res._grokLoopKit.totalCompactions, client.totalCompactions);

      if (client.totalCompactions > before) {
        compactionAfterTurn.push(turn);
        // messages.length resets on compaction: a single compacted user message.
        assert.equal(client.messages.length, 1, `messages reset after compaction at turn ${turn}`);
        assert.match(client.messages[0].content, /^\[COMPACTED:/);
        assert.equal(res._grokLoopKit.turnsSinceCompact, 0, 'turnsSinceCompact is 0 on a compaction turn');
      }
    }

    // Compaction happened ONLY at turns 8 and 16.
    assert.deepEqual(compactionAfterTurn, [8, 16]);
    // Exactly two compactions total.
    assert.equal(client.totalCompactions, 2);
    assert.equal(client.totalCompactions, mock.calls.compact);
    // 20 completion calls, 2 compact calls.
    assert.equal(mock.calls.responses, 20);
    assert.equal(mock.calls.compact, 2);
    // Estimated savings accrued.
    assert.ok(client.estimatedTokensSaved > 0, 'estimatedTokensSaved > 0');
  });
});

test('compact request carries the full pre-compaction transcript', async () => {
  await withClient({}, async (client, mock) => {
    for (let i = 1; i <= 8; i++) await client.sendMessage(`m${i}`);
    const compactReq = mock.requests.find((r) => r.path === '/responses/compact');
    assert.ok(compactReq, 'a compaction request was made');
    // 8 user + 8 assistant messages folded in.
    assert.equal(compactReq.input.length, 16);
  });
});

test('token budget triggers compaction when rendered context exceeds the threshold', async () => {
  // Context grows ~60 tokens/message; with a 250-token budget the rendered
  // context crosses the threshold at turn 3 (before the turn-count boundary).
  await withClient({ client: { compactAtTokens: 250 } }, async (client) => {
    await client.sendMessage('t1'); // ctx ~1 msg -> ~90 tok, under 250
    assert.equal(client.totalCompactions, 0);
    await client.sendMessage('t2'); // ctx ~3 msgs -> ~210 tok, under 250
    assert.equal(client.totalCompactions, 0);
    await client.sendMessage('t3'); // ctx ~5 msgs -> ~330 tok, over 250 -> compact
    assert.equal(client.totalCompactions, 1);
    assert.equal(client.messages.length, 1);
    assert.equal(client.accumulatedTokens, 0, 'accumulatedTokens reset after compaction');
  });
});

test('turnsSinceCompact counts up between compactions', async () => {
  await withClient({}, async (client) => {
    const r1 = await client.sendMessage('a');
    assert.equal(r1._grokLoopKit.turnsSinceCompact, 1);
    const r2 = await client.sendMessage('b');
    assert.equal(r2._grokLoopKit.turnsSinceCompact, 2);
  });
});

test('real-API compaction items are spread back into input VERBATIM', async () => {
  await withClient({ mock: { compactionArrayOutput: true } }, async (client, mock) => {
    for (let i = 1; i <= 8; i++) await client.sendMessage(`m${i}`);
    // After compaction the transcript is the verbatim compaction item, untouched.
    assert.equal(client.messages.length, 1);
    assert.deepEqual(client.messages[0], {
      type: 'compaction',
      id: 'cmp_mock_1',
      encrypted_content: 'enc(16)',
    });
    // The 9th turn must send that compaction item back verbatim, then the user msg.
    await client.sendMessage('m9');
    const lastResponses = mock.requests.filter((r) => r.path === '/responses').at(-1);
    assert.equal(lastResponses.input[0].type, 'compaction');
    assert.equal(lastResponses.input[0].encrypted_content, 'enc(16)');
    assert.equal(lastResponses.input.at(-1).role, 'user');
  });
});

test('tool calls: assistant output items preserved and tool outputs threaded', async () => {
  await withClient({ mock: { emitToolCall: true } }, async (client, mock) => {
    const tools = [{ type: 'function', function: { name: 'get_weather' } }];
    const res = await client.sendMessage('weather in Tokyo?', tools);
    const calls = client.getToolCalls(res);
    assert.equal(calls.length, 1, 'a tool call was surfaced');
    assert.equal(calls[0].name, 'get_weather');

    // The function_call item is preserved verbatim in the transcript.
    assert.ok(
      client.messages.some((m) => m.type === 'function_call'),
      'function_call retained in transcript',
    );

    // Submit the result; it is threaded back as function_call_output.
    await client.sendToolOutputs([{ call_id: calls[0].call_id, output: '18C sunny' }], tools);
    const lastReq = mock.requests.filter((r) => r.path === '/responses').at(-1);
    assert.ok(
      lastReq.input.some((i) => i.type === 'function_call_output' && i.output === '18C sunny'),
      'tool output sent back to the API',
    );
    // Two model round-trips => turnCount 2.
    assert.equal(client.turnCount, 2);
  });
});

test('retries transient 429s and still succeeds', async () => {
  await withClient(
    { client: { retryBaseMs: 1 }, mock: { failFirst: 2, failStatus: 429 } },
    async (client, mock) => {
      const res = await client.sendMessage('hi');
      assert.ok(res.output, 'got a completion after retries');
      assert.equal(mock.calls.failed, 2, 'first two attempts failed then recovered');
    },
  );
});

test('gives up after maxRetries and throws', async () => {
  await withClient(
    { client: { retryBaseMs: 1, maxRetries: 1 }, mock: { failFirst: 5, failStatus: 503 } },
    async (client) => {
      await assert.rejects(() => client.sendMessage('hi'), /failed 503/);
    },
  );
});

test('streamMessage delivers tokens and still compacts on schedule', async () => {
  await withClient({}, async (client, mock) => {
    let compactions = 0;
    for (let turn = 1; turn <= 8; turn++) {
      const tokens = [];
      const res = await client.streamMessage(`m${turn}`, { onToken: (d) => tokens.push(d) });
      // Deltas concatenate to the final assistant text.
      const joined = tokens.join('');
      assert.ok(joined.length > 0, `turn ${turn} streamed some tokens`);
      assert.equal(joined, res.output[0].content[0].text, 'deltas match final text');
      compactions = res._grokLoopKit.totalCompactions;
    }
    // Same cadence as sendMessage: compaction at turn 8.
    assert.equal(compactions, 1);
    assert.equal(client.messages.length, 1);
    assert.ok(mock.calls.responses >= 8);
  });
});

test('streaming and non-streaming can be mixed in one loop', async () => {
  await withClient({}, async (client) => {
    await client.sendMessage('plain');
    const r = await client.streamMessage('streamed');
    assert.equal(client.turnCount, 2);
    assert.ok(r.output[0].content[0].text.includes('#2'));
  });
});

test('onCompact hook fires with drop count and turn', async () => {
  const events = [];
  await withClient(
    { client: { onCompact: (e) => events.push(e) } },
    async (client) => {
      for (let i = 1; i <= 16; i++) await client.sendMessage(`m${i}`);
      assert.equal(events.length, 2);
      assert.equal(events[0].totalCompactions, 1);
      assert.equal(events[0].atTurn, 8);
      assert.ok(events[0].droppedMessageCount > 0);
      assert.equal(events[1].atTurn, 16);
    },
  );
});

test('reasoning items are preserved verbatim in the transcript', async () => {
  await withClient({ mock: { emitReasoning: true } }, async (client) => {
    const res = await client.sendMessage('think then answer');
    // Text is still extracted from the message item...
    assert.match(res.output.find((o) => o.type === 'message').content[0].text, /Assistant reply/);
    // ...and the reasoning item is retained in the transcript for the next call.
    assert.ok(client.messages.some((m) => m.type === 'reasoning'), 'reasoning kept in transcript');
  });
});

test('refusal content is surfaced as text', async () => {
  await withClient({ mock: { emitRefusal: true } }, async (client) => {
    const res = await client.sendMessage('do something disallowed');
    const { extractAssistantText } = await import('../dist/index.js');
    assert.equal(extractAssistantText(res), 'I cannot help with that.');
  });
});

test('incomplete status is surfaced, not swallowed', async () => {
  await withClient({ mock: { statusIncomplete: true } }, async (client) => {
    const res = await client.sendMessage('long answer');
    assert.equal(res.status, 'incomplete');
  });
});

test('extraBody is merged into the request body', async () => {
  await withClient(
    { client: { extraBody: { temperature: 0.3 } } },
    async (client, mock) => {
      await client.sendMessage('hi', undefined, { extraBody: { max_output_tokens: 128 } });
      const body = mock.requests.at(-1).body;
      assert.equal(body.temperature, 0.3, 'client-level extraBody applied');
      assert.equal(body.max_output_tokens, 128, 'per-call extraBody applied');
    },
  );
});

test('getState/loadState round-trips a conversation across clients', async () => {
  await withClient({}, async (client, mock) => {
    for (let i = 1; i <= 5; i++) await client.sendMessage(`m${i}`);
    const snapshot = JSON.parse(JSON.stringify(client.getState())); // serializable

    // Resume in a fresh client pointed at the same mock.
    const { GrokLoopClient } = await import('../dist/index.js');
    const resumed = new GrokLoopClient('test-key', {
      baseUrl: client.baseUrl,
    });
    resumed.loadState(snapshot);
    assert.equal(resumed.turnCount, 5);
    assert.equal(resumed.messages.length, client.messages.length);

    // Continuing advances the resumed state correctly.
    await resumed.sendMessage('m6');
    assert.equal(resumed.turnCount, 6);
  });
});

test('reset clears state but keeps configuration', async () => {
  await withClient({}, async (client) => {
    for (let i = 1; i <= 3; i++) await client.sendMessage(`m${i}`);
    client.reset();
    assert.equal(client.turnCount, 0);
    assert.equal(client.messages.length, 0);
    assert.equal(client.totalCompactions, 0);
    // Still usable after reset.
    await client.sendMessage('again');
    assert.equal(client.turnCount, 1);
  });
});

test('per-call AbortSignal cancels the request', async () => {
  await withClient({}, async (client) => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => client.sendMessage('hi', undefined, { signal: ac.signal }));
  });
});
