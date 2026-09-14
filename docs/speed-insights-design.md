# 模型速度排行 — 设计 v1.1（方案，未实现）

> 状态：**方案评审修订稿**（v1.1，2026-09-14；v1→v1.1 吸收六路联合评审 + 两项用户裁决：错误率拆两列、流式/非流式拆两表）。
> 受众背景（全部取舍的前提）：员工本机各跑一个桌面实例，聚合公司内部多个模型端点；
> 「有的模型慢/效率低」是**常态而非故障**——本页回答"哪个模型慢、慢多少"，支撑手动调整 auto 候选权重的决策。
>
> **引用约定**：本文 DR-SI-* 为本文私有编号；裸引 C*/W* 一律指 docs/model-auto-design.md §11 决策总表。
> 代码引用一律符号锚（`文件#符号`），行号仅作辅助注记。

---

## 1. 目标与非目标

**目标**：使用统计页新增「速度排行」标签——按真实模型聚合 TTFT / 总延迟 / 上游错误率 / 中断率 / 失败转移率，
一眼看出谁慢；样本窗口如实标注，样本不足灰显。

**明确非目标**（用户裁决，勿在实现中"顺手"加）：
1. **不影响 auto 路由**：不进健康分、不产生任何权重信号。UI 固定提示条说明这一点。
2. 不做速度路由/动态权重（model-auto §9 非目标维持）。
3. 不做历史聚合落库——样本即 `logRetention` 窗口内的日志（DR-SI-4）。
4. 不做 per-vkey / per-user 维度（单用户校准，同 C14）。
5. 渠道（Provider）维度排行不进 v1（模型维度已覆盖决策需要；Provider tab 补列留作后续可选）。
6. 不做「慢模型提醒/告警」——本页纯被动观测；提醒属新能力，须另立设计（同 model-auto C18 反过度设计口径）。

---

## 2. 数据面（现状核实，v1.1 全部符号锚化）

- `RequestLog`（types.ts#RequestLog）已有所需全部字段：`latencyMs`、`ttftMs?`、`stream`、`ok`、`status`、
  `attempts`、`routedTo?`、`chainAttempts?`、`requestedModel`、`publicName`、`channelName?`、`ts`。
- **`ttftMs` 仅流式路径落**（gateway.ts#finished 三处 finalize 分支的
  `ttftMs: firstContentAt ? firstContentAt - a.t0 : undefined`）；非流式只有 `latencyMs`。
  → 速度分两组口径，绝不能混排（DR-SI-2）。
- `attempts > 1` 的成功请求，其 `latencyMs` 含前面失败尝试的耗时，**不是该模型的速度**。
- 日志受 `logRetention` 裁剪（store.ts#NUM_BOUNDS.logRetention：默认 2000，上界 200_000；
  裁剪点 store.ts#pushLog）。→ "7 天"筛选在默认配置下实际只是"最近 2000 条"；页面必须如实标注样本真相（§5）。
- 现有统计页数据源是 `GET /api/logs` 前端聚合（commit b417be3，前端固定 `limit=5000`）；本特性**不走该路线**（DR-SI-1）。

## 3. 归因口径（v1.1 重写）

```
归一键 = l.routedTo ?? (l.chainAttempts?.length ? l.requestedModel : l.publicName) ?? '-'
  ——与 stats.byRoutedTo **逐字同键**（usage.ts#buildStats.byRoutedTo），两页数字可互相对账（DR-SI-3）。
  v1 的「routedTo ?? publicName」作废：publicName 每跳被覆写（gateway.ts#attemptRoute 的
  Object.assign(log, {publicName: logPublicName})，auto 传候选名），auto 链失败无 routedTo 时
  会把整链归到末位尝试候选头上——与 byRoutedTo 矛盾。三分支兜底 '-'：未命中 404/ACL 403/
  限流 429/413 等未路由日志两字段皆空，仍须进错误率分母，不得丢样本、不得让 key 变 undefined。
样本分组：
  速度样本   = ok === true                       （499 取消/失败一律不进速度样本）
  TTFT 组   = 速度样本中 stream === true 且 ttftMs 有效 → ttftP50 / ttftP95
  延迟组    = 速度样本中 attempts === 1           → latP50 / latP95 / avgLatencyMs
              （attempts>1 的延迟被失败尝试污染，剔除；占比单列 failoverRate）
  上游错误率 = (ok===false 且非 499 取消) / requests     ← 5xx/网络/超时，模型真实可靠性
  中断率     = 499 取消 / requests                        ← 多为客户端超时/主动取消，非上游故障（DR-SI-7）
  failoverRate = 速度样本中 attempts > 1 的占比
              （auto 流量＝换候选税；直连流量＝同渠道换 key 税——attempts 在 key 级重试也累加，
                号池不健康的伴生信号，两种语义 UI 不区分）
  lastTs    = 该模型最近一次请求时间（任意样本）
```

