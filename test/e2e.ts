/**
 * 端到端自测：mock 上游 + 网关全链路。
 * 覆盖：同协议路由、跨协议互转（双向）、流式、号池故障切换、鉴权、用量记账。
 * 运行：npm test
 */
import { serve } from '@hono/node-server';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single',  publicName: 'gpt-4o', channelId: oa.id, upstreamModel: 'mock-gpt-5', priceInput: 2.5, priceOutput: 10 }) });
await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single',  publicName: 'claude-sonnet', channelId: an.id, upstreamModel: 'mock-claude-sonnet', priceInput: 3, priceOutput: 15 }) });
const models = (await api('/api/routes?type=single', { headers: ADMIN })).body;
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
// 新契约（审查 A-M 枚举防护）：无权模型与未知模型不可区分，统一 404 未配置路由；可用列表只含该 key 有权的模型
check(
  'key 未授权该模型 -> 404 与未知模型不可区分（枚举防护）',
  notAllowed.status === 404 && /未配置路由/.test(JSON.stringify(notAllowed.body)) && !/可用模型：.*claude-sonnet/.test(JSON.stringify(notAllowed.body)),
  `${notAllowed.status} ${JSON.stringify(notAllowed.body).slice(0, 120)}`,
);

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
await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single',  publicName: 'broken-model', channelId: broken.id, upstreamModel: 'mock-gpt-5' }) });
const brokenRes = await api('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${VKEY}` }, body: JSON.stringify({ model: 'broken-model', messages: [{ role: 'user', content: 'x' }] }) });
check('全渠道鉴权失败 -> 401 透传', brokenRes.status === 401, JSON.stringify(brokenRes.body));

// 上游 5xx：重试耗尽后 502
const bad500 = (await api('/api/channels', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'Boom500', baseUrl: 'http://127.0.0.1:18099/v1', protocol: 'openai', keys: ['k-500-a', 'k-500-b', 'k-500-c'] }) })).body;
await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single',  publicName: 'boom-model', channelId: bad500.id, upstreamModel: 'mock-gpt-5' }) });
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

const mdl = (await api('/api/routes?type=single', { headers: ADMIN })).body.find((m: any) => m.publicName === 'gpt-4o');
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
const mkModel = async (body: any) => api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single', ...body }) });
const mkAuto = async (body: any) => api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'auto', ...body }) });
const patchAuto = async (id: string, body: any) => api(`/api/routes/${id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify(body) });
const patchModel = async (id: string, body: any) => api(`/api/routes/${id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify(body) });
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
const dangList = (await (await api('/api/routes?type=auto', { headers: ADMIN })).body).find((a: any) => a.id === aDangR.body.id);
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
check('404 模型名 -> 候选判负续链，穷尽 400（G3 纯 4xx 聚合终态，不再伪装 502）', r404.status === 400 && String(r404.body?.error?.message).includes('does not exist'), String(r404.status));
// C4（G12 守卫前置版）：≥3 样本全挂 → 0.1。失败样本 (routeId,vkey) 1/min 限频（SEC-1）——
// 单 vkey 一分钟内只记 1 败，凑 3 败需 3 把 vkey（毒化成本：≥3 败/10min 且须跨 vkey）
const kC4b = (await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'c4-b' }) })).body;
const kC4c = (await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'c4-c' }) })).body;
const AHb = { authorization: `Bearer ${kC4b.key}`, 'content-type': 'application/json' };
const AHc = { authorization: `Bearer ${kC4c.key}`, 'content-type': 'application/json' };
await autoReq('auto_404only', {}, AHb);
await autoReq('auto_404only', {}, AHc);
check('C4 ≥3 样本全挂 health=0.1（G12 守卫前置后语义不变）', (await autoHealth()).windows.find((w: any) => w.routeId === m404R.id)?.health === 0.1, JSON.stringify((await autoHealth()).windows.find((w: any) => w.routeId === m404R.id)));
await autoReq('auto_404only'); // VKEY 的第二次失败——应被 SEC-1 限频吞掉
check('SEC-1 失败样本 (routeId,vkey) 1/min 限频（fail 仍 3）', (await autoHealth()).windows.find((w: any) => w.routeId === m404R.id)?.fail === 3, JSON.stringify((await autoHealth()).windows.find((w: any) => w.routeId === m404R.id)));
const aFailR = await mkAuto({ publicName: 'auto_fail', candidates: [{ routeId: (await mkModel({ publicName: 'auto-m-dead', channelId: chDead.id, upstreamModel: 'mock-gpt-5' })).body.id, weight: 1 }, { routeId: m404R.id, weight: 1 }], stickyTtlMs: 0 });
const rFail = await autoReq('auto_fail');
const failMsg = String(rFail.body?.error?.message || '');
check('全候选失败 502 且明细回显（C17）', rFail.status === 502 && failMsg.includes('所有候选均失败') && failMsg.includes('Auto Dead'), failMsg.slice(0, 140));
check('哨兵：502 明细绝不泄漏 key 全值', !failMsg.includes('sk-secretauto-deadkey-98765') && failMsg.includes('***'), 'mask');

// —— AR-7 失败链确定性降序 + F5.2 三层决策快照 ——
// 全败链（4×k-500）：首跳加权随机不可控，但断言改为「从实测首跳推出的期望链序」——
// 每一步都取剩余集合的 ew 确定性降序（B/D 同分 tie-break routeId 字典序），零掷骰子依赖
await resetAutoRT();
const chDead2 = await mkCh('Auto Dead2', 'openai', ['k-500-desc']);
const mDead2R = (await mkModel({ publicName: 'auto-m-dead2', channelId: chDead2.id, upstreamModel: 'mock-gpt-5' })).body;
const chOkB = await mkCh('Auto OkB', 'openai', ['k-500-descb']);
const mOkBR = (await mkModel({ publicName: 'auto-m-okb', channelId: chOkB.id, upstreamModel: 'mock-gpt-5' })).body;
const chOkC = await mkCh('Auto OkC', 'openai', ['k-500-descc']);
const mOkCR = (await mkModel({ publicName: 'auto-m-okc', channelId: chOkC.id, upstreamModel: 'mock-gpt-5' })).body;
const chOkD = await mkCh('Auto OkD', 'openai', ['k-500-descd']);
const mOkDR = (await mkModel({ publicName: 'auto-m-okd', channelId: chOkD.id, upstreamModel: 'mock-gpt-5' })).body;
const aDesc = await mkAuto({ publicName: 'auto_desc', candidates: [
  { routeId: mDead2R.id, weight: 10000 }, { routeId: mOkBR.id, weight: 5 }, { routeId: mOkCR.id, weight: 1 }, { routeId: mOkDR.id, weight: 5 }, { routeId: 'route_dangling_desc', weight: 9 },
], stickyTtlMs: 0 });
await autoReq('auto_desc'); // 全候选 5xx → 502，链走满 4 跳
const lgDesc = (await getLogs('auto_desc'))[0];
const ewOfId = (id: string) => (id === mDead2R.id ? 10000 : id === mOkCR.id ? 1 : 5);
const allIds = [mDead2R.id, mOkBR.id, mOkCR.id, mOkDR.id];
const firstId = lgDesc?.chainAttempts?.[0]?.routeId;
const expectedOrder = firstId ? [firstId, ...allIds.filter((id) => id !== firstId).sort((x, y) => (ewOfId(y) - ewOfId(x)) || (x < y ? -1 : 1))] : [];
check('AR-7 链序 = 每步剩余集合的 ew 确定性降序（含 B/D 同分 tie-break routeId）', JSON.stringify((lgDesc?.chainAttempts || []).map((x: any) => x.routeId)) === JSON.stringify(expectedOrder), JSON.stringify(lgDesc?.chainAttempts?.map((x: any) => [x.name, x.pickBasis])));
check('AR-7 首跳 basis=weighted、续跳全 chain', lgDesc?.chainAttempts?.[0]?.pickBasis === 'weighted' && lgDesc?.chainAttempts?.slice(1).every((x: any) => x.pickBasis === 'chain'), JSON.stringify(lgDesc?.chainAttempts?.map((x: any) => x.pickBasis)));
check('F5.2 survivors 快照逐跳收缩 4→3→2→1 且带 ew', JSON.stringify((lgDesc?.chainAttempts || []).map((x: any) => x.pickSnapshot?.length)) === '[4,3,2,1]' && lgDesc?.chainAttempts?.[0]?.pickSnapshot?.[0]?.ew === 10000, JSON.stringify(lgDesc?.chainAttempts?.map((x: any) => x.pickSnapshot?.length)));
check('F5.2 excluded 层快照：悬空候选 hard 剔除带理由', lgDesc?.chainExcluded?.length === 1 && lgDesc.chainExcluded[0].kind === 'hard' && String(lgDesc.chainExcluded[0].reason).includes('悬空'), JSON.stringify(lgDesc?.chainExcluded));
const winsAfterDesc = (await autoHealth()).windows;
check('AR-7 续链健康落账：四个候选各恰记 1 败', allIds.every((id) => winsAfterDesc.find((w: any) => w.routeId === id)?.fail === 1), JSON.stringify(winsAfterDesc.map((w: any) => [w.name, w.fail])));

