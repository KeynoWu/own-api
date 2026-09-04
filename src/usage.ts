import { store } from './store.ts';
import type { ModelRoute, RequestLog } from './types.ts';
import type { Usage } from './translate.ts';

/**
 * 按每百万 token 单价估算花费（美元）。
 * 口径约定（见 translate.ts 的 usage 归一）：promptTokens 是**含缓存的总输入 token**，
 * cacheRead / cacheWrite 是其中的子集，所以这里做减法成立，且对两种上游协议一致。
 */
export function computeCost(model: ModelRoute | undefined, u: Usage): number {
  if (!model) return 0;
  const pin = model.priceInput ?? 0;
  const pout = model.priceOutput ?? 0;
  const pcRead = model.priceCacheRead ?? pin * 0.1;
  const pcWrite = model.priceCacheWrite ?? pin * 1.25;
  const freshInput = Math.max(0, u.promptTokens - u.cacheReadTokens - u.cacheWriteTokens);
  const cost = (freshInput * pin + u.cacheReadTokens * pcRead + u.cacheWriteTokens * pcWrite + u.completionTokens * pout) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

// ---------------------------------------------------------------- 限流
// 旧实现靠"扫历史日志"计数，有两个致命问题：并发请求在日志落库前全部放行；
// 日志受 logRetention 裁剪，裁掉之后当日额度静默清零。
// 现在：RPM 用内存准入时间窗（在途即计入），每日 token 用落盘的按天累计器。

const rpmWindows = new Map<string, number[]>();

/**
 * 每日 token 的"在途预占"量（已准入、尚未结束入账的请求）。
 * runtimeWindow 之外的另一层：quotaOf 只含已落账，流式请求直到结束才入账，
 * 多个并发会在额度将尽时一起穿过——所以转发前按上限预占，结束再释放。
 */
const inFlightTokens = new Map<string, number>();

function today() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function quotaOf(vkeyId: string) {
  const q = store.db.quotas;
  const day = today();
  const cur = q[vkeyId];
  if (!cur || cur.day !== day) {
    const fresh = { day, tokens: 0, requests: 0, costUsd: 0 };
    q[vkeyId] = fresh;
    return fresh;
  }
  return cur;
}

/** 请求准入。必须早于任何 await 执行，否则并发仍能绕过 */
export function admitRequest(vkeyId: string): { ok: boolean; reason?: string; retryAfterSec?: number } {
  const vk = store.listVKeys().find((k) => k.id === vkeyId);
  if (!vk) return { ok: true };

  if (vk.dailyTokenLimit && vk.dailyTokenLimit > 0 && quotaOf(vkeyId).tokens >= vk.dailyTokenLimit) {
    return { ok: false, reason: `daily token limit reached (${vk.dailyTokenLimit})`, retryAfterSec: secondsToTomorrow() };
  }

  if (vk.rpmLimit && vk.rpmLimit > 0) {
    const now = Date.now();
    const hits = (rpmWindows.get(vkeyId) || []).filter((t) => now - t < 60_000);
    if (hits.length >= vk.rpmLimit) {
      rpmWindows.set(vkeyId, hits);
      return { ok: false, reason: `rate limit exceeded: ${vk.rpmLimit} rpm`, retryAfterSec: Math.max(1, Math.ceil((60_000 - (now - hits[0])) / 1000)) };
    }
    hits.push(now);
    rpmWindows.set(vkeyId, hits);
  }
  return { ok: true };
}

/** 请求结束：token/花费累加进按天配额（落盘，与日志裁剪解耦） */
export function recordQuota(vkeyId: string, tokens: number, costUsd: number) {
  const q = quotaOf(vkeyId);
  q.tokens += tokens;
  q.requests += 1;
  q.costUsd = Math.round((q.costUsd + costUsd) * 1e6) / 1e6;
  store.save();
}

/**
 * 在途预占每日 token。返回 ok + reserved（**实际入册的预占额**）：
 * 限额为 0 时不记账（reserved=0），调用方 release 必须用 reserved 而非估算值——
 * 否则限额中途被改 0 的竞态窗里，"无中生有的 release"会侵蚀同 key 他人在途预占。
 */
export function reserveQuota(vkeyId: string, estTokens: number, dailyTokenLimit: number): { ok: boolean; reserved: number } {
  if (!dailyTokenLimit || dailyTokenLimit <= 0) return { ok: true, reserved: 0 };
  const reserve = Number.isFinite(estTokens) && estTokens > 0 ? Math.ceil(estTokens) : 0;
  const inFlight = inFlightTokens.get(vkeyId) || 0;
  const settled = quotaOf(vkeyId).tokens;
  // 当天还没有任何用量与在途：至少放行一发。否则限额小于单请求预占量时
  // （如限额 50 而 max_tokens 声明 8192）这个 key 会被永久锁死，一个 token 都花不出去
  if (settled === 0 && inFlight === 0) {
    inFlightTokens.set(vkeyId, reserve);
    return { ok: true, reserved: reserve };
  }
  if (settled + inFlight + reserve > dailyTokenLimit) return { ok: false, reserved: 0 };
  inFlightTokens.set(vkeyId, inFlight + reserve);
  return { ok: true, reserved: reserve };
}

/** 预占释放：请求终态统一调用（实际 token 已由 recordQuota 计入落盘，这里只退回在途预占） */
export function releaseQuota(vkeyId: string, estTokens: number) {
  const reserve = Number.isFinite(estTokens) && estTokens > 0 ? Math.ceil(estTokens) : 0;
  if (reserve <= 0) return;
  const cur = inFlightTokens.get(vkeyId) || 0;
  const next = cur - reserve;
  if (next <= 0) inFlightTokens.delete(vkeyId);
  else inFlightTokens.set(vkeyId, next);
}

/** 每日 token 预占准入入口（gateway 在转发前调用，补 admitRequest 的并发缺口） */
/** vkey 删除时清在途册目，防止已删 key 的幽灵账随迟到 finalize 复活 */
export function forgetQuota(vkeyId: string) {
  inFlightTokens.delete(vkeyId);
}

export function admitDailyQuota(vkeyId: string, estTokens: number, dailyTokenLimit: number): { ok: boolean; reserved: number; retryAfterSec?: number } {
  const r = reserveQuota(vkeyId, estTokens, dailyTokenLimit);
  if (r.ok) return { ok: true, reserved: r.reserved };
  return { ok: false, reserved: 0, retryAfterSec: secondsToTomorrow() };
}

/** 回收长时间未用的窗口，避免 Map 无界增长 */
export function gcRpmWindows() {
  const cutoff = Date.now() - 120_000;
  for (const [k, hits] of rpmWindows) {
    const kept = hits.filter((t) => t >= cutoff);
    if (kept.length) rpmWindows.set(k, kept);
    else rpmWindows.delete(k);
  }
}

function secondsToTomorrow() {
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 5);
  return Math.max(1, Math.round((next.getTime() - d.getTime()) / 1000));
}

