import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { store, maskKey, scrubSecret } from './store.ts';
import { clientIp, failureHit, failurePeek } from './ratelimit.ts';
import { forgetQuota } from './usage.ts';
import { availableKeyCount } from './pool.ts';
import { buildUrl, extractUpstreamError } from './upstream.ts';
import { buildSpeedStats, buildStats, quotaSnapshot } from './usage.ts';
import { buildBundle, buildImportPlan, applyPlan } from './config-bundle.ts';
import { clearHealth, clearHealthFor, clearSticky, healthSnapshot, stickyCount } from './auto.ts';
import type { Channel } from './types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 常数时间比较：先各自过一遍 SHA-256，连长度差异都不泄露 */
/** 连通测试错误体与 gateway 的 scrubOut 同口径：上游 echo key 时先掩码再回显（二轮建议） */
function scrubbedError(text: string, key: string, status: number) {
  const s = extractUpstreamError(text, status);
  return scrubSecret(s, key);
}

/**
 * 回环判定（R2 修订）：Host 是请求头，直连方可任意伪造——旧口径在 LAN 模式下
 * 「Host: localhost」即可收割 reveal 明文、打 shutdown/ticket 令牌校验，且不进限速桶。
 * 现在以 socket 对端为准（clientIp 已归一回环形态）；XFF/Forwarded 存在一律不算本机。
 */
function isLocalish(c: any) {
  if (c.req.header('x-forwarded-for') || c.req.header('forwarded')) return false;
  const ip = clientIp(c);
  return ip !== 'unknown' && (ip === '127.0.0.1' || ip.startsWith('127.'));
}

/**
 * 一次性交接票据（审查 A-M：长期 admin_token 进 URL fragment 会落浏览历史/同步/代理日志）。
 * 桌面壳与 openBrowser 改为：本机取票据 → URL 只带 60s 一次性票据 → 页面 POST 换回真令牌。
 */
const handoffTickets = new Map<string, number>();
/** index.ts 注入优雅停机动作（admin 不反向依赖 index） */
let shutdownHookFn: (() => void) | null = null;
export function setShutdownHook(fn: () => void) {
  shutdownHookFn = fn;
}
export function createHandoffTicket(): string {
  const now = Date.now();
  for (const [t, exp] of handoffTickets) if (exp <= now) handoffTickets.delete(t);
  const t = randomBytes(16).toString('base64url');
  handoffTickets.set(t, now + 60_000);
  return t;
}

