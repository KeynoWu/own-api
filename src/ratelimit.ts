/**
 * 失败计数限速（审查 A-M：爆破管理令牌 / 爆破对外 key 此前无任何速率防线）。
 * 固定窗口计数，内存态——单进程本地服务够用；只做「失败」计数，成功即清零，
 * 正常用户不受影响。IP 取自 X-Forwarded-For：本机直连时该头由调用方自报、
 * 可伪造——限速是抬高成本的 best-effort，不是边界隔离。
 */
const buckets = new Map<string, { n: number; resetAt: number }>();
const MAX_KEYS = 10_000;

export function failureAllow(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    if (buckets.size > MAX_KEYS) return { ok: true, retryAfterSec: 0 }; // 洪峰兜底：宁可放行也不吃内存
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { n: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  b.n += 1;
  if (b.n > limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  return { ok: true, retryAfterSec: 0 };
}

export function failureClear(key: string) {
  buckets.delete(key);
}
