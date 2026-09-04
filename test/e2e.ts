/**
 * 端到端自测：mock 上游 + 网关全链路。
 * 覆盖：同协议路由、跨协议互转（双向）、流式、号池故障切换、鉴权、用量记账。
 * 运行：npm test
 */
import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'llm-mgr-test-'));
process.env.LLM_DATA_DIR = DATA;
process.env.LLM_ADMIN_TOKEN = 'test-admin';
process.env.PORT = '18787';

const { mockApp } = await import('../src/mock-upstream.ts');
const { createApp } = await import('../src/app.ts');
const { store } = await import('../src/store.ts');

const mockServer = serve({ fetch: mockApp.fetch, port: 18099, hostname: '127.0.0.1' });
const gwServer = serve({ fetch: createApp().fetch, port: 18787, hostname: '127.0.0.1' });
await new Promise((r) => setTimeout(r, 300));

const BASE = 'http://127.0.0.1:18787';
const ADMIN = { 'x-admin-token': 'test-admin', 'content-type': 'application/json' };
let VKEY = '';

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
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
}

/** 读取 SSE 全文并切成 data 事件 */
async function readSSE(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events: { event?: string; data: any }[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event: string | undefined;
      const datas: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) datas.push(line.slice(5).trim());
      }
      if (!datas.length) continue;
      const data = datas.join('\n');
      events.push({ event, data: data === '[DONE]' ? '[DONE]' : safeJson(data) });
    }
  }
  return events;
}
function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ================================================================ 准备数据
section('准备：注册渠道 / 模型路由 / 对外 key');

const oa = (await api('/api/channels', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'Mock OpenAI', baseUrl: 'http://127.0.0.1:18099/v1', protocol: 'openai', keys: ['k-401-bad', 'k-429-rate', 'k-ok-main'] }) })).body;
const an = (await api('/api/channels', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'Mock Claude', baseUrl: 'http://127.0.0.1:18099/v1', protocol: 'anthropic', keys: ['k-ok-claude'] }) })).body;
check('创建两个渠道', !!oa?.id && !!an?.id, JSON.stringify(oa));
check('号池 key 数为 3', oa?.keys?.length === 3, `got ${oa?.keys?.length}`);
const listedCh = (await api('/api/channels', { headers: ADMIN })).body;
  const oaListed = (listedCh || []).find((c: any) => c.id === oa.id);
  check('管理台不回显明文 key', !!oaListed?.keys?.every?.((k: any) => typeof k.key === 'string' && !k.key.includes('k-ok-main')), JSON.stringify(oaListed?.keys?.map((k: any) => k.key)));

await api('/api/models', { method: 'POST', headers: ADMIN, body: JSON.stringify({ publicName: 'gpt-4o', channelId: oa.id, upstreamModel: 'mock-gpt-5', priceInput: 2.5, priceOutput: 10 }) });
await api('/api/models', { method: 'POST', headers: ADMIN, body: JSON.stringify({ publicName: 'claude-sonnet', channelId: an.id, upstreamModel: 'mock-claude-sonnet', priceInput: 3, priceOutput: 15 }) });
const models = (await api('/api/models', { headers: ADMIN })).body;
check('注册两个模型路由', models.length === 2, JSON.stringify(models?.map?.((m: any) => m.publicName)));

VKEY = store.listVKeys()[0].key;
const limited = (await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'only-gpt', allowedModels: ['gpt-4o'] }) })).body;

// ================================================================ 1. 鉴权
// 本套用例会看 x-lm-channel / x-lm-attempts，这些内部信息默认对外关闭，这里显式打开
await api('/api/settings', { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ debugHeaders: true }) });

section('1. 统一 Key 鉴权');
const noAuth = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', messages: [] }) });
check('无 key -> 401', noAuth.status === 401, String(noAuth.status));
const wrongKey = await api('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer sk-lm-nope' }, body: JSON.stringify({ model: 'gpt-4o', messages: [] }) });
check('错误 key -> 401', wrongKey.status === 401);
const unknownModel = await api('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${VKEY}` }, body: JSON.stringify({ model: 'no-such-model', messages: [] }) });
check('未配置模型 -> 404 且提示可用列表', unknownModel.status === 404 && /可用模型/.test(JSON.stringify(unknownModel.body)), JSON.stringify(unknownModel.body));
const notAllowed = await api('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${limited.key}` }, body: JSON.stringify({ model: 'claude-sonnet', messages: [] }) });
check('key 未授权该模型 -> 403', notAllowed.status === 403, String(notAllowed.status));

// ================================================================ 2. 同协议
section('2. 同协议路由（OpenAI -> OpenAI）');
const r1 = await api('/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${VKEY}` },
  body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: '你好呀' }] }),
});
check('返回 200', r1.status === 200, JSON.stringify(r1.body).slice(0, 200));
check('命中 mock openai 上游', /mock\(openai:mock-gpt-5\)/.test(r1.body?.choices?.[0]?.message?.content || ''), r1.body?.choices?.[0]?.message?.content);
check('对外 model 名不回漏上游名', r1.body?.model === 'gpt-4o', r1.body?.model);
check('usage 已透传', r1.body?.usage?.total_tokens === 28, JSON.stringify(r1.body?.usage));
check('响应头带命中的渠道', r1.headers.get('x-lm-channel') === 'Mock OpenAI', String(r1.headers.get('x-lm-channel')));
check('坏 key 被自动跳过（attempts>1）', Number(r1.headers.get('x-lm-attempts')) > 1, String(r1.headers.get('x-lm-attempts')));

// ================================================================ 3. 跨协议
section('3. 跨协议互转（OpenAI 客户端 -> Anthropic 上游）');
const r2 = await api('/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${VKEY}` },
  body: JSON.stringify({ model: 'claude-sonnet', max_tokens: 64, messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '交叉协议测试' }] }),
});
check('Claude 挂在 /v1/chat/completions 下可用', r2.status === 200 && /mock\(anthropic:/.test(r2.body?.choices?.[0]?.message?.content || ''), JSON.stringify(r2.body).slice(0, 200));
check('转成 OpenAI 响应结构', r2.body?.object === 'chat.completion' && r2.body?.choices?.[0]?.finish_reason === 'stop', JSON.stringify(r2.body?.choices?.[0]?.finish_reason));
// 归一口径：Anthropic 的 input_tokens(9) 不含缓存(2)，对外的 prompt_tokens 是含缓存的总输入
check('Anthropic usage 归一为 OpenAI 口径（含缓存总输入）', r2.body?.usage?.prompt_tokens === 11 && r2.body?.usage?.completion_tokens === 19 && r2.body?.usage?.prompt_tokens_details?.cached_tokens === 2, JSON.stringify(r2.body?.usage));

const toolRes = await api('/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${VKEY}` },
  body: JSON.stringify({
    model: 'claude-sonnet',
    messages: [{ role: 'user', content: '用工具查一下天气' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
  }),
});
const tc = toolRes.body?.choices?.[0]?.message?.tool_calls?.[0];
check('tool_use -> tool_calls 转换正确', tc?.function?.name === 'get_weather' && tc?.function?.arguments === '{"city":"Hangzhou"}', JSON.stringify(tc));
check('finish_reason 映射为 tool_calls', toolRes.body?.choices?.[0]?.finish_reason === 'tool_calls', toolRes.body?.choices?.[0]?.finish_reason);

// ================================================================ 4. Anthropic 入口
section('4. Anthropic 入口（/v1/messages -> OpenAI 上游）');
const r3 = await api('/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': VKEY, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'gpt-4o', max_tokens: 32, messages: [{ role: 'user', content: 'anthropic 入口' }] }),
});
check('Anthropic 客户端走 OpenAI 上游成功', r3.status === 200 && r3.body?.type === 'message', JSON.stringify(r3.body).slice(0, 200));
check('content 为 anthropic block 结构', Array.isArray(r3.body?.content) && r3.body.content[0]?.type === 'text', JSON.stringify(r3.body?.content)?.slice(0, 120));
check('stop_reason 映射正确', r3.body?.stop_reason === 'end_turn', r3.body?.stop_reason);
// Anthropic 口径：input_tokens 不含缓存。mock 上游 prompt 11（含 cached 3）→ 对外应为 8 + 单列 cached 3
check('OpenAI→Anthropic usage：input_tokens 不含缓存（求和不双算）', r3.body?.usage?.input_tokens === 8 && r3.body?.usage?.cache_read_input_tokens === 3, JSON.stringify(r3.body?.usage));