function safeEq(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function createAdmin(): Hono {
  const app = new Hono();

  // 桌面壳优雅停机：loopback + 管理令牌双闸（豁免中间件，自带校验）
  app.post('/shutdown', async (c) => {
    if (!isLocalish(c)) return c.json({ error: 'loopback only' }, 403);
    const expect = store.getSettings().adminToken;
    // R2：豁免区不再是免计数爆破面——令牌失败进 adm 同桶同阈值
    const bucket = 'adm:' + clientIp(c);
    const block = failurePeek(bucket, 20);
    if (block.blocked) return c.json({ error: 'too many failed auth attempts' }, 429, { 'retry-after': String(block.retryAfterSec) });
    if (!expect || !safeEq(c.req.header('x-admin-token') || '', expect)) {
      if (expect) failureHit(bucket, 60_000);
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!shutdownHookFn) return c.json({ error: 'shutdown hook 未注册' }, 501);
    setTimeout(() => shutdownHookFn && shutdownHookFn(), 30); // 先让本响应冲刷出去
    return c.json({ ok: true, note: 'shutting down' });
  });
  app.get('/healthz', (c) => c.json({ ok: true })); // 就绪探针（豁免区：无鉴权、无数据）

  // 一次性票据换令牌：仅回环、60s、单次消费——注册在鉴权中间件之前（豁免）
  app.post('/auth/handoff', async (c) => {
    const local = isLocalish(c);
    const bucket = 'adm:' + clientIp(c);
    const block = local ? failurePeek(bucket, 20) : { blocked: false, retryAfterSec: 0 };
    if (block.blocked) return c.json({ error: 'too many failed auth attempts' }, 429, { 'retry-after': String(block.retryAfterSec) });
    const b = await c.req.json().catch(() => ({} as any));
    const t = typeof b?.ticket === 'string' ? b.ticket : '';
    const exp = handoffTickets.get(t);
    handoffTickets.delete(t); // 一次性：无论成败即毁
    if (!exp || exp < Date.now() || !local) {
      if (local && t) failureHit(bucket, 60_000); // 票据猜测也计数（128 位随机票不可猜，纵深防御）
      return c.json({ error: 'invalid or expired handoff ticket' }, 401);
    }
    return c.json({ token: store.getSettings().adminToken });
  });

  // 桌面壳取票端点：Rust 侧只持有令牌（last-session.json），先换一次性票据再开浏览器。
  // 审查 H2：lib.rs 发的就是这个路径，端点缺失时壳静默回退 #token=，A-M 修复在桌面路径 100% 失效
  app.post('/auth/handoff/ticket', (c) => {
    if (!isLocalish(c)) return c.json({ error: 'loopback only' }, 403);
    const expect = store.getSettings().adminToken;
    // R2：同 shutdown——豁免区令牌失败进 adm 桶并受 429 拦截
    const bucket = 'adm:' + clientIp(c);
    const block = failurePeek(bucket, 20);
    if (block.blocked) return c.json({ error: 'too many failed auth attempts' }, 429, { 'retry-after': String(block.retryAfterSec) });
    if (!expect || !safeEq(c.req.header('x-admin-token') || '', expect)) {
      if (expect) failureHit(bucket, 60_000);
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json({ ticket: createHandoffTicket() });
  });

  // ---------- 管理台鉴权 ----------
  // /logs/stream 需要 EventSource（无法带自定义头），用短期 SSE 订阅令牌代替长期 admin_token 进 URL
  const sseTickets = new Map<string, number>(); // ticket -> expiresAt
  const TICKET_TTL = 10 * 60 * 1000; // 60min → 10min（审查 A-L：SSE 票据窗口收窄，重连走 mint 接口重取）
  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const expect = store.getSettings().adminToken;
    if (!expect) {
      return c.json({ error: 'unauthorized', hint: '管理令牌未配置，请设置 LLM_ADMIN_TOKEN' }, 401);
    }
    // M0-b 语义重做：只记鉴权失败；成功不增不清（清零=给持任一合法令牌者发洗白通行证，
    // 且共享桶会被爆破者反向锁死同机合法客户端）。桶键取 socket IP：TCP 上不可伪造，
    // XFF 自报头逐请求换值即可绕开，不再采信。
    const bucket = 'adm:' + clientIp(c);
    const block = failurePeek(bucket, 20);
    if (block.blocked) return c.json({ error: 'too many failed auth attempts' }, 429, { 'retry-after': String(block.retryAfterSec) });
    if (safeEq(c.req.header('x-admin-token') || '', expect)) return next();
    // 仅 /logs/stream 允许 query 短令牌；其它路径一律要求头
    const path = c.req.path.replace(/^\/api/, '');
    if (path === '/logs/stream') {
      const ticket = c.req.query('ticket');
      const exp = ticket ? sseTickets.get(ticket) : undefined;
      if (exp && exp > Date.now()) return next();
    }
    failureHit(bucket, 60_000);
    return c.json({ error: 'unauthorized', hint: '缺少或错误的 x-admin-token' }, 401);
  });

  /** 换取短期 SSE 订阅令牌：不让长期 admin_token 拼进 URL 落进访问/代理日志 */
  app.post('/logs/stream/ticket', (c) => {
    const now = Date.now();
    for (const [t, exp] of sseTickets) if (exp <= now) sseTickets.delete(t);
    const ticket = randomBytes(16).toString('base64url');
    sseTickets.set(ticket, now + TICKET_TTL);
    return c.json({ ticket, ttlMs: TICKET_TTL });
  });

  const maskChannel = (ch: Channel, reveal: boolean) => ({
    ...ch,
    keys: ch.keys.map((k) => ({
      ...k,
      key: reveal ? k.key : maskKey(k.key),
      keyMasked: maskKey(k.key),
      cooldownLeftMs: k.cooldownUntil ? Math.max(0, k.cooldownUntil - Date.now()) : 0,
    })),
    availableKeys: availableKeyCount(ch),
    urlPreview: buildUrl(ch, ch.protocol === 'anthropic' ? 'messages' : 'chat'),
  });

  app.get('/overview', (c) => {
    const s = store.getSettings();
    const stats = buildStats(24);
    return c.json({
      channels: store.listChannels().map((ch) => ({
        id: ch.id,
        name: ch.name,
        enabled: ch.enabled,
        protocol: ch.protocol,
        keys: ch.keys.length,
        available: availableKeyCount(ch),
        cooldown: ch.keys.filter((k) => k.status === 'cooldown').length,
        disabled: ch.keys.filter((k) => k.status === 'disabled').length,
      })),
      models: store.listModels().length,
      autoRoutes: store.listAutoRoutes().length,
      autoHealth: healthSnapshot(),
      vkeys: store.listVKeys().length,
      stats,
      logs: store.db.logs.length,
      // P5(H2)：暴露保留上限，前端在日志被裁剪时挂统计截断警示（此前是静默的）
      logRetention: s.logRetention,
    });
  });

  // ---------- channels ----------
  app.get('/channels', (c) => {
    // reveal=1 仅本机回环生效：LAN 里别的路由器口不能再顺走上游 key 明文（审查 A-M）
    const reveal = c.req.query('reveal') === '1' && isLocalish(c);
    return c.json(store.listChannels().map((ch) => maskChannel(ch, reveal)));
  });

  app.post('/channels', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    if (!b.name || !b.baseUrl) return c.json({ error: 'name 与 baseUrl 必填' }, 400);
    const keys = Array.isArray(b.keys)
      ? b.keys.map((k: any) => (typeof k === 'string' ? { key: k } : k))
      : b.key
        ? [{ key: b.key }]
        : [];
    let ch;
    try {
      ch = store.createChannel({ ...b, keys });
    } catch (err: any) {
      return c.json({ error: err?.message || 'channel 创建失败' }, 400);
    }
    return c.json(maskChannel(ch, isLocalish(c)), 201);
  });

  app.patch('/channels/:id', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    let ch;
    try {
      ch = store.updateChannel(c.req.param('id'), b);
    } catch (err: any) {
      return c.json({ error: err?.message || 'channels 更新失败' }, 400);
    }
    return ch ? c.json(maskChannel(ch, isLocalish(c))) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/channels/:id', (c) => {
    const { referencedAutoRoutes, deletedModelIds } = store.deleteChannel(c.req.param('id'));
    for (const mid of deletedModelIds || []) clearHealthFor(mid);
    return c.json({ ok: true, ...(referencedAutoRoutes.length ? { warning: `级联删除的模型被 ${referencedAutoRoutes.length} 个 auto 路由引用，候选将悬空并被自动剔除`, referencedAutoRoutes } : {}) });
  });

  app.post('/channels/:id/keys', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    const items = Array.isArray(b.keys)
      ? b.keys.map((k: any) => (typeof k === 'string' ? { key: k } : k))
      : [{ key: b.key, name: b.name, weight: b.weight }];
    // R3[低5]：与 createChannel 同规——null 元素读 .key 直接 500、非串 key 在 store 里炸，这里 400 拒收
    const clean = items.filter((k: any) => !!k && typeof k === 'object' && typeof k.key === 'string' && k.key.trim() !== '');
    if (!clean.length) return c.json({ error: '无有效 key（key 需为非空字符串）' }, 400);
    const ch = store.addKeys(c.req.param('id'), clean);
    return ch ? c.json(maskChannel(ch, isLocalish(c))) : c.json({ error: 'channel not found' }, 404);
  });

  app.patch('/channels/:id/keys/:keyId', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    const ok = store.updateKey(c.req.param('id'), c.req.param('keyId'), b);
    const ch = store.getChannel(c.req.param('id'));
    if (!ch) return c.json({ error: 'channel not found' }, 404);
    if (!ok) return c.json({ error: 'key not found' }, 404); // 此前改不存在的 key 静默 200（审查 C-M2）
    return c.json(maskChannel(ch, isLocalish(c)));
  });

  app.delete('/channels/:id/keys/:keyId', (c) => {
    store.removeKey(c.req.param('id'), c.req.param('keyId'));
    return c.json({ ok: true });
  });

  /** 连通性测试：拉上游模型列表（无该接口时退化为一次最小对话） */
  app.post('/channels/:id/test', async (c) => {
    const ch = store.getChannel(c.req.param('id'));
    if (!ch) return c.json({ error: 'not found' }, 404);
    const usable = ch.keys.filter((k) => k.status !== 'disabled');
    if (!usable.length) return c.json({ error: '号池内没有启用的 key' }, 400);

    const results: any[] = [];
    for (const k of usable.slice(0, 5)) {
      const started = Date.now();
      try {
        const url = buildUrl(ch, 'models');
        const headers = new Headers();
        if (ch.protocol === 'anthropic') {
          headers.set('x-api-key', k.key);
          headers.set('anthropic-version', '2023-06-01');
        } else {
          headers.set('Authorization', `Bearer ${k.key}`);
        }
        for (const [hk, hv] of Object.entries(ch.extraHeaders || {})) headers.set(hk, hv);
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        const text = await res.text();
        let models: string[] = [];
        try {
          const j = JSON.parse(text);
          models = (j.data || j.models || []).map((m: any) => m.id || m.name).filter(Boolean).slice(0, 40);
        } catch {
          /* ignore */
        }
        // 上游多数中转没有 /models 列表接口：拉不到时，若渠道配置了 testModel，
        // 就用它打一次最小对话来判断连通，而不是一律报错。
        let ok = res.ok;
        let status = res.status;
        let error = res.ok ? undefined : scrubbedError(text, k.key, res.status);
        if ((!ok || !models.length) && ch.testModel) {
          const chatHeaders = new Headers(headers);
          chatHeaders.set('content-type', 'application/json');
          // 两种协议的最小对话体恰好相同（OpenAI 接受 max_tokens，Anthropic 必需 max_tokens）
          const chatBody = { model: ch.testModel, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };
          try {
            const chat = await fetch(buildUrl(ch, 'chat'), { method: 'POST', headers: chatHeaders, body: JSON.stringify(chatBody), signal: AbortSignal.timeout(20_000) });
            const chatText = await chat.text();
            ok = chat.ok;
            status = chat.status;
            error = chat.ok ? undefined : scrubbedError(chatText, k.key, chat.status);
          } catch (err: any) {
            ok = false;
            status = 0;
            error = String(err?.message || err);
          }
        } else if (!ok && !ch.testModel) {
          error = error || `该上游没有 /models 接口，请在渠道上填写「测试模型名」以改用对话判断连通`;
        }
        results.push({
          keyId: k.id,
          key: maskKey(k.key),
          ok,
          status,
          latencyMs: Date.now() - started,
          models,
          error,
        });
      } catch (err: any) {
        results.push({ keyId: k.id, key: maskKey(k.key), ok: false, status: 0, latencyMs: Date.now() - started, error: String(err?.message || err) });
      }
    }
    return c.json({ channelId: ch.id, name: ch.name, results });
  });

  /** 从上游模型列表里挑选并批量建路由 */
  app.post('/channels/:id/import-models', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    const ch = store.getChannel(c.req.param('id'));
    if (!ch) return c.json({ error: 'not found' }, 404);
    const usable = ch.keys.find((k) => k.status !== 'disabled');
    if (!usable) return c.json({ error: '没有可用 key' }, 400);
    const names: string[] = Array.isArray(b.models) ? b.models : [];
    const created: any[] = [];
    const skipped: string[] = [];
    for (const name of names) {
      const finalName = b.prefix ? `${b.prefix}${name}` : name;
      // M3+C3（二轮）：只查最终落库名——查"未加前缀的上游真名"会把前缀导入的主场景
      // （多渠道同名模型）整体误杀；撞名项进 skipped 回执，不再静默丢弃
      if (store.findModelByName(finalName) || store.findAutoRouteByName(finalName)) {
        skipped.push(finalName);
        continue;
      }
      const { model, error: mkErr } = store.createModel({
        publicName: finalName,
        channelId: ch.id,
        upstreamModel: name,
        protocol: ch.protocol,
      });
      if (!model) {
        // 单表撞名校验兜底（tag 遮蔽等预检查不覆盖的边角）：与真撞名同走 skipped 回执
        skipped.push(finalName);
        continue;
      }
      created.push(model);
    }
    return c.json({ created: created.length, models: created, skipped });
  });

  // ---------- routes（v3 统一路由表：type: 'single' | 'auto'，模块合并） ----------
  const enrichRoute = (r: any, snap: any[]): any =>
    r.type === 'single'
      ? { ...r, channelName: store.getChannel(r.channelId)?.name || '(渠道已删除)', channelProtocol: store.getChannel(r.channelId)?.protocol }
      : {
          ...r,
          candidates: r.candidates.map((cd: any) => {
            const m = store.getModel(cd.routeId);
            const ch = m ? store.getChannel(m.channelId) : undefined;
            return {
              ...cd,
              name: m?.publicName,
              upstreamModel: m?.upstreamModel,
              routeEnabled: m?.enabled,
              channelName: ch?.name,
              channelEnabled: ch?.enabled,
              dangling: !m,
              health: snap.find((h) => h.routeId === cd.routeId)?.health ?? 1,
              healthDetail: snap.find((h) => h.routeId === cd.routeId),
            };
          }),
        };
  app.get('/routes', (c) => {
    const type = c.req.query('type');
    if (type !== undefined && type !== 'single' && type !== 'auto') return c.json({ error: "type 需为 'single' 或 'auto'" }, 400);
    const snap = healthSnapshot();
    const all = store.listRoutes();
    return c.json((type ? all.filter((r) => r.type === type) : all).map((r) => enrichRoute(r, snap)));
  });

  app.post('/routes', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    if (b.type === 'auto') {
      const { auto, error } = store.createAutoRoute(b);
      if (error) return c.json({ error }, 400);
      return c.json(auto, 201);
    }
    if (b.type !== 'single') return c.json({ error: "type 必填：'single' 或 'auto'" }, 400);
    if (!b.publicName || !b.channelId || !b.upstreamModel) {
      return c.json({ error: 'publicName / channelId / upstreamModel 必填' }, 400);
    }
    // 非字符串真值（如 123）此前在 findModelByName 内 toLowerCase 直接 500（审查 C-M3）
    if (typeof b.publicName !== 'string' || !b.publicName.trim() || typeof b.upstreamModel !== 'string' || !b.upstreamModel.trim()) {
      return c.json({ error: 'publicName / upstreamModel 需为非空字符串' }, 400);
    }
    if (b.tags !== undefined && !(Array.isArray(b.tags) && b.tags.every((t: any) => typeof t === 'string'))) {
      return c.json({ error: 'tags 需为字符串数组' }, 400);
    }
    for (const nk of ['contextWindow', 'maxOutputTokens', 'priceInput', 'priceOutput', 'priceCacheRead', 'priceCacheWrite']) {
      const v = (b as any)[nk];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return c.json({ error: nk + ' 需为 ≥0 的数字' }, 400);
    }
    if (!store.getChannel(b.channelId)) return c.json({ error: 'channel 不存在' }, 404);
    // 撞名（外名/tag × single/auto 双向）收敛进 store.routeNameTaken，HTTP 侧只翻译状态码
    const { model, error } = store.createModel(b);
    if (!model) return c.json({ error: error || '名称冲突' }, 409);
    return c.json(model, 201);
  });

  app.patch('/routes/:id', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    const id = c.req.param('id');
    const found = store.getRoute(id);
    if (!found) return c.json({ error: 'not found' }, 404);
    if (found.type === 'auto') {
      const { auto, error, missing } = store.updateAutoRoute(id, b);
      if (missing) return c.json({ error: 'not found' }, 404);
      if (error) return c.json({ error }, 400);
      return c.json(auto);
    }
    const m = store.updateModel(id, b);
    if (m === 'conflict') return c.json({ error: `名称或 tag 与既有模型/auto 路由冲突${b.publicName ? `：${b.publicName}` : ''}` }, 409);
    return m ? c.json(m) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/routes/:id', (c) => {
    const id = c.req.param('id');
    const found = store.getRoute(id);
    if (!found) return c.json({ error: 'not found' }, 404);
    if (found.type === 'auto') return store.deleteAutoRoute(id) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
    // C8：被 auto 引用的候选删除后不会自动清理，回引用清单让管理端红标警示
    const { referencedAutoRoutes } = store.deleteModel(id);
    clearHealthFor(id); // 已删路由的健康窗口条目同步回收
    return c.json({ ok: true, ...(referencedAutoRoutes.length ? { warning: `已删除的模型被 ${referencedAutoRoutes.length} 个 auto 路由引用，候选将悬空并被自动剔除`, referencedAutoRoutes } : {}) });
  });

  // ---------- virtual keys ----------
  app.get('/vkeys', (c) => {
    const reveal = c.req.query('reveal') === '1' && isLocalish(c); // 同 channels：明文仅本机
    const quotas = quotaSnapshot();
    return c.json(
      store.listVKeys().map((k) => ({
        ...k,
        key: reveal ? k.key : `${k.key.slice(0, 9)}${'*'.repeat(12)}${k.key.slice(-4)}`,
        today: quotas[k.id] || { day: '', tokens: 0, requests: 0, costUsd: 0 },
      })),
    );
  });

  app.post('/vkeys', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    if (!b.name || typeof b.name !== 'string') return c.json({ error: 'name 必填（字符串）' }, 400);
    try {
      return c.json(store.createVKey(b), 201);
    } catch (err: any) {
      const msg = String(err?.message || '创建失败');
      return c.json({ error: msg }, msg.includes('已存在') ? 409 : 400);
    }
  });

  app.patch('/vkeys/:id', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    const vk = store.updateVKey(c.req.param('id'), b);
    return vk ? c.json(vk) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/vkeys/:id', (c) => {
    store.deleteVKey(c.req.param('id'));
    forgetQuota(c.req.param('id')); // 在途册目同步清，防已删 key 幽灵账（并发线 4）
    return c.json({ ok: true });
  });

  // ---------- logs / stats ----------
  app.get('/logs', (c) => {
    const limit = Number(c.req.query('limit') || 100);
    const onlyErrors = c.req.query('errors') === '1';
    const model = c.req.query('model');
    let logs = store.db.logs;
    if (onlyErrors) logs = logs.filter((l) => !l.ok);
    if (model) logs = logs.filter((l) => l.requestedModel === model);
    return c.json([...logs].slice(-limit).reverse());
  });

  /** SSE 实时日志。回调必须保持挂起，否则 Hono 会立刻关闭响应 */
  app.get('/logs/stream', (c) => {
    return stream(c, async (s) => {
      let closed = false;
      s.onAbort(() => {
        closed = true;
      });
      // 按单调 seq 做增量：日志数组会被 logRetention 裁剪，按下标切片在裁剪瞬间会漏推/重推
      const tailSeq = () => {
        const logs = store.db.logs;
        return logs.length ? logs[logs.length - 1].seq || 0 : 0;
      };
      let lastSeq = tailSeq();
      await s.write(`data: ${JSON.stringify(store.db.logs.slice(-30))}\n\n`);
      while (!closed) {
        await sleep(2000);
        if (closed) break;
        const fresh = store.db.logs.filter((l) => (l.seq || 0) > lastSeq).slice(-30);
        if (fresh.length) {
          lastSeq = fresh[fresh.length - 1].seq || lastSeq;
          try {
            await s.write(`data: ${JSON.stringify(fresh)}\n\n`);
          } catch {
            break;
          }
        }
        try {
          await s.write(`: ping ${Date.now()}\n\n`);
        } catch {
          break;
        }
      }
    });
  });

  app.delete('/logs', (c) => {
    store.clearLogs();
    return c.json({ ok: true });
  });

  app.get('/stats', (c) => c.json(buildStats(Number(c.req.query('hours') || 24))));
  // 速度排行（speed-insights v1.1）：hours 归一钳制在 buildSpeedStats 内（DR-SI-8）
  app.get('/stats/speed', (c) => c.json(buildSpeedStats(Number(c.req.query('hours') ?? 24))));
  app.get('/config/export', (c) => c.json(buildBundle()));
  app.post('/config/import', async (c) => {
    // 本端点自建 body 闸（§6.4：/api/* 从无全局体积守卫）：content-length 预拒 + reader 流式累计
    const cap = store.db.settings.maxBodyBytes || 0;
    const cl = Number(c.req.header('content-length') || 0);
    if (cap > 0 && cl > cap) return c.json({ error: '请求体过大' }, 413);
    let body: any;
    try {
      const rb = c.req.raw.body;
      if (rb) {
        const it = rb.getReader();
        const parts: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const r = await it.read();
          if (r.done) break;
          total += (r.value as Uint8Array).byteLength;
          if (cap > 0 && total > cap) return c.json({ error: '请求体过大' }, 413);
          parts.push(r.value as Uint8Array);
        }
        const buf = new Uint8Array(total);
        let off = 0;
        for (const seg of parts) { buf.set(seg, off); off += seg.byteLength; }
        body = JSON.parse(new TextDecoder().decode(buf));
      }
    } catch { return c.json({ error: 'JSON 畸形' }, 400); }
    if (!body || typeof body !== 'object') return c.json({ error: 'body 需为对象：{ bundle, keys?, dryRun? }' }, 400);
    const { errors, plan, receipt } = buildImportPlan(body.bundle, body.keys);
    if (errors) return c.json({ error: errors.join('; '), errors }, 400);
    receipt!.dryRun = body.dryRun === true;
    if (body.dryRun === true) return c.json(receipt);
    const extra = applyPlan(plan!);
    for (const e2 of extra) receipt!.routes.conflicts.push(e2);
    store.flushSync(); // 回执前落盘：消除「回执宣称已创建、盘上还没有」观测窗（§4.5）
    return c.json(receipt);
  });

  // ---------- settings ----------
  // 管理令牌不再随设置回显（审查 A-M：GET /settings 整包吐 adminToken 让任何 XSS 一步拿权）。
  // 前端已登录即已持有令牌；配置页只看 adminTokenSet。
  const publicSettings = (s: any) => {
    const { adminToken, ...rest } = s;
    return { ...rest, adminTokenSet: !!adminToken };
  };
  app.get('/settings', (c) => c.json(publicSettings(store.getSettings())));
  app.patch('/settings', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    const { settings, applied, rejected } = store.applySettings(b);
    if (!applied.length && rejected.length) return c.json({ error: '所有设置项都未通过校验', rejected }, 400);
    return c.json({ ...publicSettings(settings), _applied: applied, _rejected: rejected });
  });

  // ---------- 客户端接入示例 ----------
  app.get('/snippet', (c) => {
    const vk = store.listVKeys().find((k) => k.enabled) || store.listVKeys()[0];
    const base = `${new URL(c.req.url).protocol}//${c.req.header('host') || `localhost:${process.env.PORT || 8787}`}`;
    const model = store.listModels().find((m) => m.enabled)?.publicName || 'gpt-4o';
    if (!vk) return c.json({ error: '还没有对外 key' }, 404);
    return c.json({
      baseUrl: base,
      key: isLocalish(c) ? vk.key : '（明文 key 请在本机直连的管理台查看复制）', // R1-S1：掩码战役后最后的无闸明文出口，与 reveal 同口径
      model,
      curl: `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer ${vk.key}" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"hi"}]}'`,
      openaiSdk: `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "${base}/v1", apiKey: "${vk.key}" });\nconst r = await client.chat.completions.create({ model: "${model}", messages: [{ role: "user", content: "hi" }] });`,
      claudeCode: `export ANTHROPIC_BASE_URL="${base}"\nexport ANTHROPIC_API_KEY="${vk.key}"\nexport ANTHROPIC_MODEL="${model}"`,
      codexCli: `# ~/.codex/config.toml\nmodel = "${model}"\n[model_providers.own-api]\nname = "own-api"\nbase_url = "${base}/v1"\nenv_key = "OWN_API_KEY"\n\n# export OWN_API_KEY="${vk.key}"`,
    });
  });

  /** 运行时观测出口（N6）：健康分窗口 + 粘性条目数；reset 供测试与调试 */
  app.get('/auto-health', (c) => {
    const snap = healthSnapshot().map((h) => {
      const m = store.getModel(h.routeId);
      return { ...h, name: m?.publicName, channel: m ? store.getChannel(m.channelId)?.name : undefined };
    });
    return c.json({ windows: snap, stickyEntries: stickyCount() });
  });
  app.post('/auto-health/reset', (c) => {
    clearHealth();
    clearSticky();
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404));
  return app;
}
