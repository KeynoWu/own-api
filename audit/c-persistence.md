# 审查 C：持久化、迁移、计费与统计（store / usage / sse / translate）

- 项目：own-api（本地多模型管理器 + 统一代理网关），版本 v0.1.16，HEAD `2f6b1df`
- 审查范围：`src/store.ts`、`src/usage.ts`、`src/sse.ts`、`src/translate.ts`、`src/types.ts`，旁读 `src/gateway.ts`、`src/admin.ts`、`src/config-bundle.ts`、`web/index.html`（仅 DR-17 消费点），裁决文档 `docs/usage-rollup-design.md`（DR-17）
- 方法：**只读**源码 + 临时脚本实证（脚本落在 `/tmp/audit-c/`，数据目录 `OWN_API_DATA_DIR=/tmp/audit-c/<case>`，未使用 18787/18099 端口，未触碰 `~/.own-api`，未改 `src/`、`test/`、`web/`、`docs/`）
- 约束遵守：未运行 `npm test` / `test:hard` / `test:all`（固定端口由 Lead 独占）
- 严重度分布：**P0 = 0，P1 = 1，P2 = 3，P3 = 10**，另「已核实一致（非缺陷）」4 条

---

## 一、已证实缺陷

### C-01 [P1] 前端 DR-17 日账本合并**完全无视时间窗**：账本全量进 KPI / Provider / 模型统计

- **结论（已证实）**：`web/index.html` 的「使用统计」页把原始日志按所选窗口过滤（`ts >= from`），却把 `/api/rollups` 返回的**全部历史账本行**无条件拼进聚合集，导致「今天 / 近 24 小时」的头部 KPI（真实消耗 Tokens、总请求数、总成本、缓存命中率）以及 Provider / 模型统计**包含建库以来的全部历史**。DR-17 的本意是让长窗（7 天/30 天）变真，但实现把账本塞进了**所有**窗口，短窗数字被历史淹没。**该文件不在本任务的主范围（web/ 属另一条审查线），但它是 DR-17 口径一致性的直接缺口，请 Lead 去重归口。**
- **证据**：
  - 原始日志过滤：`web/index.html:449`（`allLogs.filter(l => l.ts >= from)`），`from` 由 `web/index.html:445-448` 按「今天/24h/7天/30天」算出
  - 假日志构造：`web/index.html:455-463`（`rollLogs`，`ts` 被设为该账本日的中午）
  - 合并点**只对原始日志用过窗**：`web/index.html:464`（`[...logs, ...rollLogs.filter(l => l.requestedModel === ovSt.model)]`）——`rollLogs` 无任何 `ts` 过滤
  - KPI 直接用合并集：`web/index.html:480-482`（`aggLogs.forEach(addAgg)`，`realTok/hitRate`）
  - Provider/模型统计同源：`web/index.html:516-519`（`groupAgg` 遍历 `aggLogs`）
  - 生成产物同码：`src/web-html.gen.ts:449`、`464`、`481`
  - 趋势图因为按桶取值而**恰好**规避了这个错误（`web/index.html:504-505` 的 `buckets.get(align(l.ts))`），所以「图看起来对、头部数字离谱」
- **影响**：成熟实例（retention 2000 条被打满后账本逐日累积）打开默认的「今天」视图，KPI 会显示全时段累计的 token/成本/请求数；用户据此判断当日消耗与预算会系统性高估。这是 DR-17 面向用户的头号产出。
- **复现/验证**：`/tmp/audit-c/win.mjs` 逐字复刻 `web/index.html:445-481` 的合并逻辑，喂 1 条今天原始日志 + 1 条 `2026-01-01` 账本行（requests=1000, cost=50）：
  ```
  窗口=今天  KPI requests = 1003  cost = 50.03   # 历史账本 1000 次/50 美元被计入「今天」
  ```
- **修复建议**：在 `web/index.html:455-463` 生成伪日志后、`464` 合并前，对 `rollLogs` 施加与原始日志同一时间窗（`r.day` 的本地日 → `ts`，或直接 `rollLogs.filter(l => l.ts >= from && l.ts <= Date.now())`；注意「今天」档要把窗口锚到本地零点且允许日粒度账本整天计入，需明确半日边界口径）。同步 `src/web-html.gen.ts` 与 `web/index.html`，并加一条「KPI 不因账本越窗而虚增」的断言钉。

---

### C-02 [P2] `MAX_ROLLUPS` 上限裁剪可裁掉**唯一/最新**的一天，刚折的账连同整日账本被删（与 DR-17 文档「保最新」相反）