## 4. 后端

`usage.ts` 新增 `buildSpeedStats(rangeHours): SpeedReport`（**export**，供测试直 import），`admin.ts` 挂
`GET /api/stats/speed?hours=24`（落 createAdmin 子应用即自动继承 admin 令牌鉴权 + adm:IP 失败锁定；
不新增匿名面）。

**hours 入参钳制（DR-SI-8）**：`const q = Number(raw); const hours = Number.isFinite(q) ? Math.min(Math.max(Math.trunc(q), 0), 87600) : 24;`
——负数/NaN/Infinity/超界一律归一（0=全部保留日志，语义同 buildStats），**静默归一而非 400**（桌面受众宽容，
window 只回显钳制后值，样本真相条同步回显——诚实性由回显保证）。`window.to` 每次调用浮动是既定语义。

```ts
interface SpeedRow {
  key: string;            // 归一键（§3 三分支；'-' = 未归因行）
  requests: number;       // 全部样本
  errors: number;         // 非 499 上游失败
  cancels: number;        // 499
  streamN: number;        // TTFT 组样本数
  ttftP50Ms?: number; ttftP95Ms?: number;   // streamN === 0 时省略
  firstAttemptN: number;  // 延迟组样本数
  latP50Ms?: number; latP95Ms?: number; avgLatencyMs?: number;
  failoverRate: number;   // 0..1
  lastTs: number;
}
interface SpeedReport {
  window: { from: number; to: number; hours: number };  // 只回显钳制后 hours
  logsInWindow: number;
  retention: number;      // 当前 logRetention（样本真相用）
  oldestTs: number;       // 窗口内最早样本（保留窗不足提示用，§5）
  benchmark: { streamP50Ms?: number; latP50Ms?: number };  // 高亮唯一基准，后端单源（DR-SI-9）
  rows: SpeedRow[];
}
```

- 百分位实现复用 `buildStats` 的 sort+index 口径（usage.ts#buildStats 内 `pct`）；
  `benchmark` 由同一趟全量分位一次算出——**前端禁止自算任何百分位**（第二套口径 = 本仓库漂移事故模板）。
- **排序与 tie-break**（行序钉的稳定性前提）：rows 拆 `streamRows` 与 `latencyRows` 两个数组返回
  （版式两表由数据结构直给，DR-SI-10）；各自 `P50 升序 → 并列按 requests 降序 → 再按 key 字典序`；
  `'-'` 未归因行不进两表、单独作为 `unattributed: SpeedRow | null` 返回；
  无任何速度样本的行（streamN=0 且 firstAttemptN=0）不进流式表，在延迟表内按 lastTs 降序垫底。
- 每次请求全量重算 O(n log n)，样本 ≤200k 与现有 buildStats 同量级，手动/低频刷新可接受（不新增缓存债）。

## 5. 前端（web/index.html + src/web-html.gen.ts 双份同步，gen:web 流程）

- `TABS` 数组（web/index.html#TABS）加 `['speed', '速度排行']`。
  **筛选**（v1.1 重定）：速度页**不提供模型筛选**——行本身就是模型，且 overview 的模型下拉按
  requestedModel 轴构建，与归一键不同轴（照抄必错位）；时间窗用**页内独立下拉**（24h / 7d / 全部→hours=0），
  选择进样本真相条回显。v1「沿用全局筛选（模型/时间范围）」表述作废。
