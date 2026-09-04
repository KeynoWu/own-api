// 领域模型定义

/** 上游协议族。决定请求/响应编解码方式 */
export type Protocol = 'openai' | 'anthropic';

/** 密钥在号池中的健康状态 */
export type KeyStatus = 'active' | 'cooldown' | 'disabled';

export interface ChannelKey {
  id: string;
  key: string;
  name?: string;
  status: KeyStatus;
  /** 冷却到期时间戳（ms）。cooldown 状态且未到期时不参与选取 */
  cooldownUntil?: number;
  lastError?: string;
  lastErrorAt?: number;
  lastUsedAt?: number;
  totalRequests: number;
  totalErrors: number;
  /** 权重，默认 1；用于加权轮询 */
  weight: number;
  note?: string;
}

/** 一个上游渠道（供应商账号 / 中转站 / 本地推理服务） */
export interface Channel {
  id: string;
  name: string;
  /** 上游 base url，如 https://api.openai.com/v1 */
  baseUrl: string;
  protocol: Protocol;
  keys: ChannelKey[];
  enabled: boolean;
  /** 附加请求头（部分中转需要自定义 header） */
  extraHeaders?: Record<string, string>;
  /** 覆盖默认鉴权头名，默认 Authorization: Bearer；anthropic 用 x-api-key */
  authStyle?: 'bearer' | 'x-api-key';
  /** 单请求超时（ms），默认取全局配置 */
  timeoutMs?: number;
  createdAt: number;
  note?: string;
  /** 连通测试用的模型名：上游没有 /models 列表接口时用它打一次最小对话（选填） */
  testModel?: string;
  /** 该上游真实可用的模型名列表（模型路由创建时从中选择，选填） */
  modelList?: string[];
}

/** 对外的一个模型条目：agent 侧看到的 model 名 */
export interface ModelRoute {
  id: string;
  /** 对外暴露的模型名，agent 在请求体里传这个 */
  publicName: string;
  /** 归属渠道 */
  channelId: string;
  /** 上游真实模型名 */
  upstreamModel: string;
  /** 该模型走的上游协议；缺省继承 channel.protocol */
  protocol?: Protocol;
  enabled: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  /** 是否支持 tools；缺省视为支持（仅显式 false 在 auto 硬过滤中剔除，裁决 C1） */
  supportsTools?: boolean;
  /** 每百万 token 单价（美元），用于花费估算 */
  priceInput?: number;
  priceOutput?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /** 展示用别名/标签 */
  tags?: string[];
  createdAt: number;
  note?: string;
}

/** 对外分发的虚拟密钥（统一 key）。agent 只需这一个 key */
export interface VirtualKey {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  /** 允许访问的 publicName 列表；空数组 = 全部允许 */
  allowedModels: string[];
  createdAt: number;
  lastUsedAt?: number;
  /** 每分钟请求上限，0 = 不限 */
  rpmLimit?: number;
  /** 每日 token 上限，0 = 不限 */
  dailyTokenLimit?: number;
  note?: string;
}

export interface RequestLog {
  id: string;
  ts: number;
  /** 进程内单调序号：日志流按它做增量推送（数组会被 logRetention 裁剪，下标不可靠） */
  seq?: number;
  /** 网关入口路径，如 /v1/chat/completions */
  path: string;
  endpoint: string;
  /** 对外线格式：openai / openai-legacy / anthropic */
  wire?: string;
  requestedModel: string;
  /** 命中的路由（可能为空表示未命中） */
  publicName?: string;
  channelId?: string;
  channelName?: string;
  keyId?: string;
  vkeyId?: string;
  vkeyName?: string;
  status: number;
  ok: boolean;
  stream: boolean;
  latencyMs: number;
  ttftMs?: number;
  attempts: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  error?: string;
  clientIp?: string;
  /** 触发故障切换的错误链摘要 */
  retries?: string[];
  /** auto 路由：最终生效候选的 publicName（审计用） */
  routedTo?: string;
  /** auto 路由：跨候选尝试审计（候选/状态/耗时/原因，C18 不做成本审计） */
  chainAttempts?: ChainAttempt[];
}

/** auto 链上一次候选尝试的审计条目 */
export interface ChainAttempt {
  routeId: string;
  name?: string;
  channel?: string;
  status: number;
  ms: number;
  error?: string;
  /** 已提交（200 已交给框架，提交后失败不可再换候选） */
  committed?: boolean;
}

export interface AutoCandidate {
  /** 引用 ModelRoute.id；渠道/模型改动自动跟随，不复制属性 */
  routeId: string;
  /** 手动权重 >=1 整数；0 = 禁用：进 ① 硬过滤且强制驱逐粘性（裁决 C2） */
  weight: number;
}

/** 自动路由条目：agent 请求 publicName 时按「硬过滤→粘性→加权」在候选中选路（docs/model-auto-design.md） */
export interface AutoRoute {
  id: string;
  /** 对外名；全局唯一，且不得与 ModelRoute.publicName 或其 tags 冲突（双向校验，W7） */
  publicName: string;
  candidates: AutoCandidate[];
  /** 粘性 TTL（ms），命中续期；0 = 关粘性 */
  stickyTtlMs: number;
  enabled: boolean;
  createdAt: number;
  note?: string;
}

export interface Settings {
  adminToken: string;
  /** 拿到响应头的超时 */
  defaultUpstreamTimeoutMs: number;
  /** 流式响应体两次数据之间的最大空闲，超过即中断 */
  upstreamIdleTimeoutMs: number;
  /** 单次请求体上限（字节），防止超大 body 常驻内存 */
  maxBodyBytes: number;
  /** 是否对 agent 暴露 x-lm-channel / x-lm-key 等内部信息（默认关） */
  debugHeaders: boolean;
  maxKeyRetries: number;
  /** 连续失败多少次后进入冷却 */
  errorThreshold: number;
  cooldownBaseMs: number;
  cooldownMaxMs: number;
  /** 日志保留条数 */
  logRetention: number;
  /** auto 路由跨候选链的硬预算（秒，C16：本地模型加载首请求可达数十秒，默认 300） */
  autoMaxChainSeconds: number;
  /** 未知模型时是否透传给默认兜底渠道 */
  fallbackChannelId?: string;
}

export interface Quota {
  day: string;
  tokens: number;
  requests: number;
  costUsd: number;
}

export interface DBShape {
  version: number;
  /** 按天配额累计（vkeyId -> Quota），与日志裁剪解耦 */
  quotas: Record<string, Quota>;
  channels: Channel[];
  models: ModelRoute[];
  autoRoutes: AutoRoute[];
  vkeys: VirtualKey[];
  logs: RequestLog[];
  settings: Settings;
}