- **结论（已证实）**：`archiveLogs` 在折叠后按「天」整裁，切割长度是 `Math.max(1, days.length - Math.floor(MAX_ROLLUPS / 8))`。当账本只落在很少几天（极端：一天）时，这个 `Math.max(1, …)` 会**至少切掉一天**，于是把**唯一/最新**的一天整体删除——包括刚刚折进去的那批被裁日志。此后原始日志已离开内存、账本行也没了，DR-17「长窗统计仍完整」的承诺在该路径上不成立。
- **证据**：`src/store.ts:962-967`
  ```ts
  if (this.db.rollups.length > MAX_ROLLUPS) {
    const days = [...new Set(this.db.rollups.map((r) => r.day))].sort();
    const cut = new Set(days.slice(0, Math.max(1, days.length - Math.floor(MAX_ROLLUPS / 8))));
    this.db.rollups = this.db.rollups.filter((r) => !cut.has(r.day));
  ```
  文档承诺「超限按最旧的天整体裁（…保最新）」：`docs/usage-rollup-design.md:39`、`docs/usage-rollup-design.md:34`
- **影响**：账本维度异常膨胀（同一天 >6000 个 日×模型×渠道 组合）时，一次裁剪就把当天的账全部抹掉；冷备 JSONL 里虽有原始日志，但账本行本身不可恢复（需要用户离线重算）。注释与文档所说的「保最新」在实际分支里不成立。
- **复现/验证**：`/tmp/audit-c/E.mjs`：预置 `rollups` 6001 行（同一天、不同模型）+ 1 条原始日志，调 `store.clearLogs()`：
  ```
  before clearLogs: rollups = 6001 logs = 1
  [store] 日账本超上限，已裁最旧 1 天的行
  after  clearLogs: rollups = 0
  ```
- **修复建议**：`Math.max(1, …)` 改为「只有在切完之后仍不会归零时才切」，或先按天累计行数、从最旧天开始累计到刚好降到 `MAX_ROLLUPS` 以下；若切到只剩当天仍超限，应保留当天并改为**行级**裁剪或直接告警放弃裁剪（保数据优先）。同时补一条断言钉：单日超限时不丢最新一天。

---

### C-03 [P2] 装载期 `adminToken` 绕过 `sanitizeSettings`：非字符串值直通运行期，管理面鉴权全程 500

- **结论（已证实）**：`load()` 把 `adminToken` 从净化输入里**显式剔除**，随后用 `||` 直取文件原值，因此长度下限（≥8）与类型检查在**装载路径**上全部失效。若 `db.json` 里 `adminToken` 是非字符串（手工改库、迁移自别的工具、部分损坏），`safeEq` 的 `createHash('sha256').update(expect)` 会抛 `TypeError`，**每一个管理 API（含鉴权中间件本身）都变成 500**，且版本已是 v5 时不会触发迁移回写来纠正，用户只能手改文件。
- **证据**：
  - 装载期剔除 + 直取：`src/store.ts:354-359`
    ```ts
    const { value } = sanitizeSettings(
      Object.fromEntries(Object.entries(merged.settings).filter(([k]) => k !== 'adminToken')), base.settings);
    merged.settings = { ...base.settings, ...value, adminToken: merged.settings.adminToken || base.settings.adminToken };
    ```
  - 运行期无类型守卫：`src/admin.ts:65-66`（`timingSafeEqual(createHash('sha256').update(a)…)`）、`src/admin.ts:80`、`src/admin.ts:139`
  - 佐证同一净化函数的意图：`src/store.ts:75-85`（`adminToken` 至少 8 字符、类型校验）——只对 PATCH 生效
- **复现/验证**：`/tmp/audit-c/B.mjs`，`db.json` 写 `"adminToken": 12345`：
  ```
  loaded adminToken = 12345 number
  safeEq update THROWS: TypeError The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received type number (12345)
  ```
- **影响**：管理面彻底锁死（无法登录、无法改设置恢复），错误发生在鉴权中间件的第一行，连 `/api/auth/handoff` 也 500。附带：长度 <8 的弱令牌同样可在装载期通过（PATCH 路径却会被拒），形成「同一规则两条路两种结果」。
- **修复建议**：装载期对 `adminToken` 做与 PATCH 同规的校验（`typeof === 'string' && trim().length >= 8`），不合法则回落 `base.settings.adminToken`（新随机令牌）并 `warn`，同时把 `pendingMigration`（或一个 `settingsHealed` 标记）置位以诚实回写；`admin.ts` 的 `safeEq` 入参也应加 `String()` 归一，纵深防御。

---

### C-04 [P2] 「日志离开内存」的**第三条路径**：装载期的形状兜底不经 `archiveLogs`，下一次落盘后不可恢复

