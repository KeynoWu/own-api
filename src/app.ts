import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAdmin } from './admin.ts';
import { ENTRYPOINTS, estimateInputTokens, extractClientKey, gateway, listModels } from './gateway.ts';
import { store } from './store.ts';
import { admitRequest } from './usage.ts';

export function createApp() {
  const app = new Hono();
  // 全局兜底：任何漏网异常也必须回 JSON（OpenAI 风格）而不是 "Internal Server Error" 明文
  app.onError((err, c) => {
    console.error('[app] unhandled:', err);
    return c.json({ error: { message: `internal error: ${String(err?.message || err)}`, type: 'api_error', code: null, param: null } } as any, 500, { 'cache-control': 'no-store' });
  });
  // CORS：默认只放行本机来源。'*' + 全头放行会让浏览器里任意网页把本机网关当跳板，
  // 一旦 HOST=0.0.0.0 更是把管理面铺给整个局域网。需要放宽时用 LLM_CORS_ORIGIN。
  const extraOrigins = (process.env.LLM_CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return origin ?? '';
        if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return origin;
        if (extraOrigins.includes('*')) return '*';
        return extraOrigins.includes(origin) ? origin : null;
      },
      allowHeaders: ['authorization', 'x-api-key', 'content-type', 'anthropic-version', 'x-admin-token', 'x-lm-debug'],
      exposeHeaders: ['x-lm-warning', 'x-lm-retries', 'retry-after', 'x-lm-routed-to'],
      maxAge: 600,
    }),
  );

  // ---- 统一代理入口（对外只需这一组 URL + key）----
  for (const [path, { op, wire }] of Object.entries(ENTRYPOINTS)) {
    app.post(path, (c) => gateway(c, op, wire));
  }
  app.get('/v1/models', listModels);

  // Claude Code / SDK 会调它做预算估算，给个近似值即可，避免 404
  app.post('/v1/messages/count_tokens', async (c) => {
    const rawKey = extractClientKey(c);
    if (!rawKey) return c.json({ error: { type: 'authentication_error', message: 'missing api key' }, type: 'error' }, 401);
    const vk = store.findVKey(rawKey);
    if (!vk) return c.json({ error: { type: 'authentication_error', message: 'invalid api key' }, type: 'error' }, 401);
    if (!vk.enabled) return c.json({ error: { type: 'permission_error', message: 'api key disabled' }, type: 'error' }, 403);
    // 与主网关一致：先限流准入，再流式计数 body，避免无上限占用（SEC-02）
    const rl = admitRequest(vk.id);
    if (!rl.ok) return c.json({ type: 'error', error: { type: 'rate_limit_error', message: rl.reason || 'rate limited' } }, 429, rl.retryAfterSec ? { 'retry-after': String(rl.retryAfterSec) } : undefined);
    const max = store.getSettings().maxBodyBytes;
    const declared = Number(c.req.header('content-length') || 0);
    if (declared && declared > max) return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'request body too large' } }, 413);
    let rawText = '';
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.byteLength ?? 0;
        if (total > max) {
          await reader.cancel().catch(() => {});
          return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'request body too large' } }, 413);
        }
        rawText += dec.decode(value, { stream: true });
      }
      rawText += dec.decode();
    }
    let body: any;
    try {
      body = rawText ? JSON.parse(rawText) : {};
    } catch {
      body = {};
    }
    // 与网关 ①-c/预占同一估算器（M2）：system/tools/图片同口径，不再各说各话
    return c.json({ input_tokens: Math.max(1, estimateInputTokens(body)) });
  });

  // 健康检查
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      channels: store.listChannels().length,
      models: store.listModels().length,
      vkeys: store.listVKeys().length,
    }),
  );

  app.route('/api', createAdmin());

  // 管理台静态页
  app.get('/', (c) => {
    const file = join(process.cwd(), 'web', 'index.html');
    if (!existsSync(file)) return c.text('web/index.html 不存在', 500);
    return c.html(readFileSync(file, 'utf8'));
  });
  app.get('/favicon.ico', (c) => c.body(null, 204));

  return app;
}