- **两表版式（DR-SI-10，用户裁决）**：同标签页内「**流式（按 TTFT P50 升序）**」「**非流式（按总延迟 P50 升序）**」
  两张表，中间固定分隔行「↓ 非流式——无 TTFT，勿与上表比较」（DR-SI-2 由版式成立，混排即形同排行榜）。
  列：模型（+渠道徽章）· 样本数 · TTFT P50/P95（流式表）或 延迟 P50/P95/均值（非流式表）·
  上游错误率 · 中断率 · failover 率 · 最后请求。
  渠道徽章 = `GET /api/routes` 的 publicName→channelName 映射按行键补挂；匹配不到（路由已删/日志早于路由）
  显示 `-`；归一键为 auto 名时挂「auto」徽章不挂渠道徽章；`'-'` 行渲染在表尾灰显「未归因（限流/未命中等）」。
- **高亮**：阈值写死不做配置（同 C18 精神）：流式表 `ttftP50 > benchmark.streamP50Ms × 1.5` 橙、`× 2` 红；
  非流式表对 `benchmark.latP50Ms` 同倍数——**只消费后端 benchmark 字段**（DR-SI-9）。
- 样本 < 5 的行灰显并显示样本数——"看起来慢"与"统计上慢"要区分。
- **页顶固定说明条**：**"本页只做观测，不影响 auto 路由；要躲开慢模型请到模型路由调整候选权重"**；
  中断率列头注「多为客户端超时或主动取消，非上游故障」；
  样本真相条：`样本取自最近 {logsInWindow} 条日志（logRetention={retention}），时间范围 {hours}h`；
  **保留窗不足提示（v2 体验兜底）**：`hours>0` 且 `to - oldestTs < hours×3600_000` 时追加
  「所选范围已超出日志保留（实际覆盖约 {X}h）——如需更长窗口请到设置调大日志保留条数（上限 200000）」
  （措辞对齐概览页既有截断告警）。
- **空态**：rows 全空 → 「窗口内还没有请求记录——先到「接入方式」复制接入配置，跑几个请求后再回来看排行」；
  流式表 streamN 全站为 0 → 「窗口内没有流式请求，TTFT 列不可用」，延迟表照常。

## 6. 测试钉（API/库层 → test/e2e.ts；渲染断言 → test/hardening.ts DOM 桩）

| 场景 | 层 | 断言 |
| --- | --- | --- |
| 流式/非流式混合 | e2e | TTFT 组只含流式样本；延迟组只含 attempts===1；两组互不污染 |
| auto 流量归因 | e2e | 归一键三分支：成功 auto 归 routedTo；**链全败（无 routedTo 有 chainAttempts）归 auto 名**（哨兵：构造 A 败→B 败→502，断言样本落 auto 行不落 B 行）；普通单模型归 publicName；未命中 404 进 `'-'` 行 |
| failover | e2e | attempts>1 成功样本进 failoverRate 分子、不进延迟组（含直连 key 重试场景） |
| 499 拆列 | e2e | 499 不进速度样本；进 cancels/中断率，**不进 errors**；errors 只含非 499 失败 |
| 空窗/样本不足 | e2e | DELETE /api/logs 后请求 → rows/streamRows/latencyRows 全空、unattributed=null、200 不 500；streamN=0 行无 TTFT 字段而非 0 |
| 鉴权 | e2e | 无 admin 令牌 401（复用现有 401 断言模式） |
| **口径回归（确定性主钉）** | e2e | `store.pushLog` 直注 ≥20 条已知 latencyMs/ttftMs/stream/attempts/ok/routedTo 的合成日志（**专享命名**键，避开既有 publicName 串台；≥20 因 pct=floor(n·p) 小样本 P50/P95 会塌合），`import { buildSpeedStats }` 直调 `buildSpeedStats(0)` 断言精确 P50/P95 与 benchmark |
| 实况 smoke | e2e | k-slow（mock 1.2s 档）模型行序落后于零延迟行；`latP50 ∈ [1000, 2500]` 区间断言（mock 无参数化延迟，等值断言必 flaky；可选给 mock 增 `mock-lat-<ms>` 模型名分支再造分布） |
| 共享库卫生 | e2e | 数值断言只对专享键；窗口取 hours=0；`report.retention === settings.logRetention`；`logsInWindow ≥ 请求前基线`（window.to 浮动，禁等值） |
| hours 钳制 | e2e | `hours=-1/'abc'/1e12` → 200，window.hours 为钳制值且行集与钳制语义一致；hours=0 非空对照 |
| 排序稳定性 | e2e | tie-break 生效：同 P50 行按 requests 降序、再 key 字典序；streamRows 无 TTFT 字段行 |
| benchmark 单源 | DOM 桩 | 抽源断言前端不含独立百分位计算（无 `sort((a,b)=>a-b)`+下标式分位出现在 speed 视图代码段），着色只读 benchmark 字段 |
| 渲染层 | DOM 桩 | TABS 注入、说明条文案、中断率列头注、样本<5 灰显 class、空态文案、benchmark 着色阈值（复用 hardening 抽源 eval 基建） |