- **结论（已证实）**：DR-17-1 声称「原始日志离开内存的每条路径都必须先过账」，实现只覆盖了 `pushLog` 裁剪与 `clearLogs` 清空两条。`load()` 里对 `logs` 字段的兜底/元素级过滤是事实上的第三条路径：`parsed.logs` 非数组 → 静默变 `[]`；元素缺 `ts`（或非对象）→ 静默丢弃。这些日志**不进账本、不进 JSONL 冷备**，而且因为 JSON 解析成功，也**不会**走 `.corrupt-*` 备份分支；下一次任意 `save()` 就会把 `logs: []` 写回 `db.json`，原始文件中的那批日志永久消失。同时该过滤是唯一一处**丢弃元素却不打 `warn`** 的表（routes/channels/vkeys/agentLinks/rollups 都有 warn）。
- **证据**：
  - `src/store.ts:311-312`（`arr<RequestLog>(parsed.logs) ?? []` + `filter(l => !!l && typeof l.ts === 'number')`，无 warn）
  - `src/store.ts:359-361`（净化后直接返回 merged）、`src/store.ts:384-410`（`persist` 原样写回 `db.logs`）
  - 对照：`src/store.ts:260`、`295`、`299`、`310`、`347` 都有 `console.warn` 计数丢弃
  - 不变量文本：`docs/usage-rollup-design.md:44`（DR-17-1）、`docs/usage-rollup-design.md:47`（DR-17-2）
- **影响**：① 非数组形态：`db.json` 里那批日志**原文还在文件里**（只是本代码读不动），但下一次落盘会用 `logs: []` 覆盖它，连人工/外部工具事后打捞的机会也被抹掉；② 元素级：一条字段齐全、仅缺 `ts` 的日志会被直接丢弃，且**没有任何计数告警**，长窗统计与冷备都不知道它存在过。这类「形状损坏」正是本仓库既有 C-M1/P2 系列反复加固的场景，而本路径恰恰没有安全网。
- **复现/验证**：`/tmp/audit-c/A.mjs`，`db.json` 写 `"logs": "corrupt-but-parseable-2000-logs"`：
  ```
  in-memory logs: []
  in-memory rollups: []
  on-disk after flush logs field: []     # 原值被覆盖，且没有 .corrupt 备份
  ```
  元素级同因（`src/store.ts:311-312` 无 `console.warn`，而 routes/channels/vkeys/agentLinks/rollups 五处都有），可直接 `grep -n "console.warn" src/store.ts` 对照；本轮未单独构造「部分元素缺 ts」的库文件（**待核实**：丢弃条数是否与其它表同样打点）。
- **修复建议**：① `logs` 非数组时不要静默吞——若 `parsed.logs` 可枚举出任何对象元素，按 `ts` 缺失时回退 `Date.now()`（或纳入一个 `'-'` 桶）折进 rollups，再清空；不可枚举时才 warn 并置 `loadBlocked` 式保护（改名备份而非覆盖）；② 元素过滤加 `console.warn` 计数，并对被丢元素尽最大努力折账；③ 把「装载期丢弃日志 → 必须先过账本」写进 DR-17-1 的路径清单，配一条断言钉。

---

### C-05 [P3] `anthropicStreamToOpenai` 丢弃**字符串形态**的 error 消息（与反向转换口径不一致）

- **结论（已证实）**：Anthropic 流转向 OpenAI 时，error 帧若 `error` 是字符串（`{"type":"error","error":"boom"}`），分支把它替换成常量 `'upstream stream error'`，原文消息与 `scrub` 机会一起丢失；反向的 `openaiStreamToAnthropic` 则保留并掩码字符串形态。同一份「错误帧三形态」在两条路径上漂移。
- **证据**：
  - 丢失侧：`src/sse.ts:485-490`
    ```ts
    const e = json.error && typeof json.error === 'object' ? json.error : { message: 'upstream stream error' };
    ```
  - 保留侧：`src/sse.ts:587-591`（`typeof json.error === 'object' && json.error ? json.error : { message: String(json.error) }`）
  - 同类口径要求见 `src/sse.ts:277-296`（`scrubErrorFrame` 明确要求字符串形态也过 scrub）
- **影响**：跨协议客户端（OpenAI SDK ← Anthropic 上游）在流式中途失败时只能看到无信息量的通用文案，排障必须去翻网关侧日志；若上游把 key 回显在字符串 error 里，虽然「不泄漏」（因为整段被替换），但也说明这条路径没有走统一掩码链，属于「靠丢弃兜底」而非机制。
- **复现/验证**：`/tmp/audit-c/sse.mjs` 输入 `event: error / data: {"type":"error","error":"upstream boom sk-secret"}`：
  ```
  data: {"error":{"message":"upstream stream error"}}     # 原文丢失
  data: [DONE]
  ```
  同一脚本的 openai→anthropic 反向得到 `{"type":"error","error":{"message":"upstream boom sk-***"}}`（保留 + 掩码）。
