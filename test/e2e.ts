/**
 * 端到端自测：mock 上游 + 网关全链路。
 * 覆盖：同协议路由、跨协议互转（双向）、流式、号池故障切换、鉴权、用量记账。
 * 运行：npm test
 */
import { serve } from '@hono/node-server';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { request } from 'node:http';
import { dirname, join } from 'node:path';

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
// P2.1 设置校验钉（审查 T5：三组新键此前零钉）——钳制/显式拒绝/回读
const rSt1 = await patchSt({ autoSpeedFactor: { enabled: true, floor: 0.8, cap: 1.6 } });
check('P2.1 设置钉：floor/cap 合法值生效并回读', rSt1.status === 200 && rSt1.body?.autoSpeedFactor?.floor === 0.8 && rSt1.body?.autoSpeedFactor?.cap === 1.6, JSON.stringify(rSt1.body?.autoSpeedFactor));
const rSt2 = await patchSt({ autoSpeedFactor: { enabled: true, floor: 0.02, cap: 99 } });
check('P2.1 设置钉：越界 floor/cap 被钳进 [0.1,1]/[1,10]', rSt2.body?.autoSpeedFactor?.floor === 0.1 && rSt2.body?.autoSpeedFactor?.cap === 10, JSON.stringify(rSt2.body?.autoSpeedFactor));
const rSt3 = await patchSt({ autoSpeedFactor: { enabled: true, floor: 1.5, cap: 1.2 } });
// floor 先钳进 [0.1,1] 再比较——钳制后 floor≤cap 恒成立，显式拒绝是防御性死支（S4 复核口径）；钉「永不倒挂」而非「会拒绝」
check('P2.1 设置钉：floor>cap 输入钳制后恒不倒挂（floor≤cap 不变式）', rSt3.status === 200 && rSt3.body?.autoSpeedFactor?.floor <= rSt3.body?.autoSpeedFactor?.cap, JSON.stringify(rSt3.body?.autoSpeedFactor));
const rSt4 = await patchSt({ autoSaturation: { enabled: false, baseSec: 3, maxSec: 100000 } });
check('P2.1 设置钉：autoSaturation 关闭生效、baseSec/maxSec 钳进界', rSt4.body?.autoSaturation?.enabled === false && rSt4.body?.autoSaturation?.baseSec === 5 && rSt4.body?.autoSaturation?.maxSec === 86400, JSON.stringify(rSt4.body?.autoSaturation));
const rSt5 = await patchSt({ autoVision: { enabled: true, heuristics: true, evil: 'x' }, unknownKey: 1 });
check('P2.1 设置钉：未知顶层键进 _rejected、白名单外子键被剥离（输出白名单重建，无污染面）', (rSt5.body?._rejected || []).some((x: any) => String(x).includes('unknownKey')) && rSt5.body?.autoVision?.evil === undefined, JSON.stringify(rSt5.body?._rejected));
await patchSt({ autoSaturation: { enabled: true, baseSec: 60, maxSec: 1800 }, autoSpeedFactor: { enabled: true, floor: 0.5, cap: 2.0 } }); // 归位（SAT/SPD 钉依赖默认值）
// P2.1 验收指标口径钉（G21/§6）：auto 域限定 chainAttempts 非空；from/to 显式窗口
// 场景 A：双候选首候选 429×2 key → 续链成功（chainAttempts=3）→ 窗口恰 1 条日志
{
  const t0 = Date.now();
  const chAcc = await mkCh('Auto Acc', 'openai', ['k-429-acc1', 'k-429-acc2']);
  const mAccA = (await mkModel({ publicName: 'acc-a', channelId: chAcc.id, upstreamModel: 'mock-gpt-5' })).body;
  const mAccB = (await mkModel({ publicName: 'acc-b', channelId: chAuto.id, upstreamModel: 'mock-gpt-5' })).body;
  await mkAuto({ publicName: 'auto_acc', candidates: [{ routeId: mAccA.id, weight: 10000 }, { routeId: mAccB.id, weight: 1 }], stickyTtlMs: 0 });
  const rAcc = await autoReq('auto_acc', { stream: true });
  const t1 = Date.now();
  // 同进程同钟：log.ts（请求起点）必落 [t0,t1]——窗口取请求区间本身，前序流量（整段 e2e 才 ~2s 墙钟）不进窗
  const st = (await api('/api/stats?from=' + t0 + '&to=' + (t1 + 1), { headers: ADMIN })).body;
  const ac = st.autoAcceptance || {};
  check('P2.1 指标钉：续链成功 → 跨候选失败率=1（1/1）、全链失败率=0、auto 域恰 1 请求', rAcc.status === 200 && ac.autoRequests === 1 && ac.crossCandidateFailRate === 1 && ac.chainExhaustedRate === 0, JSON.stringify(ac));
  check('P2.1 指标钉：成功流式 TTFT p95 落窗', typeof ac.p95TtftStreamMs === 'number' && ac.p95TtftStreamMs > 0, JSON.stringify(ac));
  // 场景 B：全链失败（单候选双 429 key 耗尽）→ 全链失败率=1、跨候选率=null（无成功样本）
  const t2 = Date.now();
  const chAcc2 = await mkCh('Auto Acc2', 'openai', ['k-429-acc3', 'k-429-acc4']);
  const mAccC = (await mkModel({ publicName: 'acc-c', channelId: chAcc2.id, upstreamModel: 'mock-gpt-5' })).body;
  await mkAuto({ publicName: 'auto_acc2', candidates: [{ routeId: mAccC.id, weight: 1 }], stickyTtlMs: 0 });
  const rFail = await autoReq('auto_acc2');
  const t3 = Date.now();
  const st2 = (await api('/api/stats?from=' + t2 + '&to=' + (t3 + 1), { headers: ADMIN })).body;
  const ac2 = st2.autoAcceptance || {};
  // 终态 = 末次上游错误透传（全 429 耗尽 → 429，非 5xx）；耗尽口径按「非 ok 非 499」计（与 buildAcceptance 一致）
  check('P2.1 指标钉：全链耗尽 → 失败率=1、无成功样本时跨候选率=null（不编造 0）', rFail.status === 429 && ac2.autoRequests === 1 && ac2.chainExhaustedRate === 1 && ac2.crossCandidateFailRate === null, JSON.stringify(ac2));
  // 场景 C：direct 请求不进 auto 域（chainAttempts 空 → autoRequests=0、指标全 null）
  const t4 = Date.now();
  await api('/v1/chat/completions', { method: 'POST', headers: AH, body: JSON.stringify({ model: 'auto-m-gpt', messages: [{ role: 'user', content: 'hi' }] }) });
  const t5 = Date.now();
  const st3 = (await api('/api/stats?from=' + t4 + '&to=' + (t5 + 1), { headers: ADMIN })).body;
  const ac3 = st3.autoAcceptance || {};
  check('P2.1 指标钉：direct 流量不进验收域（autoRequests=0、三指标 null）', ac3.autoRequests === 0 && ac3.crossCandidateFailRate === null && ac3.chainExhaustedRate === null && ac3.p95TtftStreamMs === null, JSON.stringify(ac3));
  await api('/api/routes/' + mAccA.id, { method: 'DELETE', headers: ADMIN });
  await api('/api/routes/' + mAccB.id, { method: 'DELETE', headers: ADMIN });
  await api('/api/routes/' + mAccC.id, { method: 'DELETE', headers: ADMIN });
}
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
// VIS-5：inputEst 图片 token——data URL 100×100 精算 ceil(10000/750)=14；http URL 上界常数 1600（§10 裁决，审查 D1-2 落实）
const png100 = (() => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(100, 16); b.writeUInt32BE(100, 20); b[24] = 8; b[25] = 2; return 'data:image/png;base64,' + b.toString('base64'); })();
const ctReq = (url: string) => api('/v1/messages/count_tokens', { method: 'POST', headers: AH, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url } }] }] }) });
const ct1 = await ctReq(png100);
const ct2 = await ctReq('https://example.com/a.png');
check('VIS-5 data URL 100×100 精算（ceil(10000/750)=14）', ct1.body?.input_tokens === Math.ceil(2 / 4) + 14, JSON.stringify(ct1.body));
check('VIS-5 http URL 上界常数 1600/图（不下载，§10 裁决）', ct2.body?.input_tokens === Math.ceil(2 / 4) + 1600, JSON.stringify(ct2.body));
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
// P2.1 完整闸（R9 回滚语义，缓交①）：autoVision.enabled=false → 软排除与 0.25 降权一起失效
await api('/api/settings', { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ autoVision: { enabled: false, heuristics: true } }) });
await autoReq('auto_vis6', { messages: twoImgs });
const ewGateOff = ((await getLogs('auto_vis6'))[0]?.chainAttempts?.[0]?.pickSnapshot || []).find((x: any) => x.routeId === mVisU.id)?.ew;
check('P2.1 视觉闸：enabled=false → 带图 unknown 候选 bias 恒 1（ew 回 10000）', ewGateOff === 10000, `ew=${ewGateOff}`);
const rVisGate = await autoReq('auto_vis1', { messages: imgMsg }); // 粘性绑定在 supportsVision=false 候选上
check('P2.1 视觉闸：enabled=false → false 候选不再被软排除（粘性直接命中）', rVisGate.status === 200 && (await getLogs('auto_vis1'))[0]?.routedTo === 'auto-m-visoff', JSON.stringify({ routedTo: (await getLogs('auto_vis1'))[0]?.routedTo }));
await api('/api/settings', { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ autoVision: { enabled: true, heuristics: true } }) });
const rVisBack = await autoReq('auto_vis1', { messages: imgMsg });
check('P2.1 视觉闸：恢复 enabled → 软排除即刻回来（设置热读，改动即刻生效）', rVisBack.status === 200 && (await getLogs('auto_vis1'))[0]?.routedTo === 'auto-m-gpt', JSON.stringify({ routedTo: (await getLogs('auto_vis1'))[0]?.routedTo }));
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

