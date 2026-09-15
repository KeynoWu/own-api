/**
 * auto 路由的运行时态（设计文档 docs/model-auto-design.md §3）：
 * - 候选级健康分：每候选一份内存环形窗口，判负/成功的当下即时记录。
 *   不复用 RequestLog——一请求一条、只记终态，"先败 A 后成 B"时 A 的失败在其中不存在（B2）。
 * - 粘性 Map：vkeyId + autoName -> routeId，内存态、重启即清空（C0/C15）。
 * 聚合键 = routeId（改名不破窗，C14：全局共享，单用户工具无租户隔离需求）。
 */

const WATCH_WINDOW_MS = 600_000;
const MAX_SAMPLES = 256; // 每候选样本上限，环形截断（远大于 10min 内个人流量，纯防泄漏）

/** 迟滞带（C3）：粘性保持用下限 0.4；重新入粘要回到 0.6，中间带"保持不新建" */
export const STICKY_KEEP = 0.4;
export const STICKY_RESTICK = 0.6;

interface Sample {
  ts: number;
  ok: 1 | 0;
}
const windows = new Map<string, Sample[]>();

// 时钟钩子（设计稿 G 时钟注入点）：测试可冻结/推进时间，覆盖限频与滑动窗在真实时钟下不可写的负例与恢复侧
let clockNow: () => number = () => Date.now();
export function setClockForTest(fn: () => number) { clockNow = fn; }

// 失败样本限频（F6.1 + G12 修订）：每 (routeId, vkey) 每分钟至多 1 个失败样本。
// 只限失败、不限成功——连成功一起限会反向放大污染（30RPM 诚实流量被 1 败/min 打成恒 0.5）；
// 成功样本不限频（环形上限兜底），封顶"定向刷失败拉低候选"的污染速度。
const FAIL_RATE_LIMIT_MS = 60_000;
const lastFailAt = new Map<string, number>(); // key: routeId \u0000 vkeyId

function prune(list: Sample[], now: number): Sample[] {
  let i = 0;
  while (i < list.length && now - list[i].ts > WATCH_WINDOW_MS) i++;
  if (i > 0) list.splice(0, i);
  if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
  return list;
}

/**
 * 候选级样本：成功/失败的当下即时记录（429、客户端取消、超窗类 400 由调用方决定不调用，C11/C10/§8-4）。
 * vkeyId 传入时失败样本按 (routeId, vkeyId) 限频；未传（管理端直测等无 key 流量）不限。
 */
export function recordAttempt(routeId: string, ok: boolean, vkeyId?: string) {
  if (!routeId) return;
  const now = clockNow();
  if (!ok && vkeyId) {
    const lk = `${routeId}\u0000${vkeyId}`;
    const last = lastFailAt.get(lk);
    if (last !== undefined && now - last < FAIL_RATE_LIMIT_MS) return; // 限频：丢弃本次失败样本
    lastFailAt.set(lk, now);
  }
  const list = prune(windows.get(routeId) || [], now);
  list.push({ ts: now, ok: ok ? 1 : 0 });
  windows.set(routeId, list);
}

/**
 * health(routeId)（§3.1 + G12 守卫前置）：
 *   样本 < 3                    → 1.0（冷启动不惩罚——前置后单败/双挂不再瞬间钉 0.1，
 *                                 配合失败限频，毒化成本抬到 ≥3 败/10min 且需跨 vkey）
 *   fail>0 且 ok==0（≥3 样本）   → 0.1（C4：全挂不得满血；C4 注释「0 成 2 挂」字面即 total≥3）
 *   否则                        → max(0.1, ok/(ok+fail))
 */
export function health(routeId: string): number {
  const list = prune(windows.get(routeId) || [], clockNow());
  const total = list.length;
  if (!total) return 1.0;
  const ok = list.reduce((n, s) => n + s.ok, 0);
  const fail = total - ok;
  if (total < 3) return 1.0;
  if (fail > 0 && ok === 0) return 0.1;
  return Math.max(0.1, ok / total);
}