- **修复建议**：与 `src/sse.ts:588` 对齐：非对象时取 `String(json.error)` 并经 `meta.scrub`；顺带在 flush 阶段不要把「已发 error 帧」的流再补一个正常的 `[DONE]` 之外的终态语义（当前仅补 `[DONE]`，可接受）。

---

### C-06 [P3] `persist()` 只 fsync 文件、不 fsync 父目录：`rename` 的持久化在断电窗口内不成立

- **结论（已证实，平台相关）**：原子写序列是 `open(tmp) → write → fsync(fd) → close → rename(tmp, db)`，没有对数据目录做 `open(dir)+fsync`。文件数据本身已落盘，但**目录项（rename 的结果）**在断电/内核崩溃时可能未持久化，`db.json` 会回退到旧版本；POSIX/APFS/ext4 上「fsync 目录」才是 rename 的持久化屏障。
- **证据**：`src/store.ts:393-405`（`fsyncSync(fd)` 在 `renameSync` 之前，之后无目录 fsync）；脚本内注释 `src/store.ts:391-392` 已声明「fsync 先于 rename」的意图，但只做了一半
- **影响**：桌面壳（Tauri）常被强制退出/合盖断电。极端断电下丢失最近一次全量落盘（最多 400ms 防抖窗 + 未同步目录项），退回上一版 db.json——因为每次都是全量写，丢的是「最近几分钟的全部变更」而非单条。属于持久化强度不足，不是逻辑错误。
- **验证方式（待核实）**：无法在本机用真实断电复现。可核实部分：`grep -n "fsync" src/store.ts` 只有 `fsyncSync(fd)` 一处（第 1 行 import、396 行调用），确无目录 fsync。APFS 上的实际窗口标「**待核实**」。
- **修复建议**：`rename` 后 `const dfd = openSync(dirname(DB_FILE), 'r'); fsyncSync(dfd); closeSync(dfd);`（Windows 上打开目录会失败，需 `try/catch` 且平台分支）；或至少在文档里把「断电持久性」明确为 best-effort。

---

### C-07 [P3] 导出的 `parseSSE` 不认纯 CR 分帧，并丢弃结尾未定界帧；与同模块透传分支口径不一致

- **结论（已证实）**：`parseSSE` 只按 `\n\n` 切帧（`drainFrames`），虽然 `normalizeNewlines` 的注释声明 SSE 允许 CRLF/CR/LF，但**纯 CR 帧**（`\r\r`）在尾部游程保护下不会被换算成 `\n\n`，流结束时生成器也不处理残余，结果整条流**零事件**。同文件的零改写透传分支却显式支持 `\r\r`（`src/sse.ts:216`），`frameTransform` 的 `flush` 也会处理尾部残帧（`src/sse.ts:128-134`）。
- **证据**：`src/sse.ts:51-59`（`drainFrames` 只找 `\n\n`）、`src/sse.ts:41-48`（尾部 CR 游程整体保留）、`src/sse.ts:73-92`（生成器 `finally` 只 `reader.cancel()`，不扫尾帧）、对照 `src/sse.ts:214-221`（透传分支 `/\r?\n\r?\n|\r\r/`）、`src/sse.ts:128-135`（flush 处理尾帧）
- **影响**：`parseSSE` 目前只被 `test/hardening.ts:594` 使用，属工具函数而非网关热路径，故定 P3；但它是导出 API，且宣称的兼容性与实现不符，未来若被热路径复用会踩。正常上游（OpenAI/Anthropic）用 LF/CRLF，不受影响。
- **复现/验证**：`/tmp/audit-c/frame.mjs`：CRLF 被 TCP 拆开、多行 `data:`、`data:` 无空格三种情况都正确；`data: {"c":3}\r\r` 得到 `[]`。
- **修复建议**：`parseSSE` 与 `frameTransform` 共用同一分帧实现（抽 `splitFrames(buf)` 含 `\r\r` 与尾帧语义），或在 `done` 后对 `rest` 做一次 `parseFrame`；不然就把函数注释里的「兼容 CR」删掉，避免宣称与实现不符。

---

### C-08 [P3] 装载期候选清洗不拒空 `routeId`，与运行期 `sanitizeCandidates` 口径不一致

- **结论（已证实）**：`load()` 对 auto 路由的候选只要求 `typeof routeId === 'string'`，空串 `''` 会**留在内存**；而 API 创建/更新路径的 `sanitizeCandidates` 会 `trim()` 后丢弃空串。同一字段两条路两种规则（与本仓库多处「创建与 PATCH 同规」的整改方向相反）。
- **证据**：
  - 装载期：`src/store.ts:272-278`（`cdRaw.filter(x => !!x && typeof x === 'object' && typeof x.routeId === 'string')`）
  - 运行期：`src/store.ts:720-733`（`const routeId = typeof c?.routeId === 'string' ? c.routeId.trim() : ''; if (!routeId || seen.has(routeId)) continue;`）
  - 对照同文件其它元素级清洗都要求非空：`src/store.ts:291`、`296`