export function quotaSnapshot() {
  const day = today();
  const out: Record<string, { day: string; tokens: number; requests: number; costUsd: number }> = {};
  for (const [k, v] of Object.entries(store.db.quotas)) {
    if (v.day === day) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 统计

export interface Bucket {
  key: string;
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  avgLatencyMs: number;
}

function newBucket(key: string): Bucket {
  return { key, requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, costUsd: 0, avgLatencyMs: 0 };
}

function accumulate(b: Bucket, l: RequestLog) {
  b.requests += 1;
  if (!l.ok) b.errors += 1;
  b.promptTokens += l.promptTokens;
  b.completionTokens += l.completionTokens;
  b.cacheReadTokens += l.cacheReadTokens;
  b.costUsd = Math.round((b.costUsd + l.costUsd) * 1e6) / 1e6;
}

export interface StatsSummary {
  window: { from: number; to: number };
  totals: Bucket;
  byModel: Bucket[];
  /** auto 流量按最终候选归因（requestedModel 会全部塌成 auto 名） */
  byRoutedTo: Bucket[];
  byChannel: Bucket[];
  byVKey: Bucket[];
  byDay: Bucket[];
  successRate: number;
  p50Latency: number;
  p95Latency: number;
}

/** 按本地时区切天。UTC 切天会让东八区的"今天"从早上 8 点开始 */
function localDay(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function buildStats(rangeHours = 24): StatsSummary {
  const to = Date.now();
  const from = rangeHours > 0 ? to - rangeHours * 3600_000 : 0;
  const logs = store.db.logs.filter((l) => l.ts >= from);

  const mk = (pick: (l: RequestLog) => string) => {
    const map = new Map<string, Bucket>();
    const lat = new Map<string, number[]>();
    for (const l of logs) {
      const k = pick(l) || '-';
      if (!map.has(k)) map.set(k, newBucket(k));
      accumulate(map.get(k)!, l);
      if (!lat.has(k)) lat.set(k, []);
      lat.get(k)!.push(l.latencyMs);
    }
    return [...map.values()].map((b) => {
      const arr = (lat.get(b.key) || []).sort((a, x) => a - x);
      b.avgLatencyMs = arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length) : 0;
      return b;
    });
  };

  const totals = newBucket('total');
  for (const l of logs) accumulate(totals, l);
  const latAll = logs.map((l) => l.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => (latAll.length ? latAll[Math.min(latAll.length - 1, Math.floor(latAll.length * p))] : 0);

  return {
    window: { from, to },
    totals,
    byModel: mk((l) => l.requestedModel).sort((a, b) => b.requests - a.requests),
    byRoutedTo: mk((l) => l.routedTo || (l.chainAttempts?.length ? l.requestedModel : l.publicName) || '-').sort((a, b) => b.requests - a.requests),
    byChannel: mk((l) => l.channelName || '-').sort((a, b) => b.requests - a.requests),
    byVKey: mk((l) => l.vkeyName || '-').sort((a, b) => b.requests - a.requests),
    byDay: mk((l) => localDay(l.ts)).sort((a, b) => a.key.localeCompare(b.key)),
    successRate: totals.requests ? Math.round(((totals.requests - totals.errors) / totals.requests) * 1000) / 10 : 100,
    p50Latency: pct(0.5),
    p95Latency: pct(0.95),
  };
}
