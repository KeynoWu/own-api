import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { store, maskKey } from './store.ts';
import { forgetQuota } from './usage.ts';
import { availableKeyCount } from './pool.ts';
import { buildUrl, extractUpstreamError } from './upstream.ts';
import { buildStats, quotaSnapshot } from './usage.ts';
import { clearHealth, clearHealthFor, clearSticky, healthSnapshot, stickyCount } from './auto.ts';
import type { Channel } from './types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 常数时间比较：先各自过一遍 SHA-256，连长度差异都不泄露 */
/** 连通测试错误体与 gateway 的 scrubOut 同口径：上游 echo key 时先掩码再回显（二轮建议） */
function scrubbedError(text: string, key: string, status: number) {
  const s = extractUpstreamError(text, status);
  return key && s.includes(key) ? s.split(key).join(maskKey(key)) : s;
}

function safeEq(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function createAdmin(): Hono {
  const app = new Hono();

  // ---------- 管理台鉴权 ----------
  // /logs/stream 需要 EventSource（无法带自定义头），用短期 SSE 订阅令牌代替长期 admin_token 进 URL
  const sseTickets = new Map<string, number>(); // ticket -> expiresAt
  const TICKET_TTL = 60 * 60 * 1000;
  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const expect = store.getSettings().adminToken;
    if (!expect) {
      return c.json({ error: 'unauthorized', hint: '管理令牌未配置，请设置 LLM_ADMIN_TOKEN' }, 401);
    }
    if (safeEq(c.req.header('x-admin-token') || '', expect)) return next();
    // 仅 /logs/stream 允许 query 短令牌；其它路径一律要求头
    const path = c.req.path.replace(/^\/api/, '');
    if (path === '/logs/stream') {
      const ticket = c.req.query('ticket');
      const exp = ticket ? sseTickets.get(ticket) : undefined;
      if (exp && exp > Date.now()) return next();
    }
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
    void s;
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
    });
  });

  // ---------- channels ----------
  app.get('/channels', (c) => {
    const reveal = c.req.query('reveal') === '1';
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
    return c.json(maskChannel(ch, true), 201);
  });

  app.patch('/channels/:id', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    let ch;
    try {
      ch = store.updateChannel(c.req.param('id'), b);
    } catch (err: any) {
      return c.json({ error: err?.message || 'channels 更新失败' }, 400);
    }
    return ch ? c.json(maskChannel(ch, true)) : c.json({ error: 'not found' }, 404);
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
    const ch = store.addKeys(c.req.param('id'), items.filter((k: any) => k.key));
    return ch ? c.json(maskChannel(ch, true)) : c.json({ error: 'channel not found' }, 404);
  });

  app.patch('/channels/:id/keys/:keyId', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    store.updateKey(c.req.param('id'), c.req.param('keyId'), b);
    const ch = store.getChannel(c.req.param('id'));
    return ch ? c.json(maskChannel(ch, true)) : c.json({ error: 'not found' }, 404);
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
      created.push(
        store.createModel({
          publicName: finalName,
          channelId: ch.id,
          upstreamModel: name,
          protocol: ch.protocol,
        }),
      );
    }
    return c.json({ created: created.length, models: created, skipped });
  });

  // ---------- models ----------
  app.get('/models', (c) => {
    return c.json(
      store.listModels().map((m) => ({
        ...m,
        channelName: store.getChannel(m.channelId)?.name || '(渠道已删除)',
        channelProtocol: store.getChannel(m.channelId)?.protocol,
      })),
    );
  });

  app.post('/models', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    if (!b.publicName || !b.channelId || !b.upstreamModel) {
      return c.json({ error: 'publicName / channelId / upstreamModel 必填' }, 400);
    }
    if (store.findModelByName(b.publicName)) return c.json({ error: '同名模型已存在' }, 409);
    // 双向唯一性（W7）：模型名/tag 也不得遮蔽既有 auto 路由名
    if (store.findAutoRouteByName(b.publicName)) return c.json({ error: '外名与 auto 路由冲突（auto 名全局唯一）' }, 409);
    const tagClash = Array.isArray(b.tags) ? b.tags.find((t: any) => typeof t === 'string' && store.findAutoRouteByName(t)) : undefined;
    if (tagClash) return c.json({ error: `tag「${tagClash}」与 auto 路由名冲突` }, 409);
    if (!store.getChannel(b.channelId)) return c.json({ error: 'channel 不存在' }, 404);
    return c.json(store.createModel(b), 201);
  });

  app.patch('/models/:id', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    const m = store.updateModel(c.req.param('id'), b);
    if (m === 'conflict') return c.json({ error: `名称或 tag 与既有模型/auto 路由冲突${b.publicName ? `：${b.publicName}` : ''}` }, 409);
    return m ? c.json(m) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/models/:id', (c) => {
    // C8：被 auto 引用的候选删除后不会自动清理，回引用清单让管理端红标警示
    const { referencedAutoRoutes } = store.deleteModel(c.req.param('id'));
    clearHealthFor(c.req.param('id')); // 已删路由的健康窗口条目同步回收
    return c.json({ ok: true, ...(referencedAutoRoutes.length ? { warning: `已删除的模型被 ${referencedAutoRoutes.length} 个 auto 路由引用，候选将悬空并被自动剔除`, referencedAutoRoutes } : {}) });
  });

  // ---------- virtual keys ----------
  app.get('/vkeys', (c) => {
    const reveal = c.req.query('reveal') === '1';
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
    if (!b.name) return c.json({ error: 'name 必填' }, 400);
    return c.json(store.createVKey(b), 201);
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

  // ---------- settings ----------
  app.get('/settings', (c) => c.json(store.getSettings()));
  app.patch('/settings', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    const { settings, applied, rejected } = store.applySettings(b);
    if (!applied.length && rejected.length) return c.json({ error: '所有设置项都未通过校验', rejected }, 400);
    return c.json({ ...settings, _applied: applied, _rejected: rejected });
  });

  // ---------- 客户端接入示例 ----------
  app.get('/snippet', (c) => {
    const vk = store.listVKeys().find((k) => k.enabled) || store.listVKeys()[0];
    const base = `${new URL(c.req.url).protocol}//${c.req.header('host') || `localhost:${process.env.PORT || 8787}`}`;
    const model = store.listModels().find((m) => m.enabled)?.publicName || 'gpt-4o';
    if (!vk) return c.json({ error: '还没有对外 key' }, 404);
    return c.json({
      baseUrl: base,
      key: vk.key,
      model,
      curl: `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer ${vk.key}" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"hi"}]}'`,
      openaiSdk: `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "${base}/v1", apiKey: "${vk.key}" });\nconst r = await client.chat.completions.create({ model: "${model}", messages: [{ role: "user", content: "hi" }] });`,
      claudeCode: `export ANTHROPIC_BASE_URL="${base}"\nexport ANTHROPIC_API_KEY="${vk.key}"\nexport ANTHROPIC_MODEL="${model}"`,
      codexCli: `# ~/.codex/config.toml\nmodel = "${model}"\n[model_providers.own-api]\nname = "own-api"\nbase_url = "${base}/v1"\nenv_key = "OWN_API_KEY"\n\n# export OWN_API_KEY="${vk.key}"`,
    });
  });

  // ---------- auto routes（docs/model-auto-design.md §5/§8） ----------
  app.get('/auto-routes', (c) => {
    const snap = healthSnapshot();
    return c.json(
      store.listAutoRoutes().map((a) => ({
        ...a,
        candidates: a.candidates.map((cd) => {
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
      })),
    );
  });

  app.post('/auto-routes', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    const { auto, error } = store.createAutoRoute(b);
    if (error) return c.json({ error }, 400);
    return c.json(auto, 201);
  });

  app.patch('/auto-routes/:id', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    const { auto, error, missing } = store.updateAutoRoute(c.req.param('id'), b);
    if (missing) return c.json({ error: 'not found' }, 404);
    if (error) return c.json({ error }, 400);
    return c.json(auto);
  });

  app.delete('/auto-routes/:id', (c) => (store.deleteAutoRoute(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)));

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