- **影响**：v2 旧库迁入的空候选 `{routeId:'',weight:1}` 会永久驻留（内存态与回写的 v5 库都带），`candidates.length` 虚高、前端候选列表渲染空条目；运行时 `store.getModel('')` 落空后按硬排除处理，不影响路由正确性，属脏数据可见性/一致性问题。
- **复现/验证**：`/tmp/audit-c/M.mjs`，v2 库的 auto 候选含 `{routeId:'',weight:1}`：
  ```
  version= 5 routes= [ [ 'single','md1','m1',undefined ], [ 'auto','a1','auto1',2 ] ]   # 2 个候选都活着
  ```
- **修复建议**：`src/store.ts:276` 的过滤条件改为与运行期同规（`typeof x.routeId === 'string' && x.routeId.trim() !== ''`），并 `warn` 丢弃数；迁移回写时顺手把 `candidates` 重新过一遍 `sanitizeCandidates` 语义。

---

### C-09 [P3] 请求转换对非数组 `messages` 抛 `TypeError`：跨协议入口返回 502 而非 400

- **结论（已证实）**：`openaiToAnthropicRequest` / `anthropicToOpenaiRequest` 都用 `for (const msg of body.messages || [])`。`messages` 是对象（如 `{}`）时 `||` 不生效，`for…of` 直接 `TypeError`，被 `gateway()` 的兜底 `catch` 记成 502（`网关内部错误`），而同文件对 `estimateInputTokens` 已经做了 `Array.isArray` 守卫（`src/gateway.ts:1288`），说明该形状攻击面是被认知过的。
- **证据**：`src/translate.ts:93`、`src/translate.ts:292`；对照守卫 `src/gateway.ts:1287-1288`；兜底 502 `src/gateway.ts:843-848`
- **影响**：畸形请求被记为「网关内部错误」（502、进 `retries` 语义、污染错误分类与 auto 五格落账 A 格），实际应是 400。也把一个客户端可控的输入变成服务端异常路径。
- **复现/验证**：`/tmp/audit-c/tr.mjs`：
  ```
  1) object messages THROWS: TypeError object is not iterable (cannot read property Symbol(Symbol.iterator))
  ```
- **修复建议**：两个函数入口统一 `const msgs = Array.isArray(body?.messages) ? body.messages : []`；`messages` 存在但非数组时最好由调用方直接 400（在 `gateway()` 解析后加形状校验），避免落进 502 分类。

---

### C-10 [P3] 长窗下按 **auto 路由名**筛选模型会欠计（账本行只保留 `publicName`，丢失 `requestedModel`）

- **结论（已证实，口径缺口）**：原始日志筛选是「`requestedModel` 或 `routedTo`」双匹配（设计文档要求），但账本伪日志只把 `r.model`（= `publicName || requestedModel`）填进 `requestedModel`，没有 `routedTo`。auto 流量在日志里 `publicName` 是**候选真名**、`requestedModel` 是 **auto 名**，因此选中 auto 路由名时：原始日志能匹配，账本行（requestedModel=候选名）**匹配不上** → 7 天/30 天统计欠计 auto 名下的一部分流量。
- **证据**：
  - 筛选：`web/index.html:451-452`，账本伪日志：`web/index.html:455-463`（无 `routedTo` 字段）
  - 折叠键取 `publicName`：`src/store.ts:935`（`const model = l.publicName || l.requestedModel || '-'`）
  - auto 会把 `publicName` 写成候选名：`src/gateway.ts:1098`（`logPublicName: cur.name`）、`src/gateway.ts:1113`（`log.routedTo = cur.name`）
  - 设计文档要求双匹配：`docs/usage-rollup-design.md:68`
- **影响**：「查看 model_auto 实际吃了多少」在长窗下偏小；而按候选真名筛选两个来源都能匹配，数字正确——同一个页面两种筛选口径不一致。
- **验证方式**：代码路径推导（已给行号）；未跑真实 auto 流量对账（避免与 Lead 的端口/用例冲突），标「**待核实（数字量级）**」。
- **修复建议**：`UsageRollup` 增一个 `requestedModel`/`routedTo` 维度（会放大行数，需与 MAX_ROLLUPS 一起重估），或在消费端明确「账本只按真实模型归因，不参与 auto 名筛选」并在 UI 文案/筛选器里说明；两者都要与该文档 §5 的双匹配承诺对齐。

---

### C-11 [P3] 账本平均延迟除以 `requests` 而非 `latN`：无延迟样本的请求拉低均值