// ================================================================ 5. 流式
section('5. 流式转发与转换');
const s1 = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: '流式同协议' }] }) });
const ev1 = await readSSE(s1);
const text1 = ev1.map((e) => e.data?.choices?.[0]?.delta?.content || '').join('');
check('同协议流式内容完整', /流式同协议/.test(text1), text1);
check('以 [DONE] 结束', ev1.at(-1)?.data === '[DONE]', JSON.stringify(ev1.at(-1)));
check('流式含 usage（stream_options 注入生效）', ev1.some((e) => e.data?.usage?.completion_tokens === 17), JSON.stringify(ev1.at(-2)?.data?.usage));

const s2 = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet', stream: true, max_tokens: 32, messages: [{ role: 'user', content: '跨协议流式' }] }) });
const ev2 = await readSSE(s2);
const text2 = ev2.map((e) => e.data?.choices?.[0]?.delta?.content || '').join('');
check('Anthropic 流 -> OpenAI chunk 内容完整', /跨协议流式/.test(text2) && ev2.every((e) => e.data?.object === 'chat.completion.chunk' || e.data === '[DONE]'), text2);
check('跨协议流含 finish_reason 与 usage', ev2.some((e) => e.data?.choices?.[0]?.finish_reason === 'stop' && e.data?.usage), JSON.stringify(ev2.at(-2)?.data));

const s3 = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'x-api-key': VKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', stream: true, max_tokens: 32, messages: [{ role: 'user', content: '反向流式' }] }) });
const ev3 = await readSSE(s3);
const evNames = ev3.map((e) => e.data?.type).filter(Boolean);
const text3 = ev3.filter((e) => e.data?.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
check('OpenAI 流 -> Anthropic 事件序列完整', evNames[0] === 'message_start' && evNames.includes('content_block_delta') && evNames.at(-1) === 'message_stop', JSON.stringify(evNames));
check('反向流内容完整', /反向流式/.test(text3), text3);
check('事件顺序符合 Anthropic 规范（block_stop -> message_delta -> message_stop）',
  evNames.lastIndexOf('content_block_stop') < evNames.lastIndexOf('message_delta') && evNames.at(-1) === 'message_stop',
  JSON.stringify(evNames.slice(-4)));

const s4 = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet', stream: true, max_tokens: 32, messages: [{ role: 'user', content: '帮我用工具查天气' }], tools: [{ type: 'function', function: { name: 'get_weather' } }] }) });
const ev4 = await readSSE(s4);
const args = ev4.map((e) => e.data?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments || '').join('');
check('跨协议流式 tool_calls 参数拼接正确', args === '{"city":"Hangzhou"}', args);

// ================================================================ 6. 号池
section('6. 号池调度与故障切换');
const logs1: any[] = (await api('/api/logs?limit=200', { headers: ADMIN })).body;
// /api/logs 是倒序，at(-1) 即最早那条：它经历了 401 -> 429 -> 成功
const gptLog = logs1.filter((l: any) => l.requestedModel === 'gpt-4o' && l.ok).at(-1);
check('首个坏 key 被计入重试', (gptLog?.retries?.length || 0) >= 2, JSON.stringify(gptLog?.retries));
check('重试记录里含 401 与 429', /401/.test(gptLog?.retries?.join(' ') || '') && /429/.test(gptLog?.retries?.join(' ') || ''), JSON.stringify(gptLog?.retries));
const chAfter = (await api('/api/channels', { headers: ADMIN })).body.find((x: any) => x.id === oa.id);
const [kBad, kRate, kMain] = oa.keys;
const badKey = chAfter.keys.find((k: any) => k.id === kBad.id);
const rateKey = chAfter.keys.find((k: any) => k.id === kRate.id);
check('401 key 进入冷却', badKey?.status === 'cooldown' && badKey.cooldownLeftMs > 0, JSON.stringify({ s: badKey?.status, c: badKey?.cooldownLeftMs }));
check('429 key 进入冷却', rateKey?.status === 'cooldown', String(rateKey?.status));
check('好 key 保持 active', chAfter.keys.find((k: any) => k.id === kMain.id)?.status === 'active', JSON.stringify(chAfter.keys.map((k:any)=>[k.name,k.status])));
check('可用 key 计数为 1', chAfter.availableKeys === 1, String(chAfter.availableKeys));

// 全部 key 不可用 -> 明确报错而不是静默挂起
const broken = (await api('/api/channels', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'AllBad', baseUrl: 'http://127.0.0.1:18099/v1', protocol: 'openai', keys: ['k-401-a', 'k-401-b'] }) })).body;
await api('/api/models', { method: 'POST', headers: ADMIN, body: JSON.stringify({ publicName: 'broken-model', channelId: broken.id, upstreamModel: 'mock-gpt-5' }) });
const brokenRes = await api('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${VKEY}` }, body: JSON.stringify({ model: 'broken-model', messages: [{ role: 'user', content: 'x' }] }) });
check('全渠道鉴权失败 -> 401 透传', brokenRes.status === 401, JSON.stringify(brokenRes.body));

// 上游 5xx：重试耗尽后 502
const bad500 = (await api('/api/channels', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'Boom500', baseUrl: 'http://127.0.0.1:18099/v1', protocol: 'openai', keys: ['k-500-a', 'k-500-b', 'k-500-c'] }) })).body;
await api('/api/models', { method: 'POST', headers: ADMIN, body: JSON.stringify({ publicName: 'boom-model', channelId: bad500.id, upstreamModel: 'mock-gpt-5' }) });
const t5xx = Date.now();
const boom = await api('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${VKEY}` }, body: JSON.stringify({ model: 'boom-model', messages: [{ role: 'user', content: 'x' }] }) });
check('5xx 换 key 重试后返回 502', boom.status === 502, JSON.stringify(boom.body));
const boomLog = ((await api('/api/logs?limit=5', { headers: ADMIN })).body).find((l: any) => l.requestedModel === 'boom-model');
check('重试尝试数达到上限 3', boomLog?.attempts === 3, String(boomLog?.attempts));

// ================================================================ 7. 用量
section('7. 用量与花费统计');
const stats: any = (await api('/api/stats?hours=1', { headers: ADMIN })).body;
check('统计有请求记录', stats.totals.requests > 5, JSON.stringify(stats.totals));
check('token 已记账', stats.totals.promptTokens > 0 && stats.totals.completionTokens > 0, JSON.stringify({ p: stats.totals.promptTokens, c: stats.totals.completionTokens }));
check('花费按单价估算 > 0', stats.totals.costUsd > 0, String(stats.totals.costUsd));
const byModel = stats.byModel.find((m: any) => m.key === 'claude-sonnet');
check('按模型聚合含 claude-sonnet', !!byModel && byModel.requests >= 4, JSON.stringify(byModel));
check('成功率字段存在', typeof stats.successRate === 'number' && stats.successRate < 100, String(stats.successRate));
check('P50/P95 延迟有值', stats.p50Latency > 0 && stats.p95Latency >= stats.p50Latency, `${stats.p50Latency}/${stats.p95Latency}`);

const mdl = (await api('/api/models', { headers: ADMIN })).body.find((m: any) => m.publicName === 'gpt-4o');
check('模型单价已保存', mdl?.priceInput === 2.5, String(mdl?.priceInput));

// ================================================================ 8. 对外接口
section('8. /v1/models 与接入信息');
const ml = await api('/v1/models', { headers: { authorization: `Bearer ${VKEY}` } });
check('/v1/models 列出已配置模型', ml.body?.data?.length === 4 && ml.body.data.some((m: any) => m.id === 'claude-sonnet'), JSON.stringify(ml.body?.data?.map?.((m: any) => m.id)));
const mlLimited = await api('/v1/models', { headers: { authorization: `Bearer ${limited.key}` } });
check('受限 key 只看到授权模型', mlLimited.body?.data?.length === 1 && mlLimited.body.data[0].id === 'gpt-4o', JSON.stringify(mlLimited.body?.data));
const snip: any = (await api('/api/snippet', { headers: ADMIN })).body;
check('提供 curl / SDK / Claude Code 片段', /\/v1\/chat\/completions/.test(snip.curl || '') && /ANTHROPIC_BASE_URL/.test(snip.claudeCode || ''), JSON.stringify(Object.keys(snip)));

// ================================================================ 9. 其它
section('9. 边界与其它');
const emb = await api('/v1/embeddings', { method: 'POST', headers: { authorization: `Bearer ${VKEY}` }, body: JSON.stringify({ model: 'gpt-4o', input: 'hi' }) });
check('embeddings 透传', emb.status === 200 && emb.body?.data?.[0]?.embedding?.length === 3, JSON.stringify(emb.body).slice(0, 120));
const badJson = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}` }, body: '{not json' });
check('非法 JSON -> 400', badJson.status === 400, String(badJson.status));
const health = await api('/healthz');
check('healthz 正常', health.body?.ok === true);
const cnt = await api('/v1/messages/count_tokens', { method: 'POST', headers: { 'x-api-key': VKEY }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello world' }] }) });
check('count_tokens 有近似值', cnt.body?.input_tokens > 0, JSON.stringify(cnt.body));
const adminNoAuth = await api('/api/channels');
check('管理台需令牌', adminNoAuth.status === 401);

// 断开流式连接不应导致进程异常
const partial = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: '中断测试' }] }) });
const rd = partial.body!.getReader();
await rd.read();
await rd.cancel();
await new Promise((r) => setTimeout(r, 200));
const alive = await api('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${VKEY}` }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'still alive' }] }) });
  check('客户端中途断开后网关仍正常服务', alive.status === 200, String(alive.status));


