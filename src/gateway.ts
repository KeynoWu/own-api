import type { Context } from 'hono';
import { store, maskKey, newId } from './store.ts';
import {
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
  chatResponseToLegacy,
  collectDropWarnings,
  emptyUsage,
  legacyToChatRequest,
  openaiToAnthropicRequest,
  openaiToAnthropicResponse,
  usageFromAnthropic,
  usageFromOpenai,
  type Usage,
} from './translate.ts';
import {
  anthropicJsonToSSE,
  anthropicStreamToOpenai,
  chatStreamToLegacy,
  openaiJsonToSSE,
  openaiStreamToAnthropic,
  passthroughStream,
  type StreamMeta,
} from './sse.ts';
import { availableKeyCount, classifyFailure, parseRetryAfter, pickKey, recordFailure, recordSuccess } from './pool.ts';
import { callUpstream, extractUpstreamError, sniffStreamBody, type Endpoint } from './upstream.ts';
import { admitDailyQuota, admitRequest, computeCost, recordQuota, releaseQuota } from './usage.ts';
import { STICKY_KEEP, STICKY_RESTICK, deleteSticky, getSticky, health as healthOf, pickWeighted, recordAttempt, setSticky, touchSticky } from './auto.ts';
import type { AutoCandidate, AutoRoute, ChainAttempt, Channel, ModelRoute, Protocol, RequestLog, Settings, VirtualKey } from './types.ts';

export type ClientProtocol = 'openai' | 'anthropic';
/** 对外线格式：Anthropic / OpenAI chat / OpenAI legacy completions */
export type WireFormat = 'anthropic' | 'openai' | 'openai-legacy';

interface Resolved {
  channel: Channel;
  route?: ModelRoute;
  upstreamModel: string;
  protocol: 'openai' | 'anthropic';
  fallback: boolean;
}

/** 请求入口 -> 语义操作 + 对外线格式 */
export const ENTRYPOINTS: Record<string, { op: 'chat' | 'messages' | 'embeddings'; wire: WireFormat }> = {
  '/v1/chat/completions': { op: 'chat', wire: 'openai' },
  '/v1/completions': { op: 'chat', wire: 'openai-legacy' },
  '/v1/messages': { op: 'messages', wire: 'anthropic' },
  '/v1/embeddings': { op: 'embeddings', wire: 'openai' },
};

// ---------------------------------------------------------------- 鉴权与错误

export function extractClientKey(c: Context): string | undefined {
  const auth = c.req.header('authorization') || c.req.header('x-api-key');
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return (m ? m[1] : auth).trim() || undefined;
}

function errorBody(wire: WireFormat, status: number, message: string) {
  if (wire === 'anthropic') {
    const t =
      status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'api_error'
              : 'invalid_request_error';
    return { type: 'error', error: { type: t, message } };
  }
  const t =
    status === 401
      ? 'invalid_request_error'
      : status === 403
        ? 'permission_denied'
        : status === 429
          ? 'rate_limit_error'
          : status >= 500
            ? 'api_error'
            : 'invalid_request_error';
  return { error: { message, type: t, code: status === 404 ? 'model_not_found' : null, param: null } };
}

function fail(c: Context, wire: WireFormat, status: number, message: string, extra?: Record<string, string>) {
  return c.json(errorBody(wire, status, message) as any, status as any, { 'cache-control': 'no-store', ...(extra || {}) });
}

/** 内部拓扑信息默认不外泄：这些头能反推出渠道名与 key 尾号 */
function debugHeaders(enabled: boolean, info: { channel: Channel; key: string; publicName: string; attempts: number; fallback: boolean }) {
  if (!enabled) return {};
  return {
    'x-lm-channel': info.channel.name,
    'x-lm-key': maskKey(info.key),
    'x-lm-model': info.publicName,
    'x-lm-attempts': String(info.attempts),
    ...(info.fallback ? { 'x-lm-routing': 'fallback' } : {}),
  };
}

// ---------------------------------------------------------------- 路由解析

function resolveRoute(modelName: string): Resolved | { error: string } {
  const route = store.findModelByName(modelName.toLowerCase());
  if (route) {
    const channel = store.getChannel(route.channelId);
    if (!channel) return { error: `model "${modelName}" 绑定的渠道不存在` };
    if (!channel.enabled) return { error: `渠道 "${channel.name}" 已停用` };
    if (!route.enabled) return { error: `模型 "${route.publicName}" 已停用` };
    if (!channel.keys.length) return { error: `渠道 "${channel.name}" 号池内没有可用 key` };
    return {
      channel,
      route,
      upstreamModel: route.upstreamModel,
      protocol: route.protocol || channel.protocol,
      fallback: false,
    };
  }

  const fbId = store.getSettings().fallbackChannelId;
  if (fbId) {
    const channel = store.getChannel(fbId);
    if (channel && channel.enabled && availableKeyCount(channel) > 0) {
      return { channel, upstreamModel: modelName, protocol: channel.protocol, fallback: true };
    }
  }
  const known = store.listModels().filter((m) => m.enabled).map((m) => m.publicName);
  return {
    error: `model "${modelName}" 未配置路由。${known.length ? `可用模型：${known.join(', ')}` : '当前没有任何已启用的模型路由。'}`,
  };
}

function allowedForKey(vk: VirtualKey, publicName: string) {
  if (!vk.allowedModels?.length) return true;
  const lower = publicName.toLowerCase();
  return vk.allowedModels.some((m) => m.toLowerCase() === lower || m === '*');
}

// ---------------------------------------------------------------- auto 选路（docs/model-auto-design.md）

/** ① 硬过滤的逐候选评估结果（transient=true → 粘性只绕行不改写；false → 改写清单，§3.2/C6） */
interface CandEval {
  cand: AutoCandidate;
  route?: ModelRoute;
  channel?: Channel;
  protocol?: Protocol;
  name: string;
  ok: boolean;
  transient: boolean;
  reason?: string;
  health: number;
}

interface SurvivingEval extends CandEval {
  route: ModelRoute;
  channel: Channel;
  protocol: Protocol;
}

/** anthropic 客户端的 cache_control/thinking 标记：openai 协议候选无法承载（①-g），否则"吃缓存"承诺静默失效 */
function hasAnthropicCacheMarkers(chatBody: any): boolean {
  const th = chatBody?.thinking;
  if (th && typeof th === 'object' && th.type && th.type !== 'disabled') return true;
  return hasCacheControlKey(chatBody?.system) || hasCacheControlKey(chatBody?.messages) || hasCacheControlKey(chatBody?.tools);
}

