# 模型速度排行 — 设计 v1（方案，未实现）

> 状态：**方案评审中**（2026-09-14，受众定位讨论产出，用户裁决：**只做观测、不改路由**）。
> 受众背景（全部取舍的前提）：员工本机各跑一个桌面实例，聚合公司内部多个模型端点；
> 「有的模型慢/效率低」是**常态而非故障**——本页回答"哪个模型慢、慢多少"，支撑手动调整 auto 候选权重的决策。

---

## 1. 目标与非目标

**目标**：使用统计页新增「速度排行」标签——按真实模型聚合 TTFT / 总延迟 / 错误率 / 失败转移率，
一眼看出谁慢；样本窗口如实标注，样本不足灰显。

**明确非目标**（用户裁决，勿在实现中"顺手"加）：
1. **不影响 auto 路由**：不进健康分、不产生任何权重信号。UI 固定提示条说明这一点。
2. 不做速度路由/动态权重（`model-auto-design.md` §9 非目标维持）。
3. 不做历史聚合落库——样本即 `logRetention` 窗口内的日志（决策 DR-4）。
4. 不做 per-vkey / per-user 维度（单用户校准，同 C14）。
5. 渠道（Provider）维度排行不进 v1（模型维度已覆盖决策需要；Provider tab 补列留作后续可选）。

---

## 2. 数据面（现状核实）

- `RequestLog`（types.ts:98）已有所需全部字段：`latencyMs`、`ttftMs?`、`stream`、`ok`、`status`、
  `attempts`、`routedTo?`、`chainAttempts?`、`requestedModel`、`publicName`、`channelName?`、`ts`。
- **`ttftMs` 仅流式路径落**（gateway.ts:430/452/461，`firstContentAt - t0`）；非流式只有 `latencyMs`。
  → 速度分两组口径，绝不能混排（DR-2）。
- `attempts > 1` 的成功请求，其 `latencyMs` 含前面失败候选的耗时，**不是该模型的速度**。
- 日志受 `logRetention` 裁剪（默认 2000 条，上界 200_000，store.ts:39/58/731）。
  → "7 天"筛选在默认配置下实际只是"最近 2000 条"；页面必须如实标注样本真相（§5）。
- 现有统计页数据源是 `GET /api/logs?limit=5000` 前端聚合（b417be3）；本特性**不走该路线**（DR-1）。

## 3. 归因口径

```
归一键 = routedTo ?? publicName
  （非 auto 请求 routedTo 为空，publicName 即真实模型；auto 请求按最终候选归因，
   与 stats.byRoutedTo 同语义——requestedModel 会塌成 auto 名，不能用）
样本分组：
  速度样本   = ok === true                       （499 取消/失败一律不进速度样本）
  TTFT 组   = 速度样本中 stream === true 且 ttftMs 有效 → ttftP50 / ttftP95
  延迟组    = 速度样本中 attempts === 1           → latP50 / latP95 / avgLatencyMs
              （attempts>1 的延迟被失败尝试污染，剔除；其占比单列为 failoverRate）
  错误率    = 全部样本（含 499/5xx）errors / requests
  failoverRate = 速度样本中 attempts > 1 的占比（auto 流量的"换候选税"，慢的常见伴生信号）
  lastTs    = 该模型最近一次请求时间（任意样本）
```

## 4. 后端

`usage.ts` 新增 `buildSpeedStats(rangeHours): SpeedReport`，`admin.ts` 挂
`GET /api/stats/speed?hours=24`（admin 令牌鉴权，同现有 /api/stats 族；不新增匿名面）。

