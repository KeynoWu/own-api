/**
 * 假上游：用于在没有真实 API Key 的情况下自测全链路。
 * 同时提供 OpenAI 与 Anthropic 两套接口，并按 key 前缀模拟故障以验证号池切换。
 *
 *   k-ok / k-good  -> 正常
 *   k-401          -> 始终 401（key 失效）
 *   k-429          -> 始终 429（限流，带 retry-after）
 *   k-500          -> 始终 500
 *   k-slow         -> 延迟 1.2s
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const PORT = Number(process.env.MOCK_PORT || 8099);

function fail(key: string): { status: number; body: any; retryAfter?: string } | undefined {
  if (key.includes('401')) return { status: 401, body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } } };
  if (key.includes('429')) return { status: 429, body: { error: { message: 'Rate limit reached', type: 'rate_limit_error' } }, retryAfter: '1' };
  if (key.includes('500')) return { status: 500, body: { error: { message: 'upstream boom' } } };
  return undefined;
}

const delay = (key: string) => (key.includes('slow20') ? new Promise((r) => setTimeout(r, 20_000)) : key.includes('slow') ? new Promise((r) => setTimeout(r, 1200)) : Promise.resolve());

/** 命中计数（按上游模型名）：断言"链停止扩展/断开不续链"用 GET /__hits */
const hits = new Map<string, number>();

function lastUser(messages: any[]): string {
  const m = [...(messages || [])].reverse().find((x) => x.role === 'user');
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => p.text || '').join('');
  return '';
}

const app = new Hono();

app.get('/v1/models', (c) => c.json({ object: 'list', data: ['mock-gpt-5', 'mock-gpt-mini', 'mock-o3'].map((id) => ({ id, object: 'model' })) }));
app.get('/v1/messages/models', (c) => c.json({ data: [{ id: 'mock-claude-sonnet' }, { id: 'mock-claude-opus' }] }));
app.get('/v1/messages', (c) => c.json({ data: [{ id: 'mock-claude-sonnet' }] }));

// ---------------- OpenAI ----------------
app.post('/v1/chat/completions', async (c) => {
  const key = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  const body = await c.req.json().catch(() => ({} as any));
  hits.set(String(body.model), (hits.get(String(body.model)) || 0) + 1); // 触达即计数：必须早于 delay/失败分支
  const bad = fail(key);
  if (bad) return c.json(bad.body, bad.status as any, bad.retryAfter ? { 'retry-after': bad.retryAfter } : {});
  if (body.model === 'mock-toolong')
    return c.json({ error: { message: "This model's maximum context length is 1000 tokens. However, your messages resulted in 5000 tokens.", type: 'invalid_request_error' } }, 400 as any);
  if (body.model === 'mock-404')
    return c.json({ error: { message: 'The model `mock-404` does not exist or you do not have access to it.' } }, 404 as any);
  if (body.model === 'mock-streamcut') {
    // 提交后掐流：先正常吐首块，然后流内报错（stage B 断言用）
    return new Response(
      new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder();
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'chatcmpl-cut', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '前' } }] })}\n\n`));
          ctrl.error(new Error('上游流中断（fixture）'));
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if (body.model === 'mock-slowstream') {
    // 慢流：首块立即吐（让网关提交），之后每 300ms 一块共 5 块——提交后客户端掐断测试用
    const enc = new TextEncoder();
    let n = 0;
    let iv: ReturnType<typeof setInterval>;
    const chunk = (o: any) => `data: ${JSON.stringify({ id: 'chatcmpl-slow', object: 'chat.completion.chunk', created: 1, model: body.model, ...o })}\n\n`;
    const stream = new ReadableStream({
      start(ctrl) {
        const send = () => {
          n++;
          if (n < 5) ctrl.enqueue(enc.encode(chunk({ choices: [{ index: 0, delta: { role: n === 1 ? 'assistant' : undefined, content: String(n) } }] })));
          else {
            clearInterval(iv);
            ctrl.enqueue(enc.encode(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }) + 'data: [DONE]\n\n'));
            ctrl.close();
          }
        };
        send();
        iv = setInterval(() => { try { send(); } catch { clearInterval(iv); } }, 300);
      },
      cancel() { clearInterval(iv); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }
  await delay(key);
  const prompt = lastUser(body.messages);
  const text = `mock(openai:${body.model}) 收到: ${prompt.slice(0, 40)}`;
  const tools = Array.isArray(body.tools) && body.tools.length && /工具|tool/i.test(prompt);

  if (body.stream) {
    return new Response(
      new ReadableStream({
        start(ctrl) {
          const e = (o: any) => ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(o)}\n\n`));
          const pieces = tools ? [''] : text.match(/.{1,6}/g) || [];
          e({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
          for (const p of pieces) e({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: p } }] });
          if (tools) {
            e({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] });
            e({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Hangzhou"}' } }] } }] });
          }
          e({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 17, total_tokens: 28 } });
          ctrl.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          ctrl.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }

  if (tools) {
    return c.json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hangzhou"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 11, completion_tokens: 17, total_tokens: 28 },
    });
  }
  return c.json({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 17, total_tokens: 28, prompt_tokens_details: { cached_tokens: 3 } },
  });
});