/** 结构化扫 cache_control 键（S5）：正文/代码文本里的字面量不再误剔 openai 候选 */
function hasCacheControlKey(v: unknown, depth = 0): boolean {
  if (!v || typeof v !== 'object' || depth > 8) return false;
  if (!Array.isArray(v) && (v as any).cache_control != null) return true; // 显式 null（SDK 序列化可选字段）不算标记
  return (Array.isArray(v) ? v : Object.values(v)).some((x) => hasCacheControlKey(x, depth + 1));
}

/** C17 硬底线兜底（S8）：上游若把收到的 key echo 进错误体，进 retries/日志/响应体前替换为掩码 */
function scrubOut(s: string, k: string) {
  return k && s.includes(k) ? s.split(k).join(maskKey(k)) : s;
}

/** 上游"prompt 超出上下文窗口"类 400：换更大窗口的候选有意义（C10） */
function isPromptTooLong(msg: string): boolean {
  return /(context length|context window|maximum context|too many tokens|prompt is too long|input is too long|exceeds.{0,40}(context|window|length)|超.{0,8}(窗口|上下文|长度))/i.test(msg);
}

function evaluateCandidates(auto: AutoRoute, vkey: VirtualKey, chatBody: any, wire: WireFormat, wantsStream: boolean, inputEst: number): CandEval[] {
  const cacheMarkers = wire === 'anthropic' && hasAnthropicCacheMarkers(chatBody);
  const reqMax = Number(chatBody?.max_tokens) || Number(chatBody?.max_completion_tokens) || 0;
  return auto.candidates.map((cand) => {
    const route = store.getModel(cand.routeId);
    const base: CandEval = { cand, route, name: route?.publicName || cand.routeId, ok: false, transient: false, health: healthOf(cand.routeId) };
    const hard = (reason: string): CandEval => ({ ...base, reason });
    if (cand.weight === 0) return hard('weight=0（禁用）');
    if (!route) return hard('候选路由不存在（悬空引用）');
    if (!route.enabled) return hard('候选路由已停用');
    const channel = store.getChannel(route.channelId);
    if (!channel) return hard('所属渠道不存在');
    if (!channel.enabled) return hard(`渠道「${channel.name}」已停用`);
    const protocol: Protocol = route.protocol || channel.protocol;
    const soft = (reason: string): CandEval => ({ ...base, channel, protocol, transient: true, reason });
    if (!allowedForKey(vkey, route.publicName)) return hard('该 key 未授权此候选');
    if (!channel.keys.length) return soft('渠道号池没有 key');
    if (availableKeyCount(channel) === 0) return soft('渠道 key 全部冷却中');
    if (route.contextWindow && route.contextWindow > 0 && inputEst > route.contextWindow) return soft(`估算 prompt ${inputEst} tokens 超出其 contextWindow ${route.contextWindow}`);
    if ((chatBody?.tools?.length ?? 0) > 0 && route.supportsTools === false) return soft('请求带 tools 而候选不支持');
    if (reqMax > 0 && route.maxOutputTokens && reqMax > route.maxOutputTokens) return soft(`请求 max_tokens ${reqMax} 超出其上限 ${route.maxOutputTokens}`);
    if (wantsStream && route.supportsStreaming === false) return soft('候选不支持流式');
    if (cacheMarkers && protocol !== 'anthropic') return soft('候选协议无法承载 thinking/cache_control 语义');
    return { ...base, channel, protocol, ok: true, transient: false };
  });
}

// ---------------------------------------------------------------- 单候选管道（auto 链与单路由共用）

interface AttemptInput {
  c: Context;
  log: RequestLog;
  settings: Settings;
  wire: WireFormat;
  client: ClientProtocol;
  op: 'chat' | 'messages' | 'embeddings';
  chatBody: any;
  wantsStream: boolean;
  route: ModelRoute | undefined;
  channel: Channel;
  upstreamModel: string;
  protocol: Protocol;
  /** 响应体 model 字段与流式 meta 用名（auto=auto 名；单路由=publicName/请求名） */
  aliasName: string;
  /** 日志 publicName 用名（auto=候选外名） */
  logPublicName: string;
  aliasDiffers: boolean;
  fallback: boolean;
  retries: string[];
  /** 本次 attempt 的响应头超时（auto 链已由预算 min 过，N10-a） */
  headTimeoutMs: number;
  idleTimeoutMs: number;
  maxAttempts: number;
  /** 候选链已累计的上游尝试数（log.attempts 续加） */
  attemptBase: number;
  isAuto: boolean;
  isAborted: () => boolean;
  /** 请求终态记账（闭包在 gateway() 内，经输入对象传递——并发请求绝不能共享） */
  finalize: (patch?: Partial<RequestLog>) => void;
  /** 请求起点（ttft 基准） */
  t0: number;
  /** 候选级健康样本（C12 全流量；提交后 stream 失败也计，取消不计） */
  onSample: (routeId: string, ok: boolean) => void;
  /** 提交点成功（auto：写粘性；只在真正交出响应时调用） */
  onCommitted: () => void;
  /** JSON/合成路径的 finalize 在 attemptRoute 内部发生：先于此登记链记录，pushLog 快照才带得上 */
  onPreFinalize?: () => void;
}

type AttemptOutcome =
  | { kind: 'response'; res: Response }
  | { kind: 'candidate_fail'; status: number; message: string; sample: boolean; rateLimit?: boolean; retryAfterMs?: number }
  | { kind: 'chain_stop'; status: number; message: string }
  | { kind: 'client_abort' };

/**
 * 对一个候选（渠道+路由）执行完整的既有管道：协议转换 → key 级重试 → 流式/JSON 响应。
 * 每候选的派生物（upstreamBody/endpoint/stream_options/tried/reuseKey）都在本函数内新建
 * （§8-2：拿候选 A 的协议编码打候选 B = bug）。
 * 提交点=交出 Response（stage A/B 分界，§8-1）；此后的失败只发 error 帧。
 */