```ts
interface SpeedRow {
  key: string;            // 归一名（routedTo ?? publicName）
  requests: number;       // 全部样本
  errors: number;
  streamN: number;        // TTFT 组样本数
  ttftP50Ms?: number; ttftP95Ms?: number;   // streamN === 0 时省略
  firstAttemptN: number;  // 延迟组样本数
  latP50Ms?: number; latP95Ms?: number; avgLatencyMs?: number;
  failoverRate: number;   // 0..1
  lastTs: number;
}
interface SpeedReport {
  window: { from: number; to: number; hours: number };
  logsInWindow: number;   // 时间窗内日志条数
  retention: number;      // 当前 logRetention（样本真相用）
  rows: SpeedRow[];       // 按 ttftP50 升序、无 TTFT 的行按 latP50 排在其后
}
```

- 百分位实现复用 `buildStats` 的 sort+index 口径（usage.ts:216-218, 225-226）；
  每次请求全量重算 O(n log n)，样本 ≤200k 与现有 buildStats 同量级，管理台手动/低频刷新可接受（不新增缓存债）。
- 时间窗语义与 buildStats 一致：`hours>0` 取最近 N 小时，`0` = 全部保留日志。

## 5. 前端（web/index.html + src/web-html.gen.ts 双份同步，gen:web 流程）

- `TABS` 数组（index.html:366）加 `['speed', '速度排行']`；沿用全局筛选（模型/时间范围）与 ovSt 驻留。
- 列：模型（+渠道徽章，数据可由 routes/快照补挂）· 样本数 · **TTFT P50/P95（流式）** ·
  **延迟 P50/P95（首跳）** · 错误率 · failover 率 · 最后请求。
- 高亮阈值写死不做配置（避免过度设计，同 C18 精神）：`ttftP50 > 全体流式样本 P50 × 1.5` 橙、`× 2` 红；
  非流式行用同倍数对 latP50。
- 样本 < 5 的行灰显并显示样本数——"看起来慢"与"统计上慢"要区分。
- 页顶固定说明条：**"本页只做观测，不影响 auto 路由；要躲开慢模型请到模型路由调整候选权重"**，
  以及样本真相：`样本取自最近 {logsInWindow} 条日志（logRetention={retention}），时间范围 {hours}h`。

## 6. 测试钉（实现时固化进 test/e2e.ts）

| 场景 | 断言 |
| --- | --- |
| 流式/非流式混合 | TTFT 组只含流式样本；延迟组只含 attempts==1；两组互不污染 |
| auto 流量归因 | requestedModel=auto 名的请求归到 routedTo；无 routedTo 回退 publicName |
| failover | attempts>1 的成功请求进 failoverRate 分子、不进延迟组 |
| 499 取消 | 不进速度样本、不计错误率以外的任何速度字段；错误率含它 |
| 空窗/样本不足 | 空窗口返回 rows=[] 不 500；streamN=0 行无 TTFT 字段而非 0 |
| 鉴权 | 无 admin 令牌 401；不进入网关鉴权豁免区 |
| 口径回归 | 用 mock 上游打出已知延迟分布，断言 P50/P95 数值 |

## 7. 决策记录

| 编号 | 争点 | 裁决 | 理由 |
|---|---|---|---|
| DR-1 | 前端聚合（照抄仪表盘）vs 后端端点 | **后端新端点** | 口径单源、可被 e2e 钉死；/api/logs 有 limit 上限，前端聚合天然截断样本；现有仪表盘"零后端改动"是当时的权宜，不是范式 |
| DR-2 | TTFT 与总延迟混排 | **两组分列，禁止跨组比较** | ttftMs 仅流式存在；非流式没有可比指标 |
| DR-3 | 归一键 | routedTo ?? publicName | 与 byRoutedTo 同语义；requestedModel 会把 auto 流量塌成一个名 |
| DR-4 | 历史聚合落库 | 不做 | 样本=logRetention 窗口；落库引入写放大与迁移面，单用户收益趋零（同 C15 精神） |
| DR-5 | attempts>1 延迟处理 | 剔除出延迟组，单列 failoverRate | 混入会把"换候选税"记到最终模型头上，排行失真 |
| DR-6 | 速度进路由信号 | 不做（用户裁决） | 本页是观测工具；auto 语义变更须走 model-auto-design 的评审流程，不得由观测面顺带引入 |
