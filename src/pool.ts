import { store } from './store.ts';
import type { Channel, ChannelKey } from './types.ts';

/** 一次上游尝试的结果分类 */
export type FailureKind =
  | 'auth' // 401/403：key 无效
  | 'rate_limit' // 429：限流
  | 'upstream' // 5xx / 网络 / 超时
  | 'invalid_request'; // 4xx：换 key 也没用，不重试

export interface PickContext {
  /** 本次请求内已经试过的 keyId，不再重复选取 */
  tried: Set<string>;
}

interface Candidate {
  key: ChannelKey;
  /** 负载比 = 历史请求数 / 权重，越小越优先 */
  load: number;
}

function isAvailable(k: ChannelKey, now: number) {
  if (k.status === 'disabled') return false;
  if (k.status === 'cooldown') return !!k.cooldownUntil && k.cooldownUntil <= now;
  return true;
}

/**
 * 从号池中按「加权最小负载」顺序取一个可用 key。
 * 冷却到期的 key 自动回到可用集合（自愈）。
 */
export function pickKey(channel: Channel, ctx: PickContext): ChannelKey | undefined {
  const now = Date.now();
  const candidates: Candidate[] = [];
  for (const k of channel.keys) {
    if (ctx.tried.has(k.id)) continue;
    if (!isAvailable(k, now)) continue;
    const weight = k.weight > 0 ? k.weight : 1;
    candidates.push({ key: k, load: k.totalRequests / weight });
  }
  if (!candidates.length) {
    // 全部被本次请求试过：退回冷却集合，让最后一个还没过期的也能被尝试前先由调用方判断
    return undefined;
  }
  candidates.sort((a, b) => a.load - b.load || (a.key.lastUsedAt || 0) - (b.key.lastUsedAt || 0));
  const chosen = candidates[0].key;
  chosen.totalRequests += 1;
  chosen.lastUsedAt = now;
  // 冷却到期的 key 被选中即恢复 active
  if (chosen.status === 'cooldown') {
    chosen.status = 'active';
    chosen.cooldownUntil = undefined;
  }
  store.save();
  return chosen;
}

/** 号池里当前可用于服务的 key 数量（管理台展示用） */
export function availableKeyCount(channel: Channel, now = Date.now()) {
  return channel.keys.filter((k) => isAvailable(k, now)).length;
}

export function classifyFailure(status: number, err?: unknown): FailureKind {
  if (!status && err) return 'upstream';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream';
  return 'invalid_request';
}

/**
 * 记录一次失败：决定是否冷却该 key，以及是否值得换下一个 key 重试。
 * invalid_request 一律不重试（换 key 无用，避免打爆号池）。
 */
export function recordFailure(
  channel: Channel,
  key: ChannelKey,
  kind: FailureKind,
  detail: string,
  retryAfterMs?: number,
): { retryable: boolean; cooldownMs: number } {
  const s = store.getSettings();
  const now = Date.now();
  key.totalErrors += 1;
  key.lastError = detail.slice(0, 400);
  key.lastErrorAt = now;

  if (kind === 'invalid_request') {
    store.save();
    return { retryable: false, cooldownMs: 0 };
  }

  let cooldownMs = 0;
  if (kind === 'auth') {
    cooldownMs = Math.min(s.cooldownMaxMs, Math.max(s.cooldownBaseMs * 10, 5 * 60_000));
  } else if (kind === 'rate_limit') {
    const streak = key.totalErrors;
    // 上游的 Retry-After 只是建议值：必须夹在 [cooldownBaseMs, cooldownMaxMs] 内，
    // 否则一个离谱的响应头就能把 key 停摆数天（实测曾出现 11.6 天）
    const suggested = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 0;
    cooldownMs = suggested
      ? Math.min(s.cooldownMaxMs, Math.max(s.cooldownBaseMs, suggested))
      : Math.min(s.cooldownMaxMs, s.cooldownBaseMs * Math.min(streak, 8));
  } else {
    const streak = key.totalErrors;
    cooldownMs = streak >= s.errorThreshold ? Math.min(s.cooldownMaxMs, s.cooldownBaseMs * streak) : 0;
  }

  if (cooldownMs > 0) {
    key.status = 'cooldown';
    key.cooldownUntil = now + cooldownMs;
  }
  store.save();
  return { retryable: true, cooldownMs };
}

export function recordSuccess(channel: Channel, key: ChannelKey) {
  if (key.totalErrors > 0 || key.status !== 'active' || key.cooldownUntil) {
    key.totalErrors = 0;
    key.status = 'active';
    key.cooldownUntil = undefined;
    key.lastError = undefined;
  }
  void channel;
  store.save();
}

/** 从 429 响应头解析 retry-after（秒或 http-date） */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