## 7. 决策记录（编号仅限本文）

| 编号 | 争点 | 裁决 | 理由 |
|---|---|---|---|
| DR-SI-1 | 前端聚合 vs 后端端点 | **后端新端点** | 口径单源、可被 e2e 钉死；/api/logs 服务端不钳制 limit、仪表盘前端固定 limit=5000，retention 调大即静默丢样本；前端聚合是当时权宜不是范式 |
| DR-SI-2 | TTFT 与总延迟混排 | **两组分列，禁止跨组比较** | ttftMs 仅流式存在；混排视觉即排行榜 |
| DR-SI-3 | 归一键 | **与 byRoutedTo 逐字同键**（三分支+'-' 兜底） | 与 stats 同源自证：两页数字可互相对账；两分支公式会把 auto 链败归错（publicName 每跳覆写）；刻意按末位候选归因的备选案否决——观测页可信度优先于灵敏度 |
| DR-SI-4 | 历史聚合落库 | 不做 | 样本=logRetention 窗口；落库引入写放大与迁移面，单用户收益趋零（同 C15 精神） |
| DR-SI-5 | attempts>1 延迟处理 | 剔除出延迟组，单列 failoverRate | 混入会把"换候选/换 key 税"记到最终模型头上，排行失真 |
| DR-SI-6 | 速度进路由信号 | 不做（用户裁决） | 本页是观测工具；auto 语义变更须走 model-auto 评审流程，不得由观测面顺带引入 |
| DR-SI-7 | 499 的口径 | **拆两列：上游错误率（非 499）+ 中断率（499）** | 用户拍板；「模型慢→客户端取消→错误率高」同根因双计，会把快但偶 5xx 的模型衬得更可靠，与 W1「取消双向剔除健康分」精神一致 |
| DR-SI-8 | hours 非法值 | 归一钳制（NaN→24，clamp 0..87600）而非 400 | 桌面受众宽容；诚实性由 window 回显 + 样本真相条保证；显式 400 案否决（对目标受众是惊吓） |
| DR-SI-9 | 高亮基准归属 | 后端 benchmark 字段单源 | 前端自算=第二条百分位路径=漂移事故模板；抽源钉把守 |
| DR-SI-10 | 两表 vs 混排 | **两表**（streamRows/latencyRows 后端分装） | 用户拍板；版式即口径，混排的「勿比较」提示挡不比还是比 |

## 8. 实现后同步面（实现 PR 的 checklist）

- [ ] 状态行「方案评审中」→「已实现（YYYY-MM-DD）」+ 守护断言标注 e2e 节号
- [ ] README 核心能力表加行并链本文；「目录」节如有新文件同步
- [ ] CHANGELOG 下一版本节补条目（用户语言）
- [ ] README「自测」计数随实现轮次修正
- [ ] `npm run gen:web` 同步 + WEB_HTML 同步钉保持绿；DOM 桩新钉进 hardening
