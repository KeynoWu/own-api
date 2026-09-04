import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AutoCandidate, AutoRoute, Channel, DBShape, ModelRoute, RequestLog, Settings, VirtualKey } from './types.ts';

const DATA_DIR = process.env.LLM_DATA_DIR || join(process.cwd(), 'data');
const DB_FILE = process.env.LLM_DB_FILE || join(DATA_DIR, 'db.json');

function newId(prefix: string) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function genVirtualKey() {
  return `sk-lm-${randomBytes(18).toString('base64url')}`;
}

function n(v: string | undefined, d: number) {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : d;
}

function defaultSettings(): Settings {
  return {
    adminToken: process.env.LLM_ADMIN_TOKEN || `admin-${randomBytes(9).toString('base64url')}`,
    defaultUpstreamTimeoutMs: n(process.env.LLM_UPSTREAM_TIMEOUT, 300_000),
    upstreamIdleTimeoutMs: n(process.env.LLM_IDLE_TIMEOUT, 120_000),
    maxBodyBytes: n(process.env.LLM_MAX_BODY_BYTES, 64 * 1024 * 1024),
    debugHeaders: process.env.LLM_DEBUG_HEADERS === '1',
    maxKeyRetries: n(process.env.LLM_MAX_RETRIES, 3),
    errorThreshold: 3,
    cooldownBaseMs: 30_000,
    cooldownMaxMs: 15 * 60_000,
    logRetention: 2000,
    autoMaxChainSeconds: n(process.env.LLM_AUTO_CHAIN_SECONDS, 300),
  };
}

/**
 * 设置项白名单校验。直接 Object.assign 用户 JSON 会让 logRetention=0 静默关掉日志
 * （连带统计、限额全废），或 maxKeyRetries 变负数。这里统一夹到安全区间，
 * 非法值抛错而不是悄悄吞掉。
 */
type Bounds = { min: number; max: number };
const NUM_BOUNDS: Record<string, Bounds> = {
  defaultUpstreamTimeoutMs: { min: 1_000, max: 3_600_000 },
  upstreamIdleTimeoutMs: { min: 1_000, max: 3_600_000 },
  maxBodyBytes: { min: 1_024, max: 1024 * 1024 * 1024 },
  maxKeyRetries: { min: 1, max: 10 },
  errorThreshold: { min: 1, max: 20 },
  cooldownBaseMs: { min: 100, max: 600_000 },
  cooldownMaxMs: { min: 1_000, max: 3_600_000 },
  logRetention: { min: 1, max: 200_000 },
  autoMaxChainSeconds: { min: 10, max: 3_600 },
};

export function sanitizeSettings(patch: any, current: Settings): { value: Partial<Settings>; rejected: string[] } {
  const out: any = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'adminToken') {
      const t = typeof v === 'string' ? v.trim() : '';
      if (t.length < 8) {
        rejected.push('adminToken：至少 8 个字符（留空会关闭整个管理台鉴权）');
        continue;
      }
      out.adminToken = t;
    } else if (k === 'debugHeaders' || k === 'fallbackChannelId') {
      if (k === 'fallbackChannelId' && v !== '' && v !== undefined && v !== null && typeof v !== 'string') {
        rejected.push(`${k}：类型不合法`);
        continue;
      }
      out[k] = k === 'debugHeaders' ? Boolean(v) : ((v as string) || undefined);
    } else if (k in NUM_BOUNDS) {
      const x = Number(v);
      const bound = NUM_BOUNDS[k];
      if (!Number.isFinite(x) || x < bound.min || x > bound.max) {
        rejected.push(`${k}：${JSON.stringify(v)} 不在 ${bound.min}~${bound.max} 范围内`);
        continue;
      }
      out[k] = Math.floor(x);
    } else {
      rejected.push(`${k}：未知设置项`);
    }
  }
  // cooldownBase 不得大于 cooldownMax
  const base = out.cooldownBaseMs ?? current.cooldownBaseMs;
  const max = out.cooldownMaxMs ?? current.cooldownMaxMs;
  if (base > max) rejected.push('cooldownBaseMs：不能大于 cooldownMaxMs');
  return { value: out, rejected };
}

function emptyDb(): DBShape {
  return { version: 2, quotas: {}, channels: [], models: [], autoRoutes: [], vkeys: [], logs: [], settings: defaultSettings() };
}