// —— AUTH-1：双 k-401 渠道单请求恰记 1 次候选级失败（key 级重试不重复计败）——
await resetAutoRT();
const ch401x2 = await mkCh('Auto 401x2', 'openai', ['k-401-a2', 'k-401-b2']);
const m401x2R = (await mkModel({ publicName: 'auto-m-401x2', channelId: ch401x2.id, upstreamModel: 'mock-gpt-5' })).body;
const a401x2 = await mkAuto({ publicName: 'auto_401x2', candidates: [{ routeId: m401x2R.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const r401x2 = await autoReq('auto_401x2');
check('AUTH-1 双 401 key 候选判负续链 200', r401x2.status === 200 && (await getLogs('auto_401x2'))[0]?.routedTo === 'auto-m-gpt', String(r401x2.status));
check('AUTH-1 候选级恰记 1 败（两个 key 都挂也只 1 样本）', (await autoHealth()).windows.find((w: any) => w.routeId === m401x2R.id)?.fail === 1, JSON.stringify((await autoHealth()).windows.find((w: any) => w.routeId === m401x2R.id)));

// —— AR-3/OVF-1：纯超窗穷尽 → 400 + 聚合文案「所有候选窗口不足（最大 N tokens）」——
// mTlR 无显式窗（mkModel 默认 128000）；mTl2R 显式 200000 成为最大者，断言锚定它
const mTl2R = (await mkModel({ publicName: 'auto-m-tl2', channelId: chAuto.id, upstreamModel: 'mock-toolong', contextWindow: 200000 })).body;
const aOvf = await mkAuto({ publicName: 'auto_ovf', candidates: [{ routeId: mTlR.id, weight: 1 }, { routeId: mTl2R.id, weight: 1 }], stickyTtlMs: 0 });
const rOvf = await autoReq('auto_ovf', { messages: [{ role: 'user', content: '长'.repeat(200) }] });
check('OVF-1 纯超窗穷尽 400（非 502）', rOvf.status === 400, String(rOvf.status));
check('OVF-1 聚合文案带最大窗口', String(rOvf.body?.error?.message).includes('所有候选窗口不足') && String(rOvf.body?.error?.message).includes('200000'), String(rOvf.body?.error?.message).slice(0, 120));

// —— F2.1 收窄版：带图 400 分流（C 格白名单续链 vs D 格短接；学习闭环 P1.5 接入）——
await resetAutoRT();
const chNoImg = await mkCh('Auto NoImg', 'openai', ['k-ok-noimg']);
const mNoImgR = (await mkModel({ publicName: 'auto-m-noimg', channelId: chNoImg.id, upstreamModel: 'mock-noimg' })).body;
const aVis = await mkAuto({ publicName: 'auto_vis', candidates: [{ routeId: mNoImgR.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const imgMsg = [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }];
const rVis = await autoReq('auto_vis', { messages: imgMsg });
check('F2.1 带图 400 命中视觉白名单 → C 格续链 200', rVis.status === 200 && (await getLogs('auto_vis'))[0]?.routedTo === 'auto-m-gpt', String(rVis.status));
check('F2.1 视觉续链不计健康样本（学习动作 P1.5 接管）', !(await autoHealth()).windows.find((w: any) => w.routeId === mNoImgR.id), JSON.stringify((await autoHealth()).windows.find((w: any) => w.routeId === mNoImgR.id)));
const chBadp = await mkCh('Auto BadParam', 'openai', ['k-ok-badp']);
const mBadpR = (await mkModel({ publicName: 'auto-m-badp', channelId: chBadp.id, upstreamModel: 'mock-badparam' })).body;
const aBadp = await mkAuto({ publicName: 'auto_badp', candidates: [{ routeId: mBadpR.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const rBadp = await autoReq('auto_badp');
check('F2.1 对照：无能力声明 400 → D 格短接顶层 400', rBadp.status === 400 && String(rBadp.body?.error?.message).includes('temperature'), String(rBadp.status));
check('F2.1 对照：D 格短接不烧全链（mGpt 未被尝试）', ((await getLogs('auto_badp'))[0]?.chainAttempts || []).length === 1, JSON.stringify((await getLogs('auto_badp'))[0]?.chainAttempts));

// —— 饱和态（P1 §2）：SAT-1/2/3/4/5/6/7 ——
const origSettingsP1 = (await api('/api/settings', { headers: ADMIN })).body;
const patchSt = async (b: any) => api('/api/settings', { method: 'PATCH', headers: ADMIN, body: JSON.stringify(b) });
await patchSt({ cooldownBaseMs: 1000 }); // key 冷却 1s：配合假时钟让「key 已恢复 + 饱和将尽」可测
await resetAutoRT();
// SAT-1：双 k-429 key 渠道单链内两 key 均 429 → 触发 (a) 进入饱和；后续请求不再选它
const chSat = await mkCh('Auto Sat', 'openai', ['k-429-sat1', 'k-429-sat2']);
const mSatR = (await mkModel({ publicName: 'auto-m-sat', channelId: chSat.id, upstreamModel: 'mock-gpt-5' })).body;
const aSat = await mkAuto({ publicName: 'auto_sat', candidates: [{ routeId: mSatR.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const rSat1 = await autoReq('auto_sat');
check('SAT-1 双 k-429 触发饱和、链续到 200', rSat1.status === 200 && (await getLogs('auto_sat'))[0]?.routedTo === 'auto-m-gpt', String(rSat1.status));
const sat1 = (await autoHealth()).saturation?.find((s: any) => s.routeId === mSatR.id);
check('SAT-1 /auto-health 出饱和条目（60s 首档退避）', sat1?.leftSec > 50 && sat1?.leftSec <= 60, JSON.stringify(sat1));
const rSat2 = await autoReq('auto_sat');
check('SAT-1 饱和期内不再尝试该候选（chainAttempts 无它）', rSat2.status === 200 && !(await getLogs('auto_sat'))[0]?.chainAttempts?.some((x: any) => x.routeId === mSatR.id), JSON.stringify((await getLogs('auto_sat'))[0]?.chainAttempts));
// SAT-2/7：retry-after 7200s 突破 maxSec；合成 429 响应头不被 cooldownMaxMs(900s) 钳制；报错可区分
const chSatRa = await mkCh('Auto SatRa', 'openai', ['k-429ra7200-a', 'k-429ra7200-b']);
const mSatRaR = (await mkModel({ publicName: 'auto-m-satra', channelId: chSatRa.id, upstreamModel: 'mock-gpt-5' })).body;
await mkAuto({ publicName: 'auto_satra', candidates: [{ routeId: mSatRaR.id, weight: 1 }], stickyTtlMs: 0 });
const rSatRa1 = await autoReq('auto_satra');
check('SAT-2 触发请求 429（单候选链耗尽透传）', rSatRa1.status === 429, String(rSatRa1.status));
const rSatRa2 = await autoReq('auto_satra');
const raHdr = Number(rSatRa2.headers.get('retry-after'));
check('SAT-2 合成 429 retry-after≈7200（>cooldownMaxMs 900s，未钳制）', rSatRa2.status === 429 && raHdr > 3600 && raHdr <= 7200, String(raHdr));
check('SAT-7 合成 429 报错含「所有候选饱和」（F2.2 可区分）', String(rSatRa2.body?.error?.message).includes('所有候选饱和'), String(rSatRa2.body?.error?.message).slice(0, 80));
// SAT-3 后半：剩余 <5s → 探测例外仍尝试（假时钟 +57s；key 冷却 1s 已真实恢复）
const chSatP = await mkCh('Auto SatP', 'openai', ['k-429-satp1', 'k-429-satp2']);
const mSatPR = (await mkModel({ publicName: 'auto-m-satp', channelId: chSatP.id, upstreamModel: 'mock-gpt-5' })).body;
const aSatP = await mkAuto({ publicName: 'auto_satp', candidates: [{ routeId: mSatPR.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
await autoReq('auto_satp'); // 触发饱和（ra '1' → 退避 60s 主导）
await new Promise((r) => setTimeout(r, 2100)); // key 冷却 1s 真实过期
const autoMod = await import('../src/auto.ts');
autoMod.setClockForTest(() => Date.now() + 57_000); // 假时钟：饱和剩 ~3s <5s
const rSatP2 = await autoReq('auto_satp');
autoMod.setClockForTest(() => Date.now());
check('SAT-3 剩余<5s 探测例外仍尝试饱和候选', (await getLogs('auto_satp'))[0]?.chainAttempts?.[0]?.routeId === mSatPR.id && rSatP2.status === 200, JSON.stringify((await getLogs('auto_satp'))[0]?.chainAttempts));
// SAT-4：探测出成功 → 饱和清零退避回 1 档
const chSat4 = await mkCh('Auto Sat4', 'openai', ['k-429once1-s4a', 'k-429once1-s4b']);
const mSat4R = (await mkModel({ publicName: 'auto-m-sat4', channelId: chSat4.id, upstreamModel: 'mock-gpt-5' })).body;
const aSat4 = await mkAuto({ publicName: 'auto_sat4', candidates: [{ routeId: mSat4R.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const rSat41 = await autoReq('auto_sat4');
await new Promise((r) => setTimeout(r, 2100));
autoMod.setClockForTest(() => Date.now() + 57_000);
const rSat42 = await autoReq('auto_sat4');
autoMod.setClockForTest(() => Date.now());
check('SAT-4 探测成功 → 200 且饱和清零', rSat42.status === 200 && (await getLogs('auto_sat4'))[0]?.routedTo === 'auto-m-sat4' && !(await autoHealth()).saturation?.some((s: any) => s.routeId === mSat4R.id), `${rSat42.status} ${JSON.stringify((await autoHealth()).saturation)}`);
// SAT-5：粘性目标饱和 → 绕行 + 续期 + degraded 标；恢复后非绕行命中转正
await resetAutoRT();
// 粘性须建在 mSat5 上：先经 k-ok 渠道成功建粘，再 PATCH 模型 channelId 切到 429 渠道（一次性 429 key）
const chSat5 = await mkCh('Auto Sat5', 'openai', ['k-429once1-s5a', 'k-429once1-s5b']);
const chOk5 = await mkCh('Auto Ok5', 'openai', ['k-ok-s5']);
const mSat5R = (await mkModel({ publicName: 'auto-m-sat5', channelId: chOk5.id, upstreamModel: 'mock-gpt-5' })).body;
await mkAuto({ publicName: 'auto_sats', candidates: [{ routeId: mSat5R.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 60000 });
await autoReq('auto_sats'); // 命中 mSat5 200 → 建粘（health 1.0 ≥ 0.6）
await patchModel(mSat5R.id, { channelId: chSat5.id });
const rS2 = await autoReq('auto_sats'); // 粘性命中 → 链内双 429 → 饱和；M1 绕行；gpt 200
check('SAT-5 前置：饱和由粘性目标触发且本轮绕行 200', rS2.status === 200 && (await getLogs('auto_sats'))[0]?.routedTo === 'auto-m-gpt', `${rS2.status} ${(await getLogs('auto_sats'))[0]?.routedTo}`);
const rS3 = await autoReq('auto_sats'); // 假时钟未到（60s 内 >5s）→ 绕行 + 续期 + degraded
let stickyNow = (await api('/api/auto-health?route=auto_sats', { headers: ADMIN })).body.stickyList?.[0];
check('SAT-5 饱和绕行：绑定保留 + degraded 标', stickyNow?.routeId === mSat5R.id && stickyNow?.degraded === true, JSON.stringify(stickyNow));
const sat5 = (await autoHealth()).saturation?.find((s: any) => s.routeId === mSat5R.id);
const fakeSkew = sat5 ? Math.max(0, (sat5.until - Date.now()) - 3000) : 0; // 推进到剩 ~3s
await new Promise((r) => setTimeout(r, 2100)); // key 冷却 1s 真实过期
autoMod.setClockForTest(() => Date.now() + fakeSkew);
const rS4 = await autoReq('auto_sats'); // 探测例外放回 → 粘性正常命中转正 + 成功清零
autoMod.setClockForTest(() => Date.now());
stickyNow = (await api('/api/auto-health?route=auto_sats', { headers: ADMIN })).body.stickyList?.[0];
check('SAT-5 探测命中：degraded 转正 + 饱和清零', rS4.status === 200 && (await getLogs('auto_sats'))[0]?.routedTo === 'auto-m-sat5' && stickyNow?.degraded === false && !(await autoHealth()).saturation?.some((s: any) => s.routeId === mSat5R.id), `${rS4.status} ${(await getLogs('auto_sats'))[0]?.routedTo} ${JSON.stringify(stickyNow)}`);
// SAT-6：滑动窗 (b)——跨 key 各计 1、单次不触发、G7 成功清零；maxKeyRetries=1 让每请求只打一把 key。
// 冷却恢复默认 30s（1s 冷却会让 key 太快复活打乱序列）；渠道 keys 不可 PATCH（SEC 白名单）→ 模型 channelId 切换
await patchSt({ cooldownBaseMs: origSettingsP1.cooldownBaseMs, maxKeyRetries: 1 });
await resetAutoRT();
const chSat6 = await mkCh('Auto Sat6', 'openai', ['k-429-s6a', 'k-429-s6b', 'k-429-s6c']);
const chOk6 = await mkCh('Auto Ok6', 'openai', ['k-ok-s6']);
const mSat6R = (await mkModel({ publicName: 'auto-m-sat6', channelId: chSat6.id, upstreamModel: 'mock-gpt-5' })).body;
await mkAuto({ publicName: 'auto_sat6', candidates: [{ routeId: mSat6R.id, weight: 1 }], stickyTtlMs: 0 });
const r61 = await autoReq('auto_sat6'); // g1 429（win=1，g2/g3 可用 → (a) 不触发）
check('SAT-6 单次 429 不触发饱和', r61.status === 429 && !(await autoHealth()).saturation?.some((s: any) => s.routeId === mSat6R.id), String(r61.status));
await patchModel(mSat6R.id, { channelId: chOk6.id });
await autoReq('auto_sat6'); // ok → 200 → G7 窗清零
check('SAT-6/G7 前置：成功后窗清零', !(await autoHealth()).saturation?.some((s: any) => s.routeId === mSat6R.id), 'win cleared');
await patchModel(mSat6R.id, { channelId: chSat6.id });
await autoReq('auto_sat6'); // g1 冷却中 → g2 429 → win={g2}=1 → 不触发
check('SAT-6/G7 清零后单次 429 仍不触发（旧 g1 计数未阴魂不散）', !(await autoHealth()).saturation?.some((s: any) => s.routeId === mSat6R.id), 'still 1');
await autoReq('auto_sat6'); // g2 冷却 → g3 429 → win={g2,g3} 跨 key ≥2 → 触发 (b)
check('SAT-6 60s 滑动窗跨 key ≥2 触发（不以链为作用域）', !!(await autoHealth()).saturation?.some((s: any) => s.routeId === mSat6R.id), JSON.stringify((await autoHealth()).saturation));
await patchSt({ cooldownBaseMs: origSettingsP1.cooldownBaseMs, maxKeyRetries: origSettingsP1.maxKeyRetries });
await resetAutoRT();

// —— 视觉三态（P1.5 §4）：VIS-1~8 ——
await resetAutoRT();
const getRoute = async (id: string) => (await api('/api/routes', { headers: ADMIN })).body.find((r: any) => r.id === id);
// VIS-2：启发式初值——已知多模态家族 → true；未知名 → unknown（undefined）
const mVisFam = (await mkModel({ publicName: 'gpt-4o-vistest', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).body;
const mVisUnk = (await mkModel({ publicName: 'auto-m-visunk', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).body;
check('VIS-2 导入已知多模态家族 → 初值 true', (await getRoute(mVisFam.id))?.supportsVision === true, JSON.stringify((await getRoute(mVisFam.id))?.supportsVision));
check('VIS-2 未知名 → unknown（undefined）', (await getRoute(mVisUnk.id))?.supportsVision === undefined, JSON.stringify((await getRoute(mVisUnk.id))?.supportsVision));
// VIS-1：带图 + supportsVision=false → 软排除（粘性不覆写，同 tools 语义）
const mVisOff = (await mkModel({ publicName: 'auto-m-visoff', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).body;
await patchModel(mVisOff.id, { supportsVision: false });
const aVis1 = await mkAuto({ publicName: 'auto_vis1', candidates: [{ routeId: mVisOff.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 60000 });
await autoReq('auto_vis1'); // 文本请求 → mVisOff 200 → 建粘
const rVis1 = await autoReq('auto_vis1', { messages: imgMsg }); // 带图 → 软排除 → 绕行 → gpt
check('VIS-1 带图 + false → 软排除续链 200', rVis1.status === 200 && (await getLogs('auto_vis1'))[0]?.routedTo === 'auto-m-gpt', `${rVis1.status}`);
check('VIS-1 软排除在 chainExcluded 留痕（原因含「不支持视觉」）', JSON.stringify((await getLogs('auto_vis1'))[0]?.chainExcluded || []).includes('不支持视觉'), JSON.stringify((await getLogs('auto_vis1'))[0]?.chainExcluded));
const vis1Sticky = (await api('/api/auto-health?route=auto_vis1', { headers: ADMIN })).body.stickyList?.[0];
check('VIS-1 粘性不覆写（绑定保留在 false 候选上，同 tools 语义）', vis1Sticky?.routeId === mVisOff.id, JSON.stringify(vis1Sticky));
// VIS-3：学习闭环——400 命中白名单 + 同候选 ≥2 个不同图片指纹 → 自动置 false 持久化、链继续、不记健康样本
const mNoimg3 = (await mkModel({ publicName: 'auto-m-noimg3', channelId: chAuto.id, upstreamModel: 'mock-noimg' })).body;
const aVis3 = await mkAuto({ publicName: 'auto_vis3', candidates: [{ routeId: mNoimg3.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const twoImgs = [{ role: 'user', content: [
  { type: 'text', text: '两张图' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSU=' } },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAABh' } },
] }];
const rVis3 = await autoReq('auto_vis3', { messages: twoImgs });
check('VIS-3 学习触发：supportsVision 自动置 false 持久化', (await getRoute(mNoimg3.id))?.supportsVision === false, JSON.stringify((await getRoute(mNoimg3.id))?.supportsVision));
check('VIS-3 学习后链继续（C 格）且不记健康样本', rVis3.status === 200 && (await getLogs('auto_vis3'))[0]?.routedTo === 'auto-m-gpt' && !(await autoHealth()).windows.find((w: any) => w.routeId === mNoimg3.id), `${rVis3.status}`);
check('VIS-3 学习加锁（visionLocked）——学习值同样受 F6.3 保护', (await getRoute(mNoimg3.id))?.visionLocked === true, JSON.stringify((await getRoute(mNoimg3.id))?.visionLocked));
// G18：同一张图反复 400（粘性+重试双击形态）只有 1 个指纹 → 不触发学习
const mNoimg1 = (await mkModel({ publicName: 'auto-m-noimg1', channelId: chAuto.id, upstreamModel: 'mock-noimg' })).body;
const aVis3b = await mkAuto({ publicName: 'auto_vis3b', candidates: [{ routeId: mNoimg1.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const oneImg = [{ role: 'user', content: [{ type: 'text', text: '同一张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }];
await autoReq('auto_vis3b', { messages: oneImg });
await autoReq('auto_vis3b', { messages: oneImg });
check('G18 同一指纹两次不学习（仍 unknown）', (await getRoute(mNoimg1.id))?.supportsVision === undefined, JSON.stringify((await getRoute(mNoimg1.id))?.supportsVision));
// VIS-4：手动标注后学习不再覆盖；重置口回 unknown + 解锁
const mNoimg4 = (await mkModel({ publicName: 'auto-m-noimg4', channelId: chAuto.id, upstreamModel: 'mock-noimg' })).body;
await patchModel(mNoimg4.id, { supportsVision: true }); // 手动标 true（上锁）
const aVis4 = await mkAuto({ publicName: 'auto_vis4', candidates: [{ routeId: mNoimg4.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const rVis4 = await autoReq('auto_vis4', { messages: twoImgs }); // 2 个不同指纹——若未锁会学习置 false
check('VIS-4 手动标注锁定：学习不覆盖（仍 true）', rVis4.status === 200 && (await getRoute(mNoimg4.id))?.supportsVision === true, JSON.stringify((await getRoute(mNoimg4.id))?.supportsVision));
const rVis4r = await api(`/api/routes/${mNoimg4.id}/vision/reset`, { method: 'POST', headers: ADMIN });
check('VIS-4 重置口：回 unknown + 解锁', rVis4r.status === 200 && rVis4r.body.supportsVision === 'unknown' && rVis4r.body.visionLocked === false, JSON.stringify(rVis4r.body));
// VIS-5：inputEst 图片 token——data URL 100×100 精算 ceil(10000/750)=14；http URL 常数 1000
const png100 = (() => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(100, 16); b.writeUInt32BE(100, 20); b[24] = 8; b[25] = 2; return 'data:image/png;base64,' + b.toString('base64'); })();
const ctReq = (url: string) => api('/v1/messages/count_tokens', { method: 'POST', headers: AH, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url } }] }] }) });
const ct1 = await ctReq(png100);
const ct2 = await ctReq('https://example.com/a.png');
check('VIS-5 data URL 100×100 精算（ceil(10000/750)=14）', ct1.body?.input_tokens === Math.ceil(2 / 4) + 14, JSON.stringify(ct1.body));
check('VIS-5 http URL 常数 1000/图（不下载）', ct2.body?.input_tokens === Math.ceil(2 / 4) + 1000, JSON.stringify(ct2.body));
// VIS-6：带图请求 unknown 候选 bias=0.25 后置（pickSnapshot 的 ew 值确定性断言，零 flake）
const mVisU = (await mkModel({ publicName: 'auto-m-visu', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).body; // unknown
const chVisG = await mkCh('Auto VisG', 'openai', ['k-ok-visg']);
const mVisG = (await mkModel({ publicName: 'auto-m-visg', channelId: chVisG.id, upstreamModel: 'mock-gpt-5' })).body;
const aVis6 = await mkAuto({ publicName: 'auto_vis6', candidates: [{ routeId: mVisU.id, weight: 10000 }, { routeId: mVisG.id, weight: 3000 }], stickyTtlMs: 0 });
await autoReq('auto_vis6');
const ewText = ((await getLogs('auto_vis6'))[0]?.chainAttempts?.[0]?.pickSnapshot || []).find((x: any) => x.routeId === mVisU.id)?.ew;
await autoReq('auto_vis6', { messages: twoImgs });
const ewImg = ((await getLogs('auto_vis6'))[0]?.chainAttempts?.[0]?.pickSnapshot || []).find((x: any) => x.routeId === mVisU.id)?.ew;
check('VIS-6 带图 unknown bias=0.25（ew 10000→2500）', ewText === 10000 && ewImg === 2500, `text=${ewText} img=${ewImg}`);
// VIS-7：带图 400 判定顺序——超窗（C10）先于视觉，不双重判定
const mDual = (await mkModel({ publicName: 'auto-m-dual400', channelId: chAuto.id, upstreamModel: 'mock-dual400' })).body;
const aVis7 = await mkAuto({ publicName: 'auto_vis7', candidates: [{ routeId: mDual.id, weight: 10000 }, { routeId: mGptR.id, weight: 1 }], stickyTtlMs: 0 });
const rVis7 = await autoReq('auto_vis7', { messages: twoImgs });
check('VIS-7 判定顺序：C10 先行（报错含「超出候选窗口」）且续链', rVis7.status === 200 && String((await getLogs('auto_vis7'))[0]?.chainAttempts?.[0]?.error || '').includes('超出候选窗口'), JSON.stringify((await getLogs('auto_vis7'))[0]?.chainAttempts?.[0]?.error));
check('VIS-7 C10 路径不触发视觉学习（仍 unknown）', (await getRoute(mDual.id))?.supportsVision === undefined, JSON.stringify((await getRoute(mDual.id))?.supportsVision));
// VIS-8：带图真参数错误 → D 格短接；单候选纯 4xx 耗尽 → 顶层 400 聚合（G3）
const mBadp2 = (await mkModel({ publicName: 'auto-m-badp2', channelId: chBadp.id, upstreamModel: 'mock-badparam' })).body;
const aVis8 = await mkAuto({ publicName: 'auto_vis8', candidates: [{ routeId: mBadp2.id, weight: 1 }], stickyTtlMs: 0 });
const rVis8 = await autoReq('auto_vis8', { messages: twoImgs });
check('VIS-8 真·参数错误维持 D 格；单候选纯 4xx → 顶层 400 聚合', rVis8.status === 400 && String(rVis8.body?.error?.message).includes('temperature'), `${rVis8.status} ${String(rVis8.body?.error?.message).slice(0, 60)}`);
await resetAutoRT();

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
const delRes = await api(`/api/routes/${mDelR.id}`, { method: 'DELETE', headers: ADMIN });
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
  await autoReq('auto_ttl'); // TTL=500ms 会过期：先补一发钉住，再验清口
  const aTtl = (await api('/api/routes?type=auto', { headers: ADMIN })).body.find((r: any) => r.publicName === 'auto_ttl');
  const rStk1: any = (await api('/api/routes/' + aTtl.id + '/sticky', { method: 'DELETE', headers: ADMIN })).body;
  check('粘性立即生效：清口删活绑定（cleared>=1）', rStk1?.ok === true && rStk1.cleared >= 1, JSON.stringify(rStk1));
  const rStk2: any = (await api('/api/routes/' + aTtl.id + '/sticky', { method: 'DELETE', headers: ADMIN })).body;
  check('粘性清口幂等：再清 cleared=0', rStk2?.ok === true && rStk2.cleared === 0, JSON.stringify(rStk2));
  const sidP = (await api('/api/routes?type=single', { headers: ADMIN })).body[0].id;
  const rStk3 = await api('/api/routes/' + sidP + '/sticky', { method: 'DELETE', headers: ADMIN });
  check('粘性清口对 single 路由 400', rStk3.status === 400, String(rStk3.status));
  const rNoTokS = await fetch(BASE + '/api/routes/' + aTtl.id + '/sticky', { method: 'DELETE' });
  check('粘性清口无令牌 401', rNoTokS.status === 401, String(rNoTokS.status));
  const aStk: any = (await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'auto', publicName: 'auto_stk', candidates: [{ routeId: mGptR.id, weight: 1 }, { routeId: mGpt2R.id, weight: 1 }], stickyTtlMs: 60000 }) })).body;
  const stkProbe = async (nm: string) => (await api('/api/auto-health?route=' + encodeURIComponent(nm), { headers: ADMIN })).body.stickyForRoute;
  await autoReq('auto_stk');
  check('改名清理前置：旧名绑定在（probe=1）', (await stkProbe('auto_stk')) === 1, String(await stkProbe('auto_stk')));
  await api('/api/routes/' + aStk.id, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ publicName: 'auto_stk2' }) });
  check('auto 改名即清旧名粘性（旧名 0、新名 0）', (await stkProbe('auto_stk')) === 0 && (await stkProbe('auto_stk2')) === 0, JSON.stringify([await stkProbe('auto_stk'), await stkProbe('auto_stk2')]));
  await autoReq('auto_stk2');
  check('新名重新粘上（probe=1）', (await stkProbe('auto_stk2')) === 1, String(await stkProbe('auto_stk2')));
  await api('/api/routes/' + aStk.id, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ publicName: '  auto_stk2  ' }) });
  check('空格改名（trim 后同名）不误清粘性', (await stkProbe('auto_stk2')) === 1, String(await stkProbe('auto_stk2')));
  await api('/api/routes/' + aStk.id, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ publicName: 'AUTO_STK2' }) });
  check('纯大小写改名不清粘性（key 小写归一，绑定仍有效）', (await stkProbe('AUTO_STK2')) === 1, String(await stkProbe('AUTO_STK2')));
  const delStk = await api('/api/routes/' + aStk.id, { method: 'DELETE', headers: ADMIN });
  check('auto 删除即清粘性（probe 归 0）', delStk.status === 200 && (await stkProbe('auto_stk2')) === 0, String(await stkProbe('auto_stk2')));

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

// —— SPD-3 集成钉（P2 §3/G16/F3.2：粘性慢降级绕行——绑定保留、不续期；F5.2 pickSnapshot.factor 观测）——
await resetAutoRT();
const mSpdM = (await mkModel({ publicName: 'spd-m', channelId: chAuto.id, upstreamModel: 'mock-ttft0spaced60' })).body; // F5.1 fixture：ttft<N> 首包延迟 + spaced 分块（decode 窗 ~300ms，过 50ms 采样准入线）
const aSpd = await mkAuto({ publicName: 'auto_spd', candidates: [{ routeId: mSpdM.id, weight: 10000 }, { routeId: mGpt2R.id, weight: 1 }], stickyTtlMs: 60000 });
for (let i = 0; i < 4; i++) await autoReq('auto_spd', { stream: true }); // 快基线样本 ×4 + 建粘
const stkProbeSpd = async () => ((await api('/api/auto-health?route=auto_spd', { headers: ADMIN })).body.stickyList || []);
check('SPD-3 前置：粘性已建立在 spd-m', (await stkProbeSpd()).some((x: any) => x.routeId === mSpdM.id), JSON.stringify(await stkProbeSpd()));
const ahSpd0 = await autoHealth();
const spdRow0 = (ahSpd0.windows || []).find((w: any) => w.routeId === mSpdM.id) || {};
// 审查强化（T5）：单候选 bench=自身 p50 → speedBench === tokP50、factor 恒 1——实值断言替代 typeof 弱断言
check('SPD-2/R8 观测面实值：tokP50∈(20,200)、speedBench=自身 p50、factor=1', typeof spdRow0.tokP50 === 'number' && spdRow0.tokP50 > 20 && spdRow0.tokP50 < 200 && ahSpd0.speedBench === spdRow0.tokP50 && spdRow0.speedFactor === 1, JSON.stringify({ row: spdRow0, bench: ahSpd0.speedBench }));
await patchModel(mSpdM.id, { upstreamModel: 'mock-ttft400spaced60' }); // 切慢 TTFT（同模型换上游，SAT-5 模式）
for (let i = 0; i < 6; i++) await autoReq('auto_spd', { stream: true }); // 慢样本 ×6（TTFT 400ms）→ recent-8 p50 ≥3× 历史基线 → 降粘
// （第 5 个慢样本即置位：4快+5慢 recent-8 下中位已转慢；第 6 个的保持依赖 s≥3.5×被抬升基线——T5 复核口径）
const ahSpd = await autoHealth();
const spdRow = (ahSpd.windows || []).find((w: any) => w.routeId === mSpdM.id);
check('SPD-3 观测面：/auto-health ttftSlow 置位（≥3× 历史基线）', spdRow && spdRow.ttftSlow === true, JSON.stringify(spdRow));
const lSpd = (await getLogs('auto_spd'))[0];
const snapSpd = lSpd?.chainAttempts?.[0]?.pickSnapshot || [];
check('F5.2 pickSnapshot factor 实值=1（单候选 bench 自锚，EMA 恰为 1）', snapSpd.length > 0 && snapSpd.every((x: any) => x.factor === 1), JSON.stringify(snapSpd).slice(0, 160));
const rSpdByp = await autoReq('auto_spd', { stream: true });
const lSpdByp = (await getLogs('auto_spd'))[0];
check('SPD-3 慢降级 → 粘性绕行：pickBasis=weighted（非 sticky 命中）', rSpdByp.status === 200 && lSpdByp?.chainAttempts?.[0]?.pickBasis === 'weighted', JSON.stringify({ basis: lSpdByp?.chainAttempts?.[0]?.pickBasis }));
check('SPD-3 绑定保留不删除（F3.2：绕行不清绑定）', (await stkProbeSpd()).some((x: any) => x.routeId === mSpdM.id), JSON.stringify(await stkProbeSpd()));
const ahSpd2 = await autoHealth();
// 绕行请求自身也是慢样本 → 基线 EMA 逐样本吸收后 <2× 迟滞自动翻回（F3.2 回粘语义：瞬态降粘 + 权重层接管持续慢）
check('F3.2 迟滞自动回粘：基线吸收慢态后 ttftSlow 自动翻回', ((ahSpd2.windows || []).find((w: any) => w.routeId === mSpdM.id) || {}).ttftSlow === false, JSON.stringify(ahSpd2.windows));
await autoReq('auto_spd', { stream: true }); // TTFT 关已翻回 + 健康关通过 → 重粘双过（STK-2/F3.2）
const lStk2 = (await getLogs('auto_spd'))[0];
check('STK-2 重粘双过（健康关且 TTFT 关）→ 恢复粘性命中续期', lStk2?.chainAttempts?.[0]?.pickBasis === 'sticky', JSON.stringify({ basis: lStk2?.chainAttempts?.[0]?.pickBasis }));
await patchModel(mSpdM.id, { upstreamModel: 'mock-ttft0spaced60' });
await api('/api/routes/' + aSpd.body.id, { method: 'DELETE', headers: ADMIN });

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

section('16. 桌面发行地基：前缀 env / 数据目录 / 控制台内嵌');
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { envAny, resolveDataDir } = await import('../src/bootstrap.ts');
  const { WEB_HTML } = await import('../src/web-html.gen.ts');
  const saved = { llm: process.env.LLM_DATA_DIR, own: process.env.OWN_API_DATA_DIR };
  const withEnvCleared = (fn: () => string) => {
    try {
      delete process.env.LLM_DATA_DIR;
      delete process.env.OWN_API_DATA_DIR;
      return fn();
    } finally {
      if (saved.llm !== undefined) process.env.LLM_DATA_DIR = saved.llm;
      if (saved.own !== undefined) process.env.OWN_API_DATA_DIR = saved.own;
    }
  };
  process.env.LLM_TESTVAR = 'old';
  process.env.OWN_API_TESTVAR = 'new';
  check('前缀迁移：OWN_API_* 优先于历史 LLM_*', envAny(['OWN_API_TESTVAR', 'LLM_TESTVAR']) === 'new', String(envAny(['OWN_API_TESTVAR', 'LLM_TESTVAR'])));
  delete process.env.LLM_TESTVAR;
  delete process.env.OWN_API_TESTVAR;
  const fbCwd = fs.mkdtempSync(join(os.tmpdir(), 'ownapi-fb-'));
  fs.mkdirSync(join(fbCwd, 'data'));
  fs.writeFileSync(join(fbCwd, 'data', 'db.json'), '{}');
  check('开发兼容：cwd 有 ./data/db.json 继续用（源码用户升级不空库）', withEnvCleared(() => resolveDataDir(fbCwd)) === join(fbCwd, 'data'), withEnvCleared(() => resolveDataDir(fbCwd)));
  const emptyCwd = fs.mkdtempSync(join(os.tmpdir(), 'ownapi-empty-'));
  check('默认数据目录 ~/.own-api（不再寄生 cwd，共享盘不共账）', withEnvCleared(() => resolveDataDir(emptyCwd)) === join(os.homedir(), '.own-api'), withEnvCleared(() => resolveDataDir(emptyCwd)));
  check('控制台 HTML 内嵌副本与磁盘同步（防改 web 忘 gen:web）', WEB_HTML === fs.readFileSync('web/index.html', 'utf8'), `${WEB_HTML.length}/${fs.readFileSync('web/index.html', 'utf8').length}`);
  check('控制台支持 #token= 注入（双击启动免复制令牌）', WEB_HTML.includes('URLSearchParams(location.hash'), '');
// ================================================================
section('15. 修复战役回归断言（审查报告契约固化）');
{
  const s = (await api('/api/settings', { headers: ADMIN })).body;
  check('GET /settings 不回显 adminToken（只有 adminTokenSet 标志）', s.adminToken === undefined && s.adminTokenSet === true, JSON.stringify(s).slice(0, 110));
}
{
  const chs = (await api('/api/channels', { headers: ADMIN })).body;
  const anyCh = chs[0];
  const r404 = await api('/api/channels/' + anyCh.id + '/keys/k-does-not-exist', { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ name: 'x' }) });
  check('PATCH 不存在 key -> 404（此前静默 200 回执）', r404.status === 404, String(r404.status));
  const ok2 = await api('/api/channels/' + anyCh.id + '/keys/' + anyCh.keys[0].id, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ name: '白名单试验', status: 'active' }) });
  check('PATCH key 白名单字段正常生效', ok2.status === 200, String(ok2.status));
}
{
  const dup = await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'dup', key: VKEY }) });
  check('创建对外 key 与既有 key 重复 -> 409', dup.status === 409, String(dup.status));
  const neg = await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'neg', rpmLimit: -5 }) });
  check('创建对外 key 负限额 -> 400（不再静默变不限）', neg.status === 400, String(neg.status));
  const short = await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'short', key: 'sk-lm-abc' }) });
  check('自定义公钥短于 16 字符 -> 400', short.status === 400, String(short.status));
}
{
  const bad = await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single',  publicName: 123, channelId: 'ch-x', upstreamModel: 'm' }) });
  check('POST /models publicName 非字符串 -> 400（此前 500）', bad.status === 400, String(bad.status));
  const chR: any = (await api('/api/channels', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'redir-ch', baseUrl: 'http://127.0.0.1:18099/v1', protocol: 'openai', keys: ['k-ok-main'] }) })).body;
  await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single', publicName: 'redir-me', channelId: chR.id, upstreamModel: 'mock-redirect' }) });
  const rRed: any = await api('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + VKEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'redir-me', messages: [{ role: 'user', content: 'x' }] }) });
  const redTxt = JSON.stringify(rRed.body);
  check('SSRF 闸：上游 302 被拒——不跟随且内网金丝雀不可达', rRed.status !== 200 && redTxt.indexOf('ssrf-canary-42') === -1, String(rRed.status) + ' ' + redTxt.slice(0, 90));
}
{
  const p = (await api('/api/settings', { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ debugHeaders: 'false' }) })).body;
  check('debugHeaders 传字符串 false 被拒（Boolean 强转陷阱）', Array.isArray(p.rejected) && p.rejected.length > 0, JSON.stringify(p).slice(0, 110));
}
// ---- 审查 P1：H1 同协议透传 error 帧掩码三形态 + M0-a/M2 契约 ----
{
  const mk = (publicName: string, channelId: string, upstreamModel: string, extra?: any) =>
    api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single', publicName, channelId, upstreamModel, ...(extra || {}) }) });
  await mk('dirty-alias', oa.id, 'mock-dirty-stream');
  await mk('mock-dirty-stream', oa.id, 'mock-dirty-stream');
  await mk('mock-dirty-anth', an.id, 'mock-dirty-anth');
  const readStream = async (path: string, model: string, anth: boolean) => {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: anth
        ? { 'x-api-key': VKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
        : { authorization: 'Bearer ' + VKEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true, max_tokens: 16, messages: [{ role: 'user', content: '掩码探针' }] }),
    });
    return await res.text();
  };
  const noLeak = (raw: string, k: string) => !raw.includes(k) && !raw.includes(encodeURIComponent(k)) && !raw.includes(Buffer.from(k).toString('base64')) && raw.includes('***');
  const t1 = await readStream('/v1/chat/completions', 'mock-dirty-stream', false);
  check('H1 openai→openai 零改写透传 error 帧已掩码', noLeak(t1, 'k-ok-main'), t1.slice(0, 140));
  const t2 = await readStream('/v1/chat/completions', 'dirty-alias', false);
  check('H1 alias 改写分支 error 帧已掩码', noLeak(t2, 'k-ok-main'), t2.slice(0, 140));
  const t3 = await readStream('/v1/messages', 'mock-dirty-anth', true);
  check('H1 anthropic→anthropic 透传 error 帧已掩码', noLeak(t3, 'k-ok-claude'), t3.slice(0, 140));
  const tg400 = await mk('tag-poison', oa.id, 'mock-gpt-5', { tags: 'x' });
  check('M0-a POST tags 非数组 -> 400（持久投毒封堵）', tg400.status === 400, String(tg400.status));
  const num400 = await mk('num-poison', oa.id, 'mock-gpt-5', { priceInput: 'free' });
  check('M0-a POST 数字字段非数字 -> 400', num400.status === 400, String(num400.status));
  const nullR = (await mk('null-clear-m', oa.id, 'mock-gpt-5', { priceInput: 2, maxOutputTokens: 100 })).body;
  const nullP = await api('/api/routes/' + nullR.id, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ priceInput: null, maxOutputTokens: null }) });
  const nullG = (await api('/api/routes?type=single', { headers: ADMIN })).body.find((m: any) => m.id === nullR.id);
  check('M2 PATCH null=清除（清空价格不再静默保旧值）', nullP.status === 200 && nullG.priceInput === undefined && nullG.maxOutputTokens === undefined, JSON.stringify([nullP.status, nullG.priceInput, nullG.maxOutputTokens]));
  const bdPatch = await api('/api/channels/' + oa.id, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ baseUrl: 123 }) });
  const bdList = (await api('/api/channels', { headers: ADMIN })).body.find((x: any) => x.id === oa.id);
  check('baseUrl 数字补丁被丢弃、原值保全（GET 不再被毒成 500）', bdPatch.status === 200 && String(bdList.baseUrl).includes('18099'), JSON.stringify([bdPatch.status, bdList.baseUrl]));
}
{
  // P6：SSE 巨帧上限守卫（MAX_FRAME_BUF 8MB）——9MB 单帧不得原样缓冲转发
  await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single', publicName: 'mock-hugeframe', channelId: oa.id, upstreamModel: 'mock-hugeframe' }) });
  await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single', publicName: 'huge-alias', channelId: oa.id, upstreamModel: 'mock-hugeframe' }) });
  const hgReq = { method: 'POST', headers: { authorization: 'Bearer ' + VKEY, 'content-type': 'application/json' } };
  const raw1 = await (await fetch(BASE + '/v1/chat/completions', { ...hgReq, body: JSON.stringify({ model: 'mock-hugeframe', stream: true, messages: [{ role: 'user', content: 'x' }] }) })).text();
  check('P6 零改写透传 9MB 巨帧被 MAX_FRAME_BUF 截成错误帧', /error/i.test(raw1) && raw1.length < 1_000_000, String(raw1.length));
  const raw2 = await (await fetch(BASE + '/v1/chat/completions', { ...hgReq, body: JSON.stringify({ model: 'huge-alias', stream: true, messages: [{ role: 'user', content: 'x' }] }) })).text();
  check('P6 改写分支 9MB 巨帧不原样外发（响应有界）', raw2.length < 1_000_000, String(raw2.length));
}
{
  // P6+(R4-F2)：error 帧形态漂移封堵——string/多行 data/对象 message 三形态 × 双分支全掩
  const leaky = (raw: string, k: string) => raw.includes(k) || raw.includes(encodeURIComponent(k)) || raw.includes(Buffer.from(k).toString('base64'));
  await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single', publicName: 'mock-dirty-str', channelId: oa.id, upstreamModel: 'mock-dirty-str' }) });
  await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single', publicName: 'dirty-str-alias', channelId: oa.id, upstreamModel: 'mock-dirty-str' }) });
  for (const [mname, label] of [['mock-dirty-str', '零改写'], ['dirty-str-alias', '改写']] as const) {
    const raw = await (await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + VKEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: mname, stream: true, messages: [{ role: 'user', content: 'x' }] }) })).text();
    check('R4 error 帧三形态双分支掩码（' + label + '）', !leaky(raw, 'k-ok-main') && /\*\*\*/.test(raw), raw.slice(0, 140));
  }
}



