# model_auto 自动路由 — 设计 v2.5（已实现）

> 状态：**已实现**（v2.3：实现期发现 N10-b 字面与 C10/C11 续链语义矛盾，按 C16 意图修正，见 §8-3。
> v2.4：全面审查修复轮回写——B1 预占释放、粘性命中失败不覆写（N11）、超窗 400 豁免成文、/v1/models 口径定稿、唯一性枚举补全、Retry-After 追认、idle 武装时机；守护断言见 e2e §15。
> v2.5：二轮审查修复回——M5 兜底重写（已断复查 + cancel 语义复用 + error 分支取消归位）、提交点绝对时限 watchdog、
> import 前缀导入修复、估算器类型守卫与 tool_calls/tool_use/thinking 补漏、日志字段限长；守护断言 e2e §15 扩充 + hardening F8/F9）。
> v2 经二轮评审（8 阻塞闭合，N1-N10 / W1-W7 / advisory 已全部并入）；
> v2.2 完成三轮**个人使用校准**（单用户、自建模型，§1 背景）：C14 反转（健康分全局）、
> C16-C18 新增（链预算 300s / 502 明细默认回显 / 过度设计移除）。决策总表见 §11。

---

## 1. 目标

agent 请求 `model: "model_auto"`（或其它 auto 名）时，网关按「手动权重 × 健康分」在候选模型路由中
动态选路，并对多轮会话做粘性（吃上游 prompt cache）。多 auto 名允许（如 `model_auto_cheap`）。

**使用背景（全部取舍的前提，三轮补充裁定）**：单用户本地网关——整合多个**自建**模型服务并自动路由。
据此：多租户互害防护、成本审计、对外信息泄漏门控一律降级；**① 硬过滤（contextWindow/tools 差异）是路由的
本体**（自建模型上下文/能力异构，这是日常最高频路径），健康分/粘性/加权是配菜。测试优先级同此（§8-9）。

**强烈非目标**：探测模型能力、纯统计动态权重、跨渠道成本寻优、按语义路由、embeddings 用 auto（§6）。

---

## 2. 数据模型（持久化）

`AutoRoute` 新增 `db.autoRoutes`，沿用现有 `db.json` merge/负载 Pattern（老文件无此字段安全）。

```ts
interface AutoCandidate {
  routeId: string;      // 引用 ModelRoute.id，不复制 upstreamModel/ctx/价格/协议——渠道改动作自动跟随
  weight: number;       // 手动权重 0..10000 整数（store 校验上界）；0 = 禁用：进 ① 硬过滤 + 强制驱逐粘性（§11 C2）
}

interface AutoRoute {
  id: string;           // auto_xxx
  publicName: string;   // 对外名；全局唯一，且不得与 ModelRoute.publicName **及其 tags** 冲突（双向校验，见 §4.4; tags/改名同样查重，W7）
  candidates: AutoCandidate[];   // 长度设界（默认 <=16，管理端一起强）
  stickyTtlMs: number;  // 默认 300_000（5min，命中续期），0 = 关闭粘性；上界 86_400_000（24h，v2.4 成文）（见 §11 C5）
  enabled: boolean;
  createdAt: number;
  note?: string;
}
```

**持久化边界（ADR，agent 拍板，非评审/用户原文）** `DECISION(agent): ` 配置（含 weight/candidates）落
`db.json`；健康分、粘性是**内存运行时态**不落库——粘性唯一目的是吃分钟级缓存，重启必失，内存态=重启原谅
且与"权重只影响新会话"语义自洽；落库只引入写放大、无收益。若后续要求跨重启会话连续性再改（成本极低）。

`ModelRoute` 变更（对照源码核实，W5）：`supportsStreaming` **已存在**
（types.ts:63、store.ts:328 默认 true、已在 UPDATABLE_MODEL_FIELDS），**仅需新增**：
```ts
supportsTools?: boolean;    // 见 §11 C1：缺省视为支持（仅显式 false 才剔除）
```

---

## 3. 运行时态（内存，不落盘）

### 3.1 候选级健康分（环形窗口，不在 RequestLog 上算）

**推翻 v1"不新增存储"的假前提**（评审 B2）：`finalize` 幂等、一请求一条日志，"先败 A 后成 B"时
A 的失败在日志中不存在。改为**每候选独立环形窗口，判负/成功的当下即时记录**：