/** 管理台观测出口：窗口内所有候选的 ok/fail/health */
export function healthSnapshot() {
  const now = clockNow();
  const out: { routeId: string; ok: number; fail: number; health: number }[] = [];
  for (const [routeId, raw] of windows) {
    const list = prune(raw, now);
    if (!list.length) continue;
    const ok = list.reduce((n, s) => n + s.ok, 0);
    out.push({ routeId, ok, fail: list.length - ok, health: health(routeId) });
  }
  return out;
}

export function clearHealth() {
  windows.clear();
  lastFailAt.clear();
}

/** 路由删除时清理其窗口与限频条目，防止两个 Map 随历史 routeId 单调增长 */
export function clearHealthFor(routeId: string) {
  windows.delete(routeId);
  for (const k of [...lastFailAt.keys()]) if (k.startsWith(routeId + '\u0000')) lastFailAt.delete(k);
}

// ---------------------------------------------------------------- 粘性

export interface StickyEntry {
  routeId: string;
  expiresAt: number;
  /** 饱和绕行续期标记（F1.1/SAT-5）：绑定在目标的兜档期续上的；非绕行命中即清除转正 */
  degraded?: boolean;
}
const STICKY_MAX = 1000;
const sticky = new Map<string, StickyEntry>();

const stickKey = (vkeyId: string, autoName: string) => `${vkeyId}\u0000${autoName.toLowerCase()}`;

/** 取粘性记录；过期即删。不在这里续期——续期只发生在"本次真的用了它"时（命中续期） */
export function getSticky(vkeyId: string, autoName: string): StickyEntry | undefined {
  const k = stickKey(vkeyId, autoName);
  const e = sticky.get(k);
  if (!e) return undefined;
  if (e.expiresAt <= clockNow()) {
    sticky.delete(k);
    return undefined;
  }
  return e;
}

/** 命中续期（滑动 TTL，C5）；顺带刷新 LRU 位置。degraded=true 仅饱和绕行续期（F1.1），命中转正默认 false */
export function touchSticky(vkeyId: string, autoName: string, ttlMs: number, degraded = false) {
  const k = stickKey(vkeyId, autoName);
  const e = sticky.get(k);
  if (!e) return;
  sticky.delete(k);
  e.expiresAt = clockNow() + ttlMs;
  e.degraded = degraded || undefined;
  sticky.set(k, e);
}

/** 新建/覆盖绑定（调用方负责回粘阈值 health >= STICKY_RESTICK 与"绕行不覆写"的判定） */
export function setSticky(vkeyId: string, autoName: string, routeId: string, ttlMs: number) {
  const k = stickKey(vkeyId, autoName);
  sticky.delete(k);
  sticky.set(k, { routeId, expiresAt: clockNow() + ttlMs });
  while (sticky.size > STICKY_MAX) sticky.delete(sticky.keys().next().value as string);
}

/** 改写清单触发：删除记录（TTL 外唯一让粘性"改写"的路径，§3.2） */
export function deleteSticky(vkeyId: string, autoName: string) {
  sticky.delete(stickKey(vkeyId, autoName));
}

export function stickyCount() {
  return sticky.size;
}

export function clearSticky() {
  sticky.clear();
}

const stickySuffix = (autoName: string) => String.fromCharCode(0) + autoName.toLowerCase(); // 与 stickKey 同源的名后缀判定：只允许这一个拼法

/** 按路由名探测粘性绑定数（/auto-health?route= 观测口，不改数据） */
export function stickyCountForRoute(autoName: string): number {
  const suffix = stickySuffix(autoName);
  let n = 0;
  for (const k of sticky.keys()) if (k.endsWith(suffix)) n++;
  return n;
}

/** 按路由名清粘性（路由页「粘性立即生效」按钮）：改权重/候选后要立刻接管分流，不等 TTL/重启 */
export function clearStickyForRoute(autoName: string): number {
  const suffix = stickySuffix(autoName);
  let n = 0;
  for (const k of [...sticky.keys()]) if (k.endsWith(suffix)) { sticky.delete(k); n++; }
  return n;
}

// ---------------------------------------------------------------- 加权

