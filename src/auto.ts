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
  const now = Date.now();
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
}
const STICKY_MAX = 1000;
const sticky = new Map<string, StickyEntry>();

const stickKey = (vkeyId: string, autoName: string) => `${vkeyId}\u0000${autoName.toLowerCase()}`;

/** 取粘性记录；过期即删。不在这里续期——续期只发生在"本次真的用了它"时（命中续期） */
export function getSticky(vkeyId: string, autoName: string): StickyEntry | undefined {
  const k = stickKey(vkeyId, autoName);
  const e = sticky.get(k);
  if (!e) return undefined;
  if (e.expiresAt <= Date.now()) {
    sticky.delete(k);
    return undefined;
  }
  return e;
}

/** 命中续期（滑动 TTL，C5）；顺带刷新 LRU 位置 */
export function touchSticky(vkeyId: string, autoName: string, ttlMs: number) {
  const k = stickKey(vkeyId, autoName);
  const e = sticky.get(k);
  if (!e) return;
  sticky.delete(k);
  e.expiresAt = Date.now() + ttlMs;
  sticky.set(k, e);
}

/** 新建/覆盖绑定（调用方负责回粘阈值 health >= STICKY_RESTICK 与"绕行不覆写"的判定） */
export function setSticky(vkeyId: string, autoName: string, routeId: string, ttlMs: number) {
  const k = stickKey(vkeyId, autoName);
  sticky.delete(k);
  sticky.set(k, { routeId, expiresAt: Date.now() + ttlMs });
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
