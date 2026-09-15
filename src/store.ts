import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentLink, AutoCandidate, AutoRoute, Channel, DBShape, ModelRoute, RequestLog, RouteEntry, Settings, VirtualKey } from './types.ts';
import { heuristicVision, isVisionSupport } from './vision.ts';
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
    adminToken: envAny(['OWN_API_ADMIN_TOKEN', 'LLM_ADMIN_TOKEN']) || `admin-${randomBytes(18).toString('base64url')}`,
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
    autoSaturation: { enabled: true, baseSec: 60, maxSec: 1800 },
    autoVision: { enabled: true, heuristics: true },
    autoSpeedFactor: { enabled: true, floor: 0.5, cap: 2.0 },
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
    } else if (k === 'autoSaturation') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        rejected.push('autoSaturation：需为 { enabled, baseSec, maxSec } 对象');
        continue;
      }
      const cur = current.autoSaturation || { enabled: true, baseSec: 60, maxSec: 1800 };
      const nv = v as Record<string, unknown>;
      const enabled = nv.enabled === undefined ? cur.enabled : nv.enabled === true;
      const nb = (x: unknown, d: number, lo: number, hi: number) => {
        const x2 = Number(x);
        return Number.isFinite(x2) ? Math.min(hi, Math.max(lo, Math.floor(x2))) : d;
      };
      const baseSec = nb(nv.baseSec, cur.baseSec, 5, 600);
      const maxSec = nb(nv.maxSec, cur.maxSec, 30, 86_400);
      if (baseSec > maxSec) {
        rejected.push('autoSaturation.baseSec：不能大于 maxSec');
        continue;
      }
      out.autoSaturation = { enabled, baseSec, maxSec };
    } else if (k === 'autoVision') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        rejected.push('autoVision：需为 { enabled, heuristics } 对象');
        continue;
      }
      const cur = current.autoVision || { enabled: true, heuristics: true };
      const nv = v as Record<string, unknown>;
      out.autoVision = {
        enabled: nv.enabled === undefined ? cur.enabled : nv.enabled === true,
        heuristics: nv.heuristics === undefined ? cur.heuristics : nv.heuristics === true,
      };
    } else if (k === 'autoSpeedFactor') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        rejected.push('autoSpeedFactor：需为 { enabled, floor, cap } 对象');
        continue;
      }
      const cur = current.autoSpeedFactor || { enabled: true, floor: 0.5, cap: 2.0 };
      const nv = v as Record<string, unknown>;
      const nb = (x: unknown, d: number, lo: number, hi: number) => {
        const x2 = Number(x);
        return Number.isFinite(x2) ? Math.min(hi, Math.max(lo, x2)) : d;
      };
      const floor = nb(nv.floor, cur.floor, 0.1, 1);
      const cap = nb(nv.cap, cur.cap, 1, 10);
      if (floor > cap) {
        rejected.push('autoSpeedFactor.floor：不能大于 cap');
        continue;
      }
      out.autoSpeedFactor = { enabled: nv.enabled === undefined ? cur.enabled : nv.enabled === true, floor, cap };
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
  return { version: 4, quotas: {}, channels: [], routes: [], vkeys: [], logs: [], agentLinks: [], settings: defaultSettings() };
}