// —— 审查修复钉：速度因子端到端分化（T5 补强：e2e 域 factor 不再恒 1，speedFactorOf→ewOf 接线实证）——
await resetAutoRT();
const mSpdF = (await mkModel({ publicName: 'spd-fast', channelId: chAuto.id, upstreamModel: 'mock-ttft0spaced60' })).body; // decode ~300ms → ~56 tok/s
const mSpdS = (await mkModel({ publicName: 'spd-slow', channelId: chAuto.id, upstreamModel: 'mock-ttft0spaced240' })).body; // decode ~1200ms → ~14 tok/s
const aFac = await mkAuto({ publicName: 'auto_fac', candidates: [{ routeId: mSpdF.id, weight: 10000 }, { routeId: mSpdS.id, weight: 1 }], stickyTtlMs: 0 });
for (let i = 0; i < 3; i++) await autoReq('auto_fac', { stream: true }); // fast ×3（单候选 bench 自锚 → EMA_fast=1）
await patchAuto(aFac.body.id, { candidates: [{ routeId: mSpdF.id, weight: 1 }, { routeId: mSpdS.id, weight: 10000 }] });
for (let i = 0; i < 3; i++) await autoReq('auto_fac', { stream: true }); // slow ×3（bench=下中位=慢者 p50 → raw_slow=1 → EMA_slow=1）
await patchAuto(aFac.body.id, { candidates: [{ routeId: mSpdF.id, weight: 10000 }, { routeId: mSpdS.id, weight: 1 }] });
await autoReq('auto_fac', { stream: true }); // fast 第 3 个 fresh 样本：raw=p50F/p50S≥2→clamp cap2 → EMA_fast=0.3×2+0.7×1=1.3
await autoReq('auto_fac', { stream: true }); // 本次快照建于采样前：factor_fast=1.3（实值）、factor_slow=1.0（下中位自锚）
const lFac = (await getLogs('auto_fac'))[0];
const snapFac = lFac?.chainAttempts?.[0]?.pickSnapshot || [];
const fFacF = snapFac.find((x: any) => x.routeId === mSpdF.id) || {};
const fFacS = snapFac.find((x: any) => x.routeId === mSpdS.id) || {};
check('审查钉：速度因子端到端分化——快候选 1.3（0.3×cap+0.7×1）、慢候选 1.0（下中位 bench 自锚）', fFacF.factor === 1.3 && fFacS.factor === 1, JSON.stringify(snapFac));
check('审查钉：factor 实际进入 ew（R4 统一公式接线）：ew≈weight×factor（health≈1）', Math.abs(fFacF.ew - 10000 * fFacF.factor) < 1 && fFacS.ew === 1, JSON.stringify(snapFac));
await api('/api/routes/' + aFac.body.id, { method: 'DELETE', headers: ADMIN });

