import type { Channel, Protocol } from './types.ts';

export type Endpoint = 'chat' | 'messages' | 'embeddings' | 'models' | 'count_tokens';

/**
 * 拼接上游 URL。用户既可粘贴 https://api.openai.com/v1 也可粘贴裸域名，
 * 这里统一按协议补齐版本段（各家中转常见的两种写法）。
 */
export function buildUrl(channel: Channel, endpoint: Endpoint): string {
  const base = channel.baseUrl.replace(/\/+$/, '');
  const anthropic = channel.protocol === 'anthropic';
  const hasVersion = /\/v1$/.test(base);
  const root = hasVersion ? base : `${base}/v1`;
  if (anthropic) {
    if (endpoint === 'models') return `${root}/models`;
    if (endpoint === 'count_tokens') return `${root}/messages/count_tokens`;
    return `${root}/messages`;
  }
  if (endpoint === 'embeddings') return `${root}/embeddings`;
  if (endpoint === 'models') return `${root}/models`;
  return `${root}/chat/completions`;
}

export function buildHeaders(channel: Channel, apiKey: string, protocol: Protocol): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const style = channel.authStyle || (protocol === 'anthropic' ? 'x-api-key' : 'bearer');
  if (style === 'x-api-key') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  if (channel.extraHeaders) Object.assign(headers, channel.extraHeaders);
  return headers;
}

export interface UpstreamResult {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  /** 上游声明的 content-type（用于识别"要流式却回了 JSON"） */
  contentType: string;
  /** 失败时读取出来的文本（用于错误信息与日志） */
  errorText?: string;
  /** 结束本次调用的全部计时器；响应彻底消费完毕后必须调用 */
  dispose: () => void;
}

/**
 * 调用上游。两层超时：
 *  - 首包超时：timeoutMs 内必须拿到响应头
 *  - 空闲超时：流式响应体连续 idleMs 没有任何字节即中断
 * 只给响应头设超时是不够的——上游 200 后卡死会让客户端永久挂起。
 */
export async function callUpstream(opts: {
  channel: Channel;
  apiKey: string;
  protocol: Protocol;
  endpoint: Endpoint;
  body: any;
  timeoutMs: number;
  idleTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<UpstreamResult> {
  const url = buildUrl(opts.channel, opts.endpoint);
  const headers = buildHeaders(opts.channel, opts.apiKey, opts.protocol);
  const ac = new AbortController();
  let phase: 'head' | 'body' = 'head';
  let settled = false;

  let timer: NodeJS.Timeout | undefined;
  const arm = (ms: number, reason: string) => {
    if (timer) clearTimeout(timer);
    if (!ms || ms <= 0) return;
    timer = setTimeout(() => {
      if (settled) return;
      ac.abort(new Error(reason));
    }, ms);
    timer.unref?.();
  };
  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  arm(opts.timeoutMs, `上游 ${opts.timeoutMs}ms 内未返回响应头`);

  const onClientAbort = () => ac.abort(new Error('客户端已断开'));
  // abort 事件不向后补发：signal 已断开时必须立刻同步 abort，否则这次调用会照常打上游（断开续链 bug）
  if (opts.signal?.aborted) onClientAbort();
  else opts.signal?.addEventListener('abort', onClientAbort);

  const dispose = () => {
    settled = true;
    disarm();
    opts.signal?.removeEventListener('abort', onClientAbort);
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.body),
      signal: ac.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      dispose();
      return {
        status: res.status,
        headers: res.headers,
        body: null,
        contentType: res.headers.get('content-type') || '',
        errorText: text.slice(0, 2000),
        dispose,
      };
    }

    if (!res.body) {
      dispose();
      return { status: res.status, headers: res.headers, body: null, contentType: res.headers.get('content-type') || '', dispose };
    }

    // 进入响应体阶段：空闲超时只在"正向上游取数"期间武装（M6）。
    // 若在 enqueue 后续表，计时器度量的其实是下游消费节奏——慢客户端背压停读
    // 会被误判成上游静默，把健康流绞死；背压期间由 TCP 流控自然兜住。
    phase = 'body';
    disarm(); // 头超时使命到此为止——不留"首拉前"的错相定时器（其文案写着"未返回响应头"）；停读期生命周期由提交点 watchdog 负责（二轮 C2）
    const reader = res.body.getReader();
    const guarded = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        arm(opts.idleTimeoutMs, `上游响应体连续 ${opts.idleTimeoutMs}ms 无数据`);
        try {
          const r = await reader.read();
          if (r.done) {
            dispose();
            ctrl.close();
          } else {
            disarm();
            ctrl.enqueue(r.value);
          }
        } catch (err) {
          dispose();
          ctrl.error(err);
        }
      },
      cancel(reason) {
        // 客户端断开：停表并把取消传导回上游 fetch
        dispose();
        reader.cancel(reason).catch(() => {});
      },
    });

    return {
      status: res.status,
      headers: res.headers,
      body: guarded,
      contentType: res.headers.get('content-type') || '',
      dispose,
    };
  } catch (err: any) {
    const aborted = err?.name === 'AbortError';
    const reason = ac.signal.reason instanceof Error ? ac.signal.reason.message : String(ac.signal.reason || err?.message || err);
    dispose();
    if (aborted) {
      throw new Error(phase === 'head' ? reason : `${reason}（响应体阶段）`);
    }
    throw err;
  }
}

/** 从上游错误体里提取一句人话 */
export function extractUpstreamError(text: string, status: number): string {
  if (!text) return `upstream returned ${status}`;
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message || j?.message || j?.error_message || j?.error;
    if (typeof m === 'string' && m) return m;
  } catch {
    /* not json */
  }
  return text.slice(0, 300);
}

/**
 * 判断响应体到底是 SSE 还是整块 JSON。
 * 只看 content-type 不够：不少中转根本不声明，或声明成 text/plain。
 * 因此先窥探首块再决定，避免"要流式却拿到空响应"。
 */
export async function sniffStreamBody(
  body: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<{ kind: 'sse' | 'json'; body: ReadableStream<Uint8Array> }> {
  if (/text\/event-stream|application\/x-ndjson/i.test(contentType)) return { kind: 'sse', body };
  if (/application\/json|application\/javascript/i.test(contentType)) return { kind: 'json', body };

  const reader = body.getReader();
  let first: Uint8Array | undefined;
  try {
    const r = await reader.read();
    if (!r.done) first = r.value;
  } catch {
    /* 读不到就按 JSON 处理，交给后续解析报错 */
  }
  const head = new TextDecoder().decode(first ?? new Uint8Array()).replace(/^\s+/, '').slice(0, 64);
  const looksSSE = /^data:\s|^event:\s|^retry:\s|^id:\s/.test(head) || head.includes('data: [DONE]');

  // pull 驱动地重放（首块 + 后续）：start 里全速泵会把整条流灌进无界内部队列，
  // 慢客户端 + 无 content-type 的上游会让内存跟着响应体大小涨
  let firstPending = first;
  const rebuilt = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        if (firstPending !== undefined) {
          ctrl.enqueue(firstPending);
          firstPending = undefined;
          return;
        }
        const r = await reader.read();
        if (r.done) ctrl.close();
        else ctrl.enqueue(r.value);
      } catch (err) {
        ctrl.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });

  return { kind: looksSSE ? 'sse' : 'json', body: rebuilt };
}
