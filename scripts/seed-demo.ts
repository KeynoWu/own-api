/**
 * 灌一份演示数据（指向本地 mock 上游），方便直接打开管理台看效果。
 *   终端 A: npm run mock
 *   终端 B: npm start
 *   终端 C: npm run seed
 */
const BASE = process.env.LLM_BASE || 'http://127.0.0.1:8787';
const TOKEN = process.env.LLM_ADMIN_TOKEN || 'demo-token';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:8099/v1';

const call = async (path: string, opt: any = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...opt, headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN, ...(opt.headers || {}) } });
  const txt = await res.text();
  let body: any;
  try {
    body = txt ? JSON.parse(txt) : {};
  } catch {
    body = { raw: txt };
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
};

const main = async () => {
  const health = await call('/healthz').catch(() => null);
  if (!health) throw new Error(`网关未启动（${BASE}）。先执行 npm start`);

  const existing = await call('/api/channels');
  const mk = async (body: any) => {
    if (existing.some((c: any) => c.name === body.name)) return existing.find((c: any) => c.name === body.name);
    return call('/api/channels', { method: 'POST', body: JSON.stringify(body) });
  };

  const oa = await mk({
    name: 'Mock OpenAI',
    protocol: 'openai',
    baseUrl: MOCK,
    keys: [{ key: 'k-401-bad' }, { key: 'k-429-rate' }, { key: 'k-ok-main' }].map((k) => ({ key: k.key })),
  });
  const an = await mk({
    name: 'Mock Claude',
    protocol: 'anthropic',
    baseUrl: MOCK,
    keys: [{ key: 'k-ok-claude' }],
  });

  const models = await call('/api/models');
  const addModel = async (body: any) => {
    if (models.some((m: any) => m.publicName === body.publicName)) return;
    await call('/api/models', { method: 'POST', body: JSON.stringify(body) });
    console.log(`  + 模型 ${body.publicName} → ${body.upstreamModel}`);
  };
  await addModel({ publicName: 'gpt-4o', channelId: oa.id, upstreamModel: 'mock-gpt-5', priceInput: 2.5, priceOutput: 10, contextWindow: 128000, maxOutputTokens: 16000 });
  await addModel({ publicName: 'gpt-mini', channelId: oa.id, upstreamModel: 'mock-gpt-mini', priceInput: 0.15, priceOutput: 0.6 });
  await addModel({ publicName: 'claude-sonnet', channelId: an.id, upstreamModel: 'mock-claude-sonnet', priceInput: 3, priceOutput: 15, contextWindow: 200000, maxOutputTokens: 8192 });

  // 打几发请求，让概览页/日志页有数据
  const vk = (await call('/api/vkeys?reveal=1'))[0];
  const hit = async (model: string, stream = false) => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${vk.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: stream ? '流式演示' : '你好，演示一下' }] }),
    });
    if (stream) await res.text();
    return res.status;
  };
  for (const m of ['gpt-4o', 'claude-sonnet', 'gpt-mini']) {
    console.log(`  · ${m} 非流式 -> ${await hit(m)}`);
    console.log(`  · ${m} 流式   -> ${await hit(m, true)}`);
  }

  const snip = await call('/api/snippet');
  console.log(`\n演示数据就绪。统一入口：${snip.baseUrl}/v1`);
  console.log(`统一 Key：${snip.key}`);
  console.log(`管理台：  ${snip.baseUrl}/  （令牌 ${TOKEN}）\n`);
  console.log('试一试：');
  console.log(snip.curl);
  console.log(`\n换模型只需改 model 字段：`);
  console.log(`curl ${snip.baseUrl}/v1/chat/completions -H "Authorization: Bearer ${snip.key}" -H "content-type: application/json" -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"换个模型试试"}]}'`);
};

main().catch((e) => {
  console.error(`\n${e.message}\n\n提示：需要 npm run mock 与 npm start 都在运行，且 LLM_ADMIN_TOKEN 与网关一致（当前 ${TOKEN}）。`);
  process.exit(1);
});