{
  const r = (await api('/api/vkeys?reveal=1', { headers: { ...ADMIN, 'x-forwarded-for': '10.0.0.9' } })).body;
  check('reveal=1 经代理头拿不到明文 key', Array.isArray(r) && r.every((k) => k.key.includes('*')), JSON.stringify(r[0] && r[0].key));
}
{
  // 限速语义钉（P1 重做后）：只计鉴权失败、成功不增不清；桶按 socket IP。
  // 本循环是文件里最后的 /v1 消费位——429 粘住来源直至窗口结束也无所谓，其后无合法请求
  let last = 0;
  let first429 = 0;
  for (let i = 1; i <= 32; i++) {
    last = (await api('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer sk-lm-brute-' + i }, body: JSON.stringify({ model: 'gpt-4o', messages: [] }) })).status;
    if (last === 429 && !first429) first429 = i;
  }
  check('网关爆破错误 key -> 30/min 限速 429 生效', last === 429, String(last));
  check('R2 边界精钉：含前置 2 hits（文件前部无钥匙/错钥匙各一发），第 30 发即首次 429', first429 === 30, String(first429));
{
  // 模块合并契约：单表撞名双向互斥 + 候选禁嵌套 auto
  const autos = (await api('/api/routes?type=auto', { headers: ADMIN })).body;
  const oneAuto = autos.find((a: any) => a.enabled);
  const chs = (await api('/api/channels', { headers: ADMIN })).body;
  const r = await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single', publicName: oneAuto.publicName, channelId: chs[0].id, upstreamModel: 'u' }) });
  check('新增单模型撞 auto 名 -> 409（单表撞名校验，此前 POST 不设防）', r.status === 409, String(r.status));
  const nest = await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'auto', publicName: 'nest-attempt', candidates: [{ routeId: oneAuto.id, weight: 1 }] }) });
  check('auto 候选指向 auto -> 400（禁嵌套）', nest.status === 400 && String(nest.body?.error || '').includes('单模型'), JSON.stringify(nest.body));
}
}
}

