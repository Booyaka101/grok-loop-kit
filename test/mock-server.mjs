/**
 * Self-contained mock of xAI's Responses API for grok-loop-kit tests.
 *
 * Mirrors the doc-accurate shape of grokscope's mock
 * (D:\Repos\ideas\grokscope\test\mock-server.mjs) for POST /v1/responses, and
 * ADDS the compaction endpoint the brief specifies:
 *
 *   POST /v1/responses/compact
 *     -> { output: '[COMPACTED: {N} turns condensed]', usage: { input_tokens: floor(N/4) } }
 *
 * where N is the number of messages in the request `input` array.
 *
 * We keep our own copy inside the package (rather than editing the sibling
 * grokscope repo) so the test suite is hermetic and has no cross-repo coupling.
 */

import http from 'node:http';

export function createMockServer(opts = {}) {
  // Per-request usage. By default input_tokens SCALES with context size (~60
  // tokens/message) so the token-budget trigger can be exercised realistically;
  // magnitudes stay well under 8000 for the turn-count acceptance test. Tests can
  // pin fixed values via opts.inputTokens / opts.outputTokens.
  const usageFor = (input) => ({
    input: opts.inputTokens ?? 60 * (Array.isArray(input) ? input.length : 1),
    output: opts.outputTokens ?? 30,
  });

  const calls = { responses: 0, compact: 0, failed: 0 };
  /** Records: { path, input } for every accepted POST. */
  const requests = [];
  // opts.failFirst: fail the first N POSTs with a retryable status (exercises retry).
  let toFail = opts.failFirst ?? 0;

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    if (!/^Bearer .+/.test(req.headers.authorization ?? '')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'missing or invalid bearer token' } }));
      return;
    }
    if (toFail > 0) {
      toFail -= 1;
      calls.failed += 1;
      const headers = { 'content-type': 'application/json' };
      if (!opts.failNoRetryAfter) headers['retry-after'] = '0';
      res.writeHead(opts.failStatus ?? 429, headers);
      res.end(JSON.stringify({ error: { message: 'transient failure (mock)' } }));
      return;
    }

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
        return;
      }

      // --- POST /v1/responses/compact ---
      if (req.url?.endsWith('/responses/compact')) {
        const n = Array.isArray(body.input) ? body.input.length : 0;
        calls.compact += 1;
        requests.push({ path: '/responses/compact', input: body.input });
        // opts.compactionArrayOutput mimics the REAL API: a verbatim compaction
        // item with encrypted_content. Default mimics the brief's string form.
        const output = opts.compactionArrayOutput
          ? [
              {
                type: 'compaction',
                id: `cmp_mock_${calls.compact}`,
                encrypted_content: `enc(${n})`,
              },
            ]
          : `[COMPACTED: ${n} turns condensed]`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `cmp_mock_${calls.compact}`,
            object: 'response.compaction',
            created_at: 0,
            model: body.model,
            output,
            // Doc semantics: input_tokens = pre-compaction conversation tokens,
            // output_tokens = compacted record size, dropped_message_count = folded msgs.
            usage: {
              input_tokens: n * 50,
              output_tokens: Math.max(8, Math.floor(n / 2)),
              total_tokens: n * 50 + Math.max(8, Math.floor(n / 2)),
              dropped_message_count: n,
            },
          }),
        );
        return;
      }

      // --- POST /v1/responses ---
      if (req.url?.endsWith('/responses')) {
        if (!Array.isArray(body.input) || body.input.length === 0) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'input array missing' } }));
          return;
        }
        calls.responses += 1;
        requests.push({ path: '/responses', input: body.input, tools: body.tools, body });
        const turn = calls.responses;

        // opts.emitToolCall: emit a function_call when the latest input item is a
        // user message; otherwise (a tool result came back) emit a normal message.
        const lastItem = body.input[body.input.length - 1];
        const wantToolCall = opts.emitToolCall && lastItem?.type !== 'function_call_output';

        // Build the message item's content: refusal, or normal output_text.
        const messageContent = opts.emitRefusal
          ? [{ type: 'refusal', refusal: 'I cannot help with that.' }]
          : [
              {
                type: 'output_text',
                text: `Assistant reply #${turn} (context has ${body.input.length} messages).`,
                annotations: [],
              },
            ];

        let output = wantToolCall
          ? [{ type: 'function_call', id: `fc_${turn}`, call_id: `call_${turn}`, name: 'get_weather', arguments: '{"city":"Tokyo"}' }]
          : [{ type: 'message', role: 'assistant', content: messageContent }];

        // opts.emitReasoning: prepend a reasoning item (must be preserved verbatim).
        if (opts.emitReasoning) {
          output = [{ type: 'reasoning', id: `rs_${turn}`, summary: [] }, ...output];
        }

        const u = usageFor(body.input);
        const full = {
          id: `resp_mock_${turn}`,
          object: 'response',
          status: opts.statusIncomplete ? 'incomplete' : 'completed',
          created_at: 0,
          model: body.model,
          output,
          usage: {
            input_tokens: u.input,
            output_tokens: u.output,
            total_tokens: u.input + u.output,
          },
        };

        // Streaming: emit SSE text deltas then a terminal response.completed event.
        if (body.stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const text = output[0]?.content?.[0]?.text ?? '';
          const chunks = text ? text.match(/.{1,12}/gs) ?? [text] : [];
          for (const delta of chunks) {
            res.write('event: response.output_text.delta\n');
            res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`);
          }
          res.write('event: response.completed\n');
          res.write(`data: ${JSON.stringify({ type: 'response.completed', response: full })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(full));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });

  return {
    calls,
    requests,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Standalone demo: `node test/mock-server.mjs`
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  createMockServer()
    .listen()
    .then((port) => console.log(`Mock xAI Responses API on http://127.0.0.1:${port}/v1`));
}
