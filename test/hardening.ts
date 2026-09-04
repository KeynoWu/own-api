/**
 * 加固回归用例：把代码审查中发现的每个真实缺陷固化成断言。
 * 用"脏上游"（不声明 content-type、用 JSON 冒充流式、CRLF 分帧、卡死、离谱 Retry-After）
 * 覆盖 e2e 里"理想上游"照顾不到的路径。
 * 运行：npm run test:hard
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'llm-hard-'));
process.env.LLM_DATA_DIR = DATA;
process.env.LLM_ADMIN_TOKEN = 'hard-admin';
delete process.env.LLM_DEBUG_HEADERS;

const { createApp } = await import('../src/app.ts');
const { store } = await import('../src/store.ts');

// ============================ 脏上游 ============================
const dirty = new Hono();
const enc = new TextEncoder();
/** 上游真实收到的请求体，供断言检查 */
const echoed: any = {};
/** 各路径上游生成了多少块，用于验证断开后是否停止计费 */
const generated: Record<string, number> = {};
const cancelled: Record<string, boolean> = {};

const sseResponse = (frames: () => Iterable<string>, contentType?: string) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames()) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    contentType === null ? undefined : { headers: { 'content-type': contentType || 'text/event-stream' } },
  );

// 1) CRLF 分帧的 Anthropic 流
dirty.post('/crlf/v1/messages', () => {
  const ev = (e: string, d: any) => `event: ${e}\r\ndata: ${JSON.stringify(d)}\r\n\r\n`;
  return sseResponse(() => [
    ev('message_start', { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 1 } } }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CRLF内容' } }),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
    ev('message_stop', { type: 'message_stop' }),
  ]);
});
dirty.get('/crlf/v1/messages', (c) => c.json({ data: [] }));