// —— 审查修复钉：采样准入负向（G15 15/16 线、非流式、direct 三条毒样本静默路径）——
await resetAutoRT();
const mTok15 = (await mkModel({ publicName: 'spd-tok15', channelId: chAuto.id, upstreamModel: 'mock-ttft0spaced60tok15' })).body; // completion_tokens=15 <16
const mTok16 = (await mkModel({ publicName: 'spd-tok16', channelId: chAuto.id, upstreamModel: 'mock-ttft0spaced60' })).body; // =17 ≥16
const aT15 = await mkAuto({ publicName: 'auto_tok15', candidates: [{ routeId: mTok15.id, weight: 1 }], stickyTtlMs: 0 });
const aT16 = await mkAuto({ publicName: 'auto_tok16', candidates: [{ routeId: mTok16.id, weight: 1 }], stickyTtlMs: 0 });
await autoReq('auto_tok15', { stream: true });
await autoReq('auto_tok16', { stream: true });
const ahTok = await autoHealth();
const row15 = (ahTok.windows || []).find((w: any) => w.routeId === mTok15.id) || {};
const row16 = (ahTok.windows || []).find((w: any) => w.routeId === mTok16.id) || {};
check('G15 准入线负向：15tok 流式不采样（健康行在、无 tokP50）；16tok+ 采样', row15.ok != null && row15.tokP50 == null && typeof row16.tokP50 === 'number', JSON.stringify({ row15, row16 }));
await api('/api/routes/' + aT15.body.id, { method: 'DELETE', headers: ADMIN });
await api('/api/routes/' + aT16.body.id, { method: 'DELETE', headers: ADMIN });
const mNs = (await mkModel({ publicName: 'spd-ns', channelId: chAuto.id, upstreamModel: 'mock-ttft0spaced60' })).body;
const aNs = await mkAuto({ publicName: 'auto_ns', candidates: [{ routeId: mNs.id, weight: 1 }], stickyTtlMs: 0 });
await autoReq('auto_ns'); // 非流式：F3.3 仅观测落日志，不入速度状态
const rowNs = ((await autoHealth()).windows || []).find((w: any) => w.routeId === mNs.id) || {};
check('F3.3 负向：非流式成功不采样（健康行在、无 tokP50）', rowNs.ok != null && rowNs.tokP50 == null, JSON.stringify(rowNs));
await api('/api/routes/' + aNs.body.id, { method: 'DELETE', headers: ADMIN });
const mDir = (await mkModel({ publicName: 'spd-direct', channelId: chAuto.id, upstreamModel: 'mock-ttft0spaced60' })).body;
await autoReq('spd-direct', { stream: true }); // direct 直连：attemptRoute 单候选仍记健康，但无 AttemptInput.speedCfg → 永不采速度
const rowDir = ((await autoHealth()).windows || []).find((w: any) => w.routeId === mDir.id) || {};
check('G14 负向：direct 直连流式不采速度（健康行在、无 tokP50/speedFactor）', rowDir.ok != null && rowDir.tokP50 == null && rowDir.speedFactor == null, JSON.stringify(rowDir));


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
section('17. agent 一键接入（docs/agent-import-design.md §11 钉子 AI-0…AI-23）');
{
  const AG = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const savedHome = process.env.OWN_API_AGENT_HOME;
  process.env.OWN_API_AGENT_HOME = AG; // 测试唯一注入点：真实 ~ 零污染
  const ai = await import('../src/agent-import.ts');
  const { setSelfBaseUrl } = await import('../src/admin.ts');
  setSelfBaseUrl(BASE); // 探针恒打本进程监听地址（生产由 index.ts 注入）
  const ZF = join(AG, '.zcode', 'v2', 'config.json');
  const putZ = (obj: any, opt: { eol?: boolean; indent?: string; mode?: number } = {}) => {
    mkdirSync(dirname(ZF), { recursive: true });
    writeFileSync(ZF, JSON.stringify(obj, null, opt.indent ?? '  ') + (opt.eol ? '\n' : ''));
    chmodSync(ZF, opt.mode ?? 0o644);
  };
  const rawZ = () => readFileSync(ZF, 'utf8');
  const rdZ = () => JSON.parse(rawZ());
  const modeZ = () => statSync(ZF).mode & 0o777;
  const blk = () => rdZ().provider['own-api'];
  const FOREIGN = { provider: { 'builtin:zai': { name: 'Z.ai', kind: 'anthropic', options: { apiKey: 'glm-secret', baseURL: 'https://api.z.ai/api/anthropic' }, models: { 'GLM-5-Turbo': { limit: { context: 200000 } } } } }, ui: { theme: 'dark' } };
  const VK: any = (await api('/api/vkeys?reveal=1', { headers: ADMIN })).body[0];
  const PLAN = (b: any) => api('/api/agents/plan', { method: 'POST', headers: ADMIN, body: JSON.stringify(b) });
  const APPLY = (b: any) => api('/api/agents/apply', { method: 'POST', headers: ADMIN, body: JSON.stringify({ ...b, confirm: true }) });
  const LINKS = async () => (await api('/api/agents', { headers: ADMIN })).body.links as any[];
  const base = { agentId: 'zcode', vkeyId: VK.id, model: 'gpt-4o' };
  const realZ = join(homedir(), '.zcode', 'v2', 'config.json');
  const realMtime = existsSync(realZ) ? statSync(realZ).mtimeMs : -1;
  const realOmp = join(homedir(), '.omp', 'agent');
  const realOmpMt = ['models.yml', 'config.yml'].map((f) => { const p = join(realOmp, f); return existsSync(p) ? statSync(p).mtimeMs : -1; });
  // claude 那条是**未实机验证**换来的底线承诺：测试全程只准碰 OWN_API_AGENT_HOME 里的沙盒
  const realClaude = join(homedir(), '.claude', 'settings.json');
  const realClaudeMt = existsSync(realClaude) ? statSync(realClaude).mtimeMs : -1;
  // dsh 这两份是**我们正跑在里面的进程**的配置：写坏了就是自毁，凭据库尤其（多用户可读会被 dsh 拒绝加载）
  const realDsh = ['.dsh/settings.yaml', '.dsh/.credentials.yaml'].map((f) => { const p = join(homedir(), f); return existsSync(p) ? statSync(p).mtimeMs : -1; });

  check('AI-0 路径恒源自注入根（无任何绝对路径入参可绕）', ai.agentHome() === AG && ai.ADAPTERS.every((a) => a.targets.every((t) => ai.targetFile(t, AG).startsWith(AG))), ai.agentHome());

  const z0 = ((await api('/api/agents', { headers: ADMIN })).body as any).adapters.find((a: any) => a.id === 'zcode');
  const binExpected = existsSync('/Applications/ZCode.app') || (process.env.PATH || '').split(':').some((d) => existsSync(join(d, 'zcode')));
  check('AI-1 空沙箱 configPresent=false（残留配置≠已安装，两级分开判）', z0.configPresent === false && z0.targets[0].managedPresent === false, JSON.stringify(z0.targets));
  check('AI-1 binaryFound 独立判定（PATH + 既定安装位置，全盘扫描不参与）', z0.binaryFound === binExpected, `got=${z0.binaryFound} expect=${binExpected}`);

  const evil = ['../../../../etc/passwd', '/etc/passwd', 'opencode', '', 'ZCODE', 'zcode/../../etc'];
  const evilRes = await Promise.all(evil.map((agentId) => PLAN({ agentId, vkeyId: VK.id, model: 'gpt-4o' })));
  check('AI-2 路径穿越/未适配 agentId 一律 400（协议层不可表示）', evilRes.every((r) => r.status === 400), evilRes.map((r) => r.status).join(','));
  check('AI-2 且被拒的请求零落盘', !existsSync(ZF) && !existsSync(join(AG, 'passwd')), '');

  putZ(FOREIGN);
  const b3 = rawZ();
  const p3: any = (await PLAN(base)).body;
  check('AI-3 plan 判 create 且零写入零备份', p3.steps?.[0]?.state === 'create' && rawZ() === b3 && !existsSync(ZF + '.own-api-bak'), JSON.stringify(p3.steps?.map((s: any) => s.state)));
  check('AI-3 plan 全程不回显明文 key（diff 已掩码）', !JSON.stringify(p3).includes(VK.key) && JSON.stringify(p3).includes('***'), '');
  check('AI-13 缺 confirm → 428 且零写入', (await api('/api/agents/apply', { method: 'POST', headers: ADMIN, body: JSON.stringify(base) })).status === 428 && rawZ() === b3);
  const xff = await api('/api/agents/apply', { method: 'POST', headers: { ...ADMIN, 'x-forwarded-for': '8.8.8.8' }, body: JSON.stringify({ ...base, confirm: true }) });
  check('AI-14 写面只认 socket 对端：XFF 谎报不放宽（本机直连仍放行）', xff.status === 403 && rawZ() === b3, `${xff.status}`);
  const vkAcl: any = (await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'ai-acl', allowedModels: ['gpt-4o'] }) })).body;
  check('AI-15 越权模型 400；同 key 的授权模型可规划', (await PLAN({ agentId: 'zcode', vkeyId: vkAcl.id, model: 'claude-sonnet' })).status === 400 && (await PLAN({ agentId: 'zcode', vkeyId: vkAcl.id, model: 'gpt-4o' })).status === 200);
  check('AI-15 闸后仍零写入', rawZ() === b3 && !existsSync(ZF + '.own-api-bak'), '');

  const a5: any = (await APPLY(base)).body;
  const mk: any = (await api('/v1/models', { headers: { authorization: `Bearer ${VK.key}` } })).body;
  check('AI-12 apply 回执与 plan 都不含明文 key；key 只出现在目标文件', !JSON.stringify(a5).includes(VK.key) && blk().options.apiKey === VK.key, '');
  check('AI-4 写进 agent 的 catalog === 这把 key 的 GET /v1/models（G1 同源）', JSON.stringify(Object.keys(blk().models).sort()) === JSON.stringify(mk.data.map((m: any) => m.id).sort()), `${Object.keys(blk().models)} vs ${mk.data.map((m: any) => m.id)}`);
  check('AI-4 每个模型带 context_length（有值时）投影成 limit.context', blk().models['gpt-4o']?.limit?.context > 0, JSON.stringify(blk().models['gpt-4o']));
  check('AI-6 merge-only：别家条目与无关顶层键原样保留', rdZ().provider['builtin:zai'].options.apiKey === 'glm-secret' && rdZ().ui?.theme === 'dark', '');
  check('AI-6 非托管条目在文件中的位置未被移动（merge 而非整文件重排）', rawZ().indexOf('"builtin:zai"') < rawZ().indexOf('"own-api"'), '');
  check('AI-7 保持原文件的无尾换行 / 2 空格缩进 / 0644', !rawZ().endsWith('\n') && /\n  "provider"/.test(rawZ()) && modeZ() === 0o644, `eol=${rawZ().endsWith('\n')} mode=${modeZ().toString(8)}`);
  putZ(FOREIGN, { eol: true, indent: '    ', mode: 0o600 });
  const a7b = await APPLY(base);
  // own-api 在第 3 层（provider → own-api → name），4 空格缩进下前导是 12 个空格
  check('AI-7b 另一形态同样保持（4 空格 + 有尾换行 + 0600 不升级）', a7b.status === 200 && rawZ().endsWith('\n') && /\n {4}"provider"/.test(rawZ()) && /\n {12}"name": "own-api"/.test(rawZ()) && modeZ() === 0o600, `mode=${modeZ().toString(8)} eol=${rawZ().endsWith('\n')} status=${a7b.status}`);
  const beforeNoop = rawZ();
  const noop: any = (await APPLY(base)).body;
  check('AI-5 幂等：二次 apply 全 noop 且盘上字节完全相同（不与 agent 抢写）', noop.steps.every((s: any) => s.state === 'noop') && rawZ() === beforeNoop, JSON.stringify(noop.steps.map((s: any) => s.state)));
  rmSync(ZF);
  await APPLY(base);
  check('AI-8 无原文件可继承 mode 时新建 0600', modeZ() === 0o600, modeZ().toString(8));
  check('AI-8 写前留 .own-api-bak（同路径复写不产生 bak 堆积）', existsSync(ZF + '.own-api-bak') && !existsSync(ZF + '.own-api-bak.1'), '');

  const chAnth: any = (await api('/api/channels', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'ai-anth', baseUrl: 'https://anth.test', protocol: 'anthropic', keys: [{ key: 'sk-an' }] }) })).body;
  await api('/api/routes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ type: 'single', publicName: 'ai-claude', channelId: chAnth.id, upstreamModel: 'claude-x' }) });
  await APPLY({ ...base, model: 'ai-claude' });
  check('AI-16 anthropic 主模型 → kind=anthropic 且 baseURL 不带 /v1（实测拼法）', blk().kind === 'anthropic' && blk().options.baseURL === BASE, `${blk().kind} ${blk().options.baseURL}`);
  await APPLY(base);
  check('AI-16 openai 主模型 → kind=openai-compatible 且 baseURL 含 /v1（拼错即 404）', blk().kind === 'openai-compatible' && blk().options.baseURL === `${BASE}/v1`, `${blk().kind} ${blk().options.baseURL}`);

  const driftOf = async () => (await LINKS()).find((l) => l.agentId === 'zcode')?.drift;
  check('AI-17 刚写完 drift=consistent', (await driftOf()) === 'consistent', String(await driftOf()));
  const norm = rdZ();
  for (const m of Object.keys(norm.provider['own-api'].models)) {
    norm.provider['own-api'].models[m].modalities = { input: ['text', 'image', 'video'] };
    norm.provider['own-api'].models[m].reasoning = { enabled: true };
  }
  norm.provider['own-api'].lastUsedAt = Date.now();
  putZ(norm);
  check('AI-18 对方在我们块里补字段（zcode 实测行为）不算漂移', (await driftOf()) === 'consistent', String(await driftOf()));
  const cut = rdZ();
  delete cut.provider['own-api'].models[Object.keys(cut.provider['own-api'].models)[0]];
  putZ(cut);
  check('AI-18 我方 catalog 被增删键 → modified（G1 被破坏要让人看见）', (await driftOf()) === 'modified', String(await driftOf()));
  const lim = rdZ();
  const anyKey = Object.keys(lim.provider['own-api'].models)[0];
  lim.provider['own-api'].models[anyKey].limit = { context: 1 };
  putZ(lim);
  check('AI-18 我方声明的 limit 被改 → modified', (await driftOf()) === 'modified', '');
  await APPLY(base);
  check('AI-18 重新 apply 后回到 consistent（同步即修复）', (await driftOf()) === 'consistent', String(await driftOf()));
  const gone = rdZ();
  delete gone.provider['own-api'];
  putZ(gone);
  check('AI-17 托管块被整体删除 → missing（与"被改"分开报）', (await driftOf()) === 'missing', String(await driftOf()));
  const corrupt = '{ "provider": oops';
  writeFileSync(ZF, corrupt);
  const lCorrupt = (await LINKS()).find((l: any) => l.agentId === 'zcode');
  check('AI-19 文件损坏 → drift=unavailable 而非 500', lCorrupt?.drift === 'unavailable', JSON.stringify(lCorrupt?.drift));
  check('AI-10 损坏文件 apply 被拒（409）且原文一字节未动', (await APPLY(base)).status === 409 && rawZ() === corrupt, '');
  const planCorrupt: any = (await PLAN(base)).body;
  check('AI-10 拒写路径的 errors 说清了原因（不是含糊的"失败"）', String(planCorrupt.errors?.[0] || '').includes('拒绝'), JSON.stringify(planCorrupt.errors));

  const probe1: any = (await api('/api/agents/zcode/probe', { method: 'POST', headers: ADMIN, body: JSON.stringify({ level: 'L1' }) })).body;
  check('AI-20 探针 L1 verdict=ok 且 note 不含明文 key', probe1.verdict === 'ok' && !JSON.stringify(probe1).includes(VK.key), JSON.stringify(probe1).slice(0, 120));
  check('AI-20 探针 L2 未 confirm → 428（真上游花费要显式授权）', (await api('/api/agents/zcode/probe', { method: 'POST', headers: ADMIN, body: JSON.stringify({ level: 'L2' }) })).status === 428);
  const probe2: any = (await api('/api/agents/zcode/probe', { method: 'POST', headers: ADMIN, body: JSON.stringify({ level: 'L2', confirm: true }) })).body;
  check('AI-20 探针 L2（mock 上游）走通全流程', probe2.verdict === 'ok' && probe2.status === 200, JSON.stringify(probe2).slice(0, 140));
  check('AI-20 探针结果记账进 link.lastProbe', (await LINKS()).find((l: any) => l.agentId === 'zcode')?.lastProbe?.ok === true, '');

  const rBad = join(AG, 'elsewhere.json');
  rmSync(ZF);
  mkdirSync(dirname(ZF), { recursive: true });
  writeFileSync(rBad, '{"provider":{"own-api":{"options":{"baseURL":"https://evil.test"}}}}');
  symlinkSync(rBad, ZF);
  check('AI-11 目标是符号链接 → 拒绝跟随（plan errors 非空）', String((await PLAN(base)).body.errors?.[0] || '').includes('符号链接'), JSON.stringify((await PLAN(base)).body.errors));
  check('AI-11 apply 被拒且链接目标文件未被改写', (await APPLY(base)).status === 409 && rawZ2() === '{"provider":{"own-api":{"options":{"baseURL":"https://evil.test"}}}}', '');
  function rawZ2() { return readFileSync(rBad, 'utf8'); }
  rmSync(ZF);
  rmSync(rBad);

  putZ(FOREIGN);
  await APPLY(base);
  const rv: any = (await api('/api/agents/zcode', { method: 'DELETE', headers: ADMIN })).body;
  check('AI-21 撤销只删我们那块：own-api 消失、别家与无关键健在', rv.ok === true && rv.results[0].action === 'removed' && !('own-api' in rdZ().provider) && rdZ().provider['builtin:zai'].options.apiKey === 'glm-secret' && rdZ().ui.theme === 'dark', JSON.stringify(rv.results));
  check('AI-21 撤销后账本清空', (await LINKS()).length === 0, '');

  await APPLY(base);
  const tam = rdZ();
  tam.provider['own-api'].options.baseURL = 'https://someone.else/v1';
  putZ(tam);
  const rv2: any = (await api('/api/agents/zcode', { method: 'DELETE', headers: ADMIN })).body;
  check('AI-22 条目已不指向本网关 → 不删（防误删用户自建同名条目）', rv2.ok === false && rv2.results[0].action === 'kept' && 'own-api' in rdZ().provider, JSON.stringify(rv2.results));
  check('AI-22 残留时账本保留（UI 仍看得见这个孤儿）', (await LINKS()).length === 1, '');
  const rv3: any = (await api('/api/agents/zcode?force=1', { method: 'DELETE', headers: ADMIN })).body;
  check('AI-22 ?force=1 才允许只清账本', rv3.ok === true && (await LINKS()).length === 0, '');

  putZ(FOREIGN);
  const vkT: any = (await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'ai-throwaway' }) })).body;
  await APPLY({ agentId: 'zcode', vkeyId: vkT.id, model: 'gpt-4o' });
  await api(`/api/vkeys/${vkT.id}`, { method: 'DELETE', headers: ADMIN });
  const dang = (await LINKS()).find((l: any) => l.agentId === 'zcode');
  check('AI-23 key 被删后 link 悬空可见且不炸（GET 200）', dang?.vkeyDangling === true && dang?.vkeyName == null, JSON.stringify({ d: dang?.vkeyDangling, n: dang?.vkeyName }));
  const probeD = await api('/api/agents/zcode/probe', { method: 'POST', headers: ADMIN, body: JSON.stringify({ level: 'L1' }) });
  check('AI-23 悬空时探针明确 409 并指路（不拿空 key 去打）', probeD.status === 409 && String(probeD.body?.error).includes('已删除'), JSON.stringify(probeD.body).slice(0, 100));
  await api('/api/agents/zcode', { method: 'DELETE', headers: ADMIN });
  check('AI-23 悬空账本可撤销清理', (await LINKS()).length === 0, '');

  // 静态结构钉（本轮真实踩到的 bug）：向导里点 L2 时弹了浏览器 confirm() 却**没把 confirm 带给服务端**，
  // 于是 L2 恒 428 被 UI 显示成「探针未通过」——用户看到的是「链路坏了」，真相是「我没带确认」。
  // DOM 桩（AI-17）还欠着，先把这条不变量钉在源码上：凡是打 /probe 的 UI 调用点都必须自带 confirm 透传。
  const uiHtml = readFileSync('web/index.html', 'utf8');
  const probeSites = uiHtml.split('/probe`').slice(1);
  check('AI-24 UI 每个探针调用点都透传 confirm（防「弹了框没带确认」复发）', probeSites.length >= 2 && probeSites.every((s) => s.slice(0, 200).includes('confirm: true')), `${probeSites.length} 处调用点`);

  // ---- omp（YAML 写入点，PR2 第一支）：形态取自真机 ~/.omp/agent/*.yml，见 §4.4 ----
  const OM = join(AG, '.omp', 'agent');
  const MF = join(OM, 'models.yml');
  const CF = join(OM, 'config.yml');
  const LONG = 'word '.repeat(40).trim(); // 200 字符带空格长值：yaml 默认 80 列会把它折行，见 DR-AI-F
  const MODELS_FIX = `providers:\n  jyld: &jyld\n    baseUrl: https://up.example/v1\n    api: openai-completions\n    apiKey: sk-up-secret # 行尾注释不该被我们动\n    models:\n      - id: m1\n        name: m1\n        contextWindow: 1000000\n        maxTokens: 384000\n  other:\n    <<: *jyld\n    baseUrl: https://other.example/v1\n`;
  const CONFIG_FIX = `# 用户的头注释\nmodelRoles:\n  default: jyld/m1\n  plan: jyld/m1:auto\n  tiny: jyld/m1\nsymbolPreset: unicode\nlongNote: ${LONG}\nmemory:\n  backend: local\nempty:\n  []\nblock: |\n  keep1\n  keep2\n`;
  const putOmp = () => {
    mkdirSync(OM, { recursive: true });
    writeFileSync(MF, MODELS_FIX);
    writeFileSync(CF, CONFIG_FIX);
    chmodSync(MF, 0o600);
    chmodSync(CF, 0o600);
  };
  const rawM = () => readFileSync(MF, 'utf8');
  const rawC = () => readFileSync(CF, 'utf8');
  const parseY = (f: string) => ai.readYamlFile(f) as any;
  const OM_BASE = { agentId: 'omp', vkeyId: VK.id, model: 'gpt-4o', roles: ['default'] };

  putOmp();
  const o0 = ((await api('/api/agents', { headers: ADMIN })).body as any).adapters.find((a: any) => a.id === 'omp');
  check('AI-25 omp 被检出且角色槽随 detect 一起交给 UI', o0 && o0.configPresent === true && Array.isArray(o0.roleSlots) && o0.roleSlots.some((r: any) => r.slot === 'default'), JSON.stringify(o0?.roleSlots?.map((r: any) => r.slot)));
  const op: any = (await PLAN(OM_BASE)).body;
  check('AI-26 plan 列两个写入点（provider 块 + 角色映射）且各自标了 kind', op.steps.length === 2 && op.steps.some((s: any) => s.kind === 'block') && op.steps.some((s: any) => s.kind === 'role'), JSON.stringify(op.steps.map((s: any) => [s.kind, s.state])));
  check('AI-26 plan 里 key 仍是掩码（明文不落 diff/预览）', !JSON.stringify(op).includes(VK.key) && /\*/.test(String(op.steps[0].after?.apiKey)), String(op.steps[0].after?.apiKey));

  const oa: any = (await APPLY(OM_BASE)).body;
  const mAfter = parseY(MF).state.data;
  const cAfter = parseY(CF).state.data;
  check('AI-27 apply 建 providers.own-api（api/baseUrl/models 形态同真机）', oa.status === 'success' && mAfter.providers['own-api'].api === 'openai-completions' && mAfter.providers['own-api'].baseUrl.endsWith('/v1') && mAfter.providers['own-api'].models[0].id === 'gpt-4o', JSON.stringify(mAfter.providers['own-api']?.models));
  const JYLD_EXPECT = { baseUrl: 'https://up.example/v1', api: 'openai-completions', apiKey: 'sk-up-secret', models: [{ id: 'm1', name: 'm1', contextWindow: 1000000, maxTokens: 384000 }] };
  check('AI-27 merge-only：别人的 provider 语义一字未动', JSON.stringify(mAfter.providers.jyld) === JSON.stringify(JYLD_EXPECT) && mAfter.providers.other.baseUrl === 'https://other.example/v1', JSON.stringify(mAfter.providers.jyld));
  check('AI-27 别人的行尾注释原样还在（Document API 不重排无关节点）', rawM().includes('apiKey: sk-up-secret # 行尾注释不该被我们动'), rawM().split('\n').find((l) => l.includes('sk-up-secret')) || '');
  check('AI-28 角色逐键合并、不整块替换：未勾选的 plan/tiny 原值（含 :auto 后缀）保持不动', cAfter.modelRoles.default === 'own-api/gpt-4o' && cAfter.modelRoles.plan === 'jyld/m1:auto' && cAfter.modelRoles.tiny === 'jyld/m1', JSON.stringify(cAfter.modelRoles));
  const cRaw = rawC();
  check('AI-29 注释/块标量无损 + 长值不被折行（lineWidth:0 的实测承诺）', cRaw.includes('# 用户的头注释') && cRaw.includes('block: |') && cRaw.includes('  keep1') && new RegExp(`^longNote: ${LONG}$`, 'm').test(cRaw), cRaw.split('\n').find((l) => l.startsWith('longNote'))?.length + ' 字符仍单行');
  check('AI-29 已知让步如实钉住：空 flow 序列折叠成一行（语义等价，不假装无损）', cRaw.includes('empty: []') && Array.isArray(cAfter.empty) && cAfter.empty.length === 0 && cAfter.symbolPreset === 'unicode' && cAfter.memory.backend === 'local', cRaw.split('\n').find((l) => l.startsWith('empty')) || '');
  check('AI-30 保持原文件 mode 0600 且落备份', (statSync(MF).mode & 0o777) === 0o600 && (statSync(CF).mode & 0o777) === 0o600 && existsSync(`${CF}.own-api-bak`), `${(statSync(CF).mode & 0o777).toString(8)}`);
  const driftOmp = async () => ((await LINKS()).find((l) => l.agentId === 'omp') || {}) as any;
  check('AI-31 刚写完 drift=consistent', (await driftOmp()).drift === 'consistent', JSON.stringify((await driftOmp()).driftDetail));
  // 只改我方块内部的文本：全文 replace 会先命中 jyld（它的 api 一模一样），改到别人身上测的就不是我方域了
  const tamperOurs = (from: string, to: string) => {
    const raw = rawM();
    const i = raw.indexOf('\n  own-api:');
    writeFileSync(MF, raw.slice(0, i) + raw.slice(i).replace(from, to));
  };
  tamperOurs('api: openai-completions', 'api: anthropic-messages');
  check('AI-31 改我方声明字段 → modified', (await driftOmp()).drift === 'modified', (await driftOmp()).driftDetail);
  tamperOurs('api: anthropic-messages', 'api: openai-completions');
  writeFileSync(MF, rawM().replace('https://other.example/v1', 'https://other2.example/v1'));
  check('AI-31 改别人的 provider → 仍 consistent（域只覆盖我方声明）', (await driftOmp()).drift === 'consistent', (await driftOmp()).driftDetail);
  writeFileSync(CF, rawC().replace('  default: own-api/gpt-4o\n', ''));
  check('AI-31 合并型的 missing = 我方那些键全没了（映射还在也算 missing）', (await driftOmp()).drift === 'missing', (await driftOmp()).driftDetail);
  const oa2: any = (await APPLY(OM_BASE)).body;
  check('AI-31 重新 apply 即修复 missing（同步入口的底层能力）', oa2.status === 'success' && (await driftOmp()).drift === 'consistent', oa2.status);
  writeFileSync(CF, rawC().replace('default: own-api/gpt-4o', 'default: jyld/m1:auto'));
  const del1 = await api('/api/agents/omp', { method: 'DELETE', headers: ADMIN });
  check('AI-33 角色被用户改指别处 → 撤销 kept 且账本保留（不清账不留孤儿）', del1.body?.partial === true && del1.body?.results?.some((r: any) => r.action === 'kept') && (await driftOmp()).agentId === 'omp', JSON.stringify(del1.body?.results?.map((r: any) => [r.action, r.file?.split('/').pop()])));
  writeFileSync(CF, rawC().replace('default: jyld/m1:auto', 'default: own-api/gpt-4o'));
  const del2 = await api('/api/agents/omp', { method: 'DELETE', headers: ADMIN });
  const cBack = parseY(CF).state.data;
  check('AI-32 撤销语义=还原到「最近一次写入之前」：那次写入时 default 本不存在，故撤销是删掉它而不是凭空造值', del2.body?.ok === true && cBack.modelRoles.default === undefined && cBack.modelRoles.plan === 'jyld/m1:auto' && cBack.modelRoles.tiny === 'jyld/m1', JSON.stringify(cBack.modelRoles));
  check('AI-32 撤销只删自己的 provider 块', parseY(MF).state.data.providers['own-api'] === undefined && parseY(MF).state.data.providers.jyld.apiKey === 'sk-up-secret', JSON.stringify(Object.keys(parseY(MF).state.data.providers)));
  // 干净周期单独验 prev 真能还原（上一段中途重写覆盖了 prev 快照，测不到这条路径）
  putOmp();
  const oa3: any = (await APPLY(OM_BASE)).body;
  await api('/api/agents/omp', { method: 'DELETE', headers: ADMIN });
  const cBack2 = parseY(CF).state.data;
  check('AI-32b 干净周期：撤销把 default 逐键还原成写前的 jyld/m1，未勾选的角色一字未动', oa3.status === 'success' && cBack2.modelRoles.default === 'jyld/m1' && cBack2.modelRoles.plan === 'jyld/m1:auto' && cBack2.modelRoles.tiny === 'jyld/m1' && parseY(MF).state.data.providers['own-api'] === undefined, JSON.stringify(cBack2.modelRoles));

  mkdirSync(OM, { recursive: true });
  writeFileSync(MF, 'base: &b\n  api: openai-completions\nproviders: *b\n');
  const pa: any = (await PLAN({ agentId: 'omp', vkeyId: VK.id, model: 'gpt-4o' })).body;
  check('AI-34 托管路径落在 YAML 别名上 → plan 就拒并说清理由（不静默改到锚点公共内容）', pa.errors.some((e: string) => e.includes('别名')) && rawM().includes('providers: *b'), String(pa.errors?.[0] || '').slice(0, 90));
  writeFileSync(MF, 'providers:\n\tjyld: broken\n');
  const pb: any = (await PLAN({ agentId: 'omp', vkeyId: VK.id, model: 'gpt-4o' })).body;
  check('AI-35 坏 YAML 拒写并给出原因（不整文件重写"修好"它）', pb.errors.some((e: string) => e.includes('YAML 解析失败')) && rawM().includes('\tjyld: broken'), String(pb.errors?.[0] || '').slice(0, 80));
  const pc: any = (await PLAN({ agentId: 'omp', vkeyId: VK.id, model: 'gpt-4o', roles: ['default', '../evil', 'nope'] })).body;
  check('AI-36 未声明的角色槽名直接丢弃（槽名=目标文件里的路径段，不放开）', JSON.stringify(Object.keys(pc.steps.find((s: any) => s.kind === 'role')?.after || {})) === '["default"]', JSON.stringify(Object.keys(pc.steps.find((s: any) => s.kind === 'role')?.after || {})));

  rmSync(OM, { recursive: true, force: true });
  const of2: any = (await APPLY(OM_BASE)).body;
  check('AI-37 新装态（目录都不在）能建目录落盘，新建文件一律 0600', of2.status === 'success' && existsSync(MF) && existsSync(CF) && (statSync(MF).mode & 0o777) === 0o600 && parseY(CF).state.data.modelRoles.default === 'own-api/gpt-4o', JSON.stringify(of2.steps.map((s: any) => [s.state, s.ok])));
  await api('/api/agents/omp', { method: 'DELETE', headers: ADMIN });

  // ---- sync：账本驱动的「一键刷回」（漂移 / 网关换端口 / 模型清单变旧）----
  const SYNC = (id: string, b: any = {}) => api(`/api/agents/${id}/sync`, { method: 'POST', headers: ADMIN, body: JSON.stringify(b) });
  putOmp();
  await APPLY(OM_BASE);
  const mBefore = rawM();
  const sNo = await SYNC('omp', {});
  check('AI-39 sync 不带 confirm → 428 且盘上一字未动（新端点不豁免写面纪律）', sNo.status === 428 && rawM() === mBefore, `${sNo.status}`);
  tamperOurs('api: openai-completions', 'api: anthropic-messages');
  const sFix: any = await SYNC('omp', { confirm: true });
  check('AI-40 被改坏后 sync 刷回我方声明值，drift 回到 consistent（同步=账本再说一遍，不再问用户）', sFix.status === 200 && sFix.body?.drift?.state === 'consistent' && rawM().includes('api: openai-completions'), JSON.stringify(sFix.body?.drift));
  const cBeforeSync = rawC();
  writeFileSync(CF, rawC().replace('default: own-api/gpt-4o', 'default: jyld/m1'));
  check('AI-40b 我方角色值被改走 → modified（修复前这条永远看不见：合并型的聚合指纹域曾是空数组，指纹塌成常量）', (await driftOmp()).drift === 'modified', (await driftOmp()).driftDetail);
  writeFileSync(CF, rawC().replace('default: jyld/m1', 'default: own-api/gpt-4o'));
  check('AI-40c 改回来就重新一致（漂移判据可逆，不是单向棘轮）', (await driftOmp()).drift === 'consistent', (await driftOmp()).driftDetail);
  const sSpoof: any = await SYNC('omp', { confirm: true, model: 'auto-m-gpt', roles: ['smol', 'plan'], agentId: 'zcode' });
  const cS = parseY(CF).state.data.modelRoles;
  check('AI-41 sync 的上下文只认账本：body 覆盖 model/roles/agentId 全部无效（否则 sync 就是第二条写入通道）', sSpoof.status === 200 && rawC() === cBeforeSync && cS.default === 'own-api/gpt-4o' && cS.smol === undefined && cS.plan === 'jyld/m1:auto', JSON.stringify(cS));
  const lB: any = (await LINKS()).find((l) => l.agentId === 'omp');
  await SYNC('omp', { confirm: true });
  const lA: any = (await LINKS()).find((l) => l.agentId === 'omp');
  check('AI-45 同步不刷新「接入于」，另记 lastSyncAt（两个时间各管各的语义）', lA.linkedAt === lB.linkedAt && lA.lastSyncAt >= lB.lastSyncAt, `${lB.linkedAt}/${lB.lastSyncAt} → ${lA.linkedAt}/${lA.lastSyncAt}`);
  const pLedger: any = (await PLAN({ agentId: 'omp' })).body;
  check('AI-44 plan 缺 vkeyId/model 时回落账本：同步预览复用同一条 plan 通路（前端不再另算一套）', pLedger.steps?.length === 2 && !pLedger.errors?.length && pLedger.steps.every((s: any) => s.state === 'noop'), JSON.stringify({ states: pLedger.steps?.map((s: any) => s.state), ledgerRoles: (await LINKS()).find((l) => l.agentId === 'omp')?.roles, errs: pLedger.errors }));
  const pObj: any = (await PLAN({ agentId: 'omp', vkeyId: VK.id, model: 'gpt-4o', roles: { smol: 'gpt-4o' } })).body;
  check('AI-47 roles 的 {槽: 模型} 对象形态同样被认（这条分支曾因 dangling-else 从未执行过）', JSON.stringify(Object.keys(pObj.steps?.find((s: any) => s.kind === 'role')?.after || {})) === '["smol"]', JSON.stringify(Object.keys(pObj.steps?.find((s: any) => s.kind === 'role')?.after || {})));
  const sXff = await api('/api/agents/omp/sync', { method: 'POST', headers: { ...ADMIN, 'x-forwarded-for': '8.8.8.8' }, body: JSON.stringify({ confirm: true }) });
  check('AI-46 sync 也吃回环硬闸（XFF 伪装 → 403，不因为是「只是同步」就放行）', sXff.status === 403, String(sXff.status));
  const vkLim: any = (await api('/api/vkeys', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'ai-sync-lim', allowedModels: ['gpt-4o'] }) })).body;
  await APPLY({ agentId: 'zcode', vkeyId: vkLim.id, model: 'gpt-4o' });
  await api(`/api/vkeys/${vkLim.id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ enabled: false }) });
  const sOff: any = await SYNC('zcode', { confirm: true });
  check('AI-42 账本里的 key 已停用 → 409 让人去启用，不静默写一把停用的 key', sOff.status === 409 && /停用/.test(String(sOff.body?.error)), String(sOff.body?.error));
  await api(`/api/vkeys/${vkLim.id}`, { method: 'DELETE', headers: ADMIN });
  const sGone: any = await SYNC('zcode', { confirm: true });
  check('AI-42b key 已被删除 → 409 明说「重新接入而不是同步」（不替你猜一把新 key）', sGone.status === 409 && /已被删除/.test(String(sGone.body?.error)), String(sGone.body?.error));
  await api('/api/agents/zcode', { method: 'DELETE', headers: ADMIN });
  const savedAcl = VK.allowedModels ?? null;
  await api(`/api/vkeys/${VK.id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ allowedModels: ['auto-m-gpt'] }) });
  const sModel: any = await SYNC('omp', { confirm: true });
  check('AI-43 主模型已不在这把 key 的授权内 → 409 且拒绝替用户挑新模型（悄悄换个模型写进去更糟）', sModel.status === 409 && /不在这把 key/.test(String(sModel.body?.error)) && Array.isArray(sModel.body?.allowed), String(sModel.body?.error));
  await api(`/api/vkeys/${VK.id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ allowedModels: savedAcl }) });
  await api('/api/agents/omp', { method: 'DELETE', headers: ADMIN });

  // ---- Claude Code（PR2 第二支；**未实机验证**，形态取自本机残留 ~/.claude/settings.json）----
  const CCF = join(AG, '.claude', 'settings.json');
  const putC = (obj: any) => {
    mkdirSync(dirname(CCF), { recursive: true });
    writeFileSync(CCF, JSON.stringify(obj, null, 2) + '\n');
    chmodSync(CCF, 0o644);
  };
  const rdC = () => JSON.parse(readFileSync(CCF, 'utf8'));
  const rawCC = () => readFileSync(CCF, 'utf8');
  // 邻居刻意留着真机那种东西：插件表、statusLine 的转义 shell、用户自己的 env 键、旧 provider 的 6 个键
  const CLAUDE_FIX = (): any => ({
    effort: 'medium',
    enableAllProjectMcpServers: true,
    enabledPlugins: { 'pua@pua-skills': true, 'superpowers@superpowers-marketplace': true },
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-OLDPROVIDER-secret',
      ANTHROPIC_BASE_URL: 'https://opencode.ai/zen/go',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash[1M]',
      ANTHROPIC_MODEL: 'deepseek-v4-flash[1M]',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    },
    model: 'deepseek-v4-flash[1M]',
    statusLine: { command: 'bash -c \'exec "/usr/bin/node" "${plugin_dir}dist/index.js"\'', type: 'command' },
    theme: 'dark',
  });
  const CL = { agentId: 'claude-code', vkeyId: VK.id, model: 'gpt-4o', roles: ['default', 'haiku'] };
  const CL_LINK = async () => ((await LINKS()).find((l) => l.agentId === 'claude-code') || {}) as any;

  putC(CLAUDE_FIX());
  const cp0 = ((await api('/api/agents', { headers: ADMIN })).body as any).adapters.find((a: any) => a.id === 'claude-code');
  check('AI-48 claude-code 被检出，requiredSlots 随 detect 交给 UI（haiku 不接管会 404，必须预勾）', cp0 && cp0.configPresent === true && cp0.roleSlots?.length === 4 && JSON.stringify(cp0.requiredSlots) === '["default","haiku"]', JSON.stringify(cp0?.requiredSlots));
  const cplan: any = (await PLAN(CL)).body;
  const cenv = cplan.steps?.find((s: any) => s.path.join('.') === 'env');
  const croot = cplan.steps?.find((s: any) => s.path.length === 0);
  check('AI-49 plan 列同文件的两个写入点（env 合并 + 顶层 model），各自 kind 正确', cplan.steps?.length === 2 && cenv?.kind === 'role' && croot?.kind === 'role' && croot?.after?.model === 'gpt-4o', JSON.stringify(cplan.steps?.map((s: any) => s.path.join('.') || '(root)')));
  check('AI-49 anthropic 协议 baseURL 不追加 /v1（真机残留的 BASE_URL 也没有 /v1，多拼一次就是首发 404）', cenv?.after?.ANTHROPIC_BASE_URL === BASE, String(cenv?.after?.ANTHROPIC_BASE_URL));
  check('AI-49 ANTHROPIC_AUTH_TOKEN 在预览里被掩码（SECRET_KEYS 认得 *_TOKEN 这种形状，明文不得出现在任何回执）', /\*/.test(String(cenv?.after?.ANTHROPIC_AUTH_TOKEN)) && !JSON.stringify(cplan).includes(VK.key), String(cenv?.after?.ANTHROPIC_AUTH_TOKEN));
  check('AI-49 beforeView 只呈现我方 claim 的键（用户的 HTTPS_PROXY 不该混进 diff 让人以为要动它）', cenv?.before?.HTTPS_PROXY === undefined && cenv?.before?.ANTHROPIC_MODEL === 'deepseek-v4-flash[1M]', JSON.stringify(cenv?.before));
  const cwNoHaiku: any = (await PLAN({ agentId: 'claude-code', vkeyId: VK.id, model: 'gpt-4o', roles: ['default'] })).body;
  check('AI-50 没接管 haiku → 提示它会拿没登记的模型名打网关；接管了但等于主模型 → 换一条提示', cwNoHaiku.warnings?.some((w: string) => w.includes('haiku') && w.includes('未登记')) && cplan.warnings?.some((w: string) => w.includes('更便宜')), JSON.stringify([cwNoHaiku.warnings, cplan.warnings]));
  const cNoDefault: any = (await PLAN({ agentId: 'claude-code', vkeyId: VK.id, model: 'gpt-4o', roles: ['haiku'] })).body;
  check('AI-50 没接管 default 就不碰顶层 model（那是用户的默认模型，接管了 default 才跟着走）', cNoDefault.steps?.length === 1 && cNoDefault.steps[0].path.join('.') === 'env', JSON.stringify(cNoDefault.steps?.map((s: any) => s.path.join('.') || '(root)')));

  const ca: any = (await APPLY(CL)).body;
  const ccdAfter = rdC();
  check('AI-51 apply 写满我方 env 键并改顶层 model', ca.status === 'success' && ccdAfter.env.ANTHROPIC_BASE_URL === BASE && ccdAfter.env.ANTHROPIC_MODEL === 'gpt-4o' && ccdAfter.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'gpt-4o' && ccdAfter.model === 'gpt-4o', JSON.stringify(ccdAfter.env));
  check('AI-51 merge-only：用户的 HTTPS_PROXY、插件表、statusLine 的 shell 命令一字未动', ccdAfter.env.HTTPS_PROXY === 'http://127.0.0.1:7890' && Object.keys(ccdAfter.enabledPlugins).length === 2 && ccdAfter.statusLine.command.includes('${plugin_dir}dist/index.js') && ccdAfter.theme === 'dark' && ccdAfter.effort === 'medium', JSON.stringify(ccdAfter.statusLine).slice(0, 40));
  check('AI-51 顶层只动了 model：角色名不得变成 settings.json 根上的垃圾键（曾真写出 default/haiku 两根键，就是这么漏的）', JSON.stringify(Object.keys(ccdAfter).sort()) === JSON.stringify(Object.keys(CLAUDE_FIX()).sort()), JSON.stringify(Object.keys(ccdAfter)));
  const caNoRoleKey = rdC().env;
  check('AI-51 角色值只落在 env 里（roleKey 映射生效，不是把槽名当键名写）', caNoRoleKey.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'gpt-4o' && caNoRoleKey.haiku === undefined, JSON.stringify(Object.keys(caNoRoleKey)));
  const ca2: any = (await APPLY(CL)).body;
  check('AI-52 二次 apply 全 noop 且盘上字节完全相同', ca2.status === 'success' && ca2.steps.every((s: any) => s.state === 'noop') && rdC().env.ANTHROPIC_AUTH_TOKEN === ccdAfter.env.ANTHROPIC_AUTH_TOKEN, JSON.stringify(ca2.steps.map((s: any) => s.state)));
  check('AI-57 同文件两个写入点各占一个 byFile 键（键法撞车会让一半内容对漂移隐身）', Object.keys((await CL_LINK()).byFile || {}).length === 2, JSON.stringify(Object.keys((await CL_LINK()).byFile || {}).map((k) => k.split('#').pop() || '(root)')));
  const cc0 = await CL_LINK();
  check('AI-57 刚写完 drift=consistent', cc0.drift === 'consistent', `${cc0.drift} ${cc0.driftDetail || ''}`);
  const tamperC = (mut: (o: any) => void) => { const o = rdC(); mut(o); writeFileSync(CCF, JSON.stringify(o, null, 2) + '\n'); };
  tamperC((o) => { o.env.ANTHROPIC_MODEL = 'someone-else/model'; });
  check('AI-53 我方键的值被改走 → modified（聚合指纹域修复前这一条是瞎的：合并型曾塌成常量）', (await CL_LINK()).drift === 'modified', (await CL_LINK()).driftDetail);
  tamperC((o) => { o.env.ANTHROPIC_MODEL = 'gpt-4o'; o.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'user-picked'; o.theme = 'light'; });
  check('AI-53 用户自己的 env 键与无关字段增改不算漂移（域只覆盖我方声明）', (await CL_LINK()).drift === 'consistent', (await CL_LINK()).driftDetail);
  tamperC((o) => { delete o.env.ANTHROPIC_MODEL; delete o.env.ANTHROPIC_BASE_URL; delete o.env.ANTHROPIC_AUTH_TOKEN; delete o.env.ANTHROPIC_DEFAULT_HAIKU_MODEL; });
  check('AI-53 我方键全没了（env 映射还在、装着用户的 OPUS）→ missing', (await CL_LINK()).drift === 'missing', (await CL_LINK()).driftDetail);
  const ca3: any = (await APPLY(CL)).body;
  check('AI-53 重新 apply 即修回（漂移是可修状态，不是死档）', ca3.status === 'success' && (await CL_LINK()).drift === 'consistent', ca3.status);
  check('AI-58 catalogInFile:false → claude 不报「模型清单待同步」（否则拿环境变量名比 catalog 会永真）', (await CL_LINK()).catalogStale !== true, JSON.stringify((await CL_LINK()).catalogStale));
  tamperC((o) => { o.model = 'user-chosen'; o.env.ANTHROPIC_BASE_URL = 'https://somewhere.else'; });
  const csync: any = (await SYNC('claude-code', { confirm: true })).body;
  check('AI-58b 同步按钮对 claude 同样成立：只吃 confirm，同文件两个写入点一起修回，接入时刻不被改写', csync?.status === 'success' && rdC().model === 'gpt-4o' && rdC().env.ANTHROPIC_BASE_URL === BASE && (await CL_LINK()).drift === 'consistent' && (await CL_LINK()).linkedAt > 0, JSON.stringify(csync?.steps?.map((s: any) => s.state)));

  // 先回到干净的「别人写的」形态再接入：撤销还原的是**最近一次写入之前**的状态，prev 必须先有明确定义
  putC(CLAUDE_FIX());
  await APPLY(CL);
  tamperC((o) => { o.env.ANTHROPIC_MODEL = 'user-own-choice'; });
  const cdel1 = await api('/api/agents/claude-code', { method: 'DELETE', headers: ADMIN });
  const cPart = rdC();
  check('AI-55 部分键被用户改走：那一个不碰、其余照原样还原，且回执点得出名（Claude 写裸模型名，没有 own-api/ 前缀可判，靠 ownsKey 比写前值）', cdel1.body?.ok === true && cPart.env.ANTHROPIC_MODEL === 'user-own-choice' && cPart.env.ANTHROPIC_BASE_URL === 'https://opencode.ai/zen/go' && cPart.env.ANTHROPIC_AUTH_TOKEN === 'sk-OLDPROVIDER-secret' && String(cdel1.body?.results?.map((r: any) => r.reason).join()).includes('未动'), JSON.stringify(cPart.env));
  check('AI-55 残留下来的已经不是我们的东西 → 账本清掉（留着只会让 UI 挂一条名不副实的接入）', (await CL_LINK()).agentId === undefined, JSON.stringify(await CL_LINK()));

  const cbase = CLAUDE_FIX();
  cbase.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'user-picked'; // 用户自己加的邻居键，长得像我们的但从来不是
  putC(cbase);
  await APPLY(CL);
  const cdel2 = await api('/api/agents/claude-code', { method: 'DELETE', headers: ADMIN });
  const ccdBack = rdC();
  check('AI-54 撤销逐键还原写前值：旧 provider 的 URL/token/模型名连同顶层 model 一起回去，无关字段不碰', cdel2.body?.ok === true && ccdBack.env.ANTHROPIC_MODEL === 'deepseek-v4-flash[1M]' && ccdBack.env.ANTHROPIC_BASE_URL === 'https://opencode.ai/zen/go' && ccdBack.env.ANTHROPIC_AUTH_TOKEN === 'sk-OLDPROVIDER-secret' && ccdBack.model === 'deepseek-v4-flash[1M]' && ccdBack.env.HTTPS_PROXY === 'http://127.0.0.1:7890', JSON.stringify(ccdBack.env));
  check('AI-54 用户自己加的 OPUS 槽必须活着（我们只声明过 default/haiku，撤销不许顺手清理「看着像我们的」键）', ccdBack.env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'user-picked' && Object.keys(ccdBack.enabledPlugins).length === 2, JSON.stringify(Object.keys(ccdBack.env)));

  rmSync(CCF, { force: true });
  const cfresh: any = (await APPLY(CL)).body;
  check('AI-59 claude 全新装态（settings.json 不存在）能建文件，且默认 0600', cfresh.status === 'success' && existsSync(CCF) && (statSync(CCF).mode & 0o777) === 0o600 && rdC().env.ANTHROPIC_MODEL === 'gpt-4o', JSON.stringify(cfresh.steps.map((s: any) => s.state)));
  await api('/api/agents/claude-code', { method: 'DELETE', headers: ADMIN });

  // 作者级守卫：把 omp 的 roleTarget 摘掉，角色就无人承接——计划必须拒绝、apply 必须不落盘
  const ompA = ai.getAdapter('omp')!;
  const broken: any = { ...ompA, extra: () => [{ rel: ['.omp', 'agent', 'config.yml'], format: 'yaml', path: ['modelRoles'], merge: true, writtenKeys: [], removable: true }] };
  const bctx: any = { home: AG, baseUrl: BASE, apiKey: VK.key, model: 'gpt-4o', protocol: 'openai', models: [{ id: 'gpt-4o' }], roles: { default: 'gpt-4o' } };
  const beforeYml = existsSync(CF) ? readFileSync(CF, 'utf8') : '';
  const bplan = ai.planLink(broken, bctx);
  const bapply = ai.applyLink(broken, bctx);
  check('AI-60 角色无人承接（roleTarget 缺失）→ 计划报错、apply 拒绝，config.yml 一字节没动', bplan.errors.some((e: string) => e.includes('roleTarget')) && bapply.status === 'failed' && (existsSync(CF) ? readFileSync(CF, 'utf8') : '') === beforeYml, JSON.stringify(bplan.errors));

  // ---- dsh（第四支；规格取自**本机正在运行的 v0.1.5-rc.2 实现**，逐字段核实见 §4.4）----
  const DSF = join(AG, '.dsh', 'settings.yaml');
  const DCF = join(AG, '.dsh', '.credentials.yaml');
  // 邻居照真机那样留：头注释、provider 里的行尾注释、别人的 provider、非模型 namespace、指针指向别家
  // 同名但指向别处的 own-api 条目：§9-4 规定「同 id 不是我们的形态」一律拒覆盖，单列一条钉（AI-62a）
  const DSH_FOREIGN = `    own-api:
      displayName: own-api
      apiKeyEnv: OWN_API_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:9999/v1
      models:
        - id: stale-model
          name: stale-model
`;
  const dshSettings = (extra = '') => `# 用户自己的注释：这一份文件 dsh 也会改，别动我没说的
llm-pi-ai:
  providers:
    jyld:
      displayName: jyld
      apiKeyEnv: JYLD_API_KEY
      api: openai-completions
      baseURL: https://tokenrhythm.studio/v1
      models:
        - id: glm-5.3-flash   # 行尾注释也是用户的
          name: glm-5.3-flash
${extra}agent-default-model:
  provider: jyld
  model: glm-5.3-flash
ui-theme:
  fontSize: 16
`;
  const DSH_CREDS_FIX = `version: 1
refs:
  JYLD_API_KEY: jyld-old-secret
  OWN_API_API_KEY: old-own-api-key
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: grant-secret-keep
`;
  const putDsh = (extra = '') => {
    mkdirSync(join(AG, '.dsh'), { recursive: true });
    writeFileSync(DSF, dshSettings(extra));
    chmodSync(DSF, 0o600);
    writeFileSync(DCF, DSH_CREDS_FIX);
    chmodSync(DCF, 0o600);
  };
  const rdDsh = () => parseY(DSF).state.data;
  const rdDc = () => parseY(DCF).state.data;
  /** 文本锚点改盘：dsh 会自己写这份文件，漂移测试要模拟的就是「它改了两段指针」 */
  const tamperD = (from: string, to: string) => {
    const raw = readFileSync(DSF, 'utf8');
    if (!raw.includes(from)) throw new Error('tamperD 锚点不存在：' + from);
    writeFileSync(DSF, raw.replace(from, to));
  };
  const D = { agentId: 'dsh', vkeyId: VK.id, model: 'gpt-4o', roles: ['default'] };
  const D_LINK = async () => ((await LINKS()).find((l) => l.agentId === 'dsh') || {}) as any;

  putDsh();
  rmSync(DCF, { force: true }); // 凭据库不存在的形态
  const dNoCreds: any = (await PLAN(D)).body;
  const settingsBefore = readFileSync(DSF, 'utf8');
  const dNoCredsApply = await APPLY(D);
  check('AI-61 凭据库不存在 → 拒写并说清为什么（那是 dsh 自己的版本化文档，我们不替它发明格式），settings.yaml 一字节没动', dNoCreds.errors?.some((e: string) => e.includes('.credentials.yaml')) && dNoCredsApply.body?.status === 'failed' && readFileSync(DSF, 'utf8') === settingsBefore, JSON.stringify(dNoCreds.errors));
  const dshAd: any = ai.ADAPTERS.find((a: any) => a.id === 'dsh');
  const dHomeBak = process.env.DSH_HOME;
  const dInjBak = process.env.OWN_API_AGENT_HOME;
  delete process.env.OWN_API_AGENT_HOME; // 注入根豁免生效与否，只能在进程内直调 preflight 里验
  process.env.DSH_HOME = '/tmp/yet-another-dsh-home';
  const dEnvErrs = dshAd.preflight({ home: homedir() });
  process.env.DSH_HOME = join(homedir(), '.dsh'); // 官方默认位置：等价于没设，不该拦
  const dEnvOk = dshAd.preflight({ home: homedir() });
  if (dHomeBak === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = dHomeBak;
  if (dInjBak !== undefined) process.env.OWN_API_AGENT_HOME = dInjBak;
  check('AI-61b DSH_HOME 指向别处 → 拒绝（往错位置写 dsh 配置比不写糟得多）；指回默认位置或与 <home>/.dsh 相等就放行', dEnvErrs.some((e: string) => e.includes('DSH_HOME')) && !dEnvOk.some((e: string) => e.includes('DSH_HOME')), JSON.stringify([dEnvErrs, dEnvOk]));
  putDsh(DSH_FOREIGN);
  const dForeign: any = (await PLAN(D)).body;
  const dForeignApply = await APPLY(D);
  check('AI-62a 同名 own-api 指向别处（换过端口的旧接入也算）→ 拒覆盖，并把现值印出来（§9-4，dsh 继承该规则）', dForeign.errors?.some((e: string) => e.includes('http://127.0.0.1:9999/v1')) && !dForeign.steps?.some((s: any) => s.path.join('.').includes('own-api')) && dForeignApply.body?.status === 'failed' && readFileSync(DSF, 'utf8').includes('http://127.0.0.1:9999/v1'), JSON.stringify(dForeign.errors));
  putDsh();
  const dplan: any = (await PLAN(D)).body;
  const dBlock = dplan.steps?.find((s: any) => s.path.join('.') === 'llm-pi-ai.providers.own-api');
  const dRefs = dplan.steps?.find((s: any) => s.path.join('.') === 'refs');
  const dPtr = dplan.steps?.find((s: any) => s.path.join('.') === 'agent-default-model');
  check('AI-62 三个写入点各就各位：provider 块（块型）+ 凭据 refs（合并）+ 默认模型指针（合并），kind 不混', dplan.steps?.length === 3 && dBlock?.kind === 'block' && dRefs?.kind === 'role' && dPtr?.kind === 'role', JSON.stringify(dplan.steps?.map((s: any) => s.path.join('.') + ':' + s.kind)));
  check('AI-62 blockKeys 切分生效：provider 块里不得混进凭据引用与默认模型指针（整包吞 built 就会写出来）', JSON.stringify(Object.keys(dBlock?.after || {}).sort()) === JSON.stringify(['api', 'apiKeyEnv', 'baseURL', 'displayName', 'models']), JSON.stringify(Object.keys(dBlock?.after || {})));
  check('AI-62 baseURL 走 openai 拼法带 /v1；apiKeyEnv 只是引用名，明文 key 恒不进 settings 那一侧', dBlock?.after?.baseURL === BASE + '/v1' && dBlock?.after?.apiKeyEnv === 'OWN_API_API_KEY' && !JSON.stringify(dBlock).includes(VK.key), JSON.stringify(dBlock?.after));
  check('AI-62 凭据那格在预览里被掩码（OWN_API_API_KEY 以 _KEY 结尾，SECRET_KEYS 认得；明文只许落进 0600 的密码本）', /\*/.test(String(dRefs?.after?.OWN_API_API_KEY)) && !JSON.stringify(dplan).includes(VK.key), String(dRefs?.after?.OWN_API_API_KEY));
  check('AI-62 指针的 before 是别人家的默认（provider=jyld），改它必须先在预览里看见', dPtr?.before?.provider === 'jyld' && dplan.warnings?.some((w: string) => w.includes('默认模型')), JSON.stringify([dPtr?.before, dplan.warnings?.length]));

  const da: any = (await APPLY(D)).body;
  const dAfter = rdDsh();
  const dCreds = rdDc();
  check('AI-63 apply 写满三处：provider 块、refs 我们那一格、默认模型指针两段', da.status === 'success' && dAfter['llm-pi-ai'].providers['own-api'].baseURL === BASE + '/v1' && dCreds.refs.OWN_API_API_KEY === VK.key && dAfter['agent-default-model'].provider === 'own-api' && dAfter['agent-default-model'].model === 'gpt-4o', JSON.stringify(dAfter['agent-default-model']));
  check('AI-63 catalog 投影只在路由登记了窗口才写数字（不拿 128k 冒充用户真实窗口）', Array.isArray(dAfter['llm-pi-ai'].providers['own-api'].models) && dAfter['llm-pi-ai'].providers['own-api'].models.every((m: any) => m.id && m.name === m.id), JSON.stringify(dAfter['llm-pi-ai'].providers['own-api'].models));
  check('AI-64 merge-only：别人的 provider、行尾注释、头注释、非模型 namespace 全部原样', readFileSync(DSF, 'utf8').includes('# 用户自己的注释') && readFileSync(DSF, 'utf8').includes('# 行尾注释也是用户的') && dAfter['llm-pi-ai'].providers.jyld.baseURL === 'https://tokenrhythm.studio/v1' && dAfter['ui-theme'].fontSize === 16, '邻居被碰');
  check('AI-64 凭据库只动我们那一格：别人的 ref、records 授权、version 全部活着', dCreds.refs.JYLD_API_KEY === 'jyld-old-secret' && dCreds.records['client-connection/browser-session'].payload.secret === 'grant-secret-keep' && dCreds.version === 1 && Object.keys(dCreds.refs).length === 2, JSON.stringify(Object.keys(dCreds)));
  check('AI-64 两个文件的 0600 都必须保住——dsh 见到多用户可读的凭据库会拒绝加载', (statSync(DSF).mode & 0o777) === 0o600 && (statSync(DCF).mode & 0o777) === 0o600, `settings ${(statSync(DSF).mode & 0o777).toString(8)} creds ${(statSync(DCF).mode & 0o777).toString(8)}`);
  const da2: any = (await APPLY(D)).body;
  check('AI-65 二次 apply 全 noop（含凭据库：同值不重写）', da2.status === 'success' && da2.steps.every((s: any) => s.state === 'noop'), JSON.stringify(da2.steps.map((s: any) => s.state)));
  check('AI-65 刚写完 drift=consistent', (await D_LINK()).drift === 'consistent', (await D_LINK()).driftDetail);
  tamperD('provider: own-api', 'provider: jyld');
  tamperD('model: gpt-4o', 'model: glm-5.3-flash');
  check('AI-66 用户在 dsh 里自己换了默认模型 → modified（这是真信号：dsh 会写这同一格）', (await D_LINK()).drift === 'modified', (await D_LINK()).driftDetail);
  const dsync: any = (await SYNC('dsh', { confirm: true })).body;
  check('AI-66b 同步按账本把默认模型刷回 own-api（同一格两个键一起回）', dsync?.status === 'success' && rdDsh()['agent-default-model'].provider === 'own-api' && rdDsh()['agent-default-model'].model === 'gpt-4o' && (await D_LINK()).drift === 'consistent', JSON.stringify(dsync?.steps?.map((s: any) => s.state)));
  tamperD('displayName: jyld', 'displayName: jyld-renamed');
  tamperD('fontSize: 16', 'fontSize: 20');
  check('AI-66c 别人家与无关 namespace 的改动不算漂移', (await D_LINK()).drift === 'consistent', (await D_LINK()).driftDetail);
  const dNoDefault: any = (await PLAN({ agentId: 'dsh', vkeyId: VK.id, model: 'gpt-4o', roles: [] })).body;
  check('AI-68 不接管 default 就完全不碰 agent-default-model（那是用户每次新建 agent 的起点）', dNoDefault.steps?.length === 2 && !JSON.stringify(dNoDefault.steps).includes('agent-default-model'), JSON.stringify(dNoDefault.steps?.map((s: any) => s.path.join('.'))));
  const dd = await api('/api/agents/dsh', { method: 'DELETE', headers: ADMIN });
  const dBack = rdDsh();
  const dCredsBack = rdDc();
  const d67 = [dd.body?.ok === true, dBack['llm-pi-ai'].providers['own-api'] === undefined, dBack['llm-pi-ai'].providers.jyld !== undefined, dBack['agent-default-model'].provider === 'jyld', dBack['agent-default-model'].model === 'glm-5.3-flash'];
  check('AI-67 撤销：块型那一格整块摘除（块型无 prev 可还原，兜底是 .bak）、指针逐键回到 jyld、别人家 provider 还在', d67.every(Boolean), `ok/块摘除/邻居在/指针provider/指针model → ${JSON.stringify(d67)}`);
  check('AI-67b noop 不抹掉上一轮的写前值：sync 没动凭据那格，撤销仍还原成用户最早那把 key（不是我们那把）', dCredsBack.refs.OWN_API_API_KEY === 'old-own-api-key', String(dCredsBack.refs.OWN_API_API_KEY));
  check('AI-67 别人的东西一个没少（jyld 的 ref 与 records 授权仍在，文件仍 0600）', dCredsBack.refs.JYLD_API_KEY === 'jyld-old-secret' && !!dCredsBack.records && (statSync(DCF).mode & 0o777) === 0o600 && (await D_LINK()).agentId === undefined, JSON.stringify(Object.keys(dCredsBack)));
  // 真机形状（彩排里踩到的）：用户自己早就把 own-api 指着我们同端口，第一轮 apply 指针那格就是 noop
  writeFileSync(DSF, `llm-pi-ai:
  providers:
    own-api:
      displayName: own-api
      api: openai-completions
      baseURL: ${BASE}/v1
      apiKeyEnv: OWN_API_API_KEY
      defaultInput: [ text, image ]
      models:
        - id: gpt-4o
          name: gpt-4o
          input: [ text ]
agent-default-model:
  provider: own-api
  model: gpt-4o
ui-theme:
  fontSize: 16
`);
  const dAlready: any = (await APPLY(D)).body;
  check('AI-67e 块型整块覆盖前，先点名我们会吞掉哪些不托管字段（真机里那是用户手写的 defaultInput）', (dAlready.plan?.warnings || []).some((w: string) => w.includes('defaultInput') && w.includes('.own-api-bak')), JSON.stringify(dAlready.plan?.warnings));
  const dPtrStep = (dAlready.plan?.steps || []).find((s: any) => s.path.join('.') === 'agent-default-model');
  check('AI-67c 用户早就自己指着 own-api/gpt-4o → 指针那格判 noop（不假装做过事，但仍要记它归我们）', dAlready.status === 'success' && dPtrStep?.state === 'noop', JSON.stringify(dPtrStep?.state));
  await api('/api/agents/dsh', { method: 'DELETE', headers: ADMIN });
  const dPtrBack = parseY(DSF).state.data['agent-default-model'];
  check('AI-67d noop 过的合并写入点撤销时放回原值，不留下空映射（撤销是还原，不是删形状）', dPtrBack?.provider === 'own-api' && dPtrBack?.model === 'gpt-4o', JSON.stringify(dPtrBack));
  // 网关换端口（sync 的卖点之一）：请求 Host 就是新地址，旧块写的还是旧端口
  putDsh();
  await APPLY(D);
  // 派生基址取自请求的 Host 头，而 undici（global fetch）会吞掉手工设置的 Host——实测过：换 Host 打过去，
  // 服务端看到的还是原端口，于是「同步成功」其实是一次 noop。要真模拟换端口，得走认 Host 的 node:http。
  const portSync = (host: string) =>
    new Promise<any>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: Number(BASE.split(':')[2]), path: '/api/agents/dsh/sync', method: 'POST', headers: { ...ADMIN, Host: host } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d) });
          } catch {
            resolve({ status: res.statusCode, body: d });
          }
        });
      });
      req.on('error', reject);
      req.end('{"confirm":true}');
    });
  const sPort: any = (await portSync('127.0.0.1:9999')).body;
  check('AI-70 网关换了端口 → 旧块凭账本里记的基址仍认是我们的，同步把地址刷成新端口（§15-5）', sPort?.status === 'success' && rdDsh()['llm-pi-ai'].providers['own-api'].baseURL === 'http://127.0.0.1:9999/v1' && (await D_LINK()).baseUrl === 'http://127.0.0.1:9999', JSON.stringify([sPort?.status, sPort?.plan?.errors]));
  tamperD('baseURL: http://127.0.0.1:9999/v1', 'baseURL: https://someone-else.example/v1');
  const sSteal: any = (await SYNC('dsh', { confirm: true })).body;
  check('AI-70b 放松只放松到「账本证明的那一份」：盘上现值指向第三家 → 照旧拒覆盖（§9-4 没被放宽成抢别人）', sSteal?.status === 'failed' && readFileSync(DSF, 'utf8').includes('https://someone-else.example/v1'), JSON.stringify(sSteal?.plan?.errors || sSteal?.status));
  await api('/api/agents/dsh', { method: 'DELETE', headers: ADMIN, body: JSON.stringify({ force: true }) });

  putDsh();
  chmodSync(DSF, 0o644); // 用户的文件是 0644：我们不替他收紧
  await APPLY(D);
  check('AI-69 备份是同一份明文的第二副本，权限一律收紧 0600——但源文件宽是用户的选择，不动它', (statSync(DSF).mode & 0o777) === 0o644 && (statSync(`${DSF}.own-api-bak`).mode & 0o777) === 0o600, `源 ${(statSync(DSF).mode & 0o777).toString(8)}｜bak ${(statSync(`${DSF}.own-api-bak`).mode & 0o777).toString(8)}`);
  await api('/api/agents/dsh', { method: 'DELETE', headers: ADMIN, body: JSON.stringify({ force: true }) });
  rmSync(join(AG, '.dsh'), { recursive: true, force: true });

  // key 明文取不到那条分支放在最后：它要删掉 VK，之后的钉子就没 key 可用了
  putC(cbase);
  await APPLY(CL);
  await api(`/api/vkeys/${VK.id}`, { method: 'DELETE', headers: ADMIN }); // key 没了 → token 无从比对
  const ck = await api('/api/agents/claude-code', { method: 'DELETE', headers: ADMIN });
  check('AI-56 key 已删 → AUTH_TOKEN 判为「查不了」而不是「不是我们的」：kept + 账本留着，不赌归属', ck.body?.partial === true && rdC().env.ANTHROPIC_AUTH_TOKEN === VK.key && String(ck.body?.results?.map((r: any) => r.reason).join()).includes('无法确认归属'), JSON.stringify(ck.body?.results));
  check('AI-56 三态不是一刀切冻结整份文件：同文件里认得出的键该还原照旧还原', rdC().env.ANTHROPIC_MODEL === 'deepseek-v4-flash[1M]' && rdC().model === 'deepseek-v4-flash[1M]', JSON.stringify([rdC().env.ANTHROPIC_MODEL, rdC().model]));
  await api('/api/agents/claude-code?force=1', { method: 'DELETE', headers: ADMIN });
  putC(CLAUDE_FIX());

  // 指纹算法稳定性：键法一旦被改，老用户账本里存的指纹全体对不上 → 升级即全员误报「被改」。
  // golden 由本轮实现算出并焊死（PR1→PR2 之间 zcode 的域与 fingerprintOf 主体未动，故值不变）。
  const goldenKeys = ai.getAdapter('zcode')!.targets[0].writtenKeys;
  const goldenBlk = { options: { apiKey: 'sk-x', baseURL: 'http://127.0.0.1:8787/v1' }, models: { a: { limit: { context: 100 } } } };
  check('AI-38 zcode 指纹 golden（动指纹域必红，逼你连带处理老账本迁移）', ai.fingerprintOf(goldenBlk, goldenKeys) === 'sha256:d473619fd5da43af55ecaa4bffa22819be761d8aa5e0b6e107b965a2ffd4ca38', ai.fingerprintOf(goldenBlk, goldenKeys));
  check('AI-38 域外字段不进指纹（agent 给块补 modalities 后仍同指纹，§6.5 的立论前提）', ai.fingerprintOf({ ...goldenBlk, models: { a: { limit: { context: 100 }, modalities: ['text'] } } }, goldenKeys) === ai.fingerprintOf(goldenBlk, goldenKeys), '域外增字段');

  const nowOmpMt = ['models.yml', 'config.yml'].map((f) => { const p = join(realOmp, f); return existsSync(p) ? statSync(p).mtimeMs : -1; });
  const nowClaudeMt = existsSync(realClaude) ? statSync(realClaude).mtimeMs : -1;
  const nowDsh = ['.dsh/settings.yaml', '.dsh/.credentials.yaml'].map((f) => { const p = join(homedir(), f); return existsSync(p) ? statSync(p).mtimeMs : -1; });
  check('AI-0b 真实 HOME 的 zcode / omp / claude / **dsh** 配置全程未被本轮测试碰过（dsh 就是跑着测试的这个进程，写坏等于自毁）', (existsSync(realZ) ? statSync(realZ).mtimeMs : -1) === realMtime && JSON.stringify(nowOmpMt) === JSON.stringify(realOmpMt) && nowClaudeMt === realClaudeMt && JSON.stringify(nowDsh) === JSON.stringify(realDsh), `zcode ${realMtime} → ${existsSync(realZ) ? statSync(realZ).mtimeMs : -1}｜omp ${JSON.stringify(realOmpMt)} → ${JSON.stringify(nowOmpMt)}｜claude ${realClaudeMt} → ${nowClaudeMt}｜dsh ${JSON.stringify(realDsh)} → ${JSON.stringify(nowDsh)}`);
  if (savedHome === undefined) delete process.env.OWN_API_AGENT_HOME;
  else process.env.OWN_API_AGENT_HOME = savedHome;
  rmSync(AG, { recursive: true, force: true });
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