async function attemptRoute(a: AttemptInput): Promise<AttemptOutcome> {
  const { c, log, settings, client, wire, op, chatBody, wantsStream, route, channel, upstreamModel, protocol, aliasName } = a;
  Object.assign(log, { publicName: a.logPublicName, channelId: channel.id, channelName: channel.name });

  // 上游路径由「上游协议 + 语义操作」决定，而非客户端入口
  const upstreamEndpoint: Endpoint = op === 'embeddings' ? 'embeddings' : protocol === 'anthropic' ? 'messages' : 'chat';

  let upstreamBody: any;
  const warnings: string[] = [];
  if (protocol === client) {
    upstreamBody = { ...chatBody, model: upstreamModel };
  } else if (client === 'openai' && protocol === 'anthropic') {
    upstreamBody = openaiToAnthropicRequest({ ...chatBody, stream: wantsStream }, { upstreamModel, defaultMaxTokens: route?.maxOutputTokens });
    warnings.push(...collectDropWarnings(chatBody, 'anthropic'));
  } else {
    upstreamBody = anthropicToOpenaiRequest({ ...chatBody, stream: wantsStream }, { upstreamModel, defaultMaxTokens: route?.maxOutputTokens });
    warnings.push(...collectDropWarnings(chatBody, 'openai'));
  }

  // OpenAI 流式默认不回 usage，注入 stream_options 才能记账
  let injectedStreamOptions = false;
  if (protocol === 'openai' && wantsStream && upstreamEndpoint === 'chat' && !upstreamBody.stream_options) {
    upstreamBody.stream_options = { include_usage: true };
    injectedStreamOptions = true;
  }

  const tried = new Set<string>();
  const retries = a.retries;
  let lastStatus = 502;
  let lastMessage = `渠道 "${channel.name}" 没有可用于本次请求的 key（可能全部处于冷却或已禁用）`;
  let reuseKey: Channel['keys'][number] | undefined;
  let lastWasRateLimit = false;
  let retryAfterMs: number | undefined;

  for (let attempt = 1; attempt <= a.maxAttempts; attempt++) {
    if (a.isAborted()) return { kind: 'client_abort' };
    // 上游拒绝注入的 stream_options 时，同一把 key 原样重试一次，不计失败也不重复计数
    const key = reuseKey ?? pickKey(channel, { tried });
    const reused = !!reuseKey;
    reuseKey = undefined;
    if (!key) {
      if (!retries.length) lastMessage = `渠道 "${channel.name}" 号池为空或全部禁用`;
      break;
    }
    log.attempts = a.attemptBase + attempt;
    if (!reused) tried.add(key.id);

    let up: Awaited<ReturnType<typeof callUpstream>>;
    try {
      up = await callUpstream({
        channel,
        apiKey: key.key,
        protocol,
        endpoint: upstreamEndpoint,
        body: upstreamBody,
        timeoutMs: a.headTimeoutMs,
        idleTimeoutMs: a.idleTimeoutMs,
        signal: c.req.raw.signal,
      });
    } catch (err: any) {
      const msg = String(err?.message || err);
      // 断开不是候选故障：不 recordFailure、不计样本、不换 key（§8-4）
      if (a.isAborted() || msg.includes('客户端已断开')) return { kind: 'client_abort' };
      const { retryable } = recordFailure(channel, key, 'upstream', msg);
      retries.push(`[${channel.name}/${maskKey(key.key)}] ${msg}`);
      lastStatus = 502;
      lastMessage = msg;
      lastWasRateLimit = false;
      if (!retryable || attempt >= a.maxAttempts) break;
      continue;
    }

    if (up.status >= 400) {
      up.dispose();
      const kind = classifyFailure(up.status);
      const brief = scrubOut(extractUpstreamError(up.errorText || '', up.status), key.key);
      // 注入的 stream_options 被拒：去掉后同一把 key 再试一次，不计失败
      if (injectedStreamOptions && kind === 'invalid_request') {
        delete upstreamBody.stream_options;
        injectedStreamOptions = false;
        reuseKey = key;
        attempt -= 1;
        retries.push(`[${channel.name}/${maskKey(key.key)}] 上游不支持 stream_options，已回退`);
        continue;
      }
      // 404=上游不认识这个模型名：换 key 没有意义，换候选才有（候选判负，健康计败）
      if (up.status === 404) {
        recordFailure(channel, key, 'invalid_request', brief);
        retries.push(`[${channel.name}/${maskKey(key.key)}] 404 ${brief}`);
        return { kind: 'candidate_fail', status: 404, message: brief, sample: true };
      }
      const upstreamRetryAfter = parseRetryAfter(up.headers.get('retry-after'));
      const { retryable } = recordFailure(channel, key, kind, brief, upstreamRetryAfter);
      retries.push(`[${channel.name}/${maskKey(key.key)}] ${up.status} ${brief}`);
      lastStatus = up.status >= 500 ? 502 : up.status;
      lastMessage = brief;
      lastWasRateLimit = kind === 'rate_limit';
      if (lastWasRateLimit && upstreamRetryAfter !== undefined) retryAfterMs = retryAfterMs === undefined ? upstreamRetryAfter : Math.min(retryAfterMs, upstreamRetryAfter);
      if (kind === 'invalid_request') {
        // C10：prompt 超窗 → 本候选判负、链继续（其它候选窗口更大就可能吃得下）；
        // 其余 4xx 是请求本身的问题 → 短接全链，4xx 原样透传。
        if (a.isAuto && isPromptTooLong(brief)) {
          return { kind: 'candidate_fail', status: 400, message: `prompt 超出候选窗口：${brief}`, sample: false };
        }
        return { kind: 'chain_stop', status: up.status, message: brief };
      }
      if (!retryable || attempt >= a.maxAttempts) break;
      continue;
    }

    // ---------- 成功 ----------
    recordSuccess(channel, key);
    const usage: Usage = emptyUsage();
    const meta: StreamMeta = { publicName: aliasName, usage };
    let firstContentAt = 0;
    meta.onFirstContent = () => {
      if (!firstContentAt) firstContentAt = Date.now();
    };
    const headers = {
      ...debugHeaders(settings.debugHeaders, { channel, key: key.key, publicName: aliasName, attempts: attempt, fallback: a.fallback }),
      ...(settings.debugHeaders && a.isAuto && route ? { 'x-lm-routed-to': route.publicName } : {}),
      ...(warnings.length ? { 'x-lm-warning': encodeURIComponent(warnings.join('; ')) } : {}),
    };

    const routeId = route?.id;
    // W1/§8-4：客户端中途取消 → 独立"取消"终态，双向剔除出健康分分子分母（既不算成功也不算失败）
    const finished = (err?: any, kind?: 'cancel') => {
      if (kind === 'cancel') {
        a.finalize(
          {
            status: 499,
            ok: false,
            keyId: key.id,
            error: '客户端在流式中途断开',
            ...usagePatch(usage),
            costUsd: computeCost(route, usage),
            ttftMs: firstContentAt ? firstContentAt - a.t0 : undefined,
            retries: retries.length ? retries : undefined,
          },
        );
        return;
      }
      // C1c（二轮）：上游读拒绝若由客户端断开驱动（abort 直达 undici 先于 pump cancel 的时序），
      // 必须并入 cancel 语义——否则取消被记成候选 fail 样本，违 §8-4"双向剔除"
      if (a.isAborted()) {
        finished(undefined, 'cancel');
        return;
      }
      if (routeId) a.onSample(routeId, !err); // stream 失败（提交后）也计候选失败样本（F4 两分法）
      a.finalize(
        err
          ? {
              status: 502,
              ok: false,
              keyId: key.id,
              error: `流式响应中断：${String(err?.message || err)}`,
              ...usagePatch(usage),
              costUsd: computeCost(route, usage),
              ttftMs: firstContentAt ? firstContentAt - a.t0 : undefined,
              retries: retries.length ? retries : undefined,
            }
          : {
              status: 200,
              ok: true,
              keyId: key.id,
              ...usagePatch(usage),
              costUsd: computeCost(route, usage),
              ttftMs: firstContentAt ? firstContentAt - a.t0 : undefined,
              retries: retries.length ? retries : undefined,
            },
      );
    };
    const errorFrame = (msg: string) =>
      client === 'anthropic'
        ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } })}\n\n`
        : `data: ${JSON.stringify({ error: { message: msg, type: 'api_error', code: 'upstream_stream_aborted', param: null } })}\n\ndata: [DONE]\n\n`;

    // 客户端要流式：先确认上游真在按 SSE 回话（content-type 可能缺失或骗人，窥探首块最可靠）
    if (wantsStream && up.body) {
      const sniffed = await sniffStreamBody(up.body, up.contentType);
      up.body = sniffed.body;
      if (sniffed.kind === 'sse') {
        let out: ReadableStream<Uint8Array>;
        if (protocol === client) out = passthroughStream(up.body, protocol, meta, a.aliasDiffers ? { to: aliasName } : undefined);
        else if (client === 'openai') out = anthropicStreamToOpenai(up.body, meta);
        else out = openaiStreamToAnthropic(up.body, meta);
        // 只要对外是 legacy 线格式，一律给 text_completion 分块（与上游协议无关）
        if (wire === 'openai-legacy') out = chatStreamToLegacy(out, aliasName);
        // C1a（二轮）：sniff 是 await——此刻客户端可能已断。AbortSignal 对晚到的监听器
        // **永不补发事件**（node 实测），裸挂监听器恰好治不到 M5 宣称要治的场景；
        // 且 node-server 对 destroyed writable 直接 return（不 pull 不 cancel）。必须先复查。
        if (c.req.raw.signal.aborted) {
          up.dispose();
          return { kind: 'client_abort' };
        }
        // C1b（二轮）：提交后 signal 一 abort（正常中途断开 / writeHead 弃养都走这），
        // 统一复用 finished('cancel')：正确文案 + ttftMs；finalize 幂等令 track 终态自动 no-op。
        c.req.raw.signal.addEventListener('abort', () => finished(undefined, 'cancel'), { once: true });
        // C2（二轮）：M6 之后"下游停读且未断开"（合盖/半开）不再有任何计时器——
        // 提交点挂绝对时限 watchdog（默认 ~head+8×idle，刻意宽松到正常流远不可达），
        // 触发即掐上游并记 502，杜绝被冻结客户端无限期钉住预占/日志/连接
        const watchdogMs = a.headTimeoutMs + a.idleTimeoutMs * 8;
        let wd: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          wd = undefined;
          up.dispose();
          finished(new Error(`流绝对时限 ${Math.round(watchdogMs / 1000)}s 到达（下游疑似停读/半开）`));
        }, watchdogMs);
        wd.unref?.();
        const trackFinished = (err?: any, kind?: 'cancel') => {
          if (wd) {
            clearTimeout(wd);
            wd = undefined;
          }
          finished(err, kind);
        };
        a.onCommitted(); // 提交点：粘性/审计在此定格（§8-1：此后不可能再换候选）
        return { kind: 'response', res: c.body(track(out, trackFinished, errorFrame), 200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
          ...headers,
        }) };
      }
      // 落到下面按整块 JSON 处理，再合成 SSE 回给客户端
    }

    // 非流式（含"客户端要流式、上游只给 JSON"）：先拿到对象
    const json = await readJson(up.body);
    up.dispose();
    // M4：sniff 窗口的读异常被吞成"按 JSON 处理"，取消会在这里现形——
    // 不复查就会 recordFailure（key 冷却）+ 健康分记败，断开不是故障（§8-4）
    if (a.isAborted()) return { kind: 'client_abort' };
    // 守卫必须严：200 + null/标量/数组体直接往下走会踩属性访问抛未捕获异常
    if (json === undefined || json === null || typeof json !== 'object' || Array.isArray(json)) {
      lastStatus = 502;
      lastMessage = '上游返回 200 但响应体不是合法的 JSON 对象';
      recordFailure(channel, key, 'upstream', lastMessage);
      retries.push(`[${channel.name}/${maskKey(key.key)}] ${lastMessage}`);
      lastWasRateLimit = false;
      if (attempt >= a.maxAttempts) break;
      continue;
    }

    applyUsage(usage, protocol, json);
    if (a.aliasDiffers && json && typeof json === 'object') json.model = aliasName;
    const clientObj = protocol === client ? json : client === 'openai' ? anthropicToOpenaiResponse(json, aliasName) : openaiToAnthropicResponse(json, aliasName);
    const legacyObj = wire === 'openai-legacy' ? chatResponseToLegacy(clientObj) : clientObj;

    a.onCommitted();
    a.onPreFinalize?.(); // 链记录先落账，再交给内部 finalize（快照时序）
    if (routeId) a.onSample(routeId, true);
    // 客户端要流式但上游只给了 JSON：把完整响应合成成 SSE，别回空响应
    if (wantsStream) {
      // 合成时统一用 chat 结构（legacy 对象没有 message.content，喂进去会合成出空文本）
      const sse =
        wire === 'anthropic'
          ? anthropicJsonToSSE(clientObj, aliasName, usage)
          : wire === 'openai-legacy'
            ? chatStreamToLegacy(openaiJsonToSSE(clientObj, aliasName, usage), aliasName)
            : openaiJsonToSSE(clientObj, aliasName, usage);
      a.finalize({ status: 200, ok: true, keyId: key.id, ...usagePatch(usage), costUsd: computeCost(route, usage), retries: retries.length ? retries : undefined });
      return { kind: 'response', res: c.body(sse, 200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', ...headers }) };
    }

    a.finalize({ status: 200, ok: true, keyId: key.id, ...usagePatch(usage), costUsd: computeCost(route, usage), retries: retries.length ? retries : undefined });
    return { kind: 'response', res: c.json(legacyObj as any, 200, headers) };
  }

  // key 级重试穷尽：候选判负（rate_limit 不计健康样本，C11）
  return { kind: 'candidate_fail', status: lastStatus, message: lastMessage, sample: !lastWasRateLimit, rateLimit: lastWasRateLimit, retryAfterMs };
}

/**
 * 流式收尾包装：正常结束 / 客户端取消 / 中途出错 三种终态都要记账一次。
 * 中途出错时不把异常甩给响应流（客户端只会看到连接被掐），
 * 而是发一个协议内合法的 error 事件，让 agent 能读到原因。
 */
function track(
  stream: ReadableStream<Uint8Array>,
  onDone: (err?: any, kind?: 'cancel') => void,
  errorFrame: (msg: string) => string,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let fired = false;
  let settled = false; // 终态标志：取消之后可能还有在途 pull 醒来，不能再碰 controller
  const fire = (err?: any, kind?: 'cancel') => {
    if (fired) return;
    fired = true;
    try {
      onDone(err, kind);
    } catch (e) {
      console.error('[gateway] finalize failed', e);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (settled) return;
      try {
        const { done, value } = await reader.read();
        if (settled) return;
        if (done) {
          settled = true;
          fire();
          controller.close();
        } else if (value !== undefined) {
          controller.enqueue(value);
        }
      } catch (err: any) {
        if (settled) return;
        settled = true;
        const msg = String(err?.message || err || '上游流式响应中断');
        console.error(`[gateway] 流中断：${msg}`);
        fire(err);
        controller.enqueue(new TextEncoder().encode(errorFrame(msg)));
        controller.close();
      }
    },
    cancel(reason) {
      settled = true;
      fire(undefined, 'cancel');
      reader.cancel(reason).catch(() => {});
    },
  });
}

// ---------------------------------------------------------------- 主流程

export async function gateway(c: Context, op: 'chat' | 'messages' | 'embeddings', wire: WireFormat) {
  const t0 = Date.now();
  const settings = store.getSettings();
  const client: 'openai' | 'anthropic' = wire === 'anthropic' ? 'anthropic' : 'openai';

  const rawKey = extractClientKey(c);
  if (!rawKey) return fail(c, wire, 401, 'missing api key（请在 Authorization: Bearer <key> 或 x-api-key 中携带统一 key）');
  const vkey = store.findVKey(rawKey);
  if (!vkey) return fail(c, wire, 401, 'invalid api key');
  if (!vkey.enabled) return fail(c, wire, 403, 'api key disabled');

  // 限流在任何 await 之前准入：否则并发请求会在计数落地前一起穿过
  const rl = admitRequest(vkey.id);
  if (!rl.ok) {
    pushLog(baseLog(t0, vkey, c, wire, op), { status: 429, error: rl.reason });
    return fail(c, wire, 429, rl.reason || 'rate limited', rl.retryAfterSec ? { 'retry-after': String(rl.retryAfterSec) } : undefined);
  }

  // 请求体上限：不设限的话一个超大 body 就能把进程内存吃光
  const declared = Number(c.req.header('content-length') || 0);
  if (declared && declared > settings.maxBodyBytes) {
    return fail(c, wire, 413, `request body too large (${declared} > ${settings.maxBodyBytes} bytes)`);
  }

  // 流式边读边计数：缺 content-length（chunked）时也立即在超限处中止 413
  let body: any;
  let rawText = '';
  const reader = c.req.raw.body?.getReader();
  if (reader) {
    const dec = new TextDecoder();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > settings.maxBodyBytes) {
        await reader.cancel().catch(() => {});
        return fail(c, wire, 413, `request body too large (limit ${settings.maxBodyBytes} bytes)`);
      }
      rawText += dec.decode(value, { stream: true });
    }
    rawText += dec.decode();
  }
  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch {
    return fail(c, wire, 400, 'request body is not valid JSON');
  }

  // C5（二轮）：model 落库必须限长——64MB 的 model 字段会经全量 stringify 冻结事件循环
  const requestedModel = String(body.model || '').slice(0, 256);
  if (!requestedModel) return fail(c, wire, 400, 'missing "model" field');

  const log = baseLog(t0, vkey, c, wire, op);
  log.requestedModel = requestedModel;
  log.stream = !!body.stream;
  /** 每日 token 限额的预占估算，转发前确定、所有终态统一 release */
  let estTokens = 0;
  let finalized = false;
  const finalize = (patch: Partial<RequestLog> = {}) => {
    if (finalized) return; // 幂等：任何路径（含异常兜底）只允许记账一次
    finalized = true;
    Object.assign(log, patch, { latencyMs: Date.now() - t0 });
    vkey.lastUsedAt = Date.now();
    pushLog(log, patch);
    recordQuota(vkey.id, log.promptTokens + log.completionTokens, log.costUsd);
    releaseQuota(vkey.id, estTokens);
  };

  // legacy completions 先归一到 chat，再走统一的协议转换/出参流程（auto 硬过滤也基于归一后的体）
  const chatBody = wire === 'openai-legacy' ? legacyToChatRequest(body) : body;
  const wantsStream = !!chatBody.stream && op !== 'embeddings';
  const isAborted = () => c.req.raw.signal.aborted;
  const maxAttempts = Math.max(1, settings.maxKeyRetries);
  const idleTimeoutMs = settings.upstreamIdleTimeoutMs;

  try {
    const autoRoute = store.findAutoRouteByName(requestedModel);
    if (autoRoute) {
      return await runAuto({ c, log, settings, vkey, wire, client, op, chatBody, wantsStream, autoRoute, finalize, setEst: (n) => { estTokens = n; }, isAborted, maxAttempts, idleTimeoutMs, t0 });
    }

    // ---------------- 既有单候选路径（行为零回归：无链预算、超时取渠道自身值） ----------------
    const resolved = resolveRoute(requestedModel);
    if ('error' in resolved) {
      finalize({ status: 404, error: resolved.error });
      return fail(c, wire, 404, resolved.error);
    }
    const { channel, route, upstreamModel, protocol } = resolved;
    const publicName = route?.publicName || requestedModel;
    if (!allowedForKey(vkey, publicName)) {
      finalize({ status: 403, error: 'model not allowed for this key' });
      return fail(c, wire, 403, `this key is not allowed to access model "${publicName}"`);
    }
    // 对外别名与上游真名不同才需要改写响应里的 model，避免泄漏上游真实模型名
    const aliasDiffers = upstreamModel !== publicName;

    // 每日 token 限额的并发防护：转发前按上限在途预占，所有终态统一 release。
    estTokens =
      (Number(chatBody?.max_tokens) || Number(chatBody?.max_completion_tokens) || route?.maxOutputTokens || 0) +
      estimateInputTokens(chatBody);
    const daily = admitDailyQuota(vkey.id, estTokens, vkey.dailyTokenLimit || 0);
    if (!daily.ok) {
      estTokens = 0;
      const dailyMsg = `daily token limit reached (${vkey.dailyTokenLimit})`;
      finalize({ status: 429, error: dailyMsg, retries: [] });
      return fail(c, wire, 429, dailyMsg, { 'retry-after': String(daily.retryAfterSec) });
    }
    estTokens = daily.reserved; // 释放额=实际入册额（限额为 0 不记账；中途改限长的竞态不误伤他人预占）

    const retries: string[] = [];
    const outcome = await attemptRoute({
      c, log, settings, wire, client, op, chatBody, wantsStream,
      route, channel, upstreamModel, protocol,
      aliasName: publicName, logPublicName: publicName, aliasDiffers,
      fallback: resolved.fallback,
      retries,
      headTimeoutMs: channel.timeoutMs || settings.defaultUpstreamTimeoutMs,
      idleTimeoutMs,
      maxAttempts,
      attemptBase: 0,
      isAuto: false,
      isAborted,
      finalize,
      t0,
      onSample: (rid, ok) => recordAttempt(rid, ok), // C12：定向流量也进健康窗口
      onCommitted: () => {},
    });
    if (outcome.kind === 'response') return outcome.res;
    if (outcome.kind === 'client_abort') {
      finalize({ status: 499, ok: false, error: '客户端已断开（上游响应前）', retries: retries.length ? retries : undefined });
      return fail(c, wire, 499, 'client aborted');
    }
    if (outcome.kind === 'chain_stop') {
      finalize({ status: outcome.status, error: outcome.message, retries: retries.length ? retries : undefined });
      return fail(c, wire, outcome.status, outcome.message, settings.debugHeaders && retries.length ? { 'x-lm-retries': String(retries.length) } : undefined);
    }
    if (outcome.sample && route) recordAttempt(route.id, false);
    finalize({ status: outcome.status, error: outcome.message, retries: retries.length ? retries : undefined });
    return fail(
      c,
      wire,
      outcome.status,
      outcome.message,
      {
        ...(settings.debugHeaders && retries.length ? { 'x-lm-retries': String(retries.length) } : {}),
        ...(outcome.rateLimit && outcome.retryAfterMs !== undefined ? { 'retry-after': String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000))) } : {}),
      },
    );
  } catch (err: any) {
    // 兜底：任何未预期异常也必须 finalize（释放预占、落日志），并回协议内错误
    const msg = `网关内部错误：${String(err?.message || err)}`;
    console.error('[gateway] unhandled:', err);
    finalize({ status: 502, error: msg });
    return fail(c, wire, 502, msg);
  }
}

// ---------------------------------------------------------------- auto 候选链

interface AutoRunCtx {
  c: Context;
  log: RequestLog;
  settings: Settings;
  vkey: VirtualKey;
  wire: WireFormat;
  client: ClientProtocol;
  op: 'chat' | 'messages' | 'embeddings';
  chatBody: any;
  wantsStream: boolean;
  autoRoute: AutoRoute;
  /** 写回 gateway 闭包的 estTokens（release 与 reserve 对称的唯一通道） */
  setEst: (n: number) => void;
  finalize: (patch?: Partial<RequestLog>) => void;
  isAborted: () => boolean;
  maxAttempts: number;
  idleTimeoutMs: number;
  t0: number;
}

async function runAuto(ctx: AutoRunCtx) {
  const { c, log, settings, vkey, wire, op, chatBody, wantsStream, autoRoute, finalize, isAborted } = ctx;
  const autoName = autoRoute.publicName;
  const fail4 = (status: number, msg: string) => {
    finalize({ status, error: msg });
    return fail(c, wire, status, msg);
  };

  // §6：embeddings × auto 直接禁止（anthropic 候选会把 embedding 体转成占位聊天消息、返回形状错的 200）
  // 鉴权层 1 置于最前（§5.1/S6）：未授权 key 不得经 embeddings-400 / 停用-404 探测 auto 名存在性与开关
  if (!allowedForKey(vkey, autoName)) return fail4(403, `this key is not allowed to access model "${autoName}"`);
  if (op === 'embeddings') return fail4(400, 'auto 路由不支持 /v1/embeddings');
  if (!autoRoute.enabled) return fail4(404, `auto 路由 "${autoName}" 已停用`);

  const inputEst = estimateInputTokens(chatBody);
  const evals = evaluateCandidates(autoRoute, vkey, chatBody, wire, wantsStream, inputEst);
  const survivors = evals.filter((e): e is SurvivingEval => e.ok);
  if (!survivors.length) {
    const reasons = evals.map((e) => `${e.name}：${e.reason}`).join('；');
    return fail4(404, `auto "${autoName}" 没有满足本请求约束的候选${evals.length ? `（${reasons}）` : '（candidates 为空）'}`);
  }

  // B5 配额预占：输入估算 + max(存活候选 maxOutputTokens, 请求 max_tokens)。
  // 链只在进入时存活集内扩展，入口取 max 即覆盖全链——不存在"切更高候选"的补差场景。
  const reqMax = Number(chatBody?.max_tokens) || Number(chatBody?.max_completion_tokens) || 0;
  const candMax = survivors.reduce((m, e) => Math.max(m, e.route.maxOutputTokens || 0), 0);
  const est = inputEst + Math.max(reqMax, candMax);
  const daily = admitDailyQuota(vkey.id, est, vkey.dailyTokenLimit || 0);
  if (!daily.ok) {
    ctx.setEst(0); // 显式契约：不依赖"此刻外层必为 0"的位置性不变量
    const dailyMsg = `daily token limit reached (${vkey.dailyTokenLimit})`;
    finalize({ status: 429, error: dailyMsg, retries: [] });
    return fail(c, wire, 429, dailyMsg, { 'retry-after': String(daily.retryAfterSec) });
  }
  // B1：预占额必须回写外层闭包（finalize 统一 release）。在 runAuto 声明局部
  // const estTokens 会遮蔽外层 → release 恒 0，带限额 vkey 的在途预占永久泄漏自锁
  ctx.setEst(daily.reserved);

  // ② 粘性（命中条件：仍通过 ① 且 health >= 0.4；瞬态不满足只绕行不改写记录，C6）
  let firstPick: SurvivingEval | undefined;
  let stickyBypassed = false;
  if (autoRoute.stickyTtlMs > 0) {
    const entry = getSticky(vkey.id, autoName);
    if (entry) {
      const target = survivors.find((e) => e.cand.routeId === entry.routeId);
      if (target && target.health >= STICKY_KEEP) {
        firstPick = target;
        touchSticky(vkey.id, autoName, autoRoute.stickyTtlMs); // 命中续期（滑动 TTL）
      } else if (!target) {
        const failedEval = evals.find((e) => e.cand.routeId === entry.routeId);
        if (!failedEval || !failedEval.transient) deleteSticky(vkey.id, autoName); // 改写清单：彻底换绑定
        else stickyBypassed = true; // 瞬态：记录保留，本轮绕行
      } else if (target.health < STICKY_KEEP) {
        deleteSticky(vkey.id, autoName);
      }
    }
  }

  // ③④ 加权随机 + 跨候选链
  const chainT0 = Date.now();
  const maxChainMs = Math.max(10, settings.autoMaxChainSeconds || 300) * 1000;
  const retries: string[] = [];
  const chainAttempts: ChainAttempt[] = [];
  log.chainAttempts = chainAttempts; // 同一引用：finalize 序列化时自然带全
  const tried = new Set<string>();
  let sawRateLimit = false;
  let retryAfterMs: number | undefined;
  let lastStatus = 502;
  let lastMessage = `auto "${autoName}" 所有候选均失败`;
  let stopInvalid: { status: number; message: string } | undefined;
  let budgetNote = '';

  const chooseNext = (): SurvivingEval | undefined => {
    const rest = survivors.filter((e) => !tried.has(e.cand.routeId));
    if (!rest.length) return undefined;
    return pickWeighted(rest, (e) => e.cand.weight * e.health);
  };

  let pick = firstPick && !tried.has(firstPick.cand.routeId) ? firstPick : chooseNext();
  while (pick) {
    if (isAborted()) return autoAbort(c, wire, log, retries, finalize);
    // 链预算（N10）：每 attempt 头超时 = min(剩余预算, 渠道超时)；续链要求预算装得下最坏尝试
    const remaining = maxChainMs - (Date.now() - chainT0);
    const headTimeoutMs = Math.max(1_000, Math.min(remaining, pick.channel.timeoutMs || settings.defaultUpstreamTimeoutMs));
    if (chainAttempts.length > 0 && remaining < Math.min(5_000, ctx.idleTimeoutMs)) {
      // N10-b（v2.3 修正）：剩余预算撑不起一次最小可行 attempt 才停止扩展。
      // 原字面"剩余 < 首包+空闲"在默认预算(300s) < 单跳最坏(420s) 下恒成立，会杀死全部续链语义。
      budgetNote = `链预算 ${Math.round(maxChainMs / 1000)}s 耗尽（剩余 ${Math.max(0, Math.round(remaining / 1000))}s 不足以开启下一 attempt）`;
      break;
    }
    tried.add(pick.cand.routeId);
    const cur = pick;
    const aT0 = Date.now();
    // 提交类 attempt 的 finalize 发生在 attemptRoute 内部——链记录须经 onPreFinalize 先登记，
    // 否则 pushLog 快照落库时 chainAttempts 还是空的（失败类 finalize 都在循环尾之后，不受影响）
    let entryPushed = false;
    const pushEntry = (status: number, error: string | undefined, committed: boolean) => {
      if (entryPushed) return;
      entryPushed = true;
      chainAttempts.push({ routeId: cur.cand.routeId, name: cur.name, channel: cur.channel.name, status, ms: Date.now() - aT0, error: error?.slice(0, 300), committed });
    };
    let outcome: AttemptOutcome;
    try {
    outcome = await attemptRoute({
      c, log, settings, wire, client: ctx.client, op, chatBody, wantsStream,
      route: cur.route, channel: cur.channel, upstreamModel: cur.route.upstreamModel, protocol: cur.protocol,
      // 响应体 model 恒为 auto 名（§5.2，aliasDiffers 对 auto 恒真）；日志记候选外名 + routedTo
      aliasName: autoName, logPublicName: cur.name, aliasDiffers: true, fallback: false,
      retries,
      headTimeoutMs,
      idleTimeoutMs: Math.min(ctx.idleTimeoutMs, Math.max(5_000, remaining)), // S4：响应体阶段同样受链预算夹制
      maxAttempts: ctx.maxAttempts,
      attemptBase: log.attempts,
      isAuto: true,
      isAborted,
      finalize: ctx.finalize,
      t0: ctx.t0,
      onPreFinalize: () => pushEntry(200, undefined, true),
      onSample: (rid, ok) => recordAttempt(rid, ok),
      onCommitted: () => {
        log.routedTo = cur.name;
        if (firstPick && cur.cand.routeId === firstPick.cand.routeId) return; // 命中即已续期
        if (stickyBypassed) return; // 绕行轮不得覆写原绑定（C3）
        if (autoRoute.stickyTtlMs > 0 && healthOf(cur.cand.routeId) >= STICKY_RESTICK) setSticky(vkey.id, autoName, cur.cand.routeId, autoRoute.stickyTtlMs);
      },
    });
    } catch (err) {
      // 二轮建议：未预期异常（转换层 TypeError 等）也要落链记录，跨候选明细不断档
      pushEntry(502, `网关尝试异常：${String((err as any)?.message || err)}`, false);
      throw err;
    }
    pushEntry(
      outcome.kind === 'response' ? 200 : outcome.kind === 'client_abort' ? 499 : outcome.status,
      outcome.kind === 'response' ? undefined : 'message' in outcome ? outcome.message : '客户端断开',
      outcome.kind === 'response',
    );

    if (outcome.kind === 'response') return outcome.res;
    if (outcome.kind === 'client_abort') return autoAbort(c, wire, log, retries, finalize);
    if (outcome.kind === 'chain_stop') {
      stopInvalid = { status: outcome.status, message: outcome.message };
      break;
    }
    lastStatus = outcome.status;
    lastMessage = outcome.message;
    // M1（v2.4 裁决）：粘性命中候选运行时判负（N8 掏空/5xx/超时）→ 本轮视同绕行：
    // 其后成功候选不得覆写原绑定。瞬态运行时失败不在改写清单；health<0.4 由下轮自然松手
    if (firstPick && cur.cand.routeId === firstPick.cand.routeId) stickyBypassed = true;
    if (outcome.rateLimit) sawRateLimit = true;
    if (outcome.retryAfterMs !== undefined) retryAfterMs = retryAfterMs === undefined ? outcome.retryAfterMs : Math.min(retryAfterMs, outcome.retryAfterMs);
    if (outcome.sample) recordAttempt(cur.cand.routeId, false);
    pick = chooseNext();
  }

  // C17：跨候选明细默认回显——单用户网关里这就是自己的调试路标；硬底线是 maskKey 照旧、绝不漏 key 全值。
  const detail = retries.length ? retries.join(' | ') : lastMessage;
  if (stopInvalid) {
    finalize({ status: stopInvalid.status, error: `${stopInvalid.message}`, retries: retries.length ? retries : undefined });
    return fail(c, wire, stopInvalid.status, stopInvalid.message, settings.debugHeaders && retries.length ? { 'x-lm-retries': String(retries.length) } : undefined);
  }
  const finalStatus = sawRateLimit ? 429 : 502; // C11：链终曾见 429 → 透传 429，不伪装 502
  const msg = `${budgetNote ? budgetNote + '；' : ''}所有候选均失败：${detail}`.slice(0, 2000);
  finalize({ status: finalStatus, error: msg, retries: retries.length ? retries : undefined });
  return fail(c, wire, finalStatus, msg, {
    ...(settings.debugHeaders && retries.length ? { 'x-lm-retries': String(retries.length) } : {}),
    ...(finalStatus === 429 && retryAfterMs !== undefined ? { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } : {}),
  });
}

function autoAbort(c: Context, wire: WireFormat, log: RequestLog, retries: string[], finalize: (patch?: Partial<RequestLog>) => void) {
  finalize({ status: 499, ok: false, error: '客户端已断开（候选链终止）', retries: retries.length ? retries : undefined });
  return fail(c, wire, 499, 'client aborted');
}

// ---------------------------------------------------------------- 辅助

function baseLog(ts: number, vkey: VirtualKey, c: Context, wire: WireFormat, op: string): RequestLog {
  return {
    id: newId('log'),
    ts,
    path: c.req.path,
    endpoint: op,
    requestedModel: '',
    wire,
    vkeyId: vkey.id,
    vkeyName: vkey.name,
    status: 0,
    ok: false,
    stream: false,
    latencyMs: 0,
    attempts: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    clientIp: (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '').slice(0, 64) || undefined,
    retries: [],
  };
}

function pushLog(log: RequestLog, patch: Partial<RequestLog> = {}) {
  if (patch.stream !== undefined) log.stream = patch.stream;
  store.pushLog(log);
}

function usagePatch(u: Usage) {
  return {
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
  };
}

function applyUsage(u: Usage, protocol: string, json: any): Usage {
  Object.assign(u, emptyUsage(), protocol === 'anthropic' ? usageFromAnthropic(json.usage) : usageFromOpenai(json.usage));
  return u;
}

async function readJson(body: ReadableStream<Uint8Array> | null): Promise<any> {
  if (!body) return undefined;
  try {
    const text = await new Response(body).text();
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 输入 token 粗估（chars/4 + 图片≈1600tok/张）：①-c 窗口过滤与每日限额在途预占共用。
 * M2：anthropic 顶层 system / tools schema / tool_result / image 都计入——Claude Code
 * 级流量大头全在这几项，漏算会系统性漏剔小窗候选，只能赌 isPromptTooLong 正则兜底。
 */
export function estimateInputTokens(body: any): number {
  let chars = 0;
  let images = 0;
  const pushContent = (content: unknown, depth = 0): void => {
    if (typeof content === 'string' || typeof content === 'number') chars += String(content).length;
    else if (Array.isArray(content) && depth <= 4) {
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        if (typeof (p as any).text === 'string') chars += (p as any).text.length;
        else if (typeof (p as any).input_text === 'string') chars += (p as any).input_text.length;
        else if (typeof (p as any).thinking === 'string') chars += (p as any).thinking.length;
        else if ((p as any).type === 'tool_result') pushContent((p as any).content, depth + 1);
        else if ((p as any).type === 'tool_use' && (p as any).input != null) chars += String(JSON.stringify((p as any).input)).length; // 工具调用参数也是 prompt 大头
        else if ((p as any).type === 'image' || (p as any).type === 'image_url') images += 1;
      }
    }
  };
  // C4（二轮）：不可信 JSON 的 messages 可能不是数组（{} / 5 / true）——for-of 会 TypeError 炸成 500
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  pushContent(body?.system); // anthropic 顶层 system（不计的话系统提示词整段漏空）
  for (const m of msgs) {
    pushContent(m?.content);
    if (Array.isArray(m?.tool_calls)) for (const tc of m.tool_calls) if (typeof tc?.function?.arguments === 'string') chars += tc.function.arguments.length; // openai tool_calls.arguments 补漏
  }
  if (Array.isArray(body?.tools) && body.tools.length) chars += JSON.stringify(body.tools).length; // 工具 schema 同样进 prompt
  // embeddings 没有 messages 只有 input：不估的话它完全绕过每日限额的在途预占
  const inp = body?.input;
  if (typeof inp === 'string' || typeof inp === 'number') chars += String(inp).length;
  else if (Array.isArray(inp)) for (const it of inp) pushContent(it);
  return Math.ceil((chars + images * 6400) / 4);
}

/** GET /v1/models —— 对外只暴露已配置且该 key 有权访问的模型；auto 条目按 §5.2 契约合成 */
export function listModels(c: Context) {
  const rawKey = extractClientKey(c);
  if (!rawKey) return fail(c, 'openai', 401, 'missing api key');
  const vkey = store.findVKey(rawKey);
  if (!vkey) return fail(c, 'openai', 401, 'invalid api key');
  if (!vkey.enabled) return fail(c, 'openai', 403, 'api key disabled');
  const rl = admitRequest(vkey.id);
  if (!rl.ok) return fail(c, 'openai', 429, rl.reason || 'rate limited', rl.retryAfterSec ? { 'retry-after': String(rl.retryAfterSec) } : undefined);

  const models = store
    .listModels()
    .filter((m) => m.enabled && allowedForKey(vkey, m.publicName))
    .map((m) => ({
      id: m.publicName,
      object: 'model',
      created: Math.floor(m.createdAt / 1000),
      owned_by: `llm-manager:${store.getChannel(m.channelId)?.name || 'unknown'}`,
      context_length: m.contextWindow,
      ...(m.maxOutputTokens ? { max_output_tokens: m.maxOutputTokens } : {}),
    }));
  // auto 条目：owned_by 不暴露候选所在渠道；context_length=有效候选最小；候选菜单不外泄
  const autos = store
    .listAutoRoutes()
    .filter((a) => a.enabled && allowedForKey(vkey, a.publicName))
    .map((a) => {
      const cands = a.candidates
        .map((cand) => (cand.weight !== 0 ? store.getModel(cand.routeId) : undefined)) // 有效候选：与路由侧 weight!==0 同口径
        .filter((m): m is ModelRoute => !!m && m.enabled && !!store.getChannel(m.channelId)?.enabled && allowedForKey(vkey, m.publicName));
      const ctxs = cands.map((m) => m.contextWindow).filter((v): v is number => !!v && v > 0);
      const outs = cands.map((m) => m.maxOutputTokens);
      return {
        id: a.publicName,
        object: 'model',
        created: Math.floor(a.createdAt / 1000),
        owned_by: 'llm-manager:auto',
        ...(ctxs.length ? { context_length: Math.min(...ctxs) } : {}),
        ...(outs.length && outs.every((v) => !!v) ? { max_output_tokens: Math.min(...(outs as number[])) } : {}),
      };
    });
  return c.json({ object: 'list', data: [...models, ...autos] });
}