/** 归一化成字符串数组：支持数组，或每行一个的字符串；去重去空 */
export function toStrList(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v.map((s) => String(s)) : typeof v === 'string' ? v.split('\n') : [];
  const out = [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
  return out.length ? out : undefined;
}

// PATCH 可写字段白名单：主键、创建时间、号池 keys（走专门的增删接口）等一律拒之门外
const UPDATABLE_CHANNEL_FIELDS = ['name', 'baseUrl', 'protocol', 'enabled', 'extraHeaders', 'authStyle', 'timeoutMs', 'note', 'testModel', 'modelList'];
const UPDATABLE_MODEL_FIELDS = ['publicName', 'channelId', 'upstreamModel', 'protocol', 'enabled', 'contextWindow', 'maxOutputTokens', 'supportsStreaming', 'supportsTools', 'supportsVision', 'visionLocked', 'priceInput', 'priceOutput', 'priceCacheRead', 'priceCacheWrite', 'tags', 'note'];
const UPDATABLE_VKEY_FIELDS = ['name', 'enabled', 'allowedModels', 'rpmLimit', 'dailyTokenLimit', 'note'];
// key 级 PATCH 白名单：主键 id、key 原文、统计、冷却字段拒之门外（对齐 channel/model 设计，审查 C-M2）
const UPDATABLE_KEY_FIELDS = ['status', 'weight', 'name', 'note'];

/** extraHeaders 值级校验：只留可字符串化的值（审查 C-M3——对象值会让 Headers.set 每请求运行期 TypeError） */
export function sanitizeExtraHeaders(h: unknown): Record<string, string> | undefined {
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
  private pendingMigration = false;

  constructor() {
    this.db = this.load();
    if (this.pendingMigration) {
      // 迁移回写移出 load（审查 P2）：写失败 ≠ 数据损坏——保留内存态并稍后重试，
      // 不再在解析 try/catch 里把健康数据误判成 corrupt 搬走
      this.pendingMigration = false;
      try {
        this.persist();
      } catch (err) {
        console.error('[store] v2→v3 迁移回写失败（内存态继续服务，稍后重试）', err);
        this.save();
      }
    }
    this.logSeq = (Array.isArray(this.db.logs) ? this.db.logs : []).reduce((m, l) => Math.max(m, (l && l.seq) || 0), 0);
  }

  // R3[中3]：装载失败（IO/权限/损坏但备份改名也失败）时禁 persist——空库绝不许覆盖读不到的原库
  private loadBlocked = false;

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
      // 元素级形状过滤（审查 P2）：字段级 arr<T> 只兜非数组；单条坏元素（缺 id 的路由/无 baseUrl 的渠道）
      // 会带病进内存毒化所有运行期读路径。迁移分支同规——此前 legacy 完全不设防。
      const validRoute = (r: any): r is RouteEntry =>
        !!r && typeof r.id === 'string' && r.id !== '' && typeof r.publicName === 'string' && r.publicName !== '' && (r.type === 'single' || r.type === 'auto');
      let routes: RouteEntry[];
      if (rawRoutes) {
        routes = rawRoutes;
      } else {
        const legacy = parsed as unknown as { models?: unknown; autoRoutes?: unknown };
        routes = [
          ...(arr<any>(legacy.models) ?? []).map((m) => ({ ...m, type: 'single' as const })),
          ...(arr<any>(legacy.autoRoutes) ?? []).map((a) => ({ ...a, candidates: Array.isArray((a as any)?.candidates) ? (a as any).candidates : [], type: 'auto' as const })),
        ];
        migrated = Array.isArray(legacy.models) || Array.isArray(legacy.autoRoutes);
      }
      const keptRoutes = routes.filter(validRoute);
      if (keptRoutes.length !== routes.length) console.warn(`[store] routes 丢弃 ${routes.length - keptRoutes.length} 条非法条目（缺 id/publicName 或 type 非法）`);
      const seenIds = new Set<string>();
      routes = keptRoutes.filter((r) => {
        if (seenIds.has(r.id)) {
          console.warn(`[store] 重复路由 id ${r.id}：仅保留首条`);
          return false;
        }
        seenIds.add(r.id);
        return true;
      });
      // R3[高危2]：v3 分支 auto 缺 candidates/候选元素脏同样毒化五类读路径（auto 对话、/v1/models、
      // GET /api/routes、删除级联、前端渲染）——v2 分支当年只修了一半，这里统一归一候选层。
      routes = routes.map((r: any) => {
        if (r.type !== 'auto') return r;
        const cdRaw = Array.isArray(r.candidates) ? r.candidates : [];
        if (!Array.isArray(r.candidates)) console.warn(`[store] auto 路由 ${r.publicName} 缺 candidates，兜底空候选`);
        const cd = cdRaw.filter((x: any) => !!x && typeof x === 'object' && typeof x.routeId === 'string');
        if (cd.length !== cdRaw.length) console.warn(`[store] auto 路由 ${r.publicName} 丢弃 ${cdRaw.length - cd.length} 个坏候选元素`);
        return { ...r, candidates: cd };
      });
      // R3[低6/S1]：坏 protocol 降级 openai+warn（旧库存量拼写变体曾正常工作，整渠道误杀过重）；
      // keys 元素级清洗：缺 id/key 的元素会被 pickKey 当 Bearer undefined 打上游搅冷却
      const chanOK = (ch: any) => !!ch && typeof ch.id === 'string' && typeof ch.baseUrl === 'string' && /^https?:\/\//i.test(ch.baseUrl);
      const chanRaw = arr<Channel>(parsed.channels) ?? base.channels;
      const channels = chanRaw.filter(chanOK).map((ch: any) => {
        let protocol = ch.protocol;
        if (protocol !== 'openai' && protocol !== 'anthropic') {
          console.warn(`[store] 渠道 ${ch.id} protocol ${JSON.stringify(ch.protocol)} 不识别，兜底 openai`);
          protocol = 'openai';
        }
        const keysRaw = Array.isArray(ch.keys) ? ch.keys : [];
        const keys = keysRaw.filter((k: any) => !!k && typeof k.id === 'string' && typeof k.key === 'string' && k.key !== '');
        if (keys.length !== keysRaw.length) console.warn(`[store] 渠道 ${ch.id} 丢弃 ${keysRaw.length - keys.length} 个坏 key 元素`);
        return { ...ch, protocol, keys };
      });
      if (channels.length !== chanRaw.length) console.warn(`[store] channels 丢弃 ${chanRaw.length - channels.length} 条非法条目（缺 id/baseUrl 非 http(s)/protocol 非法/keys 非数组）`);
      const vkOK = (v: any) => !!v && typeof v.id === 'string' && typeof v.key === 'string' && v.key !== '';
      const vkRaw = arr<VirtualKey>(parsed.vkeys) ?? base.vkeys;
      const vkeys = vkRaw.filter(vkOK);
      if (vkeys.length !== vkRaw.length) console.warn(`[store] vkeys 丢弃 ${vkRaw.length - vkeys.length} 条非法条目`);
      // v4 agentLinks（agent 接入登记）：同规做元素级过滤——缺 agentId/vkeyId 的条目会让
      // GET /api/agents 与撤销路径带病运行（targets 非数组更是在 join 处直接抛）
      const linkOK = (l: any) => !!l && typeof l.agentId === 'string' && l.agentId !== '' && typeof l.vkeyId === 'string' && Array.isArray(l.targets);
      const linkRaw = arr<any>(parsed.agentLinks) ?? [];
      const agentLinks = linkRaw.filter(linkOK).map((l) => ({
        ...l,
        targets: l.targets.filter((p: unknown) => typeof p === 'string' && (p as string).startsWith('/')),
        roles: l.roles && typeof l.roles === 'object' && !Array.isArray(l.roles) ? l.roles : undefined,
        prev: l.prev && typeof l.prev === 'object' && !Array.isArray(l.prev) ? l.prev : undefined,
      }));
      if (agentLinks.length !== linkRaw.length) console.warn(`[store] agentLinks 丢弃 ${linkRaw.length - agentLinks.length} 条非法条目`);
      const logRaw = arr<RequestLog>(parsed.logs) ?? [];
      const logs = logRaw.filter((l: any) => !!l && typeof l.ts === 'number');
      const merged: DBShape = {
        ...base,
        ...parsed,
        channels,
        routes,
        vkeys,
        logs,
        agentLinks,
        quotas: parsed.quotas && typeof parsed.quotas === 'object' && !Array.isArray(parsed.quotas) ? parsed.quotas : {},
        settings: { ...base.settings, ...(parsed.settings || {}) },
      };
      // 旧双表键不得随 ...parsed 扩散进 v3 库（断言实测抓到：回写会带着 models/autoRoutes 永生）
      delete (merged as any).models;
      delete (merged as any).autoRoutes;
      if (migrated) {
        merged.version = 3;
        this.pendingMigration = true;
        console.log('[store] 已将 v2 双表(models/autoRoutes)迁移为单表 routes，构造完成后回写');
      }
      // v3→v4：仅新增 agentLinks 数组字段，无字段改名/语义变更 → 补空即迁移完成，回写只为让盘上版本号诚实
      if (!Array.isArray((parsed as any).agentLinks) || (merged.version || 0) < 4) {
        merged.version = 4;
        this.pendingMigration = true;
      }
      // 老库或手工改坏的库兜底：设置项重新过一遍校验
      const { value } = sanitizeSettings(
        Object.fromEntries(Object.entries(merged.settings).filter(([k]) => k !== 'adminToken')),
        base.settings,
      );
      // R3[中4]：以 base 默认+净化结果为准——非法原值不得从文件直通运行期（logRetention:-5 曾每写即清空）
      merged.settings = { ...base.settings, ...value, adminToken: merged.settings.adminToken || base.settings.adminToken };
      if (!Array.isArray(merged.vkeys) || merged.vkeys.length === 0) merged.vkeys = [freshVKey()];
      return merged;
    } catch (err) {
      // 审查 P2：只有 JSON 真解析不动才配 .corrupt 改名备份；IO/权限等装载异常不得把健康数据当损坏搬走
      if (err instanceof SyntaxError) {
        const backup = `${DB_FILE}.corrupt-${Date.now()}`;
        try {
          renameSync(DB_FILE, backup);
        } catch {
          this.loadBlocked = true; // 备份改名失败=没有安全网，禁 persist 保原数据
          console.error('[store] corrupt 备份改名失败，本次运行禁止回写以保护原文件');
        }
        console.error(`[store] db.json 解析失败，已备份到 ${backup}，使用空库启动`, err);
      } else {
        this.loadBlocked = true; // R3[中3]：原文件unreadable≠不存在，空库只能内存跑
        console.error('[store] db.json 装载异常（不判损坏、不改名，空库兜底启动，原文件保留并禁止回写）：', err);
      }
      const fb = emptyDb();
      fb.vkeys.push(freshVKey()); // R3[缺口b]：恢复库同样开箱可用（此前无默认 key，/v1 全 401）
      if (!this.loadBlocked) this.persist(fb);
      return fb;
    }
  }

  private persist(db: DBShape = this.db) {
    if (this.loadBlocked) {
      console.error('[store] 上次装载未成功，拒绝回写（防止空库顶掉不可读的原库，R3[中3]）');
      return;
    }
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
      // 先落盘成功再清脏（审查 P2）：persist 异常时保留脏标记等防抖窗重试；旧顺序在 exit 钩子里丢最后一秒数据
      try {
        this.persist();
        this.dirty = false;
      } catch (err) {
        console.error('[store] flushSync 落盘失败（保留脏标记，下次机会重试）', err);
      }
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
      // 空串 key 会造出恒失败的 key 反复吃池（审查 P2）：入口拒收
      keys: (Array.isArray(input.keys) ? input.keys : [])
        .filter((k) => !!k && typeof k.key === 'string' && k.key.trim() !== '')
        .map((k) => makeKey(k.key, k.name, k.weight)),
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
    // 审查：baseUrl:123/"" 此前直落库——buildUrl 抛错让 GET /channels 全量 500；空串产出相对路径、fetch Invalid URL 反复换 key 冷却整池
    if (patch.baseUrl !== undefined && (typeof next.baseUrl !== "string" || !next.baseUrl.trim() || !/^https?:\/\//.test(next.baseUrl.trim()))) delete next.baseUrl;
    else if (typeof next.baseUrl === "string" && next.baseUrl) next.baseUrl = normalizeBaseUrl(next.baseUrl);
    if (patch.note !== undefined && next.note !== undefined && typeof next.note !== "string") delete next.note;
    if (patch.testModel !== undefined && next.testModel !== undefined && typeof next.testModel !== "string") delete next.testModel;

    // modelList 兼容数组 / “每行一个”字符串，统一归一化，避免字符串直接落库
    if (patch.modelList !== undefined) {
      const ml = toStrList(patch.modelList);
      if (ml) next.modelList = ml; // R3[S3]：换算不动的值保持原清单，不再静默吞成 []
      else delete next.modelList;
    }
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
    // M0-a：创建路径与 PATCH 同规——此前 tags/数字字段裸存，一条 POST tags:"x" 就能让
    // findModelByName 每请求 TypeError（全局 502）且毒数据落库、重启不愈
    if (input.tags !== undefined && !(Array.isArray(input.tags) && input.tags.every((t) => typeof t === 'string'))) return { error: 'tags 需为字符串数组' };
    for (const nk of ['contextWindow', 'maxOutputTokens', 'priceInput', 'priceOutput', 'priceCacheRead', 'priceCacheWrite'] as const) {
      const v = input[nk];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return { error: nk + ' 需为 ≥0 的数字' };
    }
    for (const t of Array.isArray(input.tags) ? input.tags : []) {
      const conflict = this.routeNameTaken(String(t));
      if (conflict) return { error: 'tag "' + t + '" ' + conflict };
    }
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
    // AR-6 启发式初值（P1.5）：显式传入优先；否则已知多模态家族 → true，其余 unknown（undefined）。
    // 表只做先验，可经 settings.autoVision.heuristics 关闭
    if (input.supportsVision === true || input.supportsVision === false || input.supportsVision === 'unknown') {
      m.supportsVision = input.supportsVision;
      m.visionLocked = input.visionLocked;
    } else if ((this.db.settings.autoVision || { heuristics: true }).heuristics !== false) {
      m.supportsVision = heuristicVision(input.upstreamModel, input.publicName);
    }
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
      // F5：protocol 纳入 null=清除（「跟随渠道」的 UI 承诺此前是静默 no-op）
      if (v === null && k !== 'publicName' && k !== 'channelId' && k !== 'upstreamModel' && k !== 'enabled' && k !== 'supportsStreaming' && k !== 'supportsTools') { next[k] = undefined; continue; } // 前端契约（审查 M2）：null=清除；字符串/布尔的 null 仍被下方类型检查丢弃

      if (k === 'protocol' && v !== undefined && v !== 'openai' && v !== 'anthropic') continue;
      if (k === 'supportsVision' && !isVisionSupport(v)) continue; // 三态白名单：true/false/'unknown'，其余丢弃
      if ((k === 'enabled' || k === 'supportsStreaming' || k === 'supportsTools' || k === 'visionLocked') && typeof v !== 'boolean') continue;
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
      // 审查 P2：本次变更引入的每一个名字（新外名+全部 tag）都要过 routeNameTaken——
      // 旧检查只比对 auto 名，tag 撞上其它 single 的 publicName/tag 会静默双解析歧义
      const names = new Set<string>();
      if (typeof next.publicName === 'string') names.add(next.publicName.toLowerCase());
      if (next.tags !== undefined) for (const t of Array.isArray(next.tags) ? next.tags : []) if (typeof t === 'string' && t) names.add(t.toLowerCase());
      for (const n of names) if (this.routeNameTaken(n, id)) return 'conflict' as const;
    }
    // F6.3：显式改 supportsVision（未同时给 visionLocked）= 用户手动标注 → 锁定，被动学习不再覆盖。
    // 重置口（/routes/:id/vision/reset）同时带 visionLocked=false，走 'in next' 分支不误锁
    if (next.supportsVision !== undefined && !('visionLocked' in next)) next.visionLocked = true;
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
  routeNameTaken(name: string, excludeId?: string): string | undefined {
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
    // agentLinks 刻意不随删：link 悬空是可见事实（agent 里还躺着配置），由「已接入」页如实展示并可撤销，
    // 静默清账本会让用户以为 agent 侧也被清理过（docs/agent-import-design.md §14 AI-16）
  }

  // ---------- agent links（v4：一键接入登记，docs/agent-import-design.md §2.3） ----------
  listAgentLinks() {
    return this.db.agentLinks;
  }
  getAgentLink(agentId: string) {
    return this.db.agentLinks.find((l) => l.agentId === agentId);
  }
  /** 同 agentId 覆盖写（重复接入=更新）。**同步落盘不走防抖**：接入回执一经发出盘上就必须已有账，
   *  否则「回执说已接入、此刻还没有」的观测窗会让撤销/漂移两条后续路径读到空账本（DR-CB 同口径） */
  upsertAgentLink(link: AgentLink) {
    const i = this.db.agentLinks.findIndex((l) => l.agentId === link.agentId);
    if (i >= 0) this.db.agentLinks[i] = link;
    else this.db.agentLinks.push(link);
    this.flushSync();
    return link;
  }
  removeAgentLink(agentId: string) {
    const before = this.db.agentLinks.length;
    this.db.agentLinks = this.db.agentLinks.filter((l) => l.agentId !== agentId);
    this.flushSync();
    return this.db.agentLinks.length < before;
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
  // 审查 P3：base64url（JWT 圈惯例变体）与小写-%xx（日志二次转义后的大小写形态）也进变体集
  variants.add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  try {
    variants.add(encodeURIComponent(k).replace(/%([0-9A-F]{2})/g, (_m, h) => '%' + h.toLowerCase()));
  } catch {
    /* ignore */
  }
  for (const v of variants) {
    if (v && out.includes(v)) out = out.split(v).join(mask);
  }
  return out;
}

const LOCK_FILE = `${DB_FILE}.lock`;
/** 同库单实例锁（审查 C-M5）：两个网关同写一份 db.json 会 last-writer-wins 互踩整库。
 *  桌面壳竞态双 spawn 正落在此窗口；持有者已死则回收陈旧锁。 */
function acquireLock() {
  mkdirSync(dirname(DB_FILE), { recursive: true, mode: 0o700 });
  const payload = () => process.pid + ' ' + Date.now();
  try {
    // 原子占锁（审查 P2）：flag wx 由内核裁决竞态——旧的 existsSync→write 双检窗口里
    // 两个进程可同时判定对方已死、双双起网关互踩整库（桌面壳双 spawn 正在这窗口）
    writeFileSync(LOCK_FILE, payload(), { mode: 0o600, flag: 'wx' });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.error('[store] 锁写入失败（跳过，不阻断启动）：', err);
      return;
    }
  }
  let holder = 0;
  try {
    holder = parseInt(readFileSync(LOCK_FILE, 'utf8').trim().split(/\s+/)[0] || '', 10) || 0;
  } catch {
    /* 读不动按陈旧锁处理 */
  }
  let alive = false;
  if (holder > 0 && holder !== process.pid) {
    try {
      process.kill(holder, 0);
      alive = true;
    } catch (e) {
      // EPERM=活着（别人的进程，绝不能夺锁）；只有 ESRCH 才算死
      alive = (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  if (alive) {
    console.error(`[store] 数据目录已被进程 ${holder} 使用（同一 db.json 不能多进程共写），拒绝启动以防互踩；请先停掉另一个实例`);
    process.exit(1);
  }
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(LOCK_FILE, payload(), { mode: 0o600, flag: 'wx' });
  } catch {
    console.error('[store] 陈旧锁接管在竞态中败给另一实例，拒绝启动');
    process.exit(1);
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
    // R3[高危1]：锁内容是「pid ts」（P2 改了写入格式漏改这里）→ 比对永假 → 正常退出永不清锁
    const lockRaw = existsSync(LOCK_FILE) ? readFileSync(LOCK_FILE, 'utf8').trim() : '';
    if (lockRaw && lockRaw.split(' ')[0] === String(process.pid)) unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
});
