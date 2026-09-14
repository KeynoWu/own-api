/**
 * 鉴权失败限速（审查 A-M 爆破防线；M0-b 语义重做）。
 * 口径：只记鉴权失败——成功不计数也不清零（旧实现计所有请求且成功即清零，
 * 持任一合法 key 交替即可无限爆破，本机共享桶还会被爆破者反向锁死合法客户端）。
 * 桶键取 socket 远端地址：TCP 上不可伪造；XFF 是自报头，逐请求换值即可绕开，
 * 不再采信（本服务是本地网关，直连模型下 socket IP 就是真实来源）。
 * 固定窗口、内存态；桶表超上限按插入序 FIFO 逐出——绝不整体 fail-open
 * （旧实现在洪峰清完过期仍超限时全员放行，等于限速器被灌爆即瘫痪）。
 * 残留语义（R2 记录在案，属有意取舍）：内存桶随进程重启清零；FIFO 逐出不随活跃度续位，
 * 需 1 万+ 真实源才会触发，方向 fail-closed。
 */
const buckets = new Map<string, { n: number; resetAt: number }>();
const MAX_KEYS = 10_000;

/** 从 Hono context 取不可伪造的来源地址（node-server 的 incoming.socket） */
export function clientIp(c: any): string {
  try {
    const addr = c?.env?.incoming?.socket?.remoteAddress;
    if (typeof addr === 'string' && addr) {
      const ip = addr.replace(/^::ffff:/, '');
      // R2：::1 与 127.0.0.1 是同一台机器——分桶等于给本机攻击者发第二份免费预算，归一合并
      return ip === '::1' ? '127.0.0.1' : ip;
    }
  } catch {
    /* env 形态异常时归入共享桶，宁严勿松 */
  }
  return 'unknown';
}

export function failurePeek(key: string, limit: number): { blocked: boolean; retryAfterSec: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (b && b.resetAt > now && b.n > limit) {
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

export function failureHit(key: string, windowMs: number): void {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { n: 1, resetAt: now + windowMs });
  } else {
    b.n += 1;
  }
  if (buckets.size > MAX_KEYS) {
    for (const [k, bb] of buckets) if (bb.resetAt <= now) buckets.delete(k);
    for (const k of buckets.keys()) {
      if (buckets.size <= MAX_KEYS) break;
      buckets.delete(k);
    }
  }
}
