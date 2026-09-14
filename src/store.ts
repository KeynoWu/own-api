import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AutoCandidate, AutoRoute, Channel, DBShape, ModelRoute, RequestLog, RouteEntry, Settings, VirtualKey } from './types.ts';
import { envAny, resolveDataDir } from './bootstrap.ts';

const DATA_DIR = resolveDataDir();
const DB_FILE = envAny(['OWN_API_DB_FILE', 'LLM_DB_FILE']) || join(DATA_DIR, 'db.json');

/** 数据目录（last-session.json 等桌面壳交接文件写在这里） */
export function getDataDir() {
  return DATA_DIR;
}

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
    adminToken: envAny(['OWN_API_ADMIN_TOKEN', 'LLM_ADMIN_TOKEN']) || `admin-${randomBytes(9).toString('base64url')}`,
    defaultUpstreamTimeoutMs: n(envAny(['OWN_API_UPSTREAM_TIMEOUT', 'LLM_UPSTREAM_TIMEOUT']), 300_000),
    upstreamIdleTimeoutMs: n(envAny(['OWN_API_IDLE_TIMEOUT', 'LLM_IDLE_TIMEOUT']), 120_000),
    maxBodyBytes: n(envAny(['OWN_API_MAX_BODY_BYTES', 'LLM_MAX_BODY_BYTES']), 64 * 1024 * 1024),
    debugHeaders: envAny(['OWN_API_DEBUG_HEADERS', 'LLM_DEBUG_HEADERS']) === '1',
    maxKeyRetries: n(envAny(['OWN_API_MAX_RETRIES', 'LLM_MAX_RETRIES']), 3),
    errorThreshold: 3,
    cooldownBaseMs: 30_000,
    cooldownMaxMs: 15 * 60_000,
    logRetention: 2000,
    autoMaxChainSeconds: n(envAny(['OWN_API_AUTO_CHAIN_SECONDS', 'LLM_AUTO_CHAIN_SECONDS']), 300),
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
        rejected.push('adminToken：至少 8 个字符（低于 8 位的令牌在限速与随机熵的双重防线外不设防）');
        continue;
      }
      out.adminToken = t;
    } else if (k === 'debugHeaders' || k === 'fallbackChannelId') {
      if (k === 'debugHeaders') {
        // Boolean 强转会把 "false"（字符串）变 true——恰与关闭意图相反（审查 C-L4）
        if (typeof v !== 'boolean') {
          rejected.push('debugHeaders：需为布尔 true/false');
          continue;
        }
        out[k] = v;
      } else {
        if (v !== '' && v !== undefined && v !== null && typeof v !== 'string') {
          rejected.push(`${k}：类型不合法`);
          continue;
        }
        out[k] = (v as string) || undefined;
      }
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

function freshVKey(): VirtualKey {
  return { id: newId('vk'), key: genVirtualKey(), name: 'default', enabled: true, allowedModels: [], createdAt: Date.now() };
}

function emptyDb(): DBShape {
  return { version: 3, quotas: {}, channels: [], routes: [], vkeys: [], logs: [], settings: defaultSettings() };
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
// key 级 PATCH 白名单：主键 id、key 原文、统计、冷却字段拒之门外（对齐 channel/model 设计，审查 C-M2）
const UPDATABLE_KEY_FIELDS = ['status', 'weight', 'name', 'note'];

/** extraHeaders 值级校验：只留可字符串化的值（审查 C-M3——对象值会让 Headers.set 每请求运行期 TypeError） */
function sanitizeExtraHeaders(h: unknown): Record<string, string> | undefined {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

class Store {
  db: DBShape;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  /** 日志单调序号（进程内，从已加载库续起）：日志流按 seq 增量推送，不受裁剪位移影响 */
  private logSeq = 0;

  constructor() {
    this.db = this.load();
    this.logSeq = (Array.isArray(this.db.logs) ? this.db.logs : []).reduce((m, l) => Math.max(m, (l && l.seq) || 0), 0);
  }

  private load(): DBShape {
    if (!existsSync(DB_FILE)) {
      const fresh = emptyDb();
      // 首次启动时生成一个默认可用的对外 key，开箱即用
      fresh.vkeys.push(freshVKey());
      this.persist(fresh);
      return fresh;
    }
    try {
      const parsed = JSON.parse(readFileSync(DB_FILE, 'utf8')) as DBShape;
      const base = emptyDb();
      // JSON 合法但形状损坏的数组字段统一回落：此前 null/字符串穿透 merge，启动即崩且绕过 corrupt 备份（审查 C-M1）
      const arr = <T>(v: unknown): T[] | undefined => (Array.isArray(v) ? (v as T[]) : undefined);
      // 单表 routes（模块合并）；v2 旧库的 models/autoRoutes 两表就地迁移（保留 id 与字段）
      const rawRoutes = arr<RouteEntry>(parsed.routes);
      let migrated = false;
      let routes: RouteEntry[];
      if (rawRoutes) {
        routes = rawRoutes.filter((r) => r && typeof r.id === 'string' && typeof r.publicName === 'string' && (r.type === 'single' || r.type === 'auto'));
      } else {
        const legacy = parsed as unknown as { models?: unknown; autoRoutes?: unknown };
        routes = [
          ...(arr<ModelRoute>(legacy.models) ?? []).map((m) => ({ ...m, type: 'single' as const })),
          ...(arr<AutoRoute>(legacy.autoRoutes) ?? []).map((a) => ({ ...a, type: 'auto' as const })),
        ];
        migrated = Array.isArray(legacy.models) || Array.isArray(legacy.autoRoutes);
      }
      const merged: DBShape = {
        ...base,
        ...parsed,
        channels: arr<Channel>(parsed.channels) ?? base.channels,
        routes,
        vkeys: arr<VirtualKey>(parsed.vkeys) ?? base.vkeys,
        logs: arr<RequestLog>(parsed.logs) ?? [],
        quotas: parsed.quotas && typeof parsed.quotas === 'object' && !Array.isArray(parsed.quotas) ? parsed.quotas : {},
        settings: { ...base.settings, ...(parsed.settings || {}) },
      };
      // 旧双表键不得随 ...parsed 扩散进 v3 库（断言实测抓到：回写会带着 models/autoRoutes 永生）
      delete (merged as any).models;
      delete (merged as any).autoRoutes;
      if (migrated) {
        // 迁移立即回写：崩在半路也不会每次启动重迁
        merged.version = 3;
        console.log('[store] 已将 v2 双表(models/autoRoutes)迁移为单表 routes 并回写');
      }
      // 老库或手工改坏的库兜底：设置项重新过一遍校验
      const { value } = sanitizeSettings(
        Object.fromEntries(Object.entries(merged.settings).filter(([k]) => k !== 'adminToken')),
        base.settings,
      );
      merged.settings = { ...merged.settings, ...value, adminToken: merged.settings.adminToken || base.settings.adminToken };
      if (!Array.isArray(merged.vkeys) || merged.vkeys.length === 0) merged.vkeys = [freshVKey()];
      if (migrated) this.persist(merged);
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
    // fsync 先于 rename：否则断电窗口里 rename 可能指向未落盘内容（审查 C-L1）
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(db, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
        try {
          this.persist();
          this.dirty = false;
        } catch (err) {
          console.error('[store] flush failed', err); // dirty 保持：下次 save 再试（审查 C-L1）
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
    // 创建与 PATCH 同规类型校验（审查 C-M3）：extraHeaders 对象值会让每请求 Headers.set 运行期 TypeError
    const ch: Channel = {
      id: newId('ch'),
      name: String(input.name ?? '').trim(),
      baseUrl: normalizeBaseUrl(String(input.baseUrl ?? '')),
      protocol: input.protocol === 'anthropic' ? 'anthropic' : 'openai',
      keys: (Array.isArray(input.keys) ? input.keys : []).map((k) => makeKey(k.key, k.name, k.weight)),
      enabled: input.enabled !== false,
      extraHeaders: sanitizeExtraHeaders(input.extraHeaders),
      authStyle: input.authStyle === 'bearer' || input.authStyle === 'x-api-key' ? input.authStyle : undefined,
      timeoutMs:
        typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs >= 1000
          ? Math.min(input.timeoutMs, 3_600_000)
          : undefined,
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
    // 容器合法 ≠ 值合法：非字符串值丢弃（与 createChannel 同规，审查 C-M3）
    if (next.extraHeaders !== undefined) next.extraHeaders = sanitizeExtraHeaders(patch.extraHeaders);
    if (typeof next.baseUrl === 'string' && next.baseUrl) next.baseUrl = normalizeBaseUrl(next.baseUrl);
    // modelList 兼容数组 / “每行一个”字符串，统一归一化，避免字符串直接落库
    if (patch.modelList !== undefined) next.modelList = toStrList(patch.modelList) ?? [];
    Object.assign(ch, next);
    this.save();
    return ch;
  }
  deleteChannel(id: string) {
    // 级联：删掉挂在它下面的模型；同时报告哪些 auto 路由的候选会因此悬空（C8）
    const doomed = new Set(this.singles().filter((m) => m.channelId === id).map((m) => m.id));
    const referenced = this.autoRoutesReferencing(doomed);
    this.db.channels = this.db.channels.filter((c) => c.id !== id);
    this.db.routes = this.db.routes.filter((r) => !(r.type === 'single' && r.channelId === id));
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
    if (!k) return false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      // 白名单：id/key 原文/统计/冷却字段拒之门外（对齐 channel/model PATCH，审查 C-M2）
      if (!UPDATABLE_KEY_FIELDS.includes(key)) continue;
      const v = (patch as Record<string, unknown>)[key];
      if (key === 'status' && v !== undefined && !['active', 'cooldown', 'disabled'].includes(String(v))) continue;
      if (key === 'weight' && v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) continue;
      if ((key === 'name' || key === 'note') && v !== undefined && typeof v !== 'string') continue;
      next[key] = v;
    }
    Object.assign(k, next);
    if (patch.status === 'active') {
      k.cooldownUntil = undefined;
      k.lastError = undefined;
    }
    this.save();
    return true;
  }

  // ---------- routes 单表底座（模块合并：对外仍走语义化访问器） ----------
  private singles(): ModelRoute[] {
    return this.db.routes.filter((r): r is ModelRoute => r.type === 'single');
  }
  private autos(): AutoRoute[] {
    return this.db.routes.filter((r): r is AutoRoute => r.type === 'auto');
  }
  /** 统一列表（建表序）：单页合并视图用 */
  listRoutes(): RouteEntry[] {
    return this.db.routes;
  }
  /** 管理面按 id 分派用：不区分类型 */
  getRoute(id: string): RouteEntry | undefined {
    return this.db.routes.find((r) => r.id === id);
  }
  // ---------- model ----------
  listModels() {
    return this.singles();
  }
  getModel(id: string) {
    return this.singles().find((m) => m.id === id);
  }
  findModelByName(name: string) {
    const lower = name.toLowerCase();
    return this.singles().find(
      (m) => m.publicName.toLowerCase() === lower || m.tags?.some((t) => t.toLowerCase() === lower),
    );
  }
  createModel(input: Partial<ModelRoute> & { publicName: string; channelId: string; upstreamModel: string }): { model?: ModelRoute; error?: string } {
    // 模块合并后创建与更新同规撞名校验（auto 名/tags 双向）——此前 POST 可造重名歧义路由
    const taken = this.routeNameTaken(input.publicName.trim());
    if (taken) return { error: taken };
    // W7 语义原样保留：tag 不得遮蔽既有 auto 路由名（旧 admin 校验搬进单表底座）
    const tagHit = Array.isArray(input.tags) ? input.tags.find((t) => typeof t === 'string' && this.autos().some((a) => a.publicName.toLowerCase() === t.trim().toLowerCase())) : undefined;
    if (tagHit) return { error: `tag「${tagHit}」与 auto 路由名冲突` };
    const m: ModelRoute = {
      type: 'single',
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
    this.db.routes.push(m);
    this.save();
    return { model: m };
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
    // 撞名统一走 routeNameTaken（含 auto 名与任意单模型 tags，双向+W7）
    if (typeof next.publicName === 'string' && next.publicName !== m.publicName && this.routeNameTaken(next.publicName, id)) {
      return 'conflict' as const;
    }
    if (typeof next.publicName === 'string' || next.tags !== undefined) {
      const names = [typeof next.publicName === 'string' ? next.publicName : m.publicName, ...(Array.isArray(next.tags) ? next.tags : m.tags || [])]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
      if (this.db.routes.some((r) => r.id !== id && r.type === 'auto' && names.includes(r.publicName.toLowerCase()))) return 'conflict' as const;
    }
    Object.assign(m, next);
    this.save();
    return m;
  }
  deleteModel(id: string) {
    const referenced = this.autoRoutesReferencing(new Set([id]));
    this.db.routes = this.db.routes.filter((r) => r.id !== id);
    this.save();
    return { referencedAutoRoutes: referenced.map((a) => ({ id: a.id, publicName: a.publicName })) };
  }

  // ---------- auto routes ----------
  listAutoRoutes() {
    return this.autos();
  }
  /** auto 名只按 publicName 精确匹配（大小写不敏感）；模型 tags 不参与 auto 名解析 */
  findAutoRouteByName(name: string) {
    const lower = String(name || '').toLowerCase();
    return this.autos().find((a) => a.publicName.toLowerCase() === lower);
  }
  /** 全局撞名（单表后天然统一）：不得与任一 single 的 publicName/tag 或其它 auto 的 publicName 同名 */
  private routeNameTaken(name: string, excludeId?: string): string | undefined {
    const lower = String(name || '').toLowerCase();
    const hit = this.db.routes.find(
      (r) => r.id !== excludeId && (r.publicName.toLowerCase() === lower || (r.type === 'single' && r.tags?.some((t) => t.toLowerCase() === lower))),
    );
    if (!hit) return undefined;
    return hit.type === 'auto' ? '已有同名 auto 路由' : `与模型路由「${hit.publicName}」的外名或 tag 冲突`;
  }
  /** @deprecated 用 routeNameTaken；保留名给 auto 侧调用的语义 */
  private autoNameTaken(name: string, excludeId?: string): string | undefined {
    return this.routeNameTaken(name, excludeId);
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
      // 禁嵌套：候选只能引用单模型路由（悬空 id 仍放行，由删除侧 C8 报告 + 运行时硬过滤兜底）
      const ref = this.getRoute(routeId);
      if (ref && ref.type !== 'single') return { error: '候选只能引用单模型路由（auto 不可嵌套）' };
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
      type: 'auto',
      id: newId('auto'),
      publicName,
      candidates: candidates ?? [],
      stickyTtlMs: ttl,
      enabled: input?.enabled !== false,
      createdAt: Date.now(),
      note: typeof input?.note === 'string' ? input.note : undefined,
    };
    this.db.routes.push(auto);
    this.save();
    return { auto };
  }
  updateAutoRoute(id: string, patch: any): { auto?: AutoRoute; error?: string; missing?: boolean } {
    const found = this.getRoute(id);
    if (!found || found.type !== 'auto') return { missing: true };
    const a = found;
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
    const before = this.db.routes.length;
    this.db.routes = this.db.routes.filter((r) => !(r.id === id && r.type === 'auto'));
    this.save();
    return this.db.routes.length < before;
  }
  /** 哪些 auto 路由引用了这些模型路由（删除前告警，C8） */
  autoRoutesReferencing(routeIds: Set<string>): AutoRoute[] {
    if (!routeIds.size) return [];
    return this.autos().filter((a) => a.candidates.some((c) => routeIds.has(c.routeId)));
  }

  // ---------- virtual keys ----------
  listVKeys() {
    return this.db.vkeys;
  }
  findVKey(key: string) {
    if (!key) return undefined;
    // 常数时间（先各自过 SHA-256，长度也不泄露）——与 admin safeEq 同口径，逐字符短路不再泄露前缀（审查 A-M）
    const want = createHash('sha256').update(key).digest();
    for (const k of this.db.vkeys) {
      if (timingSafeEqual(want, createHash('sha256').update(k.key).digest())) return k;
    }
    return undefined;
  }
  createVKey(input: Partial<VirtualKey> & { name: string }) {
    const key = input.key?.trim() || genVirtualKey();
    // 创建路径与 PATCH 同规（审查 C-M3）：负限额静默变「不限」正是 updateVKey 注释里防的形态
    if (input.key && key.length < 16) throw new Error('自定义公钥过短（至少 16 字符；建议留空自动生成）');
    if (this.db.vkeys.some((v) => v.key === key)) throw new Error('同名公钥已存在（custom key 重复）');
    const limOk = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
    if (!limOk(input.rpmLimit)) throw new Error('rpmLimit 需为非负数字');
    if (!limOk(input.dailyTokenLimit)) throw new Error('dailyTokenLimit 需为非负数字');
    if (input.allowedModels !== undefined && !(Array.isArray(input.allowedModels) && input.allowedModels.every((s) => typeof s === 'string')))
      throw new Error('allowedModels 需为字符串数组');
    const vk: VirtualKey = {
      id: newId('vk'),
      key,
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

/**
 * 出站文本 key 掩码：原文之外连 URL 编码 / base64 / base64url（去 padding）变体一起遮。
 * 上游错误体 echo api_key 时常见编码回显——只匹配原文是掩码链的实测缺口（审查需确认项，预防加固）。
 */
export function scrubSecret(s: string, k: string) {
  if (!s || !k) return s;
  let out = s;
  const mask = maskKey(k);
  const variants = new Set<string>([k]);
  try {
    const enc = encodeURIComponent(k);
    if (enc !== k) variants.add(enc);
  } catch {
    /* ignore */
  }
  const b64 = Buffer.from(k, 'utf8').toString('base64');
  variants.add(b64);
  variants.add(b64.replace(/=+$/, ''));
  for (const v of variants) {
    if (v && out.includes(v)) out = out.split(v).join(mask);
  }
  return out;
}

const LOCK_FILE = `${DB_FILE}.lock`;
/** 同库单实例锁（审查 C-M5）：两个网关同写一份 db.json 会 last-writer-wins 互踩整库。
 *  桌面壳竞态双 spawn 正落在此窗口；持有者已死则回收陈旧锁。 */
function acquireLock() {
  try {
    mkdirSync(dirname(DB_FILE), { recursive: true, mode: 0o700 });
    if (existsSync(LOCK_FILE)) {
      const pid = Number(readFileSync(LOCK_FILE, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          console.error(`[store] 数据目录已被进程 ${pid} 使用（同一 db.json 不能多进程共写），拒绝启动以防互踩；请先停掉另一个实例`);
          process.exit(1);
        } catch {
          /* 持有者已死：陈旧锁，继续接管 */
        }
      }
    }
    writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
  } catch (err) {
    console.error('[store] 锁检查失败（跳过，不阻断启动）：', err);
  }
}
acquireLock();
export const store = new Store();
export { newId };
// 只在 exit 时兜底落盘；进程信号交给 index.ts 统一处理，
// 否则这里的 process.exit 会抢在 server.close() 之前把进程掐掉。
process.on('exit', () => {
  store.flushSync();
  try {
    if (existsSync(LOCK_FILE) && readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
});