- **结论（已证实，边界量级小）**：折叠时 `latSumMs/latN` 只累加 `latencyMs > 0` 的样本（`src/store.ts:946`），但消费端把 `latencyMs` 当「和」累加、最后用 `latSum / b.requests` 求均值，分母是**全部请求数**（含 `latN` 之外的请求）。二者相等只在 `latN === requests` 时成立。
- **证据**：`src/store.ts:946`（`if (typeof l.latencyMs === 'number' && l.latencyMs > 0) { r.latSumMs += l.latencyMs; r.latN++; }`）、`web/index.html:461`（伪日志 `latencyMs: r.latSumMs`，丢弃 `latN`）、`web/index.html:519`（`b.latSum += l.latencyMs || 0`）、`web/index.html:559`（`Math.round(b.latSum / b.requests)`）
- **影响**：亚毫秒请求（`latencyMs === 0`）或字段缺失的日志会稀释 Provider/模型统计的「平均用时」，偏差比例 = `latN/requests`。常规请求 `latencyMs ≥ 1`，偏差可忽略；长时间运行后若大量 0ms 记录（例如内部短路）才显著。
- **验证方式**：代码推导 + `/tmp/audit-c/F.mjs` 可见账本行 `latN=1`、`requests=1`；构造 `latN < requests` 的场景需注入 `latencyMs=0` 的日志，本轮未单独跑（**待核实**：真实占比）。
- **修复建议**：伪日志带出 `_latN: r.latN`，消费端用 `latSum / (latN 之和)`；或折叠时对 `latencyMs<=0` 也计入 `latN`（把 0 当作真实样本），统一分母语义。

---

### C-12 [P3] `sanitizeSettings` 白名单用 `k in NUM_BOUNDS`：`toString` / `constructor` 等原型键穿透并落盘

- **结论（已证实）**：白名单判断是 `k in NUM_BOUNDS`，而 `in` 会命中原型链成员。`PATCH /api/settings {"toString": 5}` 会通过 `Number(5)` 与 `undefined` 边界的「区间检查」，被写进 `settings` 并持久化到 `db.json`（`constructor` 同理）。`valueOf: 'x'` 因 `Number('x')=NaN` 被拒，所以只有数字型原型键可穿透。
- **证据**：`src/store.ts:149-156`
  ```ts
  } else if (k in NUM_BOUNDS) {
    const x = Number(v);
    const bound = NUM_BOUNDS[k];                       // Object.prototype.toString / constructor
    if (!Number.isFinite(x) || x < bound.min || x > bound.max) { ... }   // bound.min/max 为 undefined → 比较恒 false
    out[k] = Math.floor(x);
  ```
  落盘：`src/store.ts:982-985`（`Object.assign(this.db.settings, value)` + `save()`）
- **影响**：`settings` 对象被挂上 `toString`/`constructor` 自有属性（遮蔽 `Object.prototype`），持久化进库；重载时该键会因「未知设置项」被净化丢弃，所以**能自愈**，但库文件在被下次 `save()` 覆盖前带着污染键，且运行期任何 `settings.toString()`/`settings.constructor` 语义被改写（当前代码未见这类调用，故 P3）。
- **复现/验证**：`/tmp/audit-c/G.mjs`：
  ```
  applied = ["toString","constructor"]
  settings own toString = true 5
  on-disk settings keys = ...,toString,constructor
  ```
- **修复建议**：改为 `Object.hasOwn(NUM_BOUNDS, k)`；并把 `NUM_BOUNDS` 用 `Object.create(null)` 或 `new Map` 承载，从类型上消灭原型穿透。

---

### C-13 [P3] 冷备失败只 `console.warn`：全保真承诺对用户不可见；崩溃+重试可能重复追加

- **结论（设计取舍 + 已证实边界）**：DR-17-3 明确「冷备尽力而为」，所以「写失败不影响请求/统计」是**有意的**，不算缺陷；但由此产生两个未被设计覆盖的后果：① 冷备失败没有任何 UI/接口可见性，用户以为「明细在 JSONL 里」，实际可能整月缺失（磁盘满、权限被改）；② `clearLogs`/裁剪先把原文 `appendFileSync` 进 JSONL、再标脏防抖落盘，若在防抖窗内崩溃，重启后同一批日志仍在内存/盘上，再次清空会把**同一批原文重复追加**进 JSONL（账本不重复计，因为账本未持久化）。冷备自身无去重键（`RequestLog.id` 未被用作幂等键）。
- **证据**：`src/store.ts:968-974`（仅 `console.warn`）、`src/store.ts:917-922`（先 append 后 `save()`）、`src/store.ts:911-915`、`docs/usage-rollup-design.md:50`（DR-17-3）、`docs/usage-rollup-design.md:40`（JSONL 每行一条完整 `RequestLog`，含 `id`）
- **影响**：离线分析可能出现重复行（可自行按 `id` 去重，属可用性问题）；冷备静默缺失则破坏「全保真可离线分析」的用户预期。
- **验证方式**：崩溃时序无法在本机安全复现（**待核实**）；冷备失败路径可通过把数据目录设为只读临时目录验证 `warn` 文本，本轮未跑。
- **修复建议**：把冷备失败计数/最近失败时间放进 `/api/overview` 或设置页（一行「冷备文件 N 次写入失败」），保持「不阻断主路径」但让承诺可核验；追加时可用 `id` 做月度文件内去重（或写 `\n` 前查尾行），把幂等从纪律变成机制。