```ts
interface HealthWindow {  // per cand
  ok: number; fail: number;
  // 时间戳衰减（过期样本惰性弹出），环形缓冲避免每次扫描
  // key = routeId（聚合键用 routeId，改名不破窗，§11）
}
```
- 数据源 = 每次候选判负/成功即时落；A 失败换 B 成功 → A 记 fail、B 记 ok。
- **429 不计入健康分**（§11 C11）：429 已触发 key 级冷却（pool `recordFailure`）；再计入 =
  双重惩罚 + 相关性雪崩（共享渠道多候选同跌 0.1 抹平权重信号）。
- **计入全部流量（含定向非-auto 请求）**（§11 C12）：聚合键 routeId，方向一致最简，且非-auto 失败
  也是该模型的真实故障信号，应降权。
- **豁免（v2.4 成文）**："超窗类 400"（正则识别后换大窗候选续链，C10）**不计健康分**——请求与窗口的
  形状问题不是候选故障信号。其余 4xx/5xx 与"无可用 key 候选判负"仍计入（保守口径，实现为准）。

```
health(routeId) =
  (ok + fail) 且 fail>0 且 ok==0   → 0.1（钳后，真实值 0，C4）
  (ok + fail) < 3                  → 1.0
  否则                              → max(0.1, ok/(ok+fail))
```

### 3.2 粘性（运行时 Map：vkeyId + autoName → routeId）

**目的**：多轮吃上游 prompt cache，不是绑定用户与渠道。

- **键**：`vkeyId + autoName`（共享 key 多会话互相覆写，见 §11 C7"同进同退"；OPTIONAL `x-session-id`）。
- **迟滞带（修正 N1）**：
  - **保持**：候选通过 §4 硬过滤（含 ACL）且 `health >= 0.4`（**下限，非 0.6**）→ 粘住不掷骰子。
  - **切出**（改写记录）：`health < 0.4` / TTL 过期 / 候选停用或不存在 / weight=0（C2 强制驱逐）。
  - **重新入粘**：`health >= 0.6` 时新建粘性绑定。
  - **绕行轮**（瞬态：key 冷却、contextWindow/tools 瞬时不满足）：本轮重选，**但不得覆写粘性记录**
    ——否则健康分落 [0.4,0.6) 时每轮都随机会话抢走原绑定。
  区间语义：**保持用 0.4 下限、回粘用 0.6 起点，中间带即"保持不新建"**。
- **改写清单**（§3.2+C2+N2）：TTL / 停用 / 不存在 / 健康分 < 0.4 / **weight=0**。
- **N11（v2.4）**：粘性命中后 attempt 运行时判负（N8 掏空/5xx/超时）→ 本轮视同绕行，链上后续成功候选
  **不得覆写**原绑定。瞬态运行时失败不在改写清单；持续失败由 health<0.4 自然松手，无需即时改写。
- **TTL**：默认 300_000（命中续期滑动），≤ Anthropic 缓存 5min（§11 C5）。
- **写入时机**：成功应答后写 `sticky[autoName]=最终生效候选 routeId`；选中时不写（防粘住已被重试跳过的坏候选）。
- **LRU 1000**（单用户并发远触不到；不做 per-autoName 配额——逐出风暴是多租户攻击面，此处无，C18）；
  内存 Map，不落库（§3.3）。

### 3.3 持久化边界（C0，ADR）

| 对象 | 持久化 | 理由 |
|---|---|---|
| AutoRoute 配置（weight,candidates） | db.json | 用户配置 |
| ModelRoute.supportsTools | db.json | 用户配置 |
| 健康分 HealthWindow | 仅内存 | 自愈信号；重启即原谅 |
| 粘性 Map | 仅内存 | 缓存是上游瞬态，重启无意义；ADR 见 §2 |

### 3.4 会话维 / 租户隔离

- **不做 per-session 失败计数**（避免粘性记录可变状态复杂度）；"连挂切走"由候选健康分兜住。
- **健康分全局共享（C14，个人背景校准——修正二轮误记）**：窗键 = `routeId`。单用户工具、vkey 全部自签发，
  不存在敌意租户；全局健康分即"候选的客观故障信号"，所有 vkey 共享一份学费、信号最全。
  二轮 per-vkey 方案（routeId+vkeyId，日志已带 vkeyId，types.ts:108）保留为**不可信多租户时的升级路径**，v1 不做。

---

## 4. 选路算法

请求命中 AutoRoute 名时走 auto 分支（**先于 fallbackChannelId，§4.4**）。