// ============ 17. 模型速度排行（speed-insights v1.1 钉） ============
{
  const usage = await import('../src/usage.ts');
  let spdN = 0;
  const synth = (p: Partial<any>) => store.pushLog({
    id: 'spd-' + ++spdN, ts: Date.now(), path: '/v1/chat/completions', endpoint: 'chat', requestedModel: p.requestedModel || p.routedTo || p.publicName || '',
    status: p.ok === false ? (p.status || 500) : 200, ok: p.ok !== false, stream: p.stream === true, latencyMs: p.latencyMs || 100,
    attempts: p.attempts || 1, promptTokens: 1, completionTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, ...p,
  } as any);
  // 专享命名键（共享库卫生）：数值断言只认 spd-* 行
  const ttfts = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240];
  const lats = ttfts.map((x) => x * 4);
  for (let i = 0; i < 24; i++) synth({ routedTo: 'spd-syn', stream: true, ttftMs: ttfts[i], latencyMs: lats[i] });
  synth({ routedTo: 'spd-fo', stream: false, latencyMs: 500, attempts: 3 });
  synth({ routedTo: 'spd-err', ok: false, status: 500, latencyMs: 80, stream: false });
  synth({ routedTo: 'spd-cancel', ok: false, status: 499, latencyMs: 60, stream: false });
  synth({ requestedModel: 'spd-auto-x', publicName: 'spd-cand-z', chainAttempts: [{ name: 'spd-cand-z', ok: false }], ok: false, status: 502, latencyMs: 90 });
  synth({ publicName: 'spd-tieA', stream: true, ttftMs: 300, latencyMs: 900 }); synth({ publicName: 'spd-tieA', stream: true, ttftMs: 300, latencyMs: 900 });
  synth({ publicName: 'spd-tieB', stream: true, ttftMs: 300, latencyMs: 900 });
  synth({ ok: false, status: 429, latencyMs: 1, requestedModel: '' });
  const rep: any = usage.buildSpeedStats(0);
  const find = (rows: any[], k: string) => rows.find((r) => r.key === k);
  const s50 = ttfts.slice().sort((a, b) => a - b)[Math.floor(24 * 0.5)];
  const s95 = ttfts.slice().sort((a, b) => a - b)[Math.floor(24 * 0.95)];
  const syn = find(rep.streamRows, 'spd-syn');
  check('SI P50/P95 与 benchmark 精确（syn+index 口径）', !!syn && syn.ttftP50Ms === s50 && syn.ttftP95Ms === s95 && rep.benchmark.streamP50Ms !== undefined, JSON.stringify(syn && { p50: syn.ttftP50Ms, p95: syn.ttftP95Ms }) + ' b=' + rep.benchmark.streamP50Ms);
  const synL = find(rep.latencyRows, 'spd-syn');
  check('SI 延迟组双表分装且 avg 正确', !!synL && synL.latP50Ms === lats[Math.floor(24 * 0.5)] && synL.avgLatencyMs === Math.round(ttfts.reduce((s, x) => s + x, 0) * 4 / 24), JSON.stringify(synL && { p50: synL.latP50Ms, avg: synL.avgLatencyMs }));
  const fo = find(rep.latencyRows, 'spd-fo');
  check('SI attempts>1 剔出延迟组并进 failoverRate、排序垫后', !!fo && fo.firstAttemptN === 0 && fo.failoverRate === 1 && latencyIdxLess(rep, synL, fo), JSON.stringify(fo));
  function latencyIdxLess(r: any, a: any, b: any) { return r.latencyRows.indexOf(a) < r.latencyRows.indexOf(b); }
  const cancel = find(rep.latencyRows, 'spd-cancel');
  check('SI 499 拆列：cancels=1 且 errors=0 不进速度样本', !!cancel && cancel.cancels === 1 && cancel.errors === 0 && cancel.firstAttemptN === 0 && !find(rep.streamRows, 'spd-cancel'), JSON.stringify(cancel));
  const err = find(rep.latencyRows, 'spd-err');
  check('SI 非 499 失败进 errors', !!err && err.errors === 1 && err.cancels === 0, JSON.stringify(err));
  const ax = find(rep.latencyRows, 'spd-auto-x');
  check('SI auto 链败归 auto 名（三分支归键），不归末位候选', !!ax && !find(rep.latencyRows, 'spd-cand-z'), JSON.stringify(ax && ax.key));
  check('SI 未归因行单独返回（429 合成样本入内）', !!rep.unattributed && rep.unattributed.key === '-' && rep.unattributed.requests >= 1, JSON.stringify(rep.unattributed));
  const idxA = rep.streamRows.findIndex((r: any) => r.key === 'spd-tieA');
  const idxB = rep.streamRows.findIndex((r: any) => r.key === 'spd-tieB');
  check('SI tie-break：同 P50 按 requests 降序、再 key 升序', idxA >= 0 && idxA === idxB - 1, idxA + '/' + idxB);
  const cl1: any = (await api('/api/stats/speed?hours=-1', { headers: ADMIN })).body;
  const cl2: any = (await api('/api/stats/speed?hours=abc', { headers: ADMIN })).body;
  const cl3: any = (await api('/api/stats/speed?hours=1000000000000', { headers: ADMIN })).body;
  check('SI hours 归一钳制（-1→0全窗 / abc→24 / 1e12→87600）', cl1?.window?.hours === 0 && cl2?.window?.hours === 24 && cl3?.window?.hours === 87600, [cl1?.window?.hours, cl2?.window?.hours, cl3?.window?.hours].join('/'));
  const noauth = await fetch(BASE + '/api/stats/speed');
  // —— 评审增补钉 B：实况 smoke + 卫生 + pending 边界 + 键序 + single 不覆盖 ——
  const Bsm: any = (o: any) => ({ method: 'POST', headers: ADMIN, body: JSON.stringify(o) });
  const spCh: any = (await api('/api/channels', Bsm({ name: 'cb3-sp', baseUrl: 'http://127.0.0.1:18099/v1', protocol: 'openai', keys: ['sk-slow-1'] }))).body;
  await api('/api/routes', Bsm({ type: 'single', publicName: 'sp-slow', channelId: spCh.id, upstreamModel: 'k-slow' }));
  const spKey: any = (await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'sp-smoke', allowedModels: ['sp-slow'] }) })).body;
  const spCodes: string[] = [];
  { const rl = await import('../src/ratelimit.ts'); rl.resetFailureBuckets(); } // 爆破钉故意打爆本机桶：守卫已验，清桶后再跑实况流量
  for (let i = 0; i < 2; i++) { const rr = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + spKey.key }, body: JSON.stringify({ model: 'sp-slow', messages: [{ role: 'user', content: 'smoke' }] }) }); spCodes.push(rr.status + ':' + (await rr.text()).slice(0, 40)); }
  const spRep: any = (await api('/api/stats/speed?hours=0', { headers: ADMIN })).body;
  const spRow = (spRep.latencyRows || []).find((r: any) => r.key === 'sp-slow');
  check('SI 实况 smoke：慢上游进 latencyRows 且 latP50 区间稳', !!spRow && spRow.requests === 2 && spRow.latP50Ms >= 900 && spRow.latP50Ms <= 9000, JSON.stringify(spRow || {}) + ' codes=' + spCodes + ' keys=' + (spRep.latencyRows || []).map((r: any) => r.key).join(','));
  const stNow: any = (await api('/api/settings', { headers: ADMIN })).body;
  check('SI 卫生：retention=设置、logsInWindow 如实', spRep.retention === stNow.logRetention && spRep.logsInWindow >= 2, JSON.stringify({ ret: spRep.retention, liw: spRep.logsInWindow }));

  check('SI 无令牌 401', noauth.status === 401, String(noauth.status));
}
// ============ 19. 配置组导出（config-bundle CB-1） ============
{
  const leaky = 'sk-rtdead' + '0'.repeat(27) + '9z';
  const ch: any = (await api('/api/channels', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'cb1-ch', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai', keys: [leaky], note: '哨兵渠道' }) })).body;
  const rr: any = (await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single', publicName: 'cb1-model', channelId: ch.id, upstreamModel: 'cb1-m' }) })).body;
  const ra: any = (await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'auto', publicName: 'cb1-auto', candidates: [{ routeId: rr.id, weight: 5 }] }) })).body;
  const res = await fetch(BASE + '/api/config/export');
  check('CB 导出无令牌 401', res.status === 401, String(res.status));
  const r: any = (await api('/api/config/export', { headers: ADMIN })).body;
  check('CB 导出 kind/version/三段结构', r?.kind === 'own-api-config-bundle' && r?.version === 1 && Array.isArray(r?.channels) && Array.isArray(r?.routes?.singles) && Array.isArray(r?.routes?.autos), JSON.stringify(r && { k: r.kind, v: r.version }));
  const raw = JSON.stringify(r);
  check('CB 导出零密钥痕迹（哨兵原文+keys字段全无）', raw.indexOf(leaky) === -1 && raw.indexOf('"keys"') === -1, String(raw.indexOf(leaky)) + '/' + String(raw.indexOf('"keys"')));
  const cb1ch = (r.channels || []).find((c: any) => c.name === 'cb1-ch');
  check('CB 渠道字段域含 enabled/timeoutMs（DR-CB-L）', !!cb1ch && 'enabled' in cb1ch && 'timeoutMs' in cb1ch, JSON.stringify(cb1ch && Object.keys(cb1ch)));
  const s1 = (r.routes.singles || []).find((x: any) => x.publicName === 'cb1-model');
  check('CB single 按渠道名引用', !!s1 && s1.channelName === 'cb1-ch' && !('channelId' in s1) && s1.upstreamModel === 'cb1-m', JSON.stringify(s1));
  const a1 = (r.routes.autos || []).find((x: any) => x.publicName === 'cb1-auto');
  const singNames = new Set((r.routes.singles || []).map((x: any) => x.publicName));
  check('CB auto 候选按 publicName 引用且自洽', !!a1 && a1.candidates.length === 1 && a1.candidates[0].publicName === 'cb1-model' && a1.candidates[0].weight === 5 && !('routeId' in a1.candidates[0]) && (r.routes.autos || []).every((x: any) => x.candidates.every((cd: any) => singNames.has(cd.publicName) || (r.routes.autos || []).some((y: any) => y.publicName === cd.publicName))), JSON.stringify(a1));
}
// ============ 20. 配置组导入 dryRun（CB-2） ============
{
  const B = (o: any) => ({ method: 'POST', headers: ADMIN, body: JSON.stringify(o) });
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const hitsSum = async () => Object.values(await mockHits()).reduce((s, x) => s + x, 0);
  const mk = (name: string, base: string) => api('/api/channels', { ...B({ name, baseUrl: base, protocol: 'openai' }) });
  await mk('cb2-conf-base', 'http://127.0.0.1:8/v1');
  await mk('cb2-dup', 'http://127.0.0.1:1/v1');
  await mk('cb2-dup', 'http://127.0.0.1:2/v1');
  const b1: any = (await api('/api/config/export', { headers: ADMIN })).body;
  const cb1Chan = b1.channels.find((c: any) => c.name === 'cb1-ch');
  const cb1Single = b1.routes.singles.find((x: any) => x.publicName === 'cb1-model');
  const imp = (payload: any) => api('/api/config/import', B(payload));
  const rKind = await imp({ bundle: { kind: 'x', version: 1, channels: [{ name: 'a', baseUrl: 'http://h/v1' }] }, dryRun: true });
  const rVer = await imp({ bundle: { kind: 'own-api-config-bundle', version: 2, channels: [{ name: 'a', baseUrl: 'http://h/v1' }] }, dryRun: true });
  const rEmpty = await imp({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [], routes: { singles: [], autos: [] } }, dryRun: true });
  const rNoBase = await imp({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [{ name: 'a' }] }, dryRun: true });
  const rDupChan = await imp({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [{ name: 'a', baseUrl: 'http://h/v1' }, { name: 'a', baseUrl: 'http://g/v1' }] }, dryRun: true });
  const rTop = await imp({ bundle: 5, dryRun: true });
  check('CB 结构畸形六连 400', [rKind, rVer, rEmpty, rNoBase, rDupChan, rTop].every((r) => r.status === 400), [rKind.status, rVer.status, rEmpty.status, rNoBase.status, rDupChan.status, rTop.status].join('/'));
  check('CB version 过大 400 含升级指引', String(rVer.body?.error || '').includes('升级'), JSON.stringify(rVer.body));
  const bundle = {
    kind: 'own-api-config-bundle', version: 1, exportedAt: '2026-09-14T00:00:00Z',
    channels: [cb1Chan, { name: 'cb2-new', baseUrl: 'http://127.0.0.1:7/v1', protocol: 'openai', futureField: 1, api_key: 'sk-someone-else' }, { name: 'cb2-conf-base', baseUrl: 'http://127.0.0.1:99/v1', protocol: 'openai' }, { name: 'cb2-dup', baseUrl: 'http://127.0.0.1:3/v1', protocol: 'openai' }, { name: 'cb2-nokey', baseUrl: 'http://127.0.0.1:6/v1', protocol: 'openai' }],
    routes: {
      singles: [
        { publicName: 'cb2-s-new', channelName: 'cb2-new', upstreamModel: 'm1' },
        cb1Single,
        { publicName: 'cb2-s-confref', channelName: 'cb2-conf-base', upstreamModel: 'm2' },
        { publicName: 'cb2-s-bad', channelName: 'cb2-who', upstreamModel: 'm3' },
      ],
      autos: [{ publicName: 'cb2-auto', candidates: [{ publicName: 'cb2-s-new', weight: 5 }, { publicName: 'ghost-x', weight: 1 }, { publicName: 'cb1-auto', weight: 1 }] }],
    },
  };
  const keys = { 'cb2-new': ['sk-cb2-k1', 'sk-cb2-k1', 'sk-cb2-k2'], 'cb1-ch': ['sk-cb2-k3'], 'cb2-conf-base': ['sk-cb2-nope'], 'cb2-ghost': ['sk-cb2-nope2'] };
  await store.flushSync();
  await sleepMs(520);
  const snap = JSON.stringify({ c: store.db.channels, r: store.db.routes, s: store.db.settings });
  const logN = store.db.logs.length;
  const hits0 = await hitsSum();
  const dr = await imp({ bundle, keys, dryRun: true });
  const rc: any = dr.body;
  check('CB dryRun 200 且 dryRun:true', dr.status === 200 && rc?.dryRun === true, String(dr.status) + ' ' + JSON.stringify(rc && rc.channels && rc.channels.conflicts.map((z: any) => z.reason)).slice(0, 160));
  await store.flushSync();
  check('CB dryRun 三子树+logs 零变化（防抖安全断言法）', snap === JSON.stringify({ c: store.db.channels, r: store.db.routes, s: store.db.settings }) && store.db.logs.length === logN);
  check('CB 渠道计数 created2/merged1/conflict2', rc?.channels?.created === 2 && rc?.channels?.merged === 1 && rc?.channels?.conflicts?.length === 2, JSON.stringify(rc?.channels && { c: rc.channels.created, m: rc.channels.merged, x: rc.channels.conflicts.map((z: any) => z.name) }));
  const dupC = (rc?.channels?.conflicts || []).find((z: any) => z.name === 'cb2-dup');
  check('CB 同名歧义 conflict 文案含「2 个同名渠道」', !!dupC && dupC.reason.includes('2 个同名渠道'), JSON.stringify(dupC));
  check('CB keysAdded 净新增口径（去重后 3）', rc?.channels?.keysAdded === 3 && rc?.channels?.keysAddedByChannel?.['cb2-new'] === 2 && rc?.channels?.keysAddedByChannel?.['cb1-ch'] === 1, JSON.stringify(rc?.channels?.keysAddedByChannel));
  check('CB 路由计数 created3/skipped1/conflict1', rc?.routes?.created === 3 && rc?.routes?.skipped === 1 && rc?.routes?.conflicts?.length === 1 && rc.routes.conflicts[0].publicName === 'cb2-s-bad', JSON.stringify(rc?.routes && { c: rc.routes.created, s: rc.routes.skipped, x: rc.routes.conflicts }));
  const W = (rc?.routes?.warnings || []).map((w: any) => w.reason).join(' | ');
  check('CB warnings 全家桶（悬空/禁嵌套/conflict引用/密钥拒写×2/未知字段/外来key忽略）', W.includes('候选 ghost-x 不存在') && W.includes('候选 cb1-auto 指向自动路由') && W.includes('conflict 渠道 cb2-conf-base') && W.includes('渠道 cb2-conf-base 冲突，密钥未写入') && W.includes('渠道 cb2-ghost 不存在') && W.includes('未知字段「futureField」') && W.includes('密钥字段「api_key」已忽略'), W.slice(0, 400));
  check('CB 同包候选解析成功（cb2-s-new 无 warning）', !W.includes('候选 cb2-s-new'));
  check('CB pendingKeyChannels 只含无 key 新渠道', !!rc?.pendingKeyChannels?.includes('cb2-nokey') && !rc.pendingKeyChannels.includes('cb2-new') && !rc.pendingKeyChannels.includes('cb1-ch'), JSON.stringify(rc?.pendingKeyChannels));
  const drText = await (await fetch(BASE + '/api/config/import', B({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [{ name: 'cb2-tmp', baseUrl: 'http://h/v1' }] }, keys: { 'cb2-tmp': ['sk-cb2-k9SENT'] }, dryRun: true }))).text();
  check('CB 响应不回显 keys 原文', drText.indexOf('sk-cb2-k9SENT') === -1, drText.slice(0, 120));
  const hits1 = await hitsSum();
  check('CB dryRun 零外呼（hits 增量 0）', hits1 === hits0, hits0 + '->' + hits1);
  const st0: any = (await api('/api/settings', { headers: ADMIN })).body;
  await api('/api/settings', { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ maxBodyBytes: 4096 }) });
  const fat = { kind: 'own-api-config-bundle', version: 1, channels: [{ name: 'cb2-fat', baseUrl: 'http://h/v1', note: 'x'.repeat(20000) }] };
  const r413 = await imp({ bundle: fat, dryRun: true });
  check('CB 超 maxBodyBytes → 413（本端点自建闸）', r413.status === 413, String(r413.status));
  await api('/api/settings', { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ maxBodyBytes: st0.maxBodyBytes }) });
  const fatN = { kind: 'own-api-config-bundle', version: 1, channels: Array.from({ length: 5001 }, (_, i) => ({ name: 'cb2-e' + i, baseUrl: 'http://h/v1', protocol: 'openai' })) };
  const rCap = await api('/api/config/import', { method: 'POST', headers: ADMIN, body: JSON.stringify({ bundle: fatN, dryRun: true }) });
  check('CB 实体数超上限 → 400（§6.2 条数闸兑现）', rCap.status === 400 && JSON.stringify(rCap.body || {}).includes('上限 5000'), JSON.stringify(rCap.body || {}).slice(0, 120));
  const mkk: string[] = []; for (let i = 0; i < 1001; i++) mkk.push('sk-e' + i);
  const rCap2 = await api('/api/config/import', { method: 'POST', headers: ADMIN, body: JSON.stringify({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [{ name: 'cb2-new', baseUrl: 'http://127.0.0.1:7/v1', protocol: 'openai' }] }, keys: { 'cb2-new': mkk }, dryRun: true }) });
  check('CB keys 条目超上限 → 400', rCap2.status === 400, String(rCap2.status));
}
// ============ 21. 配置组提交导入：等价/幂等/round-trip（CB-3） ============
{
  const B = (o: any) => ({ method: 'POST', headers: ADMIN, body: JSON.stringify(o) });
  const imp = (payload: any) => api('/api/config/import', B(payload));
  const hitsSum = async () => Object.values(await mockHits()).reduce((s, x) => s + x, 0);
  const b1: any = (await api('/api/config/export', { headers: ADMIN })).body;
  const cb1Chan = b1.channels.find((c: any) => c.name === 'cb1-ch');
  const cb1Single = b1.routes.singles.find((x: any) => x.publicName === 'cb1-model');
  const routes0: any = (await api('/api/routes', { headers: ADMIN })).body;
  const mId = routes0.find((r: any) => r.publicName === 'cb1-model').id;
  await api('/api/routes', B({ type: 'auto', publicName: 'cb3-auto', candidates: [{ routeId: mId, weight: 1 }] }));
  const bundle = {
    kind: 'own-api-config-bundle', version: 1,
    channels: [cb1Chan, { name: 'cb2-new', baseUrl: 'http://127.0.0.1:7/v1', protocol: 'openai' }, { name: 'cb2-conf-base', baseUrl: 'http://127.0.0.1:99/v1', protocol: 'openai' }, { name: 'cb2-nokey', baseUrl: 'http://127.0.0.1:6/v1', protocol: 'openai' }],
    routes: {
      singles: [
        { publicName: 'cb2-s-new', channelName: 'cb2-new', upstreamModel: 'm1' },
        cb1Single,
        { publicName: 'cb2-s-confref', channelName: 'cb2-conf-base', upstreamModel: 'm2' },
      ],
      autos: [
        { publicName: 'cb3-auto', candidates: [{ publicName: 'cb1-model', weight: 9 }, { publicName: 'cb2-s-new', weight: 4 }] },
        { publicName: 'cb2-auto', candidates: [{ publicName: 'cb2-s-new', weight: 5 }, { publicName: 'ghost-x', weight: 1 }, { publicName: 'cb1-auto', weight: 1 }] },
      ],
    },
  };
  const keys = { 'cb2-new': ['sk-cb3-k1', 'sk-cb3-k1', 'sk-cb3-k2'], 'cb1-ch': ['sk-cb3-k3'], 'cb2-conf-base': ['sk-cb3-nope'] };
  const dr: any = await imp({ bundle, keys, dryRun: true });
  const hits0 = await hitsSum();
  const im: any = await imp({ bundle, keys });
  const strip = (x: any) => JSON.stringify({ ...x, dryRun: undefined });
  check('CB dryRun 回执 ≡ 真导入回执逐字段等价（预览≠落盘双路径事故的正面防御）', im.status === 200 && strip(dr.body) === strip(im.body), strip(im.body).slice(0, 200));
  check('CB 真导入零外呼（hits 增量 0）', (await hitsSum()) === hits0);
  const chNew = store.db.channels.find((c: any) => c.name === 'cb2-new') as any;
  check('CB keys 真落号池（新建净新增+merged addKeys 去重）', !!chNew && chNew.keys.length === 2 && chNew.keys.map((k: any) => k.key).join(',') === 'sk-cb3-k1,sk-cb3-k2' && (store.db.channels.find((c: any) => c.name === 'cb1-ch') as any).keys.some((k: any) => k.key === 'sk-cb3-k3'), JSON.stringify(chNew && chNew.keys.map((k: any) => k.key)));
  check('CB conflict 渠道零写入（conf-base 无 key）', (store.db.channels.find((c: any) => c.name === 'cb2-conf-base') as any).keys.length === 0);
  const masks = await (await fetch(BASE + '/api/channels', { headers: ADMIN })).text();
  check('CB GET channels 掩码不回显导入 key', masks.indexOf('sk-cb3-k1') === -1);
  const routes1: any = (await api('/api/routes', { headers: ADMIN })).body;
  const autoNew = routes1.find((r: any) => r.publicName === 'cb2-auto');
  const sNew = routes1.find((r: any) => r.publicName === 'cb2-s-new');
  check('CB auto 新建候选解析正确（悬空/嵌套已剔）', !!autoNew && autoNew.candidates.length === 1 && autoNew.candidates[0].routeId === sNew.id && autoNew.candidates[0].weight === 5, JSON.stringify(autoNew && autoNew.candidates));
  const auto3 = routes1.find((r: any) => r.publicName === 'cb3-auto');
  check('CB auto merge：weight bundle 胜 + 新候选并入', !!auto3 && auto3.candidates.length === 2 && auto3.candidates.find((x: any) => x.routeId === mId)?.weight === 9 && !!auto3.candidates.find((x: any) => x.routeId === sNew.id), JSON.stringify(auto3 && auto3.candidates));
  const cmList = JSON.stringify((im.body as any).routes.candidatesMerged || []);
  check('CB candidatesMerged 明细入回执（塞候选/权重改写可见）', cmList.includes('cb3-auto') && cmList.includes('1→9') && cmList.includes('新增候选'), cmList.slice(0, 200));
  const rNoAuth = await fetch(BASE + '/api/config/import', { method: 'POST', body: '{}' });
  check('CB 导入无令牌 401', rNoAuth.status === 401);
  const rVer0 = await imp({ bundle: { kind: 'own-api-config-bundle', version: 0, channels: [] }, dryRun: true });
  check('CB version 0 → 400（DR-CB-G 严格集合）', rVer0.status === 400, String(rVer0.status));
  const badBase = { kind: 'own-api-config-bundle', version: 1, channels: [{ name: 'cb2-badbase', baseUrl: 'ftp://x/v1', protocol: 'openai' }], routes: { singles: [], autos: [] } };
  const rBase = await imp({ bundle: badBase, dryRun: true });
  check('CB 畸形 baseUrl → conflict 不再 500（dryRun 不诸报）', rBase.status === 200 && JSON.stringify(rBase.body?.channels?.conflicts || []).includes('baseUrl'), JSON.stringify(rBase.body || {}).slice(0, 120));
  const rBase2 = await imp({ bundle: badBase });
  check('CB 畸形 baseUrl 真导入零落库', rBase2.status === 200 && rBase2.body?.channels?.created === 0 && !store.db.channels.some((c: any) => c.name === 'cb2-badbase'), String(rBase2.status));
  const rW = await imp({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [], routes: { singles: [], autos: [{ publicName: 'cb2-badw', candidates: [{ publicName: 'cb1-model', weight: -5 }] }] } }, dryRun: true });
  check('CB 候选 weight -5 → conflict（前置闸守 dryRun≡真导入）', rW.status === 200 && JSON.stringify(rW.body?.routes?.conflicts || []).includes('weight'), JSON.stringify(rW.body || {}).slice(0, 120));
  const rC17 = await imp({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [], routes: { singles: [], autos: [{ publicName: 'cb2-c17', candidates: Array.from({ length: 17 }, () => ({ publicName: 'cb1-model', weight: 1 })) }] } }, dryRun: true });
  check('CB 候选数 >16 → 整条 conflict（不静默截断）', JSON.stringify(rC17.body?.routes?.conflicts || []).includes('16'), String(rC17.status));
  const chDis: any = store.db.channels.find((c: any) => c.name === 'cb2-new');
  for (const k of chDis.keys) await api('/api/channels/' + chDis.id + '/keys/' + k.id, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ status: 'disabled' }) });
  const bDis: any = (await api('/api/config/export', { headers: ADMIN })).body;
  const rcDis: any = (await imp({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [bDis.channels.find((c: any) => c.name === 'cb2-new')] }, keys: {}, dryRun: true })).body;
  check('CB disabled-only 渠道算待填（§5 判据：无 active）', (rcDis.pendingKeyChannels || []).includes('cb2-new'), JSON.stringify(rcDis.pendingKeyChannels));
  await api('/api/channels', B({ name: 'cb3-mergeempty', baseUrl: 'http://127.0.0.1:5/v1', protocol: 'openai' }));
  const chCold: any = (await api('/api/channels', B({ name: 'cb3-cold', baseUrl: 'http://127.0.0.1:4/v1', protocol: 'openai', keys: ['sk-cold-1'] }))).body;
  await api('/api/channels/' + chCold.id + '/keys/' + chCold.keys[0].id, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ status: 'cooldown', cooldownUntil: Date.now() + 60000 }) });
  await api('/api/channels', B({ name: 'cb3-hdr', baseUrl: 'http://127.0.0.1:3/v1', protocol: 'openai', extraHeaders: { 'X-A': '1', 'X-B': '2' } }));
  const bP2: any = (await api('/api/config/export', { headers: ADMIN })).body;
  const eHdr = bP2.channels.find((c: any) => c.name === 'cb3-hdr');
  eHdr.extraHeaders = { 'X-B': '2', 'X-A': '1' };
  const rcP2: any = (await imp({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [bP2.channels.find((c: any) => c.name === 'cb3-mergeempty'), bP2.channels.find((c: any) => c.name === 'cb3-cold'), eHdr] }, keys: {}, dryRun: true })).body;
  check('CB merged 空池算待填（DR-CB-E 核心场景）', (rcP2.pendingKeyChannels || []).includes('cb3-mergeempty'), JSON.stringify(rcP2.pendingKeyChannels));
  check('CB cooldown-only 豁免待填（真置 cooldown 验证）', !(rcP2.pendingKeyChannels || []).includes('cb3-cold'), JSON.stringify(rcP2.pendingKeyChannels));
  check('CB extraHeaders 键序无关（merged 不 conflict）', rcP2.channels.conflicts.every((x: any) => x.name !== 'cb3-hdr'), JSON.stringify(rcP2.channels.conflicts));
  const singleFlip = { ...cb1Single, upstreamModel: 'cb1-changed-9' };
  const rtSnap0 = JSON.stringify((await api('/api/routes', { headers: ADMIN })).body);
  const rcFlip: any = (await imp({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [], routes: { singles: [singleFlip], autos: [] } }, keys: {}, dryRun: true })).body;
  const rtSnap1 = JSON.stringify((await api('/api/routes', { headers: ADMIN })).body);
  check('CB single 改 upstreamModel → conflict 且路由零变化', JSON.stringify(rcFlip?.routes?.conflicts || []).includes('cb1-model') && rtSnap0 === rtSnap1, JSON.stringify(rcFlip?.routes?.conflicts || []).slice(0, 120));
  const rc2: any = (await imp({ bundle, keys })).body;
  check('CB 幂等重跑：零新建零 keysAdded', rc2?.channels?.created === 0 && rc2?.routes?.created === 0 && rc2?.channels?.keysAdded === 0 && rc2?.routes?.skipped === 3, JSON.stringify(rc2 && { c: rc2.channels.created, m: rc2.channels.merged, r: rc2.routes.created, s: rc2.routes.skipped, ka: rc2.channels.keysAdded }));
  const rc3: any = (await imp({ bundle: { kind: 'own-api-config-bundle', version: 1, channels: [cb1Chan] }, keys: {} })).body;
  check('CB cooldown 不算待填（号池空判据）', !rc3?.pendingKeyChannels?.includes('cb1-ch'), JSON.stringify(rc3?.pendingKeyChannels));
  // 往返等价：spawn 隔离双实例（A 配→导出；B 导入→再导出；语义相等）
  const { spawn } = await import('node:child_process');
  const dirA = mkdtempSync(join(tmpdir(), 'ownapi-rtA-'));
  const dirB = mkdtempSync(join(tmpdir(), 'ownapi-rtB-'));
  const seed = (dir: string, token: string) => {
    writeFileSync(join(dir, 'db.json'), JSON.stringify({ channels: [], vkeys: [], logs: [], routes: [], settings: { adminToken: token, defaultUpstreamTimeoutMs: 300000, upstreamIdleTimeoutMs: 120000, maxBodyBytes: 67108864, debugHeaders: false, maxKeyRetries: 3, errorThreshold: 3, cooldownBaseMs: 30000, cooldownMaxMs: 900000, logRetention: 2000, autoMaxChainSeconds: 300 } }));
  };
  seed(dirA, 'rt-a'); seed(dirB, 'rt-b');
  const boot = (dir: string, port: string, token: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env: { ...process.env, LLM_DATA_DIR: undefined, LLM_ADMIN_TOKEN: undefined, OWN_API_ADMIN_TOKEN: undefined, OWN_API_DATA_DIR: dir, OWN_API_PORT: port, HOST: '127.0.0.1', OWN_API_OPEN_BROWSER: undefined }, stdio: 'ignore', cwd: process.cwd() });
    const wait = async () => { for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 300)); try { const rr = await fetch('http://127.0.0.1:' + port + '/api/routes', { headers: { 'x-admin-token': token } }); if (rr.status === 200) return true; } catch { /* 启动中 */ } } return false; };
    return { child, wait };
  };
  const A = boot(dirA, '18823', 'rt-a');
  const upA = await A.wait();
  check('CB round-trip：实例 A 就绪', upA);
  let rtOk = false; let rtInfo = '';
  if (upA) {
    const apiA = async (p: string, opt: any) => { const r = await fetch('http://127.0.0.1:18823' + p, { ...opt, headers: { 'x-admin-token': 'rt-a', 'content-type': 'application/json', ...(opt?.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const chA: any = (await apiA('/api/channels', { method: 'POST', body: JSON.stringify({ name: 'rt-ch', baseUrl: 'https://rt.example.com/v1', protocol: 'openai', keys: ['sk-rt-cycle-SECRETDEAD0123456789abcd'], note: '往返渠道' }) })).body;
    const mdA: any = (await apiA('/api/routes', { method: 'POST', body: JSON.stringify({ type: 'single', publicName: 'rt-model', channelId: chA.id, upstreamModel: 'rt-m', priceInput: 0.5, tags: ['rt'] }) })).body;
    await apiA('/api/routes', { method: 'POST', body: JSON.stringify({ type: 'auto', publicName: 'rt-auto', stickyTtlMs: 1234, candidates: [{ routeId: mdA.id, weight: 3 }] }) });
    const bx: any = (await apiA('/api/config/export', {})).body;
    const A2 = boot(dirB, '18824', 'rt-b');
    const upB = await A2.wait();
    if (upB) {
      const apiB = async (p: string, opt: any) => { const r = await fetch('http://127.0.0.1:18824' + p, { ...opt, headers: { 'x-admin-token': 'rt-b', 'content-type': 'application/json', ...(opt?.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
      const impB: any = (await apiB('/api/config/import', { method: 'POST', body: JSON.stringify({ bundle: bx }) })).body;
      const by: any = (await apiB('/api/config/export', {})).body;
      const norm = (b: any) => JSON.stringify({
        channels: [...b.channels].sort((x: any, y: any) => x.name.localeCompare(y.name)),
        singles: [...b.routes.singles].sort((x: any, y: any) => x.publicName.localeCompare(y.publicName)),
        autos: [...b.routes.autos].sort((x: any, y: any) => x.publicName.localeCompare(y.publicName)).map((a: any) => ({ ...a, candidates: [...a.candidates].sort((x: any, y: any) => x.publicName.localeCompare(y.publicName)) })),
      });
      rtOk = impB?.channels?.created === 1 && impB?.routes?.created === 2 && norm(bx) === norm(by);
      rtInfo = JSON.stringify(impB && { c: impB.channels.created, r: impB.routes.created }) + ' eq=' + (norm(bx) === norm(by)) + ' leak=' + (JSON.stringify(by).indexOf('SECRETDEAD') >= 0 || JSON.stringify(bx).indexOf('SECRETDEAD') >= 0);
    }
    A2.child.kill();
  }
  A.child.kill();
  check('CB 往返等价（A 导出→B 导入→B 导出语义相等，密钥全程不出 A）', rtOk && rtInfo.indexOf('leak=false') >= 0, rtInfo);
  await new Promise((r) => setTimeout(r, 3500)); // 等优雅关闭（含最后 persist）再删目录（审查竞态钉）
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
}
// ============ 18. 速度空窗（clearLogs 放最末，不伤任何 log 依赖断言） ============
{
  const del = await api('/api/logs', { method: 'DELETE', headers: ADMIN });
  const rep: any = (await api('/api/stats/speed?hours=0', { headers: ADMIN })).body;
  check('SI 空窗 200 且三集合全空不 500', del.status === 200 && rep && rep.streamRows.length === 0 && rep.latencyRows.length === 0 && rep.unattributed === null && rep.logsInWindow === 0 && rep.oldestTs === 0, JSON.stringify(rep && { n: rep.logsInWindow }));
}
// ================================================================
// §17 控制台脚本绑定钉（回归：裸块作用域吞 async 声明 → 导出/导入按钮静默无效）
// vm 全量执行内嵌控制台脚本（DOM 用万能 Proxy 桩），断言按钮 onclick 引用的
// 顶层函数在同上下文 typeof 均为 function——任何「声明被困进块作用域」都会在此爆。
{
  const vm = await import('node:vm');
  const { WEB_HTML } = await import('../src/web-html.gen.ts');
  const script = WEB_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
  const noop = () => {};
  const magic: any = () => new Proxy(function () {}, {
    get: (_t, p) => {
      if (p === 'classList') return { add: noop, remove: noop, toggle: noop, contains: () => false };
      if (p === 'style' || p === 'dataset') return {};
      if (p === 'length') return 0;
      if (p === 'then') return undefined; // 防被当 thenable
      if (p === Symbol.toPrimitive) return () => '';
      return magic();
    },
    set: () => true, apply: () => magic(),
  });
  const sandbox: any = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams,
    Blob: class {}, Date, JSON, Math,
    navigator: { clipboard: null },
    location: { hash: '', pathname: '/', search: '', href: 'http://x/' },
    history: { replaceState: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: new Proxy({}, { get: (_t, p) => {
      if (p === 'querySelector' || p === 'getElementById' || p === 'createElement') return () => magic();
      if (p === 'querySelectorAll') return () => [];
      if (p === 'addEventListener' || p === 'removeEventListener') return noop;
      return magic();
    } }),
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
    addEventListener: noop, removeEventListener: noop,
    EventSource: class { close() {} },
    confirm: () => false, alert: noop, Headers: class {},
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  // 列 0 的 function/async function 声明全部必须可解析（列 0 = 意图顶层；被困进裸块时 vm typeof 即 undefined）
  const refs = [...new Set([
    ...[...script.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
    'exportConfig', 'importConfig', 'cbFillPendingKeys', 'speedFetch', // 显式钉住四个曾经的受害者
  ])];
  let probeResult: Record<string, string> = {};
  let threw = '';
  sandbox.__probe = (o: any) => { probeResult = o; };
  try { vm.runInNewContext(script + `\n;__probe({${refs.map((n) => JSON.stringify(n) + ':typeof ' + n)}});`, sandbox, { filename: 'console-inline.js' }); }
  catch (e: any) { threw = e.message; }
  check('控制台脚本 vm 全量执行零异常', threw === '', threw);
  const missing = refs.filter((n) => probeResult[n] !== 'function');
  check(`控制台列 0 顶层函数声明全部可解析（${refs.length} 个）`, threw === '' && missing.length === 0, `缺失: ${missing.join(', ')}`);
  // 版本单源：version.gen.ts 必须与 package.json 一致（gen:web 产物陈旧性守护）
  const { APP_VERSION } = await import('../src/version.gen.ts');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  check('version.gen.ts 与 package.json 版本一致', APP_VERSION === pkg.version, `${APP_VERSION} != ${pkg.version}`);
}
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