---

### C-14 [P3] 缓存读写价缺省值（0.1× / 1.25× 输入价）是 Anthropic 口径，套用到 OpenAI 协议会低估成本（疑似）

- **结论（疑似，设计取舍偏保守）**：`computeCost` 对未配置 `priceCacheRead/priceCacheWrite` 的模型分别取 `priceInput*0.1` 与 `priceInput*1.25`（Anthropic 的缓存读/写相对价）。同一默认值也套在 OpenAI 协议渠道上：OpenAI 的缓存命中价通常是输入的 0.25×/0.5×，且没有「缓存写」加价（`cache_creation_input_tokens` 多为中转站自定义字段）。因此对 OpenAI 渠道，缓存命中成本被低估约 2.5–5×，且无缓存写时也不会多收（`cw` 通常为 0，影响有限）。
- **证据**：`src/usage.ts:14-15`；类型无协议维度：`src/types.ts:77-78`（`priceCacheRead`/`priceCacheWrite` 只在 model 上）
- **影响**：使用统计页的「≈ 成本」在 OpenAI 缓存场景下偏低（估算功能，非账单）。配置组导出示例里缓存价可为 `null`（`docs/config-bundle-design.md:51`），即走默认。
- **验证方式**：代码推导；`/tmp/audit-c/F.mjs` 已验证默认价参与算式（`computeCost = 0.003998` 与手算一致）。真实价差标「**待核实**」（需各供应商价目）。
- **修复建议**：要么按 `model.protocol ?? channel.protocol` 选默认折扣，要么在 UI 的成本口径提示里写明「缺省按 Anthropic 缓存价估算」，避免用户把估算当账单。

---

## 二、已核实一致（非缺陷，供去重与回归基线）

| 编号 | 结论 | 证据 |
|---|---|---|
| V1 | **折叠 `pin` 与 `computeCost` 净输入口径逐字一致**（缓存不双计）。日志 `prompt=1000, cr=200, cw=50`：`computeCost` 取 `freshInput=750`，账本行 `pin=750`、`costUsd=0.003998` 与手算 `(750×3+200×0.3+50×3.75+100×15)/1e6` 一致 | `src/usage.ts:16-18`、`src/store.ts:942`；实证 `/tmp/audit-c/F.mjs` |
| V2 | **两种上游协议归一到 OpenAI 语义，且出站反向减法自洽**：`usageFromAnthropic` 把 `input+read+write` 合成 `promptTokens`，`anthropicUsagePayload`/`openaiToAnthropicResponse` 再减回去；流式与非流式（`src/sse.ts:150-159`）同式，不会对 Anthropic 缓存双算/漏算 | `src/translate.ts:475-485`、`src/sse.ts:148-159`、`src/translate.ts:427-446`；实证 `/tmp/audit-c/tr.mjs`（`input_tokens:100 + cache 50+10` → `promptTokens:160`） |
| V3 | **`mergeUsage`「只覆盖非零」是有意设计**：Anthropic 流里 `message_delta` 的 `input_tokens` 是终值、且部分帧缺字段，非零覆盖避免用 0 抹掉已有值。代价是**值不可下调**（上游若发更小的修正值会被忽略、缓存字段一旦出现便不消失）——标设计取舍（非缺陷），无实测反例 | `src/translate.ts:487-494`、`src/sse.ts:171-179` |
| V4 | **迁移链 v2→v3→v4→v5 完整、诚实回写、旧字段不复活**：实测 v2 双表库装载后 `version=5`、`models/autoRoutes` 不存在、候选保留、`rollups/agentLinks` 补空，`db.json` 被回写为 v5 且不含旧键 | `src/store.ts:241-361`、`src/store.ts:209-223`；实证 `/tmp/audit-c/M.mjs` |