### 4.1 硬过滤（任一不满足即剔除，不进入加权）
```
①-a ACL：候选 ModelRoute.publicName 必须通过 allowedForKey(vkey, 候选 publicName)
         （防 model_auto 绕过 vkey 白名单；鉴权对象=候选底层真名，非 auto 名）
①-b 候选 ModelRoute 停用 / 渠道停用 / 渠道无可用 key / key 全冷却 → 剔除
         （候选 routeId 不存在/已删除同样剔除，悬空引用，C8）
①-c 估算 prompt tokens > 候选 contextWindow → 剔除（contextWindow 未配/0=视为未配不剔，C9）
①-d 请求带 tools && 候选 supportsTools === false → 剔除（缺省=支持，C1）
①-e 请求 max_tokens > 候选 maxOutputTokens（若配置）→ 剔除
①-f 请求带 stream && 候选 supportsStreaming === false → 剔除（supportsStreaming 已存在）
①-g wire=anthropic 且带 thinking/cache_control → 剔除跨协议 openai 候选（否则 cache_control 被剥）
①-h 候选 weight === 0 → 剔除（N2，并入硬过滤，不进加权）
```

### 4.2 粘性优先
```
sticky[vid+auto] 存在 && 候选通过 ① && health(routeId) >= 0.4 → 直接用，不掷骰子
否则 → 4.3 加权随机
（瞬态不满足 → 绕行但不覆写粘性记录，§3.2；仅允许"改写清单"那几类更新记录）
```

### 4.3 加权随机
```
有效权重 = weight(candidate) × health(routeId)  // 429 不进健康分（§3.1）
按有效权重加权随机选
选中后：进入尝试（选中后 key 池掏空 = attempt 失败续链，N8）
成功应答后：仅当 health >= 0.6 才新建粘性绑定（回粘线 §3.2；实现口径=提交时刻分数、不含本次样本，偏保守）；绕行轮与 N11 命中失败轮均不覆写已有记录
```

### 4.4 解析矩阵（名字命中 / fallback / 歧义）
| 情况 | 行为 |
|---|---|
| 命中 AutoRoute.publicName（精确，小写） | auto 分支，永不进 fallback |
| 命中 ModelRoute.publicName / tags | 现有一对一 |
| AutoRoute 名与某 ModelRoute.publicName 或 **tags** 同名 | 唯一性冲突，禁止建立（**建 auto / 建模型（含 import-models）/ 改模型名 / 改 tags 处处查重；检查落 admin 三条路由（POST/import/PATCH）；createModel 全部调用面在 admin 之下，新增调用面须同步查重（v2.5 校正措辞）**，W7） |
| auto 候选全剔除 / candidates 空 / 全 weight=0 | 404/502 返回，不进 fallback，不注入任意 model 串 |
| auto 名存在但 enabled=false | 明确"auto 已停用"，不进 fallback |
| 均未命中 | 现有错误路径（含 fallbackChannelId 透传，保持现状） |

**auto 名永不进 fallback**（防借 auto 名向兜底渠道注入任意 model 串，B7）。

---

## 5. 鉴权（ACL）与可观测性

### 5.1 两层鉴权（P0-4 + "候选级 ACL 3 票"）
现有 `allowedForKey(vkey, publicName)` 在 resolve 后强校验（gateway.ts:219）。model_auto 会重定向到任意候选 →
若 vkey 白名单只有 GLM 却允许 model_auto、auto 候选含 DeepSeek，则请求可打到 DeepSeek（授权旁路）。

- **层 1（选路前）**：`allowedForKey(vkey, auto 别名)` — 快速拒绝未授权 auto 名的 key。
- **层 2（①-a）**：`allowedForKey(vkey, 候选 ModelRoute.publicName)` — 授权细粒度到候选。
- **粘性命中**同样走层 2 复检；候选不通过 → 失效重选（防 key 收紧白名单后被粘性钉住）。
- 口径：允许 auto 名 ≠ 允许其全部候选。

### 5.2 可观测性
- **日志**：`requestedModel=auto 名`；新增 `routedTo=最终候选 ModelRoute.publicName`；`chainAttempts[]`
  记候选/状态/耗时/原因即可，**不做浪费成本审计**（C18，单用户无审计需求）。
  健康分聚合键用 routeId（改名不破窗）。stats 加 `byRoutedTo`（全链失败归 auto 名桶，不归末位尝试候选）。
  在途流式请求直到 finalize 才对 admin 可见（by-design：日志是终态记账，不是实时进度）。