/**
 * 加权随机（③）：有效权重 = weight × health。
 * 权重和为 0（理论不可达：weight>=1 且 health>=0.1）时退化为均匀。
 * NaN 权重按 0 兜底（NAN-1）：单个 NaN 不得毒化 sum 触发整体均匀退化。
 */
export function pickWeighted<T>(items: T[], weightOf: (t: T) => number, rand: () => number = Math.random): T {
  const weights = items.map((it) => {
    const w = weightOf(it);
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  let sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) {
    sum = items.length;
    weights.fill(1);
  }
  let r = rand() * sum;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------- 饱和态（§2，AR-4）

/** 饱和配置（settings.autoSaturation，热读；缺省兜底开） */
export interface SaturationConfig { enabled: boolean; baseMs: number; maxMs: number }
export const SAT_DEFAULTS: SaturationConfig = { enabled: true, baseMs: 60_000, maxMs: 1_800_000 };
/** settings.autoSpeedFactor → 运行时配置；未配置兜底开 */
export function speedConfigOf(s?: { enabled: boolean; floor: number; cap: number }): SpeedConfig {
  if (!s) return SPEED_DEFAULTS;
  return { enabled: s.enabled, floor: s.floor, cap: s.cap };
}

/** settings.autoSaturation（秒）→ 运行时配置（毫秒）；未配置时兜底开（旧库升级不回退语义） */
export function satConfigOf(s?: { enabled: boolean; baseSec: number; maxSec: number }): SaturationConfig {
  if (!s) return SAT_DEFAULTS;
  return { enabled: s.enabled, baseMs: s.baseSec * 1000, maxMs: s.maxSec * 1000 };
}

interface SatEntry { until: number; n: number }
const saturated = new Map<string, SatEntry>();

// 触发 (b)（F1.2/G7/G10）：60s 滑动窗内跨 key 累计 ≥2 次 429——同 key 只计首值，
// 窗内出现成功样本即整窗清零（G7：健康高并发候选的零星 429 是常态，绝不误杀）
const SAT_WINDOW_MS = 60_000;
const satWin = new Map<string, Map<string, number>>(); // routeId → (keyId → 首次 429 ts)
const SAT_ABS_MAX_MS = 24 * 3_600_000; // G8：retry-after 可突破 maxSec，但 24h 绝对帽（pool 实证过 11.6 天响应头）
export const SAT_PROBE_MS = 5_000;     // 剩余 <5s 且预算足 → 仍试（探测例外）

/** 饱和剩余毫秒（0=未饱和）。gateway 的存活集过滤/探测例外/G1 合成 429 全走此口——与时钟钩子一致，可测 */
export function satLeftMs(routeId: string): number {
  const until = saturatedUntil(routeId);
  return until ? until - clockNow() : 0;
}

/** 候选是否处于饱和期；返回 0 = 未饱和。过期惰性清除 */
export function saturatedUntil(routeId: string): number {
  const e = saturated.get(routeId);
  if (!e) return 0;
  if (e.until <= clockNow()) {
    saturated.delete(routeId);
    return 0;
  }
  return e.until;
}

/**
 * 429 入窗（attemptRoute key 循环逐 key 调用）。同 key 窗内只计首值（G10：key 级冷却已罚过）；
 * 跨 key ≥2 → 触发 (b)。饱和期内的探测 429 不入窗。仅记状态，不参与健康分（C11 不变）。
 */
export function satNote429(routeId: string, keyId: string, upstreamRetryAfterMs: number | undefined, cfg: SaturationConfig) {
  if (!routeId || !cfg.enabled) return;
  const now = clockNow();
  if (saturatedUntil(routeId)) return;
  const win = satWin.get(routeId) || new Map<string, number>();
  for (const [k, ts] of win) if (now - ts > SAT_WINDOW_MS) win.delete(k);
  if (!win.has(keyId)) win.set(keyId, now);
  satWin.set(routeId, win);
  if (win.size >= 2) triggerSaturation(routeId, undefined, cfg, now);
}

/** 成功样本（G7 + SAT-4）：清零滑动窗计数；若处于饱和期（只可能是 <5s 探测路径试出来的）→ 整个饱和态清零、退避回 1 档 */
export function satNoteSuccess(routeId: string) {
  if (!routeId) return;
  satWin.delete(routeId);
  saturated.delete(routeId);
}

/**
 * 进入/续期饱和（触发 (a)：号池全 key 429，由 gateway 在 candidate_fail 后调用；(b)：滑动窗，内部调用）。
 * 时长 = min(base × 2^(n-1), maxSec)；上游显式 retry-after 取 max(退避, retry-after) 且不受 maxSec 约束，
 * 但受 24h 绝对帽（F4.3/G8）。G11 单调：已饱和时只延长不缩短；同一饱和 episode 内重触发不递增 n
 * （防 (a)+(b) 同请求双触发把退避翻两档）；探测成功（SAT-4）是唯一清零路径。
 */
export function triggerSaturation(routeId: string, upstreamRetryAfterMs: number | undefined, cfg: SaturationConfig, now = clockNow()): number {
  if (!routeId || !cfg.enabled) return 0;
  const prev = saturated.get(routeId);
  if (prev && prev.until > now) {
    const backoff = Math.min(cfg.baseMs * Math.pow(2, prev.n - 1), cfg.maxMs); // 同一 episode：当档公式，不预支下一档
    let until2 = now + backoff;
    if (upstreamRetryAfterMs && upstreamRetryAfterMs > 0) until2 = Math.max(until2, now + upstreamRetryAfterMs);
    saturated.set(routeId, { until: Math.max(prev.until, Math.min(until2, now + SAT_ABS_MAX_MS)), n: prev.n });
    satWin.delete(routeId);
    return saturated.get(routeId)!.until;
  }
  const n = (prev?.n ?? 0) + 1;
  const backoff = Math.min(cfg.baseMs * Math.pow(2, n - 1), cfg.maxMs);
  let until = now + backoff;
  if (upstreamRetryAfterMs && upstreamRetryAfterMs > 0) until = Math.max(until, now + upstreamRetryAfterMs);
  saturated.set(routeId, { until: Math.min(until, now + SAT_ABS_MAX_MS), n });
  satWin.delete(routeId);
  return saturated.get(routeId)!.until;
}

/** 管理台观测（R8）：未过期饱和条目（含剩余秒数与连续档位） */
export function saturationSnapshot() {
  const now = clockNow();
  const out: { routeId: string; until: number; leftSec: number; n: number }[] = [];
  for (const [routeId, e] of saturated) {
    if (e.until <= now) {
      saturated.delete(routeId);
      continue;
    }
    out.push({ routeId, until: e.until, leftSec: Math.ceil((e.until - now) / 1000), n: e.n });
  }
  return out;
}

export function clearSaturation() {
  saturated.clear();
  satWin.clear();
}

/** 按路由名清饱和（管理台「清除饱和」按钮；返回清除条数） */
export function clearSaturationForRoute(routeId: string): number {
  const had = saturated.delete(routeId) ? 1 : 0;
  satWin.delete(routeId);
  return had;
}

/** /auto-health?route= 的粘性明细出口（SAT-5 断言 degraded 用） */
export function stickyListForRoute(autoName: string): { vkeyId: string; routeId: string; expiresAt: number; degraded: boolean }[] {
  const suffix = stickySuffix(autoName);
  const out: { vkeyId: string; routeId: string; expiresAt: number; degraded: boolean }[] = [];
  for (const [k, e] of sticky) {
    if (!k.endsWith(suffix)) continue;
    out.push({ vkeyId: k.slice(0, k.indexOf('\u0000')), routeId: e.routeId, expiresAt: e.expiresAt, degraded: !!e.degraded });
  }
  return out;
}

// ---------------------------------------------------------------- 速度因子（§3，AR-5）

/** 速度配置（settings.autoSpeedFactor，热读） */
export interface SpeedConfig { enabled: boolean; floor: number; cap: number }
export const SPEED_DEFAULTS: SpeedConfig = { enabled: true, floor: 0.5, cap: 2.0 };

interface SpeedSample { ts: number; tokPerSec: number; ttftMs: number }
const SPEED_WINDOW_MS = 3_600_000;          // R3：速度窗 1h（慢不需要秒级反应，与健康 10min 窗刻意不同）
const MAX_SPEED_SAMPLES = 256;              // F1.4：环形上限，与健康窗对齐
const EMA_ALPHA = 0.3;                      // R3
const SPEED_HALF_LIFE_MS = 3_600_000;       // F3.1/F3.4：样本滚出后按 1h 半衰期指数衰减回 1，不做硬重置
const SPEED_MIN_SAMPLES = 3;                // 冷启动口径：样本 <3 → factor=1 / 视为未慢降
const SPEED_RECOMPUTE_MS = 5_000;           // 读侧 5s 计算缓存（不逐请求扫全量）
const STICKY_SLOW_DEMOTE = 3.0;             // G16：降粘 = TTFT ≥3× 自身基线（自身历史 p50 的 EMA，非跨候选比值）
export const TTFT_RESTICK_X = 2.0;          // F3.2/STK-2：重粘需 <2×——与 C3 同构的迟滞带（TTFT 倍数，区别于健康 0.6 阈）
const TTFT_RECENT_N = 8;                    // 「当前 TTFT」口径：最近 8 个样本的 p50（抗单点抖动）

const speedWin = new Map<string, SpeedSample[]>();
const speedEma = new Map<string, number>();     // 平滑因子（事件驱动：该候选每个新样本更新一次）
const ttftBaseline = new Map<string, number>(); // 自身历史 recent-p50 的 EMA
const ttftSlow = new Map<string, boolean>();    // 粘性慢降级迟滞状态
const lastSampleAt = new Map<string, number>();
let speedSnap: { at: number; floor: number; cap: number; bench: number | null; rows: Map<string, { factor: number; tokP50: number | null; ttftP50: number | null; slow: boolean }> } | null = null;

export function clearSpeed() {
  speedWin.clear();
  speedEma.clear();
  ttftBaseline.clear();
  ttftSlow.clear();
  lastSampleAt.clear();
  speedSnap = null;
}

export function clearSpeedForRoute(routeId: string) {
  speedWin.delete(routeId);
  speedEma.delete(routeId);
  ttftBaseline.delete(routeId);
  ttftSlow.delete(routeId);
  lastSampleAt.delete(routeId);
  speedSnap = null;
}

const p50Of = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/**
 * 每 attempt 速度采样（G14/G15）：调用方保证只对流式且 completionTokens≥16 的成功 attempt 调用——
 * tokPerSec = completionTokens / decode 秒（流末−首包，权重层指标）；ttftMs = 首包−本 attempt 起点
 * （aT0 基准，禁止链级污染值）。非流式仅入观测（F3.3 下界口径，落日志，不进本状态）。
 */
export function speedNote(routeId: string, tokPerSec: number, ttftMs: number, cfg?: SpeedConfig) {
  // 审查修复：Infinity/NaN 拦截（上游 usage 注入 1e999 → factor=NaN → pickWeighted 静默饿死）；关闸早退（P6-2）
  if (!routeId || !Number.isFinite(tokPerSec) || tokPerSec <= 0 || !Number.isFinite(ttftMs) || ttftMs < 0) return;
  if (cfg && !cfg.enabled) return;
  const now = clockNow();
  const list = speedWin.get(routeId) || [];
  list.push({ ts: now, tokPerSec, ttftMs });
  while (list.length && now - list[0].ts > SPEED_WINDOW_MS) list.shift();
  while (list.length > MAX_SPEED_SAMPLES) list.shift();
  speedWin.set(routeId, list);
  lastSampleAt.set(routeId, now);
  speedSnap = null; // 失效读缓存
  if (cfg) refreshSpeedEvents(routeId, cfg, now); // 事件侧更新（EMA/基线/慢降级迟滞）随样本驱动
}

/** 事件侧重算（每个新样本触发一次）：该候选的 EMA 因子 + 全候选的 TTFT 基线/慢降级迟滞 */
function refreshSpeedEvents(newRouteId: string, cfg: SpeedConfig, now: number) {
  const ownToks: { routeId: string; v: number }[] = [];
  const p50s = new Map<string, { tok: number | null; ttft: number | null }>();
  for (const [routeId, list] of speedWin) {
    const fresh = list.filter((s) => now - s.ts <= SPEED_WINDOW_MS);
    if (fresh.length !== list.length) speedWin.set(routeId, fresh);
    const tok = p50Of(fresh.map((s) => s.tokPerSec));
    p50s.set(routeId, { tok, ttft: p50Of(fresh.map((s) => s.ttftMs)) });
    if (fresh.length >= SPEED_MIN_SAMPLES && tok !== null) ownToks.push({ routeId, v: tok });
  }
  // G17/SPD-5：bench = 速度样本 ≥3 的候选 own p50 的中位数；无任何合格候选 → bench null（全体 factor=1）。
  // 单个有样本候选 → bench=自身 p50 → factor=1（有样本者不因冷启动同伴被压）
  const bench = ownToks.length ? p50Of(ownToks.map((o) => o.v)) : null;
  if (bench !== null && bench > 0) {
    const me = ownToks.find((o) => o.routeId === newRouteId);
    if (me) {
      const raw = Math.min(cfg.cap, Math.max(cfg.floor, me.v / bench)); // 吞吐高优：own/bench（R3 改指标后的倒数形式，TTFT 类低优指标才是 bench/own）
      const prev = speedEma.get(newRouteId);
      if (prev === undefined) {
        speedEma.set(newRouteId, raw);
      } else {
        // 审查修复（M2-b 锯齿）：存量 EMA 先按样本间隔衰减到本次采样时点再混合——
        // 否则稀疏样本候选在读值上出现「衰减位 → 新样本硬拉回历史 EMA」的锯齿，F3.4 无硬跳变被击穿
        // gap 取「上一采样时刻」而非 lastSampleAt——后者已被本样本覆写为 now（恒 0 退化回普通混合）
        const own = speedWin.get(newRouteId) || [];
        const prevTs = own.length >= 2 ? own[own.length - 2].ts : now;
        const gap = Math.max(0, now - prevTs);
        const eff = 1 + (prev - 1) * Math.pow(0.5, gap / SPEED_HALF_LIFE_MS);
        speedEma.set(newRouteId, EMA_ALPHA * raw + (1 - EMA_ALPHA) * eff);
      }
    }
  }
  // 粘性慢降级（G16/F3.2）：recent-8 p50 vs 自身历史 p50 EMA；3× 降、<2× 回（迟滞）；样本 <3 视为未慢降
  for (const [routeId, list] of speedWin) {
    const recent = list.slice(-TTFT_RECENT_N);
    if (recent.length < SPEED_MIN_SAMPLES) {
      ttftSlow.set(routeId, false);
      continue;
    }
    const rp = p50Of(recent.map((s) => s.ttftMs));
    if (rp === null || !(rp > 0)) continue;
    // 倍数比较用「历史基线」（不含本次读数——EMA 若先吞慢样本，3× 判据在阶跃劣化下永不可达）
    const prevBase = ttftBaseline.get(routeId);
    if (prevBase === undefined) {
      ttftBaseline.set(routeId, rp); // 播种：首个 recent-p50 即基线，不参与倍数判定
    } else {
      if (ttftSlow.get(routeId)) {
        if (prevBase > 0 && rp < TTFT_RESTICK_X * prevBase) ttftSlow.set(routeId, false);
      } else if (prevBase > 0 && rp >= STICKY_SLOW_DEMOTE * prevBase) {
        ttftSlow.set(routeId, true);
      }
      ttftBaseline.set(routeId, EMA_ALPHA * rp + (1 - EMA_ALPHA) * prevBase);
    }
  }
}

/** 读侧快照（5s 缓存）：factor 已含衰减；bench/观测值直出 */
function speedSnapshotRead(cfg: SpeedConfig, now: number) {
  if (!speedSnap || now - speedSnap.at > SPEED_RECOMPUTE_MS || speedSnap.floor !== cfg.floor || speedSnap.cap !== cfg.cap) {
    const rows = new Map<string, { factor: number; tokP50: number | null; ttftP50: number | null; slow: boolean }>();
    let bench: number | null = null;
    const ownToks: number[] = [];
    for (const [, list] of speedWin) {
      const fresh = list.filter((s) => now - s.ts <= SPEED_WINDOW_MS);
      if (fresh.length >= SPEED_MIN_SAMPLES) {
        const tok = p50Of(fresh.map((s) => s.tokPerSec));
        if (tok !== null) ownToks.push(tok);
      }
    }
    if (ownToks.length >= 1) bench = p50Of(ownToks);
    for (const [routeId, list] of speedWin) {
      const fresh = list.filter((s) => now - s.ts <= SPEED_WINDOW_MS);
      const freshOk = fresh.length >= SPEED_MIN_SAMPLES;
      const ema = freshOk ? speedEma.get(routeId) : undefined;
      const last = lastSampleAt.get(routeId) ?? now;
      // 读侧统一公式（审查 v2.3 修订，四修合一）：
      // (1) fresh<3 → 1：与 bench/EMA 更新门同口径——存量 EMA 不得被涓流样本无限期钉死（A7 实测恒 1.3）；
      //     衰减在窗内连续（SPD-4），窗外按冷启动口径归 1（最大跳变 ≤(cap+1)/2−1，受 cap 有界）
      // (2) dt 下钳 0：墙钟回拨（NTP/休眠恢复）时 pow(0.5, 负) 指数爆炸（实测回拨 6h → 65）
      // (3) 按当前 [floor,cap] 重钳：设置热改对存量 EMA 即时生效（校验保证 floor≤1≤cap，合法态不改衰减轨迹）
      const dt = Math.max(0, now - last);
      const decayed = ema === undefined ? 1 : 1 + (ema - 1) * Math.pow(0.5, dt / SPEED_HALF_LIFE_MS);
      const factor = ema === undefined ? 1 : Math.min(cfg.cap, Math.max(cfg.floor, decayed));
      rows.set(routeId, { factor, tokP50: p50Of(fresh.map((s) => s.tokPerSec)), ttftP50: p50Of(fresh.map((s) => s.ttftMs)), slow: (freshOk ? ttftSlow.get(routeId) : false) || false });
    }
    speedSnap = { at: now, floor: cfg.floor, cap: cfg.cap, bench, rows };
  }
  return speedSnap;
}

/** 权重层速度因子（R4 统一公式第三因子）：冷启动/关闸 → 1；有样本 → clamp(own/bench, floor, cap) 的 EMA 平滑值按半衰期衰减 */
export function speedFactorOf(routeId: string, cfg: SpeedConfig): number {
  if (!routeId || !cfg.enabled) return 1;
  const snap = speedSnapshotRead(cfg, clockNow());
  return snap.rows.get(routeId)?.factor ?? 1;
}

/** 粘性慢降级判定（SPD-3）：3× 降粘（绕行不删绑定不续期）、<2× 才回粘——迟滞带内维持原状 */
export function ttftSlowDemoted(routeId: string, cfg: SpeedConfig): boolean {
  if (!routeId || !cfg.enabled) return false;
  const snap = speedSnapshotRead(cfg, clockNow());
  return snap.rows.get(routeId)?.slow || false;
}

/** 管理台观测（R8）：speedBench + 各候选 factor/p50/slow */
export function speedSnapshotForAdmin(cfg: SpeedConfig) {
  const snap = speedSnapshotRead(cfg, clockNow());
  return { bench: snap.bench, rows: [...snap.rows.entries()].map(([routeId, r]) => ({ routeId, ...r })) };
}

/** 单测注 sample（与生产同路径：speedNote 内联事件侧更新） */
export function speedNoteForTest(routeId: string, tokPerSec: number, ttftMs: number, cfg: SpeedConfig) {
  speedNote(routeId, tokPerSec, ttftMs, cfg);
}