补充口径说明（各有裁决，非缺陷）：499 在 `rollup.errors`/`successRate` 计为失败（`src/store.ts:941`、`src/usage.ts:243`），但在 `chainExhaustedRate`（`src/usage.ts:260`）与速度榜 `cancels`（`src/usage.ts:315`）中单独剔除——是「三套指标三种分母」的有意差异；`recordQuota` 用 `prompt+completion`（含缓存）计每日限额（`src/gateway.ts:759`），与 KPI 的净输入口径不同但语义不同（限额=总吞吐）。

---

## 三、日志离开内存的所有路径清单（DR-17-1 核对结果）

| # | 路径 | 是否过账本 | 是否进 JSONL 冷备 | 证据 |
|---|---|---|---|---|
| 1 | `pushLog` 超限裁剪（`logRetention`） | ✅ 是 | ✅ 是 | `src/store.ts:910-914` → `929-975`；e2e R17-2/R17-6 |
| 2 | `clearLogs`（`DELETE /api/logs`） | ✅ 是 | ✅ 是 | `src/store.ts:917-922`；`src/admin.ts:569-572`；e2e R17-7 |
| 3 | **装载期 `logs` 非数组 / 元素缺 `ts` 被丢** | ❌ **否（C-04）** | ❌ 否 | `src/store.ts:311-312`；实证 `/tmp/audit-c/A.mjs` |
| 4 | **JSON 解析失败 → `.corrupt-<ts>` 改名 + 空库启动** | ❌ 否（原文件留档，可人工恢复，但不折账） | ❌ 否 | `src/store.ts:362-381` |
| 5 | **进程被杀/断电，防抖窗（≤400ms）内日志未落盘** | ❌ 否（内存与盘双失，从未过账） | ❌ 否 | `src/store.ts:414-429`（400ms 防抖）、`1111-1120`（仅 `exit` 钩子兜底，SIGKILL 不触发） |
| 6 | 缩小 `logRetention` 本身 | —（不即时裁，R17-4 成立） | — | `src/store.ts:910-914`；e2e R17-1 |
| 7 | 配置组导入（`POST /api/config/import`） | —（不动 `logs`/`rollups`，已核实） | — | `src/admin.ts:615-650`、`src/config-bundle.ts` 全文无 `logs`/`settings`/`rollups` 写入 |
| 8 | 手工删 `db.json` / 删数据目录 | —（外部操作，不在代码职责内） | — | — |

**结论**：显式两条路径都已过账；**第 3、4、5 条是清单外的真实路径**，其中第 3 条（C-04）可通过一次普通落盘造成不可恢复丢失，建议写进 DR-17-1 并补断言钉；第 4 条可接受（留档）；第 5 条应明确为「本机单用户 + 全量写」的持久化边界。

---

## 四、未覆盖 / 待核实清单

1. **未运行官方测试**：`npm test`（18787）、`npm run test:hard`（18099）、`test:all` 一律未跑（Lead 端口独占）。本报告所有实证均来自 `/tmp/audit-c/` 的独立脚本（`tsx` + `OWN_API_DATA_DIR=/tmp/audit-c/*`），未复现 e2e R17-* 全套。
2. **未触碰真实 `~/.own-api`** 与在跑的桌面实例。
3. **`gateway.ts` 仅审与日志/计费交界处**：auto 链预算/粘性/健康分/饱和（审查 A/B 范围）未系统审；`attemptRoute` 的 499/cancel 记账只核对了 `finalize` 幂等与用量快照。
4. **`upstream.ts` / `sniffStreamBody`** 的空闲超时、断流判定未审（只沿用了 `sse.ts` 侧结论）。
5. **`web/` 只审 DR-17 合并消费点**（C-01/C-10/C-11），其余前端归口另一审查线；`src/web-html.gen.ts` 是生成物，结论以 `web/index.html` 与生成脚本为准。
6. **C-06 目录 fsync**：APFS/ext4 实际持久化窗口「待核实」；本轮只能核实代码未做目录 fsync。
7. **C-10 auto 名长窗欠计**、**C-11 latN 偏差**、**C-13 JSONL 重复/冷备静默缺失**：均为代码路径推导（行号已给），未跑真实流量对账/崩溃注入，量级标「待核实」。
8. **C-14 缓存默认价**：未查各供应商现行价目，「低估 2.5–5×」为疑似，非实测。
9. **未验证**跨协议 `openai→anthropic` 流式 `message_start.usage` 恒为 `{input_tokens:0,output_tokens:0}`（`src/sse.ts:575`）时，严格 Anthropic 客户端是否会把 input 记成 0——代码注释称已在审查 I2 裁决，本轮按设计取舍处理，标「疑似（客户端行为待核实）」。
10. **`translate.ts:333-337`** 仅图片的 user 消息会产出 `[{type:'text',text:''}, image]` 空文本块（实证 `/tmp/audit-c/tr.mjs` 第 2 条），OpenAI 上游是否 400 未实测，标「疑似」。