- **成功响应**：`X-Lm-Routed-To` 头仅受 debugHeaders 门控；`exposeHeaders` 同步放宽。
- **响应体 `model` 恒为 auto 名**（不泄候选；`aliasDiffers` 对 auto 恒真）。
- `/v1/models` auto 条目：`owned_by:'own-api:auto'`；**只聚合有效候选（weight>0，v2.4）**；
  `context_length`=已配置者中的最小（未配置=∞ 不参与；全未配置则省略该字段）；
  `max_output_tokens`=**全部**配置时才取最小；不暴露 candidates 菜单；沿用 `allowedForKey`（层 2 也过滤）；
  消费方须知"配置可见性 ≠ 可用性 SLA"（auto 是否可用还取决于健康分/粘性/链预算）。

### 5.3 502 明细归属（个人背景校准，C17）
- 跨候选全失败：**明细默认进响应体**（渠道名/候选外名/掩码 key 尾号/失败原因）——单用户网关里
  明细就是自己的调试路标，无多租户拓扑泄漏问题；若将来对外开放，再收回 debugHeaders 门控（一个开关的事）。
- 硬底线：**上游 key 全值绝不出现在响应**（maskKey 照旧）；502 体仍为协议合法 JSON。
- 回归哨兵（按新基线写断言）：auto 全失败响应不得含任何 key 全值；渠道名/候选明细在场不算泄漏。

---

## 6. 边界语义
- **embeddings × auto**：直接禁止，embedding 请求命中 auto → 400"auto 不支持 embeddings"（防 embedding 打上
  anthropic 占位消息返回形状错 200）。
- **跨协议候选 × anthropic 客户端**：见 ①-g（wire=anthropic 带 thinking/cache_control 剔除 openai 候选）。

---

## 7. 撤回但保留为读取面：探针/熔断（N4, N7）
- **死候选无熔断**（N4 风险接受，ADR；个人背景校准）：钳 0.1 的候选 w=8 仍吃 ~28.6% 首掷，但自建模型的
  挂法是进程死/端口不通——**ECONNREFUSED 毫秒级、提交前，failover 近乎免费**，失败税仅在挂死类慢故障下痛。
  链预算（§8.3，默认 300s）封顶伤害。熔断/半开+探针不进 v1；重评估触发：候选数 >8 或死候选首掷造成可感延迟。
- **探针提交**（N7 风险接受，ADR；个人背景校准）：维持头提交。自建模型"慢"的主因是**模型加载慢——那是
  提交前，已被 failover 窗口覆盖**；剩下的"200 后卡死不吐字"（首包即死/OOM）不可 failover，只发 200+error 帧，
  由客户端重试兜底——已接受。若线上此模式高频，v1.1 启用"auto-only 探针提交"（只缓冲首帧再 commit，无双写，
  代价仅 TTFT）；v1 不动已验证的流式管道。

---

## 8. 实现期硬约束（含 N10 细则）
1. **两段式提交**：stage A（提交前=attempt 失败，主请求流开启前返回非 2xx）→ 可换候选；stage B（提交后=
   stream 失败，`c.body` 已交流 + 上游回 event-stream 首包）→ 不可换候选，只发协议内 error 帧 + 健康分计样。
   双 200 + 重复计费绝不允许。提交时机维持头提交（§7）。
2. **每候选派生物全重建**（B4）：换候选时重建 upstreamBody（openaiToAnthropic/anthropicToOpenai）、
   defaultMaxTokens 兜底、endpoint、timeout、estTokens、stream_options 注入、tried/reuseKey/injectedStreamOptions。
   拿候选 A 的协议编码打候选 B = bug。
   例外（v2.4 B1 修复注记）：配额 estTokens 是**入口一次**算好的"存活候选最大值"，不逐候选重算——
   链只在存活集内扩展，逐候选重算反会引入 reserve/release 金额漂移；release 一律用实际入册额（reserved）。