// ================================================================ 14. model_auto 自动路由
section('14. model_auto 自动路由（设计文档 §4-§8 验证矩阵）');
await api('/api/settings', { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ debugHeaders: false }) }); // 准备段曾开启，哨兵需先归位
const AH = { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' };
const mkCh = async (name: string, protocol: string, keys: string[], baseUrl = 'http://127.0.0.1:18099/v1') =>
  (await api('/api/channels', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name, baseUrl, protocol, keys }) })).body;
const mkModel = async (body: any) => api('/api/models', { method: 'POST', headers: ADMIN, body: JSON.stringify(body) });
const mkAuto = async (body: any) => api('/api/auto-routes', { method: 'POST', headers: ADMIN, body: JSON.stringify(body) });
const patchAuto = async (id: string, body: any) => api(`/api/auto-routes/${id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify(body) });
const patchModel = async (id: string, body: any) => api(`/api/models/${id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify(body) });
const patchSettings = async (body: any) => api('/api/settings', { method: 'PATCH', headers: ADMIN, body: JSON.stringify(body) });
const autoReq = async (model: string, extra: any = {}, headers: any = AH) =>
  api('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }], ...extra }) });
const autoHealth = async () => (await api('/api/auto-health', { headers: ADMIN })).body;
const resetAutoRT = async () => api('/api/auto-health/reset', { method: 'POST', headers: ADMIN });
const getLogs = async (model: string) => {
  const r = await api('/api/logs?limit=400', { headers: ADMIN });
  const arr: any[] = r.body.logs || r.body.data || r.body;
  return arr.filter((l) => l.requestedModel === model);
};
const mockHits = async () => (await (await fetch('http://127.0.0.1:18099/__hits')).json()) as Record<string, number>;

const chAuto = await mkCh('Auto Good', 'openai', ['k-ok-auto']);
const chAnth = await mkCh('Auto Anth', 'anthropic', ['k-ok-anth']);
const ch401 = await mkCh('Auto 401', 'openai', ['k-401-auto']);
const ch429 = await mkCh('Auto 429', 'openai', ['k-429-auto']);
const chDead = await mkCh('Auto Dead', 'openai', ['sk-secretauto-deadkey-98765'], 'http://127.0.0.1:1/v1');
const chSlow = await mkCh('Auto Slow', 'openai', ['k-slow20-auto']);
const mGptR = (await mkModel({ publicName: 'auto-m-gpt', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).body;
const mGpt2R = (await mkModel({ publicName: 'auto-m-gpt2', channelId: chAuto.id, upstreamModel: 'mock-gpt-mini' })).body;
const mSmallR = (await mkModel({ publicName: 'auto-m-small', channelId: chAuto.id, upstreamModel: 'mock-gpt-5', contextWindow: 10 })).body;
const mTlR = (await mkModel({ publicName: 'auto-m-tl', channelId: chAuto.id, upstreamModel: 'mock-toolong' })).body;
const m404R = (await mkModel({ publicName: 'auto-m-404', channelId: chAuto.id, upstreamModel: 'mock-404' })).body;
const mClaudeR = (await mkModel({ publicName: 'auto-m-claude', channelId: chAnth.id, upstreamModel: 'mock-claude-sonnet' })).body;
const mSlow1R = (await mkModel({ publicName: 'auto-m-slow1', channelId: chSlow.id, upstreamModel: 'mock-slow-1' })).body;
const mSlow2R = (await mkModel({ publicName: 'auto-m-slow2', channelId: chSlow.id, upstreamModel: 'mock-slow-2' })).body;
const mPoisonR = (await mkModel({ publicName: 'poison-m', channelId: ch401.id, upstreamModel: 'mock-gpt-5' })).body;
const mRateR = (await mkModel({ publicName: 'rate429-m', channelId: ch429.id, upstreamModel: 'mock-gpt-5' })).body;
check('auto 测试夹具就绪', chAuto.id && mGptR.id && mClaudeR.id, JSON.stringify(chAuto).slice(0, 80));

// —— 基本路由与别名契约 ——
const aMainR = await mkAuto({ publicName: 'model_auto', candidates: [{ routeId: mGptR.id, weight: 1 }, { routeId: mGpt2R.id, weight: 1 }], stickyTtlMs: 0 });
check('创建 auto 路由', aMainR.status === 201, JSON.stringify(aMainR.body));
const rMain = await autoReq('model_auto');
check('auto 基本请求 200', rMain.status === 200 && !!rMain.body?.choices, String(rMain.status));
check('响应 model 恒为 auto 名（候选名不外泄）', rMain.body?.model === 'model_auto', String(rMain.body?.model));
check('默认不下发 x-lm-routed-to', !rMain.headers?.get?.('x-lm-routed-to'), 'debugHeaders 关');
const lgMain = await getLogs('model_auto');
check('日志 routedTo=候选外名', ['auto-m-gpt', 'auto-m-gpt2'].includes(lgMain[0]?.routedTo), JSON.stringify(lgMain[0]?.routedTo));
check('日志 chainAttempts 记录链', Array.isArray(lgMain[0]?.chainAttempts) && lgMain[0].chainAttempts.length >= 1, JSON.stringify(lgMain[0]?.chainAttempts));
const autoMdl = await api('/v1/models', { headers: AH });
const autoEntry = (autoMdl.body?.data || []).find((m: any) => m.id === 'model_auto');
check('/v1/models 含 auto 条目且不泄渠道', autoEntry?.owned_by === 'own-api:auto', JSON.stringify(autoEntry));
const embAuto = await api('/v1/embeddings', { method: 'POST', headers: AH, body: JSON.stringify({ model: 'model_auto', input: 'x' }) });
check('embeddings × auto 直接 400（§6）', embAuto.status === 400, String(embAuto.status));

// —— 唯一性双向（C/W7）——
check('auto 名撞模型外名 -> 400', (await mkAuto({ publicName: 'gpt-4o', candidates: [] })).status === 400, 'gpt-4o');
const mTagR = (await mkModel({ publicName: 'auto-m-tagged', channelId: chAuto.id, upstreamModel: 'mock-gpt-5', tags: ['mytag-x'] })).body;
check('auto 名撞模型 tag -> 400', (await mkAuto({ publicName: 'mytag-x', candidates: [] })).status === 400, 'mytag-x');
check('重复 auto 名 -> 400', (await mkAuto({ publicName: 'model_auto', candidates: [] })).status === 400, 'dup');
check('模型外名撞 auto 名 -> 409', (await mkModel({ publicName: 'model_auto', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).status === 409, 'model post');
check('模型 tag 撞 auto 名 -> 409', (await mkModel({ publicName: 'auto-m-tagged2', channelId: chAuto.id, upstreamModel: 'mock-gpt-5', tags: ['model_auto'] })).status === 409, 'tag post');
check('模型改名撞 auto 名 -> 409', (await patchModel(mTagR.id, { publicName: 'model_auto' })).status === 409, 'rename');
check('模型改 tags 撞 auto 名 -> 409', (await patchModel(mTagR.id, { tags: ['model_auto'] })).status === 409, 'retag');
check('非法 weight 拒绝', (await mkAuto({ publicName: 'auto_bad_w', candidates: [{ routeId: mGptR.id, weight: -1 }] })).status === 400, 'w=-1');

// —— ① 硬过滤 ——
const aCtxR = await mkAuto({ publicName: 'auto_ctx', candidates: [{ routeId: mSmallR.id, weight: 1 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const rCtx = await autoReq('auto_ctx', { messages: [{ role: 'user', content: '长'.repeat(200) }] });
check('①-c 超窗候选剔除（小窗不被选）', rCtx.status === 200 && (await getLogs('auto_ctx'))[0]?.routedTo === 'auto-m-gpt', String(rCtx.status));
const rEmpty = await mkAuto({ publicName: 'auto_empty', candidates: [{ routeId: mSmallR.id, weight: 1 }], stickyTtlMs: 0 });
const rE = await autoReq('auto_empty', { messages: [{ role: 'user', content: '长'.repeat(200) }] });
check('候选全剔除 -> 404 带逐候选理由', rE.status === 404 && String(rE.body?.error?.message).includes('contextWindow'), JSON.stringify(rE.body).slice(0, 120));
await patchModel(mGpt2R.id, { maxOutputTokens: 1000 });
const aMaxR = await mkAuto({ publicName: 'auto_maxout', candidates: [{ routeId: mGpt2R.id, weight: 1 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const rMax = await autoReq('auto_maxout', { max_tokens: 5000 });
check('①-e max_tokens 超候选上限剔除', rMax.status === 200 && (await getLogs('auto_maxout'))[0]?.routedTo === 'auto-m-gpt', String(rMax.status));
const aProtoR = await mkAuto({ publicName: 'auto_proto', candidates: [{ routeId: mGptR.id, weight: 1 }, { routeId: mClaudeR.id, weight: 1 }], stickyTtlMs: 0 });
const rProto = await api('/v1/messages', { method: 'POST', headers: { 'x-api-key': VKEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto_proto', max_tokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: '缓存测试', cache_control: { type: 'ephemeral' } }] }] }) });
check('①-g cache_control 只走 anthropic 候选', rProto.status === 200 && (await getLogs('auto_proto'))[0]?.routedTo === 'auto-m-claude', `${rProto.status} ${(await getLogs('auto_proto'))[0]?.routedTo}`);
const aDangR = await mkAuto({ publicName: 'auto_dang', candidates: [{ routeId: 'route_gone_404', weight: 1 }], stickyTtlMs: 0 });
check('悬空候选被剔除 -> 404（C8）', (await autoReq('auto_dang')).status === 404, 'dangling');
const dangList = (await (await api('/api/auto-routes', { headers: ADMIN })).body).find((a: any) => a.id === aDangR.body.id);
check('管理端标注 dangling 候选', dangList?.candidates?.[0]?.dangling === true, JSON.stringify(dangList?.candidates));

// —— 链失败分类 ——
await resetAutoRT();
const aChainR = await mkAuto({ publicName: 'auto_chain', candidates: [{ routeId: mTlR.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
let chainOk = true;
for (let i = 0; i < 3; i++) { const r = await autoReq('auto_chain'); if (r.status !== 200 || r.body?.model !== 'auto_chain') chainOk = false; }
const lgChain = await getLogs('auto_chain');
check('C10 超窗 400 续链后仍 200（×3）', chainOk, JSON.stringify(lgChain.map((l) => l.status)));
check('C10 超窗不计健康分', !(await autoHealth()).windows.find((w: any) => w.routeId === mTlR.id), 'no sample');
check('chainAttempts 记录超窗候选在前', lgChain.some((l) => l.chainAttempts?.[0]?.name === 'auto-m-tl' && String(l.chainAttempts[0].error).includes('超出候选窗口')), JSON.stringify(lgChain[0]?.chainAttempts));
const aOnly404 = await mkAuto({ publicName: 'auto_404only', candidates: [{ routeId: m404R.id, weight: 1 }], stickyTtlMs: 0 });
const r404 = await autoReq('auto_404only');
check('404 模型名 -> 候选判负续链，穷尽 502', r404.status === 502 && String(r404.body?.error?.message).includes('does not exist'), String(r404.status));
check('C4 0 成 N 挂 health=0.1（非满血）', (await autoHealth()).windows.find((w: any) => w.routeId === m404R.id)?.health === 0.1, JSON.stringify((await autoHealth()).windows.find((w: any) => w.routeId === m404R.id)));
const aFailR = await mkAuto({ publicName: 'auto_fail', candidates: [{ routeId: (await mkModel({ publicName: 'auto-m-dead', channelId: chDead.id, upstreamModel: 'mock-gpt-5' })).body.id, weight: 1 }, { routeId: m404R.id, weight: 1 }], stickyTtlMs: 0 });
const rFail = await autoReq('auto_fail');
const failMsg = String(rFail.body?.error?.message || '');
check('全候选失败 502 且明细回显（C17）', rFail.status === 502 && failMsg.includes('所有候选均失败') && failMsg.includes('Auto Dead'), failMsg.slice(0, 140));
check('哨兵：502 明细绝不泄漏 key 全值', !failMsg.includes('sk-secretauto-deadkey-98765') && failMsg.includes('***'), 'mask');
await resetAutoRT();
const aR429 = await mkAuto({ publicName: 'auto_429', candidates: [{ routeId: mRateR.id, weight: 1 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const r429 = await autoReq('auto_429');
check('C11 候选 429 剔除续链 -> 200', r429.status === 200 && (await getLogs('auto_429'))[0]?.routedTo === 'auto-m-gpt', String(r429.status));
check('C11 429 不计健康样本', !(await autoHealth()).windows.find((w: any) => w.routeId === mRateR.id), 'no sample');
// 直连 429 探针用独立通道：auto_429 那步可能已把共享 key 打进冷却，串通道会假失败
const ch429d = await mkCh('Auto 429 Direct', 'openai', ['k-429-direct']);
const mRate2R = (await mkModel({ publicName: 'rate429b-m', channelId: ch429d.id, upstreamModel: 'mock-gpt-5' })).body;
const rDirect429 = await autoReq('rate429b-m');
check('直连 429 透传 + retry-after', rDirect429.status === 429 && !!rDirect429.headers?.get?.('retry-after'), `${rDirect429.status} ${rDirect429.headers?.get?.('retry-after')}`);
await resetAutoRT();
for (let i = 0; i < 3; i++) await autoReq('poison-m');
const wP = (await autoHealth()).windows.find((w: any) => w.routeId === mPoisonR.id);
check('C12 定向流量也进健康窗口', wP?.fail === 3 && wP?.health === 0.1, JSON.stringify(wP));

// —— 粘性：钉住 / 绕行不覆写 / weight=0 强逐 ——
await resetAutoRT();
const aStickR = await mkAuto({ publicName: 'auto_sticky', candidates: [{ routeId: mGptR.id, weight: 0 }, { routeId: mGpt2R.id, weight: 1 }] });
check('首请求写粘性（成功应答后）', (await autoReq('auto_sticky')).status === 200 && (await autoHealth()).stickyEntries >= 1, String((await autoHealth()).stickyEntries));
await patchAuto(aStickR.body.id, { candidates: [{ routeId: mGptR.id, weight: 1 }, { routeId: mGpt2R.id, weight: 1 }] });
let pinned = true;
for (let i = 0; i < 4; i++) { const l = (await (await autoReq('auto_sticky')).body?.choices?.[0]?.message?.content ? (await getLogs('auto_sticky'))[0] : null); if (l?.routedTo !== 'auto-m-gpt2') pinned = false; }
check('粘性钉住：双活候选 4 连请求全走同候选', pinned, JSON.stringify((await getLogs('auto_sticky')).slice(0, 4).map((l) => l.routedTo)));
await patchModel(mGpt2R.id, { supportsTools: false });
const rTools = await autoReq('auto_sticky', { tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }], messages: [{ role: 'user', content: '查下天气 tool' }] });
check('①-d tools 不支持 -> 绕行成功', rTools.status === 200 && (await getLogs('auto_sticky'))[0]?.routedTo === 'auto-m-gpt', String((await getLogs('auto_sticky'))[0]?.routedTo));
await patchModel(mGpt2R.id, { supportsTools: true });
const rAfterBypass = await autoReq('auto_sticky');
check('C3 绕行轮不覆写粘性（回到原绑定）', (await getLogs('auto_sticky'))[0]?.routedTo === 'auto-m-gpt2', String((await getLogs('auto_sticky'))[0]?.routedTo));
await patchAuto(aStickR.body.id, { candidates: [{ routeId: mGptR.id, weight: 1 }, { routeId: mGpt2R.id, weight: 0 }] });
const rEvict = await autoReq('auto_sticky');
check('C2 weight=0 强制逐出粘性并改道', rEvict.status === 200 && (await getLogs('auto_sticky'))[0]?.routedTo === 'auto-m-gpt', String((await getLogs('auto_sticky'))[0]?.routedTo));
const aNoStick = await mkAuto({ publicName: 'auto_nosticky', candidates: [{ routeId: mGptR.id, weight: 1 }, { routeId: mGpt2R.id, weight: 1 }], stickyTtlMs: 0 });
const seen = new Set<string>();
for (let i = 0; i < 12; i++) { const r = await autoReq('auto_nosticky'); if (r.status === 200) seen.add((await getLogs('auto_nosticky'))[0]?.routedTo); }
check('TTL=0 不建粘性：加权随机两候选都出现', seen.has('auto-m-gpt') && seen.has('auto-m-gpt2'), JSON.stringify([...seen]));

// —— 两层 ACL ——
const aAcl = await mkAuto({ publicName: 'auto_acl', candidates: [{ routeId: mGptR.id, weight: 1 }, { routeId: mClaudeR.id, weight: 1 }], stickyTtlMs: 0 });
const kNoAuto = (await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'no-auto', allowedModels: ['auto-m-gpt'] }) })).body;
check('ACL 层1：无 auto 名授权 -> 403', (await autoReq('model_auto', {}, { authorization: `Bearer ${kNoAuto.key}`, 'content-type': 'application/json' })).status === 403, 'layer1');
const kLayer2 = (await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'acl2', allowedModels: ['auto_acl', 'auto-m-gpt'] }) })).body;
let aclOk = true;
for (let i = 0; i < 4; i++) { const r = await autoReq('auto_acl', {}, { authorization: `Bearer ${kLayer2.key}`, 'content-type': 'application/json' }); if (r.status !== 200) aclOk = false; }
const aclLog = (await getLogs('auto_acl')).filter((l) => l.vkeyName === 'acl2');
check('ACL 层2：候选按授权过滤（claude 从不被选）', aclOk && aclLog.every((l) => l.routedTo === 'auto-m-gpt'), JSON.stringify(aclLog.map((l) => l.routedTo)));
const autoMdl2 = await api('/v1/models', { headers: { authorization: `Bearer ${kLayer2.key}` } });
check('/v1/models 按 key 授权过滤 auto 条目', (autoMdl2.body?.data || []).some((m: any) => m.id === 'auto_acl') && !(autoMdl2.body?.data || []).some((m: any) => m.id === 'model_auto'), 'acl list');

// —— fallback 护栏（auto 永不进兜底渠道）——
await patchSettings({ fallbackChannelId: chAuto.id });
await patchAuto(aMainR.body.id, { enabled: false });
check('停用 auto -> 404 不进兜底', (await autoReq('model_auto')).status === 404, 'disabled');
await mkAuto({ publicName: 'auto_w0', candidates: [{ routeId: mGptR.id, weight: 0 }], stickyTtlMs: 0 });
check('weight 全 0 -> 404 不进兜底', (await autoReq('auto_w0')).status === 404, 'w0');
check('兜底渠道对未知普通模型仍生效（对照组）', (await autoReq('totally-unknown-xyz')).status === 200, 'fallback ok');
await patchAuto(aMainR.body.id, { enabled: true });
await patchSettings({ fallbackChannelId: '' });

// —— 引用告警（C8）——
const mDelR = (await mkModel({ publicName: 'auto-m-del', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).body;
await mkAuto({ publicName: 'auto_del', candidates: [{ routeId: mDelR.id, weight: 1 }] });
const delRes = await api(`/api/models/${mDelR.id}`, { method: 'DELETE', headers: ADMIN });
check('删被引用模型 -> 回 referencedAutoRoutes', delRes.body?.referencedAutoRoutes?.some((a: any) => a.publicName === 'auto_del'), JSON.stringify(delRes.body));

// —— debugHeaders 下 routed-to 头 ——
await patchSettings({ debugHeaders: true });
const rDbg = await autoReq('model_auto');
check('debugHeaders 开启后下发 x-lm-routed-to', !!rDbg.headers?.get?.('x-lm-routed-to'), String(rDbg.headers?.get?.('x-lm-routed-to')));
await patchSettings({ debugHeaders: false });

// —— 断开止损：链必须立即终止且不续下候选（B6）——
await fetch('http://127.0.0.1:18099/__hits/reset', { method: 'POST' });
const aSlow = await mkAuto({ publicName: 'auto_slow', candidates: [{ routeId: mSlow1R.id, weight: 1 }, { routeId: mSlow2R.id, weight: 1 }], stickyTtlMs: 0 });
const ac0 = new AbortController();
const pSlow = fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: AH, body: JSON.stringify({ model: 'auto_slow', messages: [{ role: 'user', content: '慢' }] }), signal: ac0.signal });
await new Promise((r) => setTimeout(r, 400));
ac0.abort();
await pSlow.catch(() => {});
await new Promise((r) => setTimeout(r, 800));
const hSlow = await mockHits();
check('断开后不续链：只触达一个慢候选（首跳随机）', (hSlow['mock-slow-1'] || 0) + (hSlow['mock-slow-2'] || 0) === 1, JSON.stringify(hSlow));
const lgSlow = (await getLogs('auto_slow'))[0];
check('断开落 499 取消终态', lgSlow?.status === 499, String(lgSlow?.status));
check('取消不记健康样本', !(await autoHealth()).windows.find((w: any) => w.routeId === mSlow1R.id || w.routeId === mSlow2R.id), 'no sample');

// —— 链预算：autoMaxChainSeconds 止损（N10）——
await patchSettings({ autoMaxChainSeconds: 10 });
await fetch('http://127.0.0.1:18099/__hits/reset', { method: 'POST' });
const tB = Date.now();
const rBudget = await autoReq('auto_slow');
const durB = Date.now() - tB;
const hSlow2 = await mockHits();
check('预算内止损 502（不拖满渠道超时）', rBudget.status === 502 && durB > 8_000 && durB < 25_000, `${durB}ms`);
const h1 = hSlow2['mock-slow-1'] || 0, h2 = hSlow2['mock-slow-2'] || 0;
check('预算耗尽停止扩展第二候选（首跳随机，另一候选必为 0）', h1 + h2 === 1 && String(rBudget.body?.error?.message).includes('链预算'), JSON.stringify(hSlow2) + ' ' + String(rBudget.body?.error?.message).slice(0, 80));
await patchSettings({ autoMaxChainSeconds: 300 });

// —— 观测出口 ——
const ovw = (await api('/api/overview', { headers: ADMIN })).body;
const btGpt = ((ovw.stats?.byRoutedTo || ovw.byRoutedTo || []) as any[]).find((b) => b.key === 'auto-m-gpt');
check('stats.byRoutedTo 归因真实去向（精确桶且非空）', !!btGpt && btGpt.requests > 0, JSON.stringify(btGpt));

// ================================================================ 15. 修复轮补测（评审裁决 B1/M1-M8 的守护断言）
section('15. 修复轮补测：流式两段式提交 / 配额 / C11 固化 / 粘性 TTL / 估算器');
// 如实声明（二轮 F18）：M5 的"提交瞬间 writeHead 弃养"竞态窗无法在进程内确定性打开，
// 该兜底路径靠 finalize 幂等 + 提交点复查守护，不在本节目的（本节目覆盖其可测邻域：三态断开）。

// —— M7：auto × 流式（§8-1 两段式提交的全部三态）——
const ch401b = await mkCh('Auto 401 Stream', 'openai', ['k-401-str']);
const mS401R = (await mkModel({ publicName: 'auto-m-s401', channelId: ch401b.id, upstreamModel: 'mock-gpt-5' })).body;
const mCutR = (await mkModel({ publicName: 'auto-m-cut', channelId: chAuto.id, upstreamModel: 'mock-streamcut' })).body;
const mScR = (await mkModel({ publicName: 'auto-m-sc', channelId: chAuto.id, upstreamModel: 'mock-slowstream' })).body;
await resetAutoRT();
await mkAuto({ publicName: 'auto_stream', candidates: [{ routeId: mS401R.id, weight: 99 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 }); // 二轮F4：偏置消 50/50 抽奖尾
let sawFailHop = false;
let streamAll200 = true;
let streamText = '';
for (let i = 0; i < 3; i++) {
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: AH, body: JSON.stringify({ model: 'auto_stream', stream: true, messages: [{ role: 'user', content: '流式续链' }] }) });
  const evs = await readSSE(res);
  const txt = evs.map((e) => e.data?.choices?.[0]?.delta?.content || '').join('');
  if (res.status !== 200 || !txt) streamAll200 = false;
  else streamText = txt;
  const lg = (await getLogs('auto_stream'))[0];
  if (lg?.chainAttempts?.some((x: any) => x.name === 'auto-m-s401' && x.committed === false)) sawFailHop = true;
  if (sawFailHop) break;
}
check('stage A 流式：提交前判负候选换候选续链（首跳偏置，3 连内必现且全 200）', sawFailHop && streamAll200 && !!streamText, `${sawFailHop}/${streamAll200}`);
const lgStageA = (await getLogs('auto_stream'))[0];
check('stage A 流式：routedTo 归属成功候选且响应为 SSE', lgStageA?.routedTo === 'auto-m-gpt' && !!streamText, String(lgStageA?.routedTo));
check('F13 stage A：提交前判负的 401 候选计一条健康败样', (await autoHealth()).windows.find((w: any) => w.routeId === mS401R.id)?.fail === 1, JSON.stringify((await autoHealth()).windows.find((w: any) => w.routeId === mS401R.id)));
const aCutR = await mkAuto({ publicName: 'auto_cut', candidates: [{ routeId: mCutR.id, weight: 1 }], stickyTtlMs: 0 });
const resCut = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: AH, body: JSON.stringify({ model: 'auto_cut', stream: true, messages: [{ role: 'user', content: '掐流' }] }) });
const bodyCut = await resCut.text();
const lgCut = (await getLogs('auto_cut'))[0];
check('stage B 提交后掐流：不换候选（链仅 1 条且 committed）+ 协议内 error 帧', resCut.status === 200 && bodyCut.includes('"error"') && lgCut?.chainAttempts?.length === 1 && lgCut?.chainAttempts?.[0]?.committed === true, `${resCut.status} ${JSON.stringify(lgCut?.chainAttempts)}`);
check('stage B 掐流计上游失败样本（F4 两分法）', (await autoHealth()).windows.find((w: any) => w.routeId === mCutR.id)?.fail === 1 && lgCut?.status === 502, JSON.stringify((await autoHealth()).windows.find((w: any) => w.routeId === mCutR.id)));
const aScR = await mkAuto({ publicName: 'auto_sc', candidates: [{ routeId: mScR.id, weight: 1 }], stickyTtlMs: 0 });
const resSc = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: AH, body: JSON.stringify({ model: 'auto_sc', stream: true, messages: [{ role: 'user', content: '提交后断开' }] }) });
const rdSc = resSc.body!.getReader();
await rdSc.read(); // 首块到达 = 已提交
await new Promise((r) => setTimeout(r, 120));
await rdSc.cancel();
await new Promise((r) => setTimeout(r, 500));
const lgSc = (await getLogs('auto_sc'))[0];
check('提交后客户端断开：499 终态、链不续、不计健康分', lgSc?.status === 499 && lgSc?.chainAttempts?.[0]?.committed === true && !(await autoHealth()).windows.find((w: any) => w.routeId === mScR.id), JSON.stringify({ s: lgSc?.status, ca: lgSc?.chainAttempts }));
await patchModel(mGpt2R.id, { supportsStreaming: false });
await mkAuto({ publicName: 'auto_sf', candidates: [{ routeId: mGpt2R.id, weight: 1 }], stickyTtlMs: 0 });
const rSf = await autoReq('auto_sf', { stream: true });
check('①-f 流式×不支持流式候选 -> 唯一候选 404 带理由', rSf.status === 404 && String(rSf.body?.error?.message).includes('流式'), `${rSf.status} ${JSON.stringify(rSf.body).slice(0, 90)}`);
await patchModel(mGpt2R.id, { supportsStreaming: true });

// —— M2：估算器口径（system / tools schema 必须进 ①-c）——
const rSysE = await api('/v1/messages', { method: 'POST', headers: { 'x-api-key': VKEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto_empty', max_tokens: 8, system: 's'.repeat(2000), messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }) });
check('M2 顶层 system 计入估算：超窗唯一候选 404（修复前是 200 放行）', rSysE.status === 404, String(rSysE.status));
const bigTool = { type: 'function', function: { name: 'big', parameters: { properties: { p: { type: 'string', enum: Array.from({ length: 400 }, (_, i) => 'v'.repeat(30) + i) } } } } };
const rToolE = await autoReq('auto_empty', { messages: [{ role: 'user', content: 'hi' }], tools: [bigTool] });
check('M2 tools schema 计入估算：超窗唯一候选 404', rToolE.status === 404, String(rToolE.status));
const aGonly = await mkAuto({ publicName: 'auto_gonly', candidates: [{ routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const rGonly = await api('/v1/messages', { method: 'POST', headers: { 'x-api-key': VKEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto_gonly', max_tokens: 8, messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }] }) });
check('①-g 确定性形态：唯一候选不承载 cache_control -> 404', rGonly.status === 404, String(rGonly.status));
const aMaxOnly = await mkAuto({ publicName: 'auto_maxonly', candidates: [{ routeId: mGpt2R.id, weight: 1 }], stickyTtlMs: 0 });
const rMaxE = await autoReq('auto_maxonly', { max_tokens: 5000 });
check('①-e 确定性形态：唯一候选超 maxOut -> 404 带理由', rMaxE.status === 404 && String(rMaxE.body?.error?.message).includes('上限'), `${rMaxE.status} ${JSON.stringify(rMaxE.body).slice(0, 90)}`);

// —— B1：auto × dailyTokenLimit 预占必须随完成释放 ——
const kQuota = (await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'quota-key', dailyTokenLimit: 1150 }) })).body;
await patchModel(mGpt2R.id, { maxOutputTokens: 1075 }); // 二轮F15：本段自给自足（1075 同时是 est 来源；请求不带 max_tokens，避免撞上 ①-e）
await mkAuto({ publicName: 'auto_quota', candidates: [{ routeId: mGpt2R.id, weight: 1 }], stickyTtlMs: 0 });
const AHQ = { authorization: `Bearer ${kQuota.key}`, 'content-type': 'application/json' };
const QMAX: any = {}; // est=1+candMax(1075)=1076：winner 56+1076≤1150；败者无论"在途叠加"(56+1076+1076)还是"等 winner 完成后串行"(84+1076)都 >1150——拒绝与完成顺序无关
const q1 = await autoReq('auto_quota', QMAX, AHQ);
const q2 = await autoReq('auto_quota', QMAX, AHQ);
check('B1 预占随完成释放：限额 key 第二发不再假 429（修复前必 429）', q1.status === 200 && q2.status === 200, `${q1.status}/${q2.status}`);
const qAll = await Promise.all([autoReq('auto_quota', QMAX, AHQ), autoReq('auto_quota', QMAX, AHQ), autoReq('auto_quota', QMAX, AHQ)]);
const qOk = qAll.filter((q) => q.status === 200).length;
check('F2 三发并发恰一放行（在途预占真实参与判定，非串行假象）', qOk === 1, JSON.stringify(qAll.map((q) => q.status)));

// —— C11 固化：定向 429-first 续链 + 全候选 429 终态 ——
await resetAutoRT();
const ch429cb = await mkCh('Auto 429 ChainB', 'openai', ['k-429-cb']);
const mRateCbR = (await mkModel({ publicName: 'rate429c-m', channelId: ch429cb.id, upstreamModel: 'mock-gpt-5' })).body;
await mkAuto({ publicName: 'auto_429b', candidates: [{ routeId: mRateCbR.id, weight: 99 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 }); // 二轮F5：偏置消 8 连抽奖
let rateFirst: { st: number; routedTo?: string } | null = null;
for (let i = 0; i < 8; i++) {
  const r = await autoReq('auto_429b');
  const l = (await getLogs('auto_429b'))[0];
  if (l?.chainAttempts?.[0]?.name === 'rate429c-m') { rateFirst = { st: r.status, routedTo: l.routedTo }; break; }
}
check('C11 固化：429 候选居链首仍续链 200 且不进健康窗口', !!rateFirst && rateFirst.st === 200 && rateFirst.routedTo === 'auto-m-gpt' && !(await autoHealth()).windows.find((w: any) => w.routeId === mRateCbR.id), JSON.stringify(rateFirst));
const ch429end = await mkCh('Auto 429 End', 'openai', ['k-429-end']);
const mRateEndR = (await mkModel({ publicName: 'rate429d-m', channelId: ch429end.id, upstreamModel: 'mock-gpt-5' })).body;
await mkAuto({ publicName: 'auto_429end', candidates: [{ routeId: mRateEndR.id, weight: 1 }], stickyTtlMs: 0 });
const rEnd = await autoReq('auto_429end');
check('C11 后半：全候选 429 -> 终态 429 + retry-after，链记录 committed=false', rEnd.status === 429 && !!rEnd.headers?.get?.('retry-after') && (await getLogs('auto_429end'))[0]?.chainAttempts?.[0]?.committed === false, `${rEnd.status} ${rEnd.headers?.get?.('retry-after')}`);
check('C11 后半：429 穷尽也不计健康样本', !(await autoHealth()).windows.find((w: any) => w.routeId === mRateEndR.id), 'no sample');
const ovw2 = (await api('/api/overview', { headers: ADMIN })).body;
const bt2 = (ovw2.stats?.byRoutedTo || ovw2.byRoutedTo || []) as any[];
check('F7 归因：全链失败的 auto 落 auto 名桶，而非末位尝试候选桶', bt2.some((b) => b.key === 'auto_429end' && b.requests >= 1) && !bt2.some((b) => b.key === 'rate429d-m'), JSON.stringify(bt2.map((b) => b.key)));

// —— C4 冷启动分支：混合样本 total<3 -> 1.0 ——
const mColdR = (await mkModel({ publicName: 'cold-m', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).body;
await autoReq('cold-m'); // 定向成功 1 样本
await patchModel(mColdR.id, { upstreamModel: 'mock-404' });
await autoReq('cold-m'); // 定向失败 1 样本
const wCold = (await autoHealth()).windows.find((w: any) => w.routeId === mColdR.id);
check('C4 冷启动：1ok+1fail（total<3）health=1.0 不误杀', wCold?.ok === 1 && wCold?.fail === 1 && wCold?.health === 1, JSON.stringify(wCold));

// —— 粘性 TTL：滑动续期与过期（可测形态：TTL=500ms）——
const aTtlR = await mkAuto({ publicName: 'auto_ttl', candidates: [{ routeId: mGptR.id, weight: 1 }, { routeId: mGpt2R.id, weight: 0 }], stickyTtlMs: 500 });
await autoReq('auto_ttl'); // 钉到唯一活候选 gpt
await patchAuto(aTtlR.body.id, { candidates: [{ routeId: mGptR.id, weight: 1 }, { routeId: mGpt2R.id, weight: 99 }] }); // 二轮F3/F6：过期重钉偏置向 gpt2——续期失效/不过期都会当场现形
let renewed = true;
for (let i = 0; i < 4; i++) {
  await autoReq('auto_ttl');
  if ((await getLogs('auto_ttl'))[0]?.routedTo !== 'auto-m-gpt') renewed = false;
  await new Promise((r) => setTimeout(r, 160)); // 4×~170ms ≈ 680ms > TTL：无续期必在中途松手
}
check('粘性滑动续期：TTL=500ms 下 680ms 连打仍钉住原候选', renewed, JSON.stringify((await getLogs('auto_ttl')).slice(0, 4).map((l) => l.routedTo)));
// 过期后首个请求会重新钉住（粘性语义使然），"分流"不可直接观察；
// 可观察的是：每轮静默越过 TTL 后重打，绑定终将易主——粘性不过期则永远 gpt，必假红
let released = false;
for (let i = 0; i < 8 && !released; i++) {
  await new Promise((r) => setTimeout(r, 650)); // > TTL=500ms，粘性过期
  await autoReq('auto_ttl');
  if ((await getLogs('auto_ttl'))[0]?.routedTo === 'auto-m-gpt2') released = true;
}
check('粘性 TTL 过期：静默越过 TTL 后绑定可易主（不过期则永无此日）', released, JSON.stringify((await getLogs('auto_ttl')).slice(0, 8).map((l) => l.routedTo)));
check('粘性条目数可观测（auto-health 出口，此刻 auto_ttl 必有活绑定）', (await autoHealth()).stickyEntries > 0, JSON.stringify((await autoHealth()).stickyEntries));

// —— N11 守护（二轮 F1"绿色谎言①"：M1 修复此前零断言）——
await resetAutoRT();
const mN11R = (await mkModel({ publicName: 'auto-m-n11', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).body;
await autoReq('auto-m-n11'); // 定向成功 1 样本（total<3 → health 1.0）
const aN11R = await mkAuto({ publicName: 'auto_n11', candidates: [{ routeId: mN11R.id, weight: 1 }, { routeId: mGpt2R.id, weight: 0 }] });
await autoReq('auto_n11');
check('N11 前置：钉住唯一活候选 n11', (await getLogs('auto_n11'))[0]?.routedTo === 'auto-m-n11', JSON.stringify((await getLogs('auto_n11'))[0]?.routedTo));
await patchAuto(aN11R.body.id, { candidates: [{ routeId: mN11R.id, weight: 1 }, { routeId: mGpt2R.id, weight: 99 }] });
await patchModel(mN11R.id, { upstreamModel: 'mock-404' }); // 粘性目标运行时判负（404 计败样 → health 2/3 仍 ≥0.4，不触发松手）
const rN11 = await autoReq('auto_n11');
const lN11 = (await getLogs('auto_n11'))[0];
check('N11：命中运行时判负 → 换候选续链成功（committed=false 在前）', rN11.status === 200 && lN11?.routedTo === 'auto-m-gpt2' && lN11?.chainAttempts?.[0]?.name === 'auto-m-n11' && lN11?.chainAttempts?.[0]?.committed === false, JSON.stringify(lN11?.chainAttempts));
await patchModel(mN11R.id, { upstreamModel: 'mock-gpt-5' });
await autoReq('auto_n11');
check('N11：命中失败后成功候选不得覆写——绑定回到 n11（覆写回归必红）', (await getLogs('auto_n11'))[0]?.routedTo === 'auto-m-n11', String((await getLogs('auto_n11'))[0]?.routedTo));

// —— L1 前置顺序（二轮 F10：只测"403 存在"不够，要测"403 先于探测面"）——
const rEmbNo = await api('/v1/embeddings', { method: 'POST', headers: { authorization: `Bearer ${kNoAuto.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'model_auto', input: 'x' }) });
check('L1 前置：未授权 key × embeddings 也得 403（存在性探测已闭，非 400）', rEmbNo.status === 403, String(rEmbNo.status));
await patchAuto(aMainR.body.id, { enabled: false });
const rDisNo = await autoReq('model_auto', {}, { authorization: `Bearer ${kNoAuto.key}`, 'content-type': 'application/json' });
check('L1 前置：未授权 × 停用 auto 也是 403（开关探测已闭，非 404）', rDisNo.status === 403, String(rDisNo.status));
await patchAuto(aMainR.body.id, { enabled: true });

// —— import-models：前缀主场景不被误杀 + 真撞名有回执（二轮 C3/F11）——
const imp1 = await api(`/api/channels/${chAuto.id}/import-models`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ models: ['auto-m-gpt', 'brand-new-x'], prefix: 'imp-' }) });
check('C3/F11：前缀导入不因"上游真名撞既有外名"被误杀（created=2 + skipped 形状）', imp1.status === 200 && imp1.body?.created === 2 && Array.isArray(imp1.body?.skipped), JSON.stringify(imp1.body?.skipped));
const imp2 = await api(`/api/channels/${chAuto.id}/import-models`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ models: ['imp-brand-new-x'] }) });
check('C3/F11：与既有外名真撞 → created=0 且进 skipped 回执', imp2.body?.created === 0 && imp2.body?.skipped?.includes('imp-brand-new-x'), JSON.stringify(imp2.body));

// —— 迟滞松手：health<0.4 删绑定直接改道（二轮 F12，STICKY_KEEP 守护）——
const mK1R = (await mkModel({ publicName: 'auto-m-k1', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).body;
const mK2R = (await mkModel({ publicName: 'auto-m-k2', channelId: chAuto.id, upstreamModel: 'mock-gpt-mini' })).body;
const aKeepR = await mkAuto({ publicName: 'auto_keep', candidates: [{ routeId: mK1R.id, weight: 1 }, { routeId: mK2R.id, weight: 0 }] });
await autoReq('auto_keep'); // 钉住 k1（health 1.0 ≥0.6 写粘性）
await patchModel(mK1R.id, { upstreamModel: 'mock-404' });
for (let i = 0; i < 3; i++) await autoReq('auto-m-k1'); // 定向 3 败 → 1ok+3fail → health 0.25 <0.4
await patchAuto(aKeepR.body.id, { candidates: [{ routeId: mK1R.id, weight: 1 }, { routeId: mK2R.id, weight: 99 }] });
const rKeep = await autoReq('auto_keep');
const lKeep = (await getLogs('auto_keep'))[0];
check('迟滞松手：粘性目标 health<0.4 → 删绑定直接改道，不烧一次失败尝试（松手回归必红）', rKeep.status === 200 && lKeep?.routedTo === 'auto-m-k2' && lKeep?.chainAttempts?.length === 1, JSON.stringify(lKeep?.chainAttempts));
await patchModel(mK1R.id, { upstreamModel: 'mock-gpt-5' });

// ================================================================
console.log(`\n\x1b[1m结果\x1b[0m  \x1b[32m${pass} 通过\x1b[0m  ${failCount ? `\x1b[31m${failCount} 失败\x1b[0m` : ''}`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
}

store.flushSync();
mockServer.close();
gwServer.close();
rmSync(DATA, { recursive: true, force: true });
process.exit(failCount ? 1 : 0);