app.post('/v1/embeddings', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const n = Array.isArray(body.input) ? body.input.length : 1;
  return c.json({ object: 'list', data: Array.from({ length: n }, (_, i) => ({ object: 'embedding', index: i, embedding: [0.1, 0.2, 0.3] })), model: body.model, usage: { prompt_tokens: 5, total_tokens: 5 } });
});

// ---------------- Anthropic ----------------
app.post('/v1/messages', async (c) => {
  const key = c.req.header('x-api-key') || '';
  const body = await c.req.json().catch(() => ({} as any));
  hits.set(String(body.model), (hits.get(String(body.model)) || 0) + 1);
  const bad = fail(key);
  if (bad) return c.json({ type: 'error', error: { type: bad.status === 401 ? 'authentication_error' : 'api_error', message: bad.body.error.message } }, bad.status as any);
  await delay(key);
  const prompt = lastUser(body.messages);
  const text = `mock(anthropic:${body.model}) 收到: ${prompt.slice(0, 40)}`;
  const useTool = Array.isArray(body.tools) && body.tools.length && /工具|tool/i.test(prompt);

  if (body.stream) {
    return new Response(
      new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder();
          const e = (ev: string, o: any) => ctrl.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(o)}\n\n`));
          e('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], model: body.model, usage: { input_tokens: 9, output_tokens: 1 } } });
          e('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          if (useTool) {
            e('content_block_stop', { type: 'content_block_stop', index: 0 });
            e('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_mock', name: 'get_weather', input: {} } });
            e('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"Hangzhou"}' } });
            e('content_block_stop', { type: 'content_block_stop', index: 1 });
            e('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 21 } });
          } else {
            for (const p of text.match(/.{1,6}/g) || []) {
              e('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } });
            }
            e('content_block_stop', { type: 'content_block_stop', index: 0 });
            e('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 19 } });
          }
          e('message_stop', { type: 'message_stop' });
          ctrl.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }

  const content = useTool
    ? [{ type: 'text', text: '好的，我来查' }, { type: 'tool_use', id: 'toolu_mock', name: 'get_weather', input: { city: 'Hangzhou' } }]
    : [{ type: 'text', text }];
  return c.json({
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: useTool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 9, output_tokens: 19, cache_read_input_tokens: 2 },
  });
});

app.get('/__hits', (c) => c.json(Object.fromEntries(hits)));
app.post('/__hits/reset', (c) => {
  hits.clear();
  return c.json({ ok: true });
});
app.get('/healthz', (c) => c.json({ ok: true, mock: true }));

if (process.argv[1]?.includes('mock-upstream')) {
  serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
    console.log(`[mock-upstream] http://127.0.0.1:${info.port}  (OpenAI: /v1/chat/completions, Anthropic: /v1/messages)`);
  });
}

export { app as mockApp, PORT as MOCK_PORT };