// 2) 客户端要流式，上游只回 application/json
const jsonAsSSE = (c: any) =>
  c.json({
    id: 'chatcmpl-j',
    object: 'chat.completion',
    model: 'mock-gpt-5',
    choices: [{ index: 0, message: { role: 'assistant', content: 'JSON冒充流式' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
  });
dirty.post('/jsonstream/v1/chat/completions', jsonAsSSE);
dirty.get('/jsonstream/v1/chat/completions', (c) => c.json({ data: [] }));

// 3) 声明成 text/plain 的真 SSE（content-type 不可信）
dirty.post('/plain/v1/chat/completions', () => {
  const f = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
  return sseResponse(
    () => [
      f({ id: 'p1', object: 'chat.completion.chunk', model: 'mock-gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
      f({ id: 'p1', object: 'chat.completion.chunk', model: 'mock-gpt-5', choices: [{ index: 0, delta: { content: '纯文本类型的流' } }] }),
      f({ id: 'p1', object: 'chat.completion.chunk', model: 'mock-gpt-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
      'data: [DONE]\n\n',
    ],
    'text/plain; charset=utf-8',
  );
});
dirty.get('/plain/v1/chat/completions', (c) => c.json({ data: [] }));

// 4) 429 + 离谱 Retry-After
dirty.post('/huge/v1/messages', (c) => c.json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after': '999999' }));
dirty.get('/huge/v1/messages', (c) => c.json({ data: [] }));

// 5) Anthropic 缓存语义：input_tokens 不含缓存部分
dirty.post('/cache/v1/messages', () =>
  new Response(
    JSON.stringify({
      id: 'm', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'cached answer' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, cache_read_input_tokens: 8000, output_tokens: 100 },
    }),
    { headers: { 'content-type': 'application/json' } },
  ),
);
dirty.get('/cache/v1/messages', (c) => c.json({ data: [] }));

// 6) 200 后卡死不发数据
dirty.post('/stall/v1/messages', () => {
  const ev = 'event: message_start\ndata: {"type":"message_start","message":{"id":"s","role":"assistant","content":[],"usage":{}}}\n\n';
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(ev));
        // 之后永不 enqueue / close
      },
      cancel() {
        cancelled.stall = true;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
});
dirty.get('/stall/v1/messages', (c) => c.json({ data: [] }));

// 7) 慢速流：每 80ms 一块，共 40 块，验证客户端断开后是否停止生成
const slowSSE = (kind: string, frame: (i: number) => string) =>
  new Response(
    new ReadableStream({
      start(c) {
        let i = 0;
        const t = setInterval(() => {
          if (i++ >= 40) {
            clearInterval(t);
            try {
              c.close();
            } catch {
              /* noop */
            }
            return;
          }
          generated[kind] = i;
          try {
            c.enqueue(enc.encode(frame(i)));
          } catch {
            clearInterval(t);
          }
        }, 80);
      },
      cancel() {
        cancelled[kind] = true;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
dirty.post('/slow/v1/chat/completions', () =>
  slowSSE('slowOai', (i) => `data: ${JSON.stringify({ id: 's', object: 'chat.completion.chunk', model: 'tee', choices: [{ index: 0, delta: { content: 'x' + i } }] })}\n\n`),
);
dirty.get('/slow/v1/chat/completions', (c) => c.json({ data: [] }));
dirty.post('/slow/v1/messages', () => slowSSE('slowAnt', (i) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'y' + i } })}\n\n`));
dirty.get('/slow/v1/messages', (c) => c.json({ data: [] }));

// 7b) 慢速 JSON（sniff 判 JSON、正文滴落）：M4 sniff/下载窗取消复查的用例夹具
dirty.post('/slowjson/v1/chat/completions', () => {
  const parts = ['{"id":"j","object":"chat.completion","model":"jx","choices":[{"index":0,"message":{"role":"assistant","content":"', '慢慢下载'.repeat(300), '"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":17,"total_tokens":28}}'];
  let i = 0;
  return new Response(
    new ReadableStream({
      start(c) {
        const t = setInterval(() => {
          if (i >= parts.length) {
            clearInterval(t);
            try {
              c.close();
            } catch {
              /* noop */
            }
            return;
          }
          try {
            c.enqueue(enc.encode(parts[i++]));
          } catch {
            clearInterval(t);
          }
        }, 200);
      },
      cancel() {
        cancelled.slowjson = true;
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
});
dirty.get('/slowjson/v1/chat/completions', (c) => c.json({ data: [] }));

// 8) 回显上游：把收到的请求体原样返回
dirty.post('/echo/v1/chat/completions', async (c) => {
  const b = await c.req.json();
  echoed.chat = b;
  return c.json({ id: 'e', object: 'chat.completion', model: b.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(b) }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
});
dirty.get('/echo/v1/chat/completions', (c) => c.json({ data: [] }));
dirty.post('/echo/v1/messages', async (c) => {
  const b: any = await c.req.json();
  echoed.msg = b;
  return c.json({ id: 'e', type: 'message', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(b) }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } });
});
dirty.get('/echo/v1/messages', (c) => c.json({ data: [] }));

// 9) 200 但响应体不是 JSON 对象（null / 标量）：网关必须协议内报错，不得未捕获异常
dirty.post('/nulljson/v1/chat/completions', () => new Response('null', { headers: { 'content-type': 'application/json' } }));
dirty.get('/nulljson/v1/chat/completions', (c) => c.json({ data: [] }));
dirty.post('/scalarjson/v1/chat/completions', () => new Response('123', { headers: { 'content-type': 'application/json' } }));
dirty.get('/scalarjson/v1/chat/completions', (c) => c.json({ data: [] }));

// 10) 永远 401 的渠道：验证失败重试计数 x-lm-retries 默认不外泄
dirty.post('/deny/v1/chat/completions', (c) => c.json({ error: { message: 'bad key' } }, 401));
dirty.get('/deny/v1/chat/completions', (c) => c.json({ data: [] }));

// 11) 带缓存明细的 OpenAI 上游：Anthropic 客户端侧的 usage 口径
dirty.post('/cacheoai/v1/chat/completions', (c) =>
  c.json({
    id: 'x', object: 'chat.completion', model: 'x',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 80 } },
  }),
);
dirty.get('/cacheoai/v1/chat/completions', (c) => c.json({ data: [] }));

const dirtyServer = serve({ fetch: dirty.fetch, port: 19099, hostname: '127.0.0.1' });
const gwServer = serve({ fetch: createApp().fetch, port: 19199, hostname: '127.0.0.1' });
await new Promise((r) => setTimeout(r, 300));

// ============================ 断言骨架 ============================
const BASE = 'http://127.0.0.1:19199';
const ADMIN = { 'x-admin-token': 'hard-admin', 'content-type': 'application/json' };
const VKEY = store.listVKeys()[0].key;
let pass = 0;
let failCount = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failCount++;
    failures.push(`${name} ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name} \x1b[2m${detail}\x1b[0m`);
  }
}
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function api(path: string, init: any = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 保留原文 */
  }
  return { status: res.status, headers: res.headers, body };
}
const post = (p: string, body: any, h: any = {}) => api(p, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, ...h }, body: JSON.stringify(body) });
const admin = (p: string, method = 'GET', body?: any) => api(p, { method, headers: ADMIN, body: body ? JSON.stringify(body) : undefined });

async function readAll(res: Response) {
  const reader = res.body!.getReader();
  let buf = '';
  const events: { event?: string; data: any }[] = [];
  let raw = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const t = new TextDecoder().decode(value);
    raw += t;
    buf += t.replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event: string | undefined;
      const datas: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) datas.push(line.slice(5).trim());
      }
      if (datas.length) events.push({ event, data: datas.join('\n') === '[DONE]' ? '[DONE]' : safeJson(datas.join('\n')) });
    }
  }
  return { events, raw };
}
function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ============================ 夹具 ============================
const mkChannel = async (name: string, path: string, protocol: 'openai' | 'anthropic', extra: any = {}) => {
  const ch = (await admin('/api/channels', 'POST', { name, baseUrl: `http://127.0.0.1:19099/${path}`, protocol, keys: ['k-ok'], ...extra })).body;
  return ch;
};
const mkModel = async (publicName: string, channelId: string, upstreamModel: string, extra: any = {}) =>
  (await admin('/api/models', 'POST', { publicName, channelId, upstreamModel, ...extra })).body;

// ============================ 1. SSE 分帧与类型嗅探 ============================
section('1. SSE 分帧与响应类型嗅探');
{
  const ch = await mkChannel('CRLF', 'crlf', 'anthropic');
  await mkModel('h-crlf', ch.id, 'x');
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h-crlf', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const { events } = await readAll(res);
  const text = events.map((e) => e.data?.choices?.[0]?.delta?.content || '').join('');
  check('CRLF 分帧的 SSE 内容不丢（审查探针1）', text === 'CRLF内容', `got "${text}"`);
  check('CRLF 流以 [DONE] 收尾', events.at(-1)?.data === '[DONE]', JSON.stringify(events.at(-1)));
  check('CRLF 流拿到 usage', events.some((e) => e.data?.usage?.completion_tokens === 7), JSON.stringify(events.at(-2)?.data?.usage));
}
{
  const ch = await mkChannel('Plain', 'plain', 'openai');
  await mkModel('h-plain', ch.id, 'other-name'); // 别名不同 => 走逐帧改写，同样要能识别流
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h-plain', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const { events } = await readAll(res);
  const text = events.map((e) => e.data?.choices?.[0]?.delta?.content || '').join('');
  check('上游 content-type=text/plain 的真流仍被当流处理', text === '纯文本类型的流', `got "${text}"`);
  check('别名改写后 model 不泄漏上游名', events.every((e) => !e.data?.model || e.data.model === 'h-plain'), JSON.stringify(events[0]?.data?.model));
}
{
  const ch = await mkChannel('JSONStream', 'jsonstream', 'openai');
  await mkModel('h-json', ch.id, 'mock-gpt-5');
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h-json', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const ct = res.headers.get('content-type') || '';
  const { events } = await readAll(res);
  const text = events.map((e) => e.data?.choices?.[0]?.delta?.content || '').join('');
  check('上游用 JSON 冒充流式时不返回空响应（审查探针2）', text === 'JSON冒充流式', `got "${text}"`);
  check('合成流仍是合法 SSE', ct.includes('text/event-stream') && events.at(-1)?.data === '[DONE]', ct);
  const logs: any = await admin('/api/logs?limit=1');
  check('该请求 token 被正确记账（不是 0）', logs.body[0]?.promptTokens === 12 && logs.body[0]?.completionTokens === 34, JSON.stringify({ p: logs.body[0]?.promptTokens, c: logs.body[0]?.completionTokens }));
}

// ============================ 2. 超时护栏 ============================
section('2. 超时护栏');
{
  await admin('/api/settings', 'PATCH', { upstreamIdleTimeoutMs: 1200 });
  const ch = await mkChannel('Stall', 'stall', 'anthropic');
  await mkModel('h-stall', ch.id, 'x');
  const t0 = Date.now();
  let raw = '';
  let outcome = 'hang';
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h-stall', stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
    // 6 秒内必须收尾，否则视为挂死
    raw = await Promise.race([
      new Response(res.body).text(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('hang')), 6000)),
    ]) as string;
    outcome = 'ended';
  } catch {
    outcome = 'threw';
  }
  const cost = Date.now() - t0;
  check(`上游 200 后卡死会被空闲超时切断（审查探针6，耗时 ${cost}ms）`, outcome === 'ended' && cost < 6000, `${outcome} ${cost}ms`);
  check('中断以协议内 error 事件告知客户端，而不是静默掐连接', /"error"/.test(raw) && /无数据/.test(raw), raw.slice(-160));
  const stallLog: any = await admin('/api/logs?limit=1');
  check('流中断落库为失败（不是 ok:true）', stallLog.body[0]?.ok === false && stallLog.body[0]?.status === 502, JSON.stringify({ ok: stallLog.body[0]?.ok, st: stallLog.body[0]?.status }));
  await admin('/api/settings', 'PATCH', { upstreamIdleTimeoutMs: 120000 });
}

// ============================ 3. 客户端断开要停上游 ============================
section('3. 客户端断开必须停止上游生成');
{
  const chTee = await mkChannel('Slow', 'slow', 'openai');
  await mkModel('tee', chTee.id, 'tee'); // 内外同名 => 零改写透传（曾经的 tee 泄漏点）
  await mkModel('h-cross-stream', chTee.id, 'other', { protocol: 'anthropic' });
  const model = process.env.__x || 'tee';
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const rd = res.body!.getReader();
  await rd.read();
  await rd.cancel();
  const at = generated.slowOai || 0;
  await new Promise((r) => setTimeout(r, 2500));
  const after = generated.slowOai || 0;
  check(`断开后上游不再继续生成（审查探针5：多生成 ${after - at} 块）`, after - at <= 2, `at=${at} after=${after} cancelled=${!!cancelled.slowOai}`);
  const cancelLog: any = await admin('/api/logs?limit=1');
  check('流中途断开落 499 取消终态（既不算成功也不算上游失败）', cancelLog.body[0]?.status === 499 && cancelLog.body[0]?.ok === false, JSON.stringify({ st: cancelLog.body[0]?.status, ok: cancelLog.body[0]?.ok }));

  generated.slowAnt = 0;
  const res2 = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h-cross-stream', stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
  const rd2 = res2.body!.getReader();
  await rd2.read();
  await rd2.cancel();
  const at2 = generated.slowAnt || 0;
  await new Promise((r) => setTimeout(r, 2500));
  check(`跨协议流断开同样停止上游（多生成 ${(generated.slowAnt || 0) - at2} 块）`, (generated.slowAnt || 0) - at2 <= 2, `at=${at2}`);
}

// ============================ 4. 号池退避 ============================
section('4. 号池退避');
{
  const ch = await mkChannel('Huge', 'huge', 'anthropic');
  await mkModel('h-huge', ch.id, 'x');
  await post('/v1/messages', { model: 'h-huge', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': VKEY, 'anthropic-version': '2023-06-01' });
  const chs: any = await admin('/api/channels');
  const key = chs.body.find((x: any) => x.id === ch.id)?.keys?.[0];
  const days = (key?.cooldownLeftMs || 0) / 86400000;
  const maxDays = store.getSettings().cooldownMaxMs / 86400000;
  check(`离谱 Retry-After 被夹进冷却上限（审查探针4：${days.toFixed(3)} 天）`, days <= maxDays + 0.01 && days > 0, `left=${days}d max=${maxDays}d`);
}

// ============================ 5. 计费口径 ============================
section('5. 计费口径（Anthropic 的 input_tokens 不含缓存）');
{
  const ch = await mkChannel('Cache', 'cache', 'anthropic');
  await mkModel('h-cache', ch.id, 'x', { priceInput: 3, priceOutput: 15 });
  const r = await post('/v1/chat/completions', { model: 'h-cache', messages: [{ role: 'user', content: 'hi' }] });
  const logs: any = await admin('/api/logs?limit=1');
  const real = (1000 * 3 + 8000 * 0.3 + 100 * 15) / 1e6;
  const got = logs.body[0]?.costUsd;
  check(`缓存计费不再重复扣减（审查探针3）`, Math.abs(got - real) < 1e-4, `got=${got} 期望=${real}`);
  check('prompt_tokens 归一为含缓存的总输入', r.body?.usage?.prompt_tokens === 9000, JSON.stringify(r.body?.usage));
  check('缓存明细单独暴露', r.body?.usage?.prompt_tokens_details?.cached_tokens === 8000, JSON.stringify(r.body?.usage?.prompt_tokens_details));
}

// ============================ 6. 限流真实性 ============================
section('6. 限流');
{
  const vk: any = (await admin('/api/vkeys', 'POST', { name: 'rpm1', rpmLimit: 1 })).body;
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => post('/v1/chat/completions', { model: 'h-json', messages: [{ role: 'user', content: 'x' }] }, { authorization: `Bearer ${vk.key}` })));
  const okCount = rs.filter((x) => x.status === 200).length;
  check(`并发打满 rpmLimit=1 只放行 1 个（审查探针7：实际 ${okCount} 个）`, okCount === 1, rs.map((x) => x.status).join(','));
  check('429 带回 Retry-After', !!rs.find((x) => x.status === 429)?.headers.get('retry-after'), String(rs.find((x) => x.status === 429)?.headers.get('retry-after')));
}
{
  // 每次 46 token：第 1 次后 46、第 2 次后 92；限额 90 => 第 3 次必须被拦
  const vk: any = (await admin('/vkeys'.replace('/vkeys', '/api/vkeys'), 'POST', { name: 'daily', dailyTokenLimit: 90 })).body;
  const before: number[] = [];
  for (let i = 0; i < 2; i++) before.push((await post('/v1/chat/completions', { model: 'h-json', messages: [] }, { authorization: `Bearer ${vk.key}` })).status);
  await admin('/api/settings', 'PATCH', { logRetention: 2 }); // 把日志裁到 2 条，旧实现会因此清零
  const third = await post('/v1/chat/completions', { model: 'h-json', messages: [] }, { authorization: `Bearer ${vk.key}` });
  check('裁掉日志后每日额度依然生效（审查探针7-2）', third.status === 429 && before.every((s) => s === 200), `${before.join(',')} -> ${third.status}`);
  const q: any = await admin('/api/vkeys');
  const mine = q.body.find((k: any) => k.id === vk.id);
  check('管理台能看到当日已用配额', (mine?.today?.tokens || 0) >= 92, JSON.stringify(mine?.today));
  await admin('/api/settings', 'PATCH', { logRetention: 2000 });
}
{
  // 并发越界：10 个并发请求都声明 max_tokens=46，限额 90 =>
  // 在途预占只放行 1 个，不允许"先一起穿过、结束再累计"越过限额。
  // 旧实现只靠 recordQuota 在结束时入账，并发会一起越过 90；修复后带上限的请求被预占拦截。
  const vk: any = (await admin('/api/vkeys', 'POST', { name: 'daily-conc', dailyTokenLimit: 90 })).body;
  const rs = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(() => post('/v1/chat/completions', { model: 'h-json', max_tokens: 46, messages: [] }, { authorization: `Bearer ${vk.key}` })));
  const okCount = rs.filter((x) => x.status === 200).length;
  check(`并发越过 dailyTokenLimit 被在途预占拦截（审查探针7-3：200×${okCount}）`, okCount === 1, rs.map((x) => x.status).join(','));
  const q3: any = await admin('/api/vkeys');
  const mine3 = q3.body.find((k: any) => k.id === vk.id);
  check('并发请求实际消耗不超限额', (mine3?.today?.tokens || 0) <= 90, JSON.stringify(mine3?.today));
}

// ============================ 7. 设置项校验 ============================
section('7. 设置项校验');
{
  const bad = await admin('/api/settings', 'PATCH', { logRetention: 0, maxKeyRetries: -5, cooldownMaxMs: NaN, adminToken: '', unknownKey: 1 });
  const s: any = store.getSettings();
  check('logRetention=0 被拒（否则日志与统计静默失效）', s.logRetention > 0, String(s.logRetention));
  check('maxKeyRetries 负数被拒', s.maxKeyRetries > 0, String(s.maxKeyRetries));
  check('adminToken 空串被拒（否则管理台裸奔）', s.adminToken === 'hard-admin', String(s.adminToken));
  check('NaN 被拒', Number.isFinite(s.cooldownMaxMs), String(s.cooldownMaxMs));
  const rejectedList = bad.body?._rejected || bad.body?.rejected || [];
  check('未知设置项被拒而不是静默接收', rejectedList.some((r: string) => r.includes('unknownKey')), JSON.stringify(bad.body));
  const good = await admin('/api/settings', 'PATCH', { logRetention: 3000 });
  check('合法值正常生效且回报 applied', good.body?.logRetention === 3000 && (good.body?._applied || []).includes('logRetention'), JSON.stringify(good.body?._applied));
}

// ============================ 8. 信息暴露 ============================
section('8. 内部信息暴露');
{
  const def = await post('/v1/chat/completions', { model: 'h-json', messages: [] });
  check('默认不回 x-lm-channel（渠道名不外泄）', def.headers.get('x-lm-channel') === null, String(def.headers.get('x-lm-channel')));
  check('默认不回 x-lm-key 尾号', def.headers.get('x-lm-key') === null, String(def.headers.get('x-lm-key')));
  await admin('/api/settings', 'PATCH', { debugHeaders: true });
  const dbg = await post('/v1/chat/completions', { model: 'h-json', messages: [] });
  check('显式开启 debugHeaders 后才有这些头', dbg.headers.get('x-lm-channel') === 'JSONStream', String(dbg.headers.get('x-lm-channel')));
  await admin('/api/settings', 'PATCH', { debugHeaders: false });
}
{
  const pre = await fetch(`${BASE}/api/channels`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-admin-token,content-type' } });
  check('非本机 Origin 拿不到 ACAO（不能拿本机网关当跳板）', !pre.headers.get('access-control-allow-origin'), String(pre.headers.get('access-control-allow-origin')));
  const pre2 = await fetch(`${BASE}/api/channels`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-admin-token,content-type' } });
  check('本机 Origin 正常放行（管理台还能用）', pre2.headers.get('access-control-allow-origin') === 'http://localhost:5173', String(pre2.headers.get('access-control-allow-origin')));
}
{
  const q = await admin('/api/logs?limit=1');
  check('管理令牌走 query 不再对任意端点开放', (await fetch(`${BASE}/api/vkeys?reveal=1&admin_token=hard-admin`)).status === 401, 'query 令牌被接受 = 泄漏面扩大');
  const noOld = await fetch(`${BASE}/api/logs/stream?admin_token=hard-admin`);
  check('SSE 不再接受长期 admin_token 进 URL', noOld.status === 401, String(noOld.status));
  noOld.body?.cancel();
  const tkt = (await admin('/api/logs/stream/ticket', 'POST')).body;
  const sse = await fetch(`${BASE}/api/logs/stream?ticket=${encodeURIComponent(tkt.ticket)}`);
  check('SSE 端点可用短期 ticket（EventSource 不能带自定义头）', !!tkt?.ticket && sse.status === 200, `ticket=${!!tkt?.ticket} status=${sse.status}`);
  sse.body?.cancel();
  check('overview 不再回显管理令牌', !('adminToken' in (await admin('/api/overview')).body), '');
  void q;
}

// ============================ 9. 请求体上限 ============================
section('9. 请求体上限');
{
  await admin('/api/settings', 'PATCH', { maxBodyBytes: 4096 });
  const big = await post('/v1/chat/completions', { model: 'h-json', messages: [{ role: 'user', content: 'x'.repeat(20000) }] });
  check('超大请求体返回 413 而不是全量驻留内存', big.status === 413, String(big.status));
  await admin('/api/settings', 'PATCH', { maxBodyBytes: 64 * 1024 * 1024 });
}

// ============================ 10. 转换层补漏 ============================
section('10. 转换层');
{
  const ch = await mkChannel('EchoOai', 'echo', 'openai');
  const chA = await mkChannel('EchoAnt', 'echo', 'anthropic');
  await mkModel('h-echo', ch.id, 'mock');
  await mkModel('h-echo-ant', chA.id, 'mock');

  const legacy = await post('/v1/completions', { model: 'h-echo', prompt: 'hello legacy', max_tokens: 8 });
  check('/v1/completions 把 prompt 转成 messages（审查探针B）', Array.isArray(echoed.chat?.messages) && echoed.chat.messages[0]?.content === 'hello legacy', JSON.stringify(echoed.chat?.messages));
  check('/v1/completions 返回 text_completion 结构', legacy.body?.object === 'text_completion' && typeof legacy.body?.choices?.[0]?.text === 'string', JSON.stringify(legacy.body?.object));

  const prefill = await post('/v1/chat/completions', { model: 'h-echo-ant', messages: [{ role: 'assistant', content: '预填充内容' }, { role: 'user', content: 'hi' }] });
  const sentP = JSON.parse(prefill.body.choices[0].message.content);
  check('首条 assistant 预填充不被丢弃（审查探针D）', JSON.stringify(sentP.messages).includes('预填充内容'), JSON.stringify(sentP.messages));
  check('Anthropic 首条仍是 user', sentP.messages[0]?.role === 'user', JSON.stringify(sentP.messages[0]?.role));

  const rf = await post('/v1/chat/completions', { model: 'h-echo-ant', messages: [{ role: 'user', content: '给我 JSON' }], response_format: { type: 'json_object' }, n: 2 });
  const sentR = JSON.parse(rf.body.choices[0].message.content);
  check('response_format 降级为 system 指令而非静默丢弃', /JSON/i.test(JSON.stringify(sentR.system || '')), JSON.stringify(sentR.system));
  check('降级通过 x-lm-warning 显式告知', decodeURIComponent(rf.headers.get('x-lm-warning') || '').includes('response_format'), String(rf.headers.get('x-lm-warning')));

  const orphan = await post('/v1/chat/completions', {
    model: 'h-echo-ant',
    messages: [{ role: 'user', content: 'hi' }, { role: 'tool', tool_call_id: 'call_ghost', content: '{}' }],
  });
  const sentO = JSON.parse(orphan.body.choices[0].message.content);
  check('没有配对 tool_use 的 tool_result 被剔除', !JSON.stringify(sentO.messages).includes('call_ghost'), JSON.stringify(sentO.messages));

  const paired = await post('/v1/chat/completions', {
    model: 'h-echo-ant',
    messages: [
      { role: 'user', content: '查天气' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"HZ"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"t":20}' },
    ],
  });
  const sentPr = JSON.parse(paired.body.choices[0].message.content);
  check('配对正常的 tool_result 保留', JSON.stringify(sentPr.messages).includes('call_1'), JSON.stringify(sentPr.messages));
}


{
  // legacy 流式：老 SDK 读 choices[].text，结构错了就是一段空白
  const legacySSE = await fetch(`${BASE}/v1/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h-plain', prompt: '老接口流式', stream: true }) });
  const { events } = await readAll(legacySSE);
  const t1 = events.map((e) => e.data?.choices?.[0]?.text || '').join('');
  check('legacy 流式回 text_completion 分块且 text 有内容', t1 === '纯文本类型的流' && events.some((e) => e.data?.object === 'text_completion'), `got "${t1}"`);
  check('legacy 流式不再吐 chat.completion.chunk', events.every((e) => !e.data?.object || e.data.object === 'text_completion'), JSON.stringify(events[0]?.data?.object));
  check('legacy 流式以 [DONE] 收尾', events.at(-1)?.data === '[DONE]', JSON.stringify(events.at(-1)?.data));

  const legacyAnt = await fetch(`${BASE}/v1/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h-crlf', prompt: 'claude 挂老接口', stream: true }) });
  const { events: evA } = await readAll(legacyAnt);
  const tA = evA.map((e) => e.data?.choices?.[0]?.text || '').join('');
  check('legacy 挂在 Anthropic 上游下也是 text_completion 结构', tA === 'CRLF内容' && evA.every((e) => !e.data?.object || e.data.object === 'text_completion'), `got "${tA}"`);

  const legacyJson = await fetch(`${BASE}/v1/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h-json', prompt: '老接口', stream: true }) });
  const { events: ev2 } = await readAll(legacyJson);
  const t2 = ev2.map((e) => e.data?.choices?.[0]?.text || '').join('');
  check('legacy + 上游只回 JSON 时能合成出文本（不是空）', t2 === 'JSON冒充流式', `got "${t2}"`);
}

// ============================ 11. 数据完整性 ============================
section('11. 数据完整性');
{
  const ms: any = await admin('/api/models');
  const a = ms.body[0];
  const b = ms.body.find((m: any) => m.publicName !== a.publicName);
  const clash = await admin(`/api/models/${b.id}`, 'PATCH', { publicName: a.publicName });
  const after: any = await admin('/api/models');
  const dup = after.body.filter((m: any) => m.publicName === a.publicName).length;
  check('模型改名撞名返回 409（审查探针8）', clash.status === 409, String(clash.status));
  check('不再存在两条同名路由', dup === 1, String(dup));

  store.flushSync();
  const mode = statSync(join(DATA, 'db.json')).mode & 0o777;
  check(`db.json 权限收紧到 0600（实测 ${(mode & 0o777).toString(8)}）`, (mode & 0o077) === 0, mode.toString(8));
}

// ============================ 12. SSE 分帧单元探针 ============================
section('12. SSE 分帧（单元）：CRLF 恰好断在块边界');
{
  const { parseSSE } = await import('../src/sse.ts');
  // 一个帧有两条 data 行（规范：合并为 "AAA\nBBB"），网络把行分隔符 \r\n 拆到两个 chunk。
  // 旧实现对尾部 \r 立刻归一，会在多行帧中间拼出假 \n\n 边界，把帧劈成两半。
  const uenc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(uenc.encode('data: AAA\r'));
      c.enqueue(uenc.encode('\ndata: BBB\r\n\r\ndata: [DONE]\r\n\r\n'));
      c.close();
    },
  });
  const events: any[] = [];
  for await (const ev of parseSSE(stream)) events.push(ev);
  check('\\r 落块尾不制造假帧边界（多行帧按规范合并）', events.length === 2 && events[0]?.data === 'AAA\nBBB' && events[1]?.data === '[DONE]', JSON.stringify(events));
}

// ============================ 13. 上游 200 的非对象 JSON 体 ============================
section('13. 上游 200 回 null/标量 JSON');
{
  const chN = await mkChannel('NullJson', 'nulljson', 'openai');
  await mkModel('h-null', chN.id, 'x');
  const chS = await mkChannel('ScalarJson', 'scalarjson', 'openai');
  await mkModel('h-scalar', chS.id, 'x');
  const vk: any = (await admin('/api/vkeys', 'POST', { name: 'nullup', dailyTokenLimit: 60 })).body;
  const auth = { authorization: `Bearer ${vk.key}` };
  const r1 = await api('/v1/chat/completions', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'h-null', max_tokens: 40, messages: [{ role: 'user', content: 'hi' }] }) });
  check('null 体返回 502 协议内 JSON（不是 500 明文页）', r1.status === 502 && typeof r1.body === 'object' && !!r1.body?.error?.message, `${r1.status} ${JSON.stringify(r1.body).slice(0, 70)}`);
  const lg: any = await admin('/api/logs?limit=10');
  check('该失败请求落了库（finalize 未静默丢失）', lg.body.some((l: any) => l.requestedModel === 'h-null' && !l.ok), JSON.stringify(lg.body?.[0]?.requestedModel));
  const r2 = await api('/v1/chat/completions', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'h-json', max_tokens: 40, messages: [] }) });
  check('失败请求未泄漏在途预占（后续正常请求不被误 429）', r2.status === 200, `status=${r2.status}`);
  const r3 = await post('/v1/chat/completions', { model: 'h-scalar', messages: [] });
  check('标量 JSON 不原样透给客户端（502 报错）', r3.status === 502 && typeof r3.body === 'object' && !!r3.body?.error, `${r3.status} ${JSON.stringify(r3.body).slice(0, 50)}`);
}

// ============================ 14. 信息暴露 / 口径 / 数据完整性 ============================
section('14. 信息暴露、usage 口径与主键完整性');
{
  // 上一段已把 debugHeaders 关掉：失败重试计数也属于内部拓扑，默认不得下发
  check('前置：debugHeaders 处于默认关闭', store.getSettings().debugHeaders === false, String(store.getSettings().debugHeaders));
  const chD = await mkChannel('Deny401', 'deny', 'openai', { keys: ['k-b1', 'k-b2'] });
  await mkModel('h-deny', chD.id, 'x');
  const r = await post('/v1/chat/completions', { model: 'h-deny', messages: [{ role: 'user', content: 'x' }] });
  check('x-lm-retries 也受 debugHeaders 门控（默认不下发）', r.status >= 400 && r.headers.get('x-lm-retries') === null, `status=${r.status} header=${r.headers.get('x-lm-retries')}`);
}
{
  const chC = await mkChannel('CacheOaiAnt', 'cacheoai', 'openai');
  await mkModel('h-cacheoai', chC.id, 'x');
  const r = await api('/v1/messages', { method: 'POST', headers: { 'x-api-key': VKEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'h-cacheoai', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
  const u = r.body?.usage;
  check('OpenAI→Anthropic 响应：input_tokens 不含缓存（客户端求和不双算）', u?.input_tokens === 20 && u?.cache_read_input_tokens === 80 && u.input_tokens + u.cache_read_input_tokens === 100, JSON.stringify(u));
}
{
  const ms: any = await admin('/api/models');
  const m = ms.body[0];
  const patched: any = await admin(`/api/models/${m.id}`, 'PATCH', { id: 'md_HACKED', note: 'ok' });
  check('PATCH 改不动模型主键 id（note 正常生效）', patched.status === 200 && patched.body?.id === m.id && patched.body?.note === 'ok', `id=${patched.body?.id}`);
  const chs: any = await admin('/api/channels');
  const ch = chs.body[0];
  await admin(`/api/channels/${ch.id}`, 'PATCH', { keys: 'garbage', id: 'ch_HACKED' });
  const chAfter: any = (await admin('/api/channels')).body.find((x: any) => x.id === ch.id);
  check('PATCH 改不动渠道 id、塞不进畸形 keys', !!chAfter && chAfter.keys.length === ch.keys.length && typeof chAfter.keys[0] === 'object', JSON.stringify({ alive: !!chAfter, keys: chAfter?.keys?.length }));
  const vks: any = await admin('/api/vkeys');
  const vk0 = vks.body.find((k: any) => k.name !== 'nullup');
  await admin(`/api/vkeys/${vk0.id}`, 'PATCH', { id: 'vk_HACKED', key: 'sk-lm-HACKED' });
  const vks2: any = await admin('/api/vkeys');
  check('PATCH 改不动对外 key 的 id/key（配额引用不被孤立）', vks2.body.some((k: any) => k.id === vk0.id) && !vks2.body.some((k: any) => k.key === 'sk-lm-HACKED'), '');
}
{
  // 限额小于单请求预占量：不能把 key 永久锁死，当天首次请求必须放行
  const vk: any = (await admin('/api/vkeys', 'POST', { name: 'tiny-cap', dailyTokenLimit: 10 })).body;
  const r = await api('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${vk.key}` }, body: JSON.stringify({ model: 'h-json', max_tokens: 80, messages: [] }) });
  check('限额 < 单请求预占时仍放行首發（不被硬锁）', r.status === 200, `status=${r.status}`);
}
{
  // F8（二轮）：sniff 判 JSON（要流的上游回 JSON）+ 正文慢速下载 + 客户端中途 abort
  // → readJson 得 undefined，网关必须复查取消并按"取消终态"记账：499、不冷却 key、不计健康分。
  // 删掉复查（M4）→ 被误判"200 非法 JSON"：502 + recordFailure 把健康 key 打进 5min 冷却。
  const ch = await mkChannel('SlowJson', 'slowjson', 'openai');
  await mkModel('h-slowjson', ch.id, 'jx');
  const ac = new AbortController();
  const p = fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h-slowjson', stream: true, messages: [{ role: 'user', content: 'hi' }] }), signal: ac.signal });
  await new Promise((r) => setTimeout(r, 500)); // 首块 ~200ms 已被 sniff；此刻正停在 readJson 的滴落下载中途
  ac.abort();
  await p.catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const lgCancel: any = await admin('/api/logs?limit=1');
  check('F8 sniff 窗取消落 499 取消终态（不是"200 非法 JSON"的 502）', lgCancel.body[0]?.status === 499, JSON.stringify({ st: lgCancel.body[0]?.status, err: String(lgCancel.body[0]?.error || '').slice(0, 60) }));
  const chsJ: any = await admin('/api/channels');
  const keysJ = chsJ.body.find((x: any) => x.id === ch.id)?.keys || [];
  check('F8 取消不冷却 key 也不计健康败样（recordFailure/onSample 均未被误触发）', keysJ.every((k: any) => k.status === 'active'), JSON.stringify(keysJ.map((k: any) => k.status)));
}
{
  // F9（二轮）：M6 的反向语义——健康流 + 慢客户端停读 >idle 不得被误杀。
  // 修前（enqueue 后续表）计时器度量下游节奏，此用例必绞死上游、内容截断。
  const chB = await mkChannel('SlowB', 'slow', 'openai');
  await mkModel('h-slowb', chB.id, 'tee');
  await admin('/api/settings', 'PATCH', { upstreamIdleTimeoutMs: 1200 });
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h-slowb', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const decd = new TextDecoder();
  let buf = '';
  const rd = res.body!.getReader();
  const r1 = await rd.read();
  buf += decd.decode(r1.value ?? new Uint8Array());
  await new Promise((r) => setTimeout(r, 2600)); // ≈2.2×idle 的下游停读；上游一直在健康吐字
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += decd.decode(value ?? new Uint8Array());
  }
  const chunks = (buf.match(/"content":/g) || []).length;
  const lgSlow: any = await admin('/api/logs?limit=1');
  check(`F9 慢客户端停读 2.2×idle 不误杀健康流（M6 反向，收 ${chunks} 块）`, chunks >= 38 && lgSlow.body[0]?.status === 200 && lgSlow.body[0]?.ok === true, `${chunks}块 status=${lgSlow.body[0]?.status}`);
  await admin('/api/settings', 'PATCH', { upstreamIdleTimeoutMs: 120000 });
}
{
  // 桌面引导（spawn 真进程）：端口避让 / 首启随机令牌 / last-session 交接文件。
  // 这三样是 Tauri 壳与"双击即用"的地基，只有真进程能证明。
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const fs2 = await import('node:fs');
  const bootDir = mkdtempSync(join(tmpdir(), 'ownapi-boot-'));
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(18810, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, LLM_ADMIN_TOKEN: undefined, LLM_DATA_DIR: undefined, OWN_API_ADMIN_TOKEN: undefined, OWN_API_DATA_DIR: bootDir, OWN_API_PORT: '18810', HOST: '127.0.0.1', OWN_API_OPEN_BROWSER: undefined },
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  let up: Response | null = null;
  for (let i = 0; i < 80 && !up; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      up = await fetch('http://127.0.0.1:18811/v1/models');
    } catch {
      /* 还没起来 */
    }
  }
  check('端口 18810 被占自动避让到 18811（桌面双击的启动率保障）', !!up, String(up?.status));
  const bootDb = up ? JSON.parse(fs2.readFileSync(join(bootDir, 'db.json'), 'utf8')) : {};
  check('首启随机管理令牌（无团队共享默认口令）', /^admin-[A-Za-z0-9_-]{8,}$/.test(bootDb.settings?.adminToken || ''), JSON.stringify(String(bootDb.settings?.adminToken || '').slice(0, 9)));
  let sess: any = {};
  try {
    sess = JSON.parse(fs2.readFileSync(join(bootDir, 'last-session.json'), 'utf8'));
  } catch {
    /* 缺文件时给空对象走断言 */
  }
  check('last-session.json 交接端口与令牌给桌面壳（0600）', sess.port === 18811 && sess.token === bootDb.settings?.adminToken && (fs2.statSync(join(bootDir, 'last-session.json')).mode & 0o077) === 0, JSON.stringify({ port: sess.port, hasToken: !!sess.token }));
  child.kill();
  await new Promise<void>((r) => {
    child.on('exit', () => r());
    setTimeout(r, 4000);
  });
  blocker.close();
}

console.log(`\n\x1b[1m结果\x1b[0m  \x1b[32m${pass} 通过\x1b[0m  ${failCount ? `\x1b[31m${failCount} 失败\x1b[0m` : ''}`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
}
dirtyServer.close();
gwServer.close();
store.flushSync();
rmSync(DATA, { recursive: true, force: true });
process.exit(failCount ? 1 : 0);