3. **链预算（B1 + N10）**：
   - 无请求级 deadline；跨候选会放大（默认 4 候选 × (3+1 key) × (首包 300s+空闲 120s) ≈ 84min）。
   - 加链级硬 cap `maxChainSeconds`（默认 **300s**，C16：本地推理首请求模型加载 30~120s+ 是常态
     （llama.cpp/LM Studio 换载），120s 会把"正在加载的健康模型"误判死并 failover 掉——恰是 auto 最不该犯的错；
     频繁换载多模型者应常驻模型或调大预算）。
   - **N10-a**：每 attempt 超时 = min(剩余预算, 渠道超时)；响应体空闲阶段同样受剩余预算夹制
     （`idle = min(idle, max(5s, 剩余))`，v2.4）；已提交的流永不被预算腰斩（N10-c）。
   - **N10-b**（v2.3 修正）：剩余预算低于最小可行 attempt 窗口（min(5s, 空闲超时)）才停止扩展；
     慢上游的截断由 N10-a 负责。v2.2 字面"剩余 < 首包+空闲"在默认预算(300s) < 单跳最坏(300+120s)
     下恒成立，会杀死全部 failover 续链，与 C10/C11 的续链语义直接矛盾——按 C16 意图修正。
   - **N10-c 成文**：链预算（300s）< 单跳最坏（首包 300s+空闲 120s），且 < 直连非 auto 路由的单跳行为 →
     同一慢上游可直连成功、走 auto 被切；N10-a/b 使分叉可预期，此为预期行为。
   - chainAttempts 数受链预算自然封顶；recordFailure 也受链内次数硬上限 =（候选数 × maxKeyRetries，默认 ≤16×3）
     （防止 1 RPM 槽=长连接+15×冷却；v2.4 成文）。
4. **断开止损（B6 + W1 + v2.5）**：每跳查 `signal.aborted`，断开即断链；**断开记"取消"终态、不计健康分样本、不冷却 key**。
   v2.5 细化：① sniff/读体等每个 await 后复查取消（AbortSignal 对晚注册监听器**永不补发**，裸挂必漏）；
   ② 提交后的 abort 统一复用 cancel 记账路径（文案/ttftMs 单一来源）；③ stream error 分支先判
   `isAborted()`——abort 驱动的上游读拒绝归入 cancel，绝不计候选失败样本。
   （修正 v2.0 把"取消记 fail"写反——取消需双向剔除出分子分母，否则 agent 超时取消风暴把健康候选喂成挂死。）
5. **配额预占（B5）**：estTokens 按 **存活候选 maxOutputTokens 最大值**预占；切更高候选先补差，不足 → 429，不得先打上游再记账。
   输入估算（v2.5 定稿口径，count_tokens 同函数）：消息正文 + **anthropic 顶层 system** + **tools schema**
   + tool_result 递归 + tool_calls.arguments / tool_use.input / thinking 块 + 图片≈1600 tok/张，chars/4；
   入口对非数组 messages 等畸形 JSON 一律守卫（估算器绝不允许把请求炸成 5xx）。
   估算器漏项 = ①-c 系统性漏剔（M2 教训）；日志字段（model/XFF）限长 256/64 落库（v2.5）。
6. **每日限额口径**：token 口径非美元；候选价差大时预算失真 → 文档明示 + 分档 auto 名。
7. **stats/log 并入**（§5.2）；AutoRoute CRUD 沿用 UPDATABLE_* 白名单 + weight/TTL/candidates 长度设界。
8. **tried 去重按候选 routeId**；同渠道不同候选视为不同尝试。
9. **测试矩阵**（照 e2e+hardening；个人场景优先级）：contextWindow 超窗剔除 + 400 超窗续链（日常最高频）>
   断开止损 > 粘性迟滞/改写/绕行不覆写 > key 池掏空续链 > 候选全剔除 404 > ACL 绕过哨兵 >
   502 明细哨兵（新基线：不漏 key 全值）> 429 续链（自建上游低频，排最后）。
   **v2.4 审查修复轮补洞**（e2e §15）：auto×流式两段式提交三态（stage A 换候选/stage B error 帧/提交后 499）、
   auto×限额预占释放（绞杀 B1）、429 定向居链首 + 全候选 429 终态、粘性 TTL 续期/过期、
   估算器 system/tools 口径、①-e/f/g 确定性形态（唯一候选→404）、C4 冷启动分支。
10. **空闲计时武装时机（v2.4）**：响应体 idle 计时只在"正向上游取数"期间武装（read() 挂起时）；
    下游背压停读不武装——否则慢客户端会绞死健康上游。背压期缓冲由 TCP 流控兜底。
    另（v2.5 重写）：提交点三重守护——(a) 提交前复查 `signal.aborted`（已断直接走 client_abort，
   晚注册监听器不补发事件，裸挂必漏）；(b) 一次性 abort 监听器复用 cancel 记账路径；
   (c) **绝对时限 watchdog**（默认 headTimeout+8×idle，刻意宽松）：覆盖 M6 之后
   "下游停读且未断开"（合盖/半开）的零计时器真空，触发即掐上游记 502，杜绝预占/日志被无限期钉住。