/** 归一化成字符串数组：支持数组，或每行一个的字符串；去重去空 */
function toStrList(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v.map((s) => String(s)) : typeof v === 'string' ? v.split('\n') : [];
  const out = [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
  return out.length ? out : undefined;
}

// PATCH 可写字段白名单：主键、创建时间、号池 keys（走专门的增删接口）等一律拒之门外
const UPDATABLE_CHANNEL_FIELDS = ['name', 'baseUrl', 'protocol', 'enabled', 'extraHeaders', 'authStyle', 'timeoutMs', 'note', 'testModel', 'modelList'];
const UPDATABLE_MODEL_FIELDS = ['publicName', 'channelId', 'upstreamModel', 'protocol', 'enabled', 'contextWindow', 'maxOutputTokens', 'supportsStreaming', 'supportsTools', 'priceInput', 'priceOutput', 'priceCacheRead', 'priceCacheWrite', 'tags', 'note'];
const UPDATABLE_VKEY_FIELDS = ['name', 'enabled', 'allowedModels', 'rpmLimit', 'dailyTokenLimit', 'note'];

class Store {
  db: DBShape;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  /** 日志单调序号（进程内，从已加载库续起）：日志流按 seq 增量推送，不受裁剪位移影响 */
  private logSeq = 0;

  constructor() {
    this.db = this.load();
    this.logSeq = this.db.logs.reduce((m, l) => Math.max(m, l.seq || 0), 0);
  }

  private load(): DBShape {
    if (!existsSync(DB_FILE)) {
      const fresh = emptyDb();
      // 首次启动时生成一个默认可用的对外 key，开箱即用
      fresh.vkeys.push({
        id: newId('vk'),
        key: genVirtualKey(),
        name: 'default',
        enabled: true,
        allowedModels: [],
        createdAt: Date.now(),
      });
      this.persist(fresh);
      return fresh;
    }
    try {
      const parsed = JSON.parse(readFileSync(DB_FILE, 'utf8')) as DBShape;
      const base = emptyDb();
      const merged: DBShape = {
        ...base,
        ...parsed,
        quotas: parsed.quotas || {},
        // 老库无此字段安全；手工改成非数组也当空处理，不致启动即崩
        autoRoutes: Array.isArray(parsed.autoRoutes) ? parsed.autoRoutes : [],
        settings: { ...base.settings, ...(parsed.settings || {}) },
      };
      // 老库或手工改坏的库兜底：设置项重新过一遍校验
      const { value } = sanitizeSettings(
        Object.fromEntries(Object.entries(merged.settings).filter(([k]) => k !== 'adminToken')),
        base.settings,
      );
      merged.settings = { ...merged.settings, ...value, adminToken: merged.settings.adminToken || base.settings.adminToken };
      return merged;
    } catch (err) {
      const backup = `${DB_FILE}.corrupt-${Date.now()}`;
      try {
        renameSync(DB_FILE, backup);
      } catch {
        /* ignore */
      }
      console.error(`[store] db.json 解析失败，已备份到 ${backup}，使用空库启动`, err);
      return emptyDb();
    }
  }

  private persist(db: DBShape = this.db) {
    mkdirSync(dirname(DB_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${DB_FILE}.tmp`;
    // db.json 里是明文上游 key，必须 0600：默认 umask 出来的 0644 同机其他人可读
    writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600); // tmp 复用时 mode 不会变，显式设一次
    } catch {
      /* ignore */
    }
    renameSync(tmp, DB_FILE);
    try {
      chmodSync(DB_FILE, 0o600);
    } catch {
      /* ignore */
    }
  }

  /** 标脏 + 去抖落盘，避免每个请求都写文件 */
  save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) {
        this.dirty = false;
        try {
          this.persist();
        } catch (err) {
          console.error('[store] flush failed', err);
        }
      }
    }, 400);
    this.timer.unref?.();
  }

  flushSync() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty) {
      this.dirty = false;
      this.persist();
    }
  }

  // ---------- channel ----------
  listChannels() {
    return this.db.channels;
  }
  getChannel(id: string) {
    return this.db.channels.find((c) => c.id === id);
  }
  createChannel(input: Partial<Channel> & { name: string; baseUrl: string }) {
    const ch: Channel = {
      id: newId('ch'),
      name: input.name,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      protocol: input.protocol || 'openai',
      keys: (input.keys || []).map((k) => makeKey(k.key, k.name, k.weight)),
      enabled: input.enabled ?? true,
      extraHeaders: input.extraHeaders,
      authStyle: input.authStyle,
      timeoutMs: input.timeoutMs,
      createdAt: Date.now(),
      note: input.note,
      testModel: input.testModel,
      modelList: toStrList(input.modelList),
    };
    this.db.channels.push(ch);
    this.save();
    return ch;
  }
  updateChannel(id: string, patch: Partial<Channel>) {
    const ch = this.getChannel(id);
    if (!ch) return undefined;
    // 字段白名单：id/createdAt/keys 等结构性字段不可经 PATCH 改写——
    // 改 id 会切断模型与配额的引用，塞畸形 keys 会绕过 makeKey 的形状校验（SEC：完整性）
    const next: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      if (!UPDATABLE_CHANNEL_FIELDS.includes(k)) continue;
      next[k] = (patch as Record<string, unknown>)[k];
    }
    if (patch.protocol !== undefined && patch.protocol !== 'openai' && patch.protocol !== 'anthropic') delete next.protocol;
    if (patch.authStyle !== undefined && !['bearer', 'x-api-key'].includes(String(patch.authStyle))) delete next.authStyle;
    if (patch.timeoutMs !== undefined && (typeof patch.timeoutMs !== 'number' || !Number.isFinite(patch.timeoutMs) || patch.timeoutMs <= 0)) delete next.timeoutMs;
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') delete next.enabled;
    if (patch.name !== undefined && typeof patch.name !== 'string') delete next.name;
    if (patch.extraHeaders !== undefined && !(typeof patch.extraHeaders === 'object' && patch.extraHeaders !== null && !Array.isArray(patch.extraHeaders))) delete next.extraHeaders;
    if (typeof next.baseUrl === 'string' && next.baseUrl) next.baseUrl = normalizeBaseUrl(next.baseUrl);
    // modelList 兼容数组 / “每行一个”字符串，统一归一化，避免字符串直接落库
    if (patch.modelList !== undefined) next.modelList = toStrList(patch.modelList) ?? [];
    Object.assign(ch, next);
    this.save();
    return ch;
  }
  deleteChannel(id: string) {
    // 级联：删掉挂在它下面的模型；同时报告哪些 auto 路由的候选会因此悬空（C8）
    const doomed = new Set(this.db.models.filter((m) => m.channelId === id).map((m) => m.id));
    const referenced = this.autoRoutesReferencing(doomed);
    this.db.channels = this.db.channels.filter((c) => c.id !== id);
    this.db.models = this.db.models.filter((m) => m.channelId !== id);
    this.save();
    return { referencedAutoRoutes: referenced.map((a) => ({ id: a.id, publicName: a.publicName })), deletedModelIds: [...doomed] };
  }

  /** 往渠道号池里加 key */
  addKeys(channelId: string, items: { key: string; name?: string; weight?: number }[]) {
    const ch = this.getChannel(channelId);
    if (!ch) return undefined;
    const existing = new Set(ch.keys.map((k) => k.key));
    for (const it of items) {
      const raw = (it.key || '').trim();
      if (!raw || existing.has(raw)) continue;
      ch.keys.push(makeKey(raw, it.name, it.weight));
      existing.add(raw);
    }
    this.save();
    return ch;
  }
  removeKey(channelId: string, keyId: string) {
    const ch = this.getChannel(channelId);
    if (!ch) return;
    ch.keys = ch.keys.filter((k) => k.id !== keyId);
    this.save();
  }
  updateKey(channelId: string, keyId: string, patch: Partial<{ status: Channel['keys'][number]['status']; weight: number; name: string; note: string }>) {
    const k = this.getChannel(channelId)?.keys.find((x) => x.id === keyId);
    if (!k) return;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const v = (patch as Record<string, unknown>)[key];
      if (key === 'status' && v !== undefined && !['active', 'cooldown', 'disabled'].includes(String(v))) continue;
      if (key === 'weight' && v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) continue;
      next[key] = v;
    }
    Object.assign(k, next);
    if (patch.status === 'active') {
      k.cooldownUntil = undefined;
      k.lastError = undefined;
    }
    this.save();
  }

  // ---------- model ----------
  listModels() {
    return this.db.models;
  }
  getModel(id: string) {
    return this.db.models.find((m) => m.id === id);
  }
  findModelByName(name: string) {
    const lower = name.toLowerCase();
    return this.db.models.find(
      (m) => m.publicName.toLowerCase() === lower || m.tags?.some((t) => t.toLowerCase() === lower),
    );
  }
  createModel(input: Partial<ModelRoute> & { publicName: string; channelId: string; upstreamModel: string }) {
    const m: ModelRoute = {
      id: newId('md'),
      publicName: input.publicName.trim(),
      channelId: input.channelId,
      upstreamModel: input.upstreamModel.trim(),
      protocol: input.protocol,
      enabled: input.enabled ?? true,
      // 上下文窗口默认 128k，可在模型路由里改
      contextWindow: input.contextWindow ?? 128_000,
      maxOutputTokens: input.maxOutputTokens,
      supportsStreaming: input.supportsStreaming ?? true,
      supportsTools: input.supportsTools,
      priceInput: input.priceInput,
      priceOutput: input.priceOutput,
      priceCacheRead: input.priceCacheRead,
      priceCacheWrite: input.priceCacheWrite,
      tags: input.tags,
      createdAt: Date.now(),
      note: input.note,
    };
    this.db.models.push(m);
    this.save();
    return m;
  }
  updateModel(id: string, patch: Partial<ModelRoute>) {
    const m = this.getModel(id);
    if (!m) return undefined;
    // 字段白名单：id 等结构性字段不可改写（改主键会孤立引用），
    // 非法类型直接丢弃而不是裸 Object.assign（SEC-04）
    const next: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      if (!UPDATABLE_MODEL_FIELDS.includes(k)) continue;
      const v = (patch as Record<string, unknown>)[k];
      if (k === 'protocol' && v !== undefined && v !== 'openai' && v !== 'anthropic') continue;
      if ((k === 'enabled' || k === 'supportsStreaming' || k === 'supportsTools') && typeof v !== 'boolean') continue;
      if ((k === 'publicName' || k === 'channelId' || k === 'upstreamModel') && (typeof v !== 'string' || (k !== 'channelId' && !v.trim()))) continue;
      if (k === 'tags' && v !== undefined && !(Array.isArray(v) && v.every((s) => typeof s === 'string'))) continue;
      if (k === 'note' && v !== undefined && typeof v !== 'string') continue;
      if (['contextWindow', 'maxOutputTokens', 'priceInput', 'priceOutput', 'priceCacheRead', 'priceCacheWrite'].includes(k) && v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) continue;
      next[k] = v;
    }
    if (typeof next.publicName === 'string' && next.publicName !== m.publicName) {
      const clash = this.findModelByName(next.publicName);
      if (clash && clash.id !== id) return 'conflict' as const;
    }
    // auto 名唯一性（双向+W7）：改模型外名/改 tags 都不得遮蔽既有 auto 路由名
    if (typeof next.publicName === 'string' || next.tags !== undefined) {
      const names = [typeof next.publicName === 'string' ? next.publicName : m.publicName, ...(Array.isArray(next.tags) ? next.tags : m.tags || [])]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
      if (this.db.autoRoutes.some((a) => names.includes(a.publicName.toLowerCase()))) return 'conflict' as const;
    }
    Object.assign(m, next);
    this.save();
    return m;
  }
  deleteModel(id: string) {
    const referenced = this.autoRoutesReferencing(new Set([id]));
    this.db.models = this.db.models.filter((m) => m.id !== id);
    this.save();
    return { referencedAutoRoutes: referenced.map((a) => ({ id: a.id, publicName: a.publicName })) };
  }

  // ---------- auto routes ----------
  listAutoRoutes() {
    return this.db.autoRoutes;
  }
  /** auto 名只按 publicName 精确匹配（大小写不敏感）；模型 tags 不参与 auto 名解析 */
  findAutoRouteByName(name: string) {
    const lower = String(name || '').toLowerCase();
    return this.db.autoRoutes.find((a) => a.publicName.toLowerCase() === lower);
  }
  /** 唯一性：不得与其它 auto、ModelRoute.publicName 或其任一 tag 同名 */
  private autoNameTaken(name: string, excludeId?: string): string | undefined {
    const lower = name.toLowerCase();
    if (this.db.autoRoutes.some((a) => a.id !== excludeId && a.publicName.toLowerCase() === lower)) return '已有同名 auto 路由';
    const m = this.db.models.find((x) => x.publicName.toLowerCase() === lower || x.tags?.some((t) => t.toLowerCase() === lower));
    if (m) return `与模型路由「${m.publicName}」的外名或 tag 冲突`;
    return undefined;
  }
  private sanitizeCandidates(v: unknown): { candidates?: AutoCandidate[]; error?: string } {
    if (!Array.isArray(v)) return { error: 'candidates 必须是数组' };
    if (v.length > 16) return { error: 'candidates 长度不能超过 16' };
    const out: AutoCandidate[] = [];
    const seen = new Set<string>();
    for (const c of v) {
      const routeId = typeof c?.routeId === 'string' ? c.routeId.trim() : '';
      const weight = c?.weight;
      if (!routeId || seen.has(routeId)) continue;
      if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 0 || weight > 10_000) {
        return { error: '候选 weight 必须是 0~10000 的整数（0=禁用）' };
      }
      seen.add(routeId);
      out.push({ routeId, weight });
    }
    return { candidates: out };
  }
  createAutoRoute(input: any): { auto?: AutoRoute; error?: string } {
    const publicName = typeof input?.publicName === 'string' ? input.publicName.trim() : '';
    if (!publicName) return { error: 'publicName 必填' };
    const taken = this.autoNameTaken(publicName);
    if (taken) return { error: taken };
    const { candidates, error } = this.sanitizeCandidates(input?.candidates ?? []);
    if (error) return { error };
    const ttl = input?.stickyTtlMs === undefined ? 300_000 : Number(input.stickyTtlMs);
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 86_400_000) return { error: 'stickyTtlMs 必须是 0~86400000 的整数（0=关粘性）' };
    const auto: AutoRoute = {
      id: newId('auto'),
      publicName,
      candidates,
      stickyTtlMs: ttl,
      enabled: input?.enabled !== false,
      createdAt: Date.now(),
      note: typeof input?.note === 'string' ? input.note : undefined,
    };
    this.db.autoRoutes.push(auto);
    this.save();
    return { auto };
  }
  updateAutoRoute(id: string, patch: any): { auto?: AutoRoute; error?: string; missing?: boolean } {
    const a = this.db.autoRoutes.find((x) => x.id === id);
    if (!a) return { missing: true };
    const next: Record<string, unknown> = {};
    if (patch?.publicName !== undefined) {
      const name = typeof patch.publicName === 'string' ? patch.publicName.trim() : '';
      if (!name) return { error: 'publicName 不能为空' };
      const taken = this.autoNameTaken(name, id);
      if (taken) return { error: taken };
      next.publicName = name;
    }
    if (patch?.candidates !== undefined) {
      const { candidates, error } = this.sanitizeCandidates(patch.candidates);
      if (error) return { error };
      next.candidates = candidates;
    }
    if (patch?.stickyTtlMs !== undefined) {
      const ttl = Number(patch.stickyTtlMs);
      if (!Number.isInteger(ttl) || ttl < 0 || ttl > 86_400_000) return { error: 'stickyTtlMs 必须是 0~86400000 的整数' };
      next.stickyTtlMs = ttl;
    }
    if (patch?.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') return { error: 'enabled 必须是布尔' };
      next.enabled = patch.enabled;
    }
    if (patch?.note !== undefined) {
      if (typeof patch.note !== 'string') return { error: 'note 必须是字符串' };
      next.note = patch.note;
    }
    Object.assign(a, next);
    this.save();
    return { auto: a };
  }
  deleteAutoRoute(id: string) {
    const before = this.db.autoRoutes.length;
    this.db.autoRoutes = this.db.autoRoutes.filter((a) => a.id !== id);
    this.save();
    return this.db.autoRoutes.length < before;
  }
  /** 哪些 auto 路由引用了这些模型路由（删除前告警，C8） */
  autoRoutesReferencing(routeIds: Set<string>): AutoRoute[] {
    if (!routeIds.size) return [];
    return this.db.autoRoutes.filter((a) => a.candidates.some((c) => routeIds.has(c.routeId)));
  }

  // ---------- virtual keys ----------
  listVKeys() {
    return this.db.vkeys;
  }
  findVKey(key: string) {
    return this.db.vkeys.find((k) => k.key === key);
  }
  createVKey(input: Partial<VirtualKey> & { name: string }) {
    const vk: VirtualKey = {
      id: newId('vk'),
      key: input.key?.trim() || genVirtualKey(),
      name: input.name,
      enabled: input.enabled ?? true,
      allowedModels: input.allowedModels || [],
      createdAt: Date.now(),
      rpmLimit: input.rpmLimit ?? 0,
      dailyTokenLimit: input.dailyTokenLimit ?? 0,
      note: input.note,
    };
    this.db.vkeys.push(vk);
    this.save();
    return vk;
  }
  updateVKey(id: string, patch: Partial<VirtualKey>) {
    const vk = this.db.vkeys.find((k) => k.id === id);
    if (!vk) return;
    // 白名单：id/key 不可经 PATCH 改写——配额按 id 记账，改 id 会静默孤立当日额度；
    // 限额负数/非有限值不生效，否则 rpmLimit=-5 落到准入判断是 falsy，静默变"不限"。
    const next: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      if (!UPDATABLE_VKEY_FIELDS.includes(k)) continue;
      const v = (patch as Record<string, unknown>)[k];
      if ((k === 'name' || k === 'note') && v !== undefined && typeof v !== 'string') continue;
      if (k === 'enabled' && typeof v !== 'boolean') continue;
      if (k === 'allowedModels' && !(Array.isArray(v) && v.every((s) => typeof s === 'string'))) continue;
      next[k] = v;
    }
    for (const k of ['rpmLimit', 'dailyTokenLimit'] as const) {
      const v = next[k];
      if (v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0)) continue;
      delete next[k];
    }
    Object.assign(vk, next);
    this.save();
    return vk;
  }
  deleteVKey(id: string) {
    this.db.vkeys = this.db.vkeys.filter((k) => k.id !== id);
    delete this.db.quotas[id]; // 并发线 4(a)：不留幽灵日账（quotaOf 会在迟到 finalize 时重建，故 admin 侧还要 forgetQuota 清在途）
    this.save();
  }

  // ---------- logs ----------
  pushLog(log: RequestLog) {
    log.seq = ++this.logSeq;
    // 落库存快照：finalize 后网关仍持有 log 与 retries/chainAttempts 的活引用，
    // 不拷快照的话"已落库历史"会被后续改动静默改写（一致性从靠纪律改为靠机制）
    this.db.logs.push({ ...log, ...(log.retries ? { retries: [...log.retries] } : {}), ...(log.chainAttempts ? { chainAttempts: [...log.chainAttempts] } : {}) });
    const cap = this.db.settings.logRetention;
    if (this.db.logs.length > cap) this.db.logs.splice(0, this.db.logs.length - cap);
    this.save();
  }
  clearLogs() {
    this.db.logs = [];
    this.save();
  }

  getSettings() {
    return this.db.settings;
  }
  /** 只接受白名单内的合法值；返回实际生效的字段与被拒原因 */
  applySettings(patch: any): { settings: Settings; applied: string[]; rejected: string[] } {
    const { value, rejected } = sanitizeSettings(patch, this.db.settings);
    Object.assign(this.db.settings, value);
    this.save();
    return { settings: this.db.settings, applied: Object.keys(value), rejected };
  }
  updateSettings(patch: Partial<Settings>) {
    return this.applySettings(patch).settings;
  }
}

export function normalizeBaseUrl(url: string) {
  let u = (url || '').trim().replace(/\/+$/, '');
  if (u) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`baseUrl 仅支持 http:// 或 https://：${u}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('baseUrl')) throw err;
      throw new Error(`baseUrl 无法解析：${u}`);
    }
  }
  return u;
}

function makeKey(key: string, name?: string, weight?: number): Channel['keys'][number] {
  return {
    id: newId('k'),
    key: (key || '').trim(),
    name: name || maskKey(key),
    status: 'active',
    weight: weight && weight > 0 ? weight : 1,
    totalRequests: 0,
    totalErrors: 0,
  };
}

export function maskKey(key: string) {
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 6)}***${key.slice(-4)}`;
}

export const store = new Store();
export { newId };
// 只在 exit 时兜底落盘；进程信号交给 index.ts 统一处理，
// 否则这里的 process.exit 会抢在 server.close() 之前把进程掐掉。
process.on('exit', () => store.flushSync());