`Resolved` 返回值契约（advisory）：auto 分支 `resolveRoute` 返回 **`{ autoAlias, route(最终候选) }`** 而非
单 route——`aliasDiffers` 改写用 `autoAlias`（响应体 model=auto 名），日志/健康分聚合用 `route.id`。
现有单 `route/upstreamModel/protocol` 无法同时承载"对外=auto 名"与"内部=候选 routeId+publicName"两套 key，
此契约保证 alias 改写与 usage 聚合不冲突。实现注记（v2.4）：auto 以链式循环直接驱动 attemptRoute，
即为该契约的等价实现（alias 改写用 autoAlias、聚合用 route.id），未在 resolveRoute 内制造 Resolved 中间对象。

---

## 9. 非目标（延续）
探测能力、纯统计动态权重、跨渠道成本寻优、语义路由、embeddings×auto、探针提交（v1）、熔断/半开（v1）、
跨租户隔离 / 浪费成本审计 / 粘性逐出配额（C18，个人场景无此攻击面与审计需求）。

---

## 10. 术语
候选 / 候选路由 / auto 路由 / chainAttempts / 健康分（候选级内存窗）/ 授权层 1-2（auto 名级 / 候选 publicName 级）。

---

## 11. 决策记录总表

| 编号 | 争点 | 裁决 | 来源 |
|---|---|---|---|
| C0 | 持久化边界 | 配置落库；健康分/粘性仅内存 | ADR(agent) |
| C1 | supportsTools 缺省严/宽 | 宽（仅 ===false 剔） | 评审 |
| C2 | weight=0 语义 | =禁用，**进①硬过滤**，并强制驱逐粘性（权重调低的显式例外） | 评审+二轮N2 |
| C3 | 迟滞带 | 保持下限 0.4、回粘起点 0.6、绕行不覆写 | 评审+二轮N1 |
| C4 | 样本<3 的 0 成挂 | ok==0 且 fail>0 → 钳后 0.1 | 评审+二轮W4 |
| C5 | 粘性 TTL | 默认 300_000，命中续期 | 评审+二轮W3 |
| C6 | 失效二分 | 改写（TTL/停用/不存在/健康<0.4/weight=0）vs 只绕行（瞬态） | 评审 |
| C7 | 粘性粒度 | vkeyId+autoName；共享 key 同进同退 | 评审 |
| C8 | 悬空引用 | routeId 不存在=剔除+告警；删除 API 返回 referencedByAutoRoutes；管理端红标 | 评审 |
| C9 | contextWindow 0/未配 | 未配或 0 = 不剔除非请求明确超大 | 评审+二轮W6 |
| C10 | 400 分类 | prompt 超窗→剔除续链；其余 400→短接不续链 | 评审 |
| C11 | 429 | **候选 429 → 该候选本轮判负续链（不计健康分）**；链终回 429 透传最短 Retry-After；直连（非 auto）429 终态同样透传该头（v2.4 追认：客户端只赚不亏） | 评审+二轮N5 |
| C12 | 健康分计入范围 | 计入全部流量（含定向），聚合键 routeId | 二轮N9 裁定(agent) |
| C13 | 熔断/探针 | 不进 v1；接受"失败税+链预算封顶"，理由成文（§7） | 二轮N4/N7 拍板(agent) |
| C14 | 健康分粒度 | **全局（窗键=routeId）**：单用户无敌意租户，故障信号全 vkey 共享、学费只交一次；per-vkey 为不可信租户时的升级路径 | 三轮个人背景（修正二轮误记） |
| C15 | 粘性持久跨重启 | 不做（ADR：缓存必失，无意义） | agent |
| C16 | 链预算默认 | **300s**（本地模型加载首请求数十秒，120s 会误杀"加载中"的健康模型） | 三轮个人背景 |
| C17 | 502 明细 | 默认回显响应体（=自己的调试路标）；硬底线=不漏上游 key 全值 | 三轮个人背景 |
| C18 | 过度设计移除 | per-autoName 逐出配额、wastedUsage 成本审计、跨租户隔离均不做（个人场景无攻击面/审计需求） | 三轮个人背景 |