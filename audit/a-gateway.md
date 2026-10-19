# 审查 A：网关请求路径与路由决策

> 仓库：`/Users/wuminxuan/Desktop/test/llm-manager`　版本 v0.1.16　HEAD `2f6b1df`
> 范围：`src/gateway.ts`(1370) `src/auto.ts`(511) `src/pool.ts`(140) `src/ratelimit.ts`(56) `src/upstream.ts`(284) `src/vision.ts`(158)，一致性对照 `docs/auto-routing-v2-design.md` / `docs/model-auto-design.md` / `docs/speed-insights-design.md`
> 只读约束：未修改 `src/` `test/` `web/` `docs/` 及任何配置；唯一写入本文件。
> 资源约束：未运行 `npm test` / `test:all` / `test:hard`（18787/18099 由 Lead 独占）。动态验证全部走 `/tmp/a-gw/*` 独立脚本 + 本地 mock 上游（`127.0.0.1:18911`）、内存态 `app.request()`，DB 指向 `/tmp/a-gw/data`，未触碰 `~/.own-api` 及任何真实用户目录。
> 日期：2026-10-19

## 0. 摘要

| 严重度 | 数量 | 编号 |
| --- | --- | --- |
| P0 致命 | 0 | — |
| P1 严重 | 1 | A-1 |
| P2 一般 | 5 | A-2 A-3 A-4 A-5 A-6 |
| P3 建议 | 5 | A-7 A-8 A-9 A-10 A-11 |
| 设计取舍（非缺陷） | 5 | D-1 ~ D-5 |

**一句话结论**：主链状态机、饱和退避（AR-4）、空存活三分支（G1）、加权权重公式（R4/DR-16）、429→健康窗隔离（C11）、配额预占/释放对称性在实测中均按文档工作；本次最重的问题是 **A-1：同一渠道上的兄弟候选会把别家候选触发的「号池冷却」记成自己的健康败样本**（实测把从未被上游调用过的候选 health 打到 0.1），其次是与 `pool.ts` 分类学不一致的 **402 终态误判（A-2）**、**单路由号池冷却退化为 502+错误文案（A-3）**、**`/v1/models` 广告不可调用模型（A-4）**。

---

## 1. 发现详情

### A-1（P1 严重）同渠道兄弟候选：别人触发的号池冷却被记成本候选健康败样本，实测把「从未被上游调用过」的候选 health 压到 0.1

**结论**：一个 auto 链里若两个候选共用同一渠道，候选 A 的 429 把该渠道 key 全部冷却后，候选 B 的 `pickKey()` 只会返回 `undefined`，但该路径返回的 `candidate_fail` 带 `sample:true`，于是 B 被 `recordAttempt(B,false)` 记健康败——B 从未真正打过上游。C11「429 永远不进健康窗」在效果上被绕过。

**证据**

- 冷却导致取不到 key 但不加区分：`src/gateway.ts:326-333`
  ```ts
  const key = reuseKey ?? pickKey(channel, { tried });
  ...
  if (!key) {
    if (!retries.length) lastMessage = `渠道 "${channel.name}" 号池为空或全部禁用`;
    else if (tried.size >= channel.keys.length) lastMessage = `${lastMessage}（号池 ${tried.size} 把 key 已全部尝试）`;
    break;
  }
  ```
  注意 B 的 `attemptRoute` 有独立的 `const tried = new Set()`（`gateway.ts:315`），且 `retries` 是**链级共享数组**，所以 B 走到的是 `break` 前的初始 `lastMessage`（`gateway.ts:318`），而不是 `tried.size >= channel.keys.length` 分支。
- 出口把该情形一律当「候选判负且计样本」：`src/gateway.ts:616-617`
  ```ts
  // key 级重试穷尽：候选判负（rate_limit 不计健康样本，C11）
  return { kind: 'candidate_fail', status: lastStatus, message: lastMessage, sample: !lastWasRateLimit, rateLimit: lastWasRateLimit, retryAfterMs };
  ```
  `lastWasRateLimit` 只在**真正收到 429 响应**时才置真（`gateway.ts:401`），「无 key 可用」是 break 出的，故 `sample=true`。
- 链级据此记败：`src/gateway.ts:1157`
  ```ts
  if (outcome.sample && store.getModel(cur.cand.routeId)) recordAttempt(cur.cand.routeId, false, vkey.id);
  ```
- 入口软排除只覆盖「请求进入时」的冷却，管不住**链中途**被兄弟候选打冷的池：`src/gateway.ts:216`（`if (availableKeyCount(channel) === 0) return soft('渠道 key 全部冷却中')`）在 `evaluateCandidates` 里、对全部候选一次性求值；`evaluateCandidates`→`pickKey` 之间无 await，所以这不是并发竞态，而是**同链时序**。

**实测**（`/tmp/a-gw/run5.ts`，mock 计数 `/tmp/a-gw/mock.log`）
- 配置：渠道 1 把 key（`cooldownBaseMs=100` 便于复现，`autoSaturation.enabled=false` 以排除饱和兜底），两个路由 `shA`(weight 10, 上游恒 429)/`shB`(weight 1) 同挂一个渠道，auto `firstHop='best'`。
- 3 次请求（3 把不同 vkey，绕开 F6.1 失败限频）：

```
      results: [ {status:429, chain:["shA:429","shB:502"]},
                 {status:429, chain:["shA:429","shB:502"]},
                 {status:429, chain:["shA:429","shB:502"]} ]
      health:  [ {routeId: md_7892…(=shB), ok:0, fail:3, health:0.1} ]   // shA 无任何样本
--- mock received ---   model=x429a 共 3 次；model=x429b 共 0 次
```
即：**上游一次都没被 shB 打过，shB 却拿到 3 个失败样本并降到 0.1**；真正 429 的 shA 反而满血。

**影响**
1. 违背设计文档 §1/§2「429 不进健康窗（C11 不变）」与 §2「饱和只回答忙不忙，健康只回答坏没坏」的正交主张——池冷却从健康通道泄漏进来。
2. 受害候选被 `weight × health × …`（`gateway.ts:1043`）降权到 1/10，粘性重粘门槛 `health >= 0.6`（`gateway.ts:1117`）也不再可达：健康的备胎被系统性饿死，与 §5「低权重候选仍有首跳流量，不缺样本」相悖。
3. 决策快照被污染：`chainAttempts` 里 `shB:502`（`gateway.ts:1087-1090`）是**没发生过的 attempt 的状态**，复盘会误判为「第二个候选也坏了」。

**复现方式**：见上 `/tmp/a-gw/run5.ts`（`OWN_API_DATA_DIR=/tmp/a-gw/data OWN_API_DB_FILE=/tmp/a-gw/data/db.json npx tsx /tmp/a-gw/run5.ts`，mock 在 18911）。

**修复建议**：在 `pickKey` 返回 `undefined` 时区分「无 key（禁用/空池）」与「全部冷却」，例如新增 `AttemptOutcome` 变体或给 `candidate_fail` 增 `cause: 'pool_cooling'`：
- `cause==='pool_cooling'` → `sample:false`；`retryAfterMs` 取 `min(k.cooldownUntil)-now`；链记录状态用 429/503 而非 502；
- 「号池为空或全部禁用」文案只在 `channel.keys.every(k => k.status==='disabled' || !k.cooldownUntil)` 时使用，冷却中应回「号池全部冷却（最早 Xs 后恢复）」。

---

### A-2（P2 一般）402（余额不足）在 auto 链穷尽时被判成「纯 4xx」→ 顶层 400 + `invalid_request_error`，与 `pool.ts` 的 auth 归类自相矛盾

**结论**：`pool.ts` 明确把 402 归为 key 级故障（auth 类，换 key 才有救，绝不短接全链），gateway 的五格落账与 `errorBody` 却把 402 当请求侧错误：auto 全链耗尽回 400，单路由透传时错误 `type` 也是 `invalid_request_error`。

**证据**
- 归类源：`src/pool.ts:66-68`
  ```ts
  if (!status && err) return 'upstream';
  // 402（余额不足）是 key 级故障：换 key + 冷却，与鉴权失败同类处理，绝不短接全链
  if (status === 401 || status === 402 || status === 403) return 'auth';
  ```
- 终态落账漏了 402：`src/gateway.ts:1140-1142`
  ```ts
  // 401/403 归 A 格侧（对客户端等价"网关背后配置坏了"，非请求本身坏）——纯鉴权穷尽终态 502 而非 400
  if (outcome.status >= 500 || outcome.status === 401 || outcome.status === 403) sawServerError = true;
  else if (outcome.status !== 429) sawInvalid4xx = true;
  ```
- 由它推出的终态：`src/gateway.ts:1169-1171`
  ```ts
  const pure4xx = sawInvalid4xx && !sawRateLimit && !sawServerError && !budgetNote && chainAttempts.length > 0;
  ...
  const finalStatus = sawRateLimit ? 429 : pure4xx ? 400 : 502;
  ```
- 错误 type 映射：`src/gateway.ts:76-86`（openai 线：非 401/403/429/5xx → `invalid_request_error`）。

**实测**（`/tmp/a-gw/run2.ts`，上游回 402 `{"error":{"message":"insufficient balance"}}`）
```
t1_auto_all_402  : status 400  body {"error":{"message":"所有候选均失败：[ch402/sk-402***ghij] 402 insufficient balance","type":"invalid_request_error",...}}
t2_direct_402_clean: status 402 body {"error":{"message":"insufficient balance（号池 1 把 key 已全部尝试）","type":"invalid_request_error",...}}
```

**影响**：客户端/agent（Claude Code、各家 SDK）普遍把 400 当**不可重试的请求错误**并直接报错给用户——余额耗尽是运维可恢复故障，正解是 502（或 402 透传 + 明确 type）。同时控制台按 `pure4xx` 归类会把此类失败算进「请求侧坏」的聚合文案，掩盖真实原因。

**修复建议**：把 `sawServerError` 的条件改为「auth 类即算」，与 `pool.ts` 单一真源对齐（例如 `['auth'].includes(classifyFailure(outcome.status))` 或显式 `|| outcome.status === 402`）；`errorBody` 增加 402 → `insufficient_quota`/`api_error` 映射。建议补一条钉：双 key 渠道全 402 → 顶层 502 且 `sawServerError` 为真（当前 `test/e2e.ts` 无任何 402 用例，`grep -n 402 test/*.ts` 为空）。

---

### A-3（P2 一般）单路由（非 auto）号池全部冷却 → 502「号池为空或全部禁用」，无 429/Retry-After，且原因文案与事实相反

**结论**：`resolveRoute` 对单路由只校验 `channel.keys.length`，不校验可用性；于是「上一发把 key 打进冷却」后的下一发，客户端拿到 502 + `api_error` + 一句错误原因，而真实情形只是 30s 冷却。

**证据**
- 单路由只查长度：`src/gateway.ts:121`
  ```ts
  if (!channel.keys.length) return { error: `渠道 "${channel.name}" 号池内没有可用 key` };
  ```
- 而 fallback 渠道分支查了可用性：`src/gateway.ts:134`
  ```ts
  if (channel && channel.enabled && availableKeyCount(channel) > 0) {
  ```
- 无 key 时的错误文案：`src/gateway.ts:330`
  ```ts
  if (!retries.length) lastMessage = `渠道 "${channel.name}" 号池为空或全部禁用`;
  ```
- 可用性判定：`src/pool.ts:22-26`（`cooldown` 且未到期 → 不可用）。

**实测**（`/tmp/a-gw/run.ts`，同一渠道 1 把 key，上游恒 429）
```
t3a_direct_429_first              : status 429 「rate limited by upstream（号池 1 把 key 已全部尝试）」
t3b_direct_429_second_while_cooling: status 502 {"error":{"message":"渠道 \"ch429\" 号池为空或全部禁用","type":"api_error"}}
```

**影响**：① 客户端在 30s 冷却窗内看到 502（不可恢复语义）而非 429 + `Retry-After`，会触发 SDK 的指数重试或直接把故障暴露给用户；② 文案把「冷却中」说成「为空或全部禁用」，与工程文化「运维排障刚需」相悖；③ 与 auto 路径的空存活三分支（G1 会给 429）行为不一致，同一事故两种表现。

**修复建议**：单路由路径引入与 auto 相同的入口判定：`availableKeyCount(channel) === 0` 时回 429 + `retry-after = min(cooldownUntil)-now`（或至少修正文案并复用 `satLeftMs` 口径）；`lastMessage` 按「空 / 全禁用 / 全冷却」三分支生成。

---

### A-4（P2 一般）`GET /v1/models` 广告不可调用的模型：渠道停用、号池为空/全冷却的 single 路由仍被列出，破坏被文档称唯一真源的 G1 不变式

**结论**：single 条目只过滤 `m.enabled ∧ allowedForKey`，**不校验渠道存在/启用/有 key**；auto 条目却校验了渠道启用。于是「选择器里的集合 ≡ 这把 key 能调的集合」（`gateway.ts:1332-1337` 的 G1 承诺）对 single 不成立。

**证据**
- single 过滤链：`src/gateway.ts:1338-1349`
  ```ts
  const models = store
    .listModels()
    .filter((m) => m.enabled && allowedForKey(vkey, m.publicName))
    .map((m) => ({ ... owned_by: `own-api:${store.getChannel(m.channelId)?.name || 'unknown'}`, ... }));
  ```
- auto 对照（显式查渠道启用）：`src/gateway.ts:1355-1357`
  ```ts
  .filter((m): m is ModelRoute => !!m && m.enabled && !!store.getChannel(m.channelId)?.enabled && allowedForKey(vkey, m.publicName));
  ```
- 调用侧却会拒：`src/gateway.ts:117-121`（渠道不存在 / 已停用 / 路由已停用 / 号池无 key 均 404）。

**实测**（`/tmp/a-gw/run3.ts`）
```
t7_models_after_channel_disabled: {status:200, ids:["visOK","visNoKeys"]}   // 渠道已 enabled:false
t7_call_disabled_channel        : 404 「渠道 "chVis" 已停用」
t8_models_has_empty_pool        : true                                       // 号池 keys:[]
t8_call_empty_pool              : 404 「渠道 "chEmpty" 号池内没有可用 key」
```

**影响**：一键接入（`docs/agent-import-design.md §2.2`）把 `/v1/models` 当作 agent 模型清单的单一真源；停用渠道/清空号池后，agent 选择器仍列出该模型，用户选中后必 404。「由构造保证」的一致性承诺实际只对 auto 成立。这正是任务书里「把一致性从靠纪律改为靠机制」的反例。

**修复建议**：把 `visibleModelsForVKey` 的 single 过滤与 `resolveRoute` 的准入条件收敛到同一个函数（如 `isRouteServable(m)`：route.enabled ∧ channel 存在 ∧ channel.enabled ∧ keys.length>0），两处共用；cooling 属瞬态可继续列出（与 auto 口径一致）。

---

### A-5（P2 一般）视觉路由漏检 `tool_result` 内嵌图片：软排除/0.25 降权/被动学习闭环全不生效，但 inputEst 又把它算进图片 token

**结论**：`chatHasImages` 只扫 `messages[].content[]` 一层，而 anthropic 的图片常嵌在 `tool_result.content[]`（Claude Code 读图/截图回灌的典型形态）；`estimateInputTokens` 却会递归进 `tool_result` 计数。两条判定口径不一致 → 带图请求被当纯文本路由。

**证据**
- 一层扫描：`src/vision.ts:37-43`
  ```ts
  export function chatHasImages(chatBody: any): boolean {
    for (const m of chatBody?.messages || []) {
      if (!Array.isArray(m?.content)) continue;
      for (const p of m.content) if (p?.type === 'image_url' || p?.type === 'image') return true;
    }
    return false;
  }
  ```
- 递归计数：`src/gateway.ts:1278-1283`
  ```ts
  else if ((p as any).type === 'tool_result') pushContent((p as any).content, depth + 1);
  ...
  else if ((p as any).type === 'image' || (p as any).type === 'image_url') {
    imgTokens += imageDataTokens(p) ?? 1600;
  ```
- 三个消费点全以 `chatHasImages` 为闸：软排除 `gateway.ts:222`、被动学习 `gateway.ts:411`、unknown 降权 `gateway.ts:1041-1042`。

**实测**（`/tmp/a-gw/run2.ts` T6，body 唯一图片放在 `tool_result.content[]`）
```
t6_nested_tool_result: { chatHasImages: false, estimateInputTokens: 1 }
t6_flat_openai       : { chatHasImages: true,  estimateInputTokens: 1 }
```
（同尺寸 1×1 PNG 两者 token 数相同，差异点确凿在 `chatHasImages=false`。）

**影响**：① `supportsVision === false` 的候选不会被排除，用户会遇到「静默丢图返回 200」的坏结果（正是 §4 想消灭的场景）；② unknown 候选拿不到 0.25 降权；③ 被动学习闭环（G18/F6.2）永不触发——因为闸门就没开。四条视觉裁决（VIS-1/3/6/7）在这一形态下全部失效。

**修复建议**：把 `chatHasImages` 改为与 `estimateInputTokens.pushContent` 同源的递归扫描（抽一个共享的 `walkContentParts`，含 `tool_result`/`tool_use` 下钻），并把 `imageFingerprints` 一起对齐（`vision.ts:102-114` 同样只扫一层）。补钉：`tool_result` 内嵌图 + `supportsVision=false` → 软排除（VIS-1 的嵌套形态）。

---

### A-6（P2 一般）`stream_options` 回退分支对**所有** `invalid_request` 类失败盲重试同一把 key：流式 4xx 上游请求量翻倍

**结论**：判断条件是 `injectedStreamOptions && kind === 'invalid_request'`，而 `classifyFailure` 把 400/404/422 等全部归 `invalid_request`。于是任何流式请求遇到 4xx（含「模型名不存在」这种不可能由 stream_options 引起的错误）都会先摘掉 `stream_options` 再打一次上游。

**证据**：`src/gateway.ts:376-392`
```ts
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
if (up.status === 404) { ... }
```
404 分支在它之后，永远拿不到第一次 404。

**实测**（`/tmp/a-gw/run6.ts`，暗桩按 model 区分并打印每次上游调用）
```
#1 model=nf-nonstream stream_options=false      // 非流式：1 次
#2 model=nf-stream    stream_options=true       // 流式：第 1 次
#3 model=nf-stream    stream_options=false      // 流式：第 2 次（盲回退）
```

**影响**：流式 + 4xx（模型名配错、上游参数校验失败、配额 402 前的 400 等）时上游请求量 ×2；配合 SDK 自带重试与 §1「16 倍放大面」的既有担忧（G2/G4）叠加。无错误结果，只放大流量/延迟/错误计数。

**修复建议**：只在**首块错误体明确指向 stream_options** 时回退（如 `/stream_options|include_usage|unknown (field|parameter)|unsupported parameter/i.test(brief)`），或仅在 `up.status === 400` 且非 404 时尝试一次。

---

### A-7（P3 建议）被动学习置 `supportsVision=false` 会顺带把 `visionLocked` 置真，与 F6.3「只有用户手动改过才锁定」的语义混淆

**结论**：`store.updateModel` 在 patch 含 `supportsVision` 且未带 `visionLocked` 时自动 `visionLocked = true`；学习闭环走的正是这条 patch，于是**自动降级被记成用户锁定**。

**证据**
- 学习写入：`src/gateway.ts:415-418`
  ```ts
  if (route && a.settings.autoVision?.enabled !== false && route.visionLocked !== true
    && visionLearnReady(route.id, imageFingerprints(a.chatBody))) {
    store.updateModel(route.id, { supportsVision: false });
    markVisionLearned(route.id);
  }
  ```
- 副作用：`src/store.ts:679-681`
  ```ts
  // F6.3：显式改 supportsVision（未同时给 visionLocked）= 用户手动标注 → 锁定，被动学习不再覆盖。
  if (next.supportsVision !== undefined && !('visionLocked' in next)) next.visionLocked = true;
  ```
- 文档语义：`docs/auto-routing-v2-design.md:85`「**用户手动改过的路由学习不再覆盖**」；`gateway.ts:415` 也把 `visionLocked` 当「用户锁定」闸。

**实测**（`/tmp/a-gw/run4.ts`：上游对带图请求回 400「images are not supported by this text-only model」，两次不同图片指纹）
```
req1后: {}                                        // 未学习
req2后: {"supportsVision":false,"visionLocked":true}  // 自动学习同时锁定
req3   : 404 auto "autoNV" 没有满足本请求约束的候选（nv：请求带图片而候选不支持视觉）
```

**影响**：管理台无法区分「自动学到 false」与「用户手动锁定」，用户按文档去「改回去」时面对的是一个已锁状态；同时该路由的后续学习（哪怕是反向信号）被永久关闭。属语义/可运维性问题，不产生错误响应。

**修复建议**：学习路径显式传 `{ supportsVision: false, visionLocked: false }`，或给 `updateModel` 增加 `source: 'learn'` 参数区分写入来源。

---

### A-8（P3 建议）[疑似] 200 响应体非法/超限时，`recordSuccess` 与 `satNoteSuccess` 已在读体之前执行——「假成功」会清零 key 错误streak 与候选饱和态

**结论**：`// ---------- 成功 ----------` 段在 `await readJson(...)` 之前就调用了 `recordSuccess`/`satNoteSuccess`，而合法性校验在之后。若上游返回 200 但体不是合法 JSON / 超 `maxBodyBytes`，这次调用会被记为「key 成功 + 候选恢复」，随后才对 key 记一次 upstream 失败。

**证据**：`src/gateway.ts:428-430` 与 `573-589`
```ts
// ---------- 成功 ----------
recordSuccess(channel, key);
if (route) satNoteSuccess(route.id); // G7/SAT-4：滑动窗清零；探测命中则整个饱和态清零
...
const json = await readJson(up.body, settings.maxBodyBytes);
up.dispose();
if (a.isAborted()) return { kind: 'client_abort' };
if (json === undefined || json === null || typeof json !== 'object' || Array.isArray(json)) {
  lastStatus = 502;
  lastMessage = up.getStreamError() || '上游返回 200 但响应体不是合法的 JSON 对象';
  recordFailure(channel, key, 'upstream', lastMessage);
  ...
```
`readJson` 对超限/解析失败统一返回 `undefined`（`gateway.ts:1234-1260`）。

**影响**：SAT-4「只有真成功才清零饱和」在「200+垃圾体」形态下被破坏——饱和退避可能被一个假 200 提前解除；key 的 `totalErrors` 被 `recordSuccess` 清零（`pool.ts:121-130`），错误累积阈值失效。窗口较窄（上游 200 返回非 JSON / >32MB 体），故标 **疑似**（未构造运行时复现，仅静态确认执行顺序）。

**修复建议**：把 `recordSuccess`/`satNoteSuccess` 移到「响应体校验通过、确定要提交」之后（JSON 路径挪到 `gateway.ts:591` 附近；流式路径保持现有提交点语义）。

---

### A-9（P3 建议）[疑似] 管理端可把 key 置为 `status='cooldown'` 且不带 `cooldownUntil`，此后该 key 永久不可用且无自愈路径

**结论**：`updateKey` 白名单接受 `status`，但 `cooldownUntil` 不在可写字段里，且只有 `status='active'` 才清冷却；`isAvailable` 对 `cooldown` 且无 `cooldownUntil` 的 key 恒判不可用。

**证据**
- `src/store.ts:545-562`
  ```ts
  if (key === 'status' && v !== undefined && !['active','cooldown','disabled'].includes(String(v))) continue;
  ...
  if (patch.status === 'active') { k.cooldownUntil = undefined; k.lastError = undefined; }
  ```
  （`cooldownUntil` 未列入 `UPDATABLE_KEY_FIELDS`）
- `src/pool.ts:22-26`
  ```ts
  if (k.status === 'cooldown') return !!k.cooldownUntil && k.cooldownUntil <= now;
  ```
- 端点：`src/admin.ts:250-256`（`PATCH /channels/:id/keys/:keyId` 原样透传 body）。

**影响**：一把被手工置 `cooldown` 的 key 永久留在池里占位（`availableKeyCount` 恒不计），单 key 渠道会一直 502/404。**UI 不可达**（`web/index.html:1004` 仅展示冷却），只有手工调管理 API 才会踩到，故标 疑似/防御性缺口。

**修复建议**：`updateKey` 在 `status==='cooldown'` 时同时写 `cooldownUntil = now + settings.cooldownBaseMs`，或在 `isAvailable` 里对缺失 `cooldownUntil` 的 cooldown key 做惰性恢复为 active。

---

### A-10（P3 建议）入站 body 读取中断（499）不落审计日志，与相邻的 413/400 分支不一致

**结论**：`content-length` 超限、JSON 非法两条早退都 `pushLog`，唯独「body 读到一半客户端断开」直接返回 499 不记账。

**证据**：`src/gateway.ts:700-738`
```ts
if (declared && declared > settings.maxBodyBytes) {
  pushLog(baseLog(t0, vkey, c, wire, op), { status: 413, ok: false, error: 'declared content-length too large' });
  ...
} catch {
  // body 读到一半客户端断开：reader reject 是取消语义，不是协议错误（审查 C-L7）
  if (c.req.raw.signal.aborted) return fail(c, wire, 499, 'client aborted');
  return fail(c, wire, 400, 'request body read failed');
}
```
（`gateway.ts:736` 的 JSON 解析失败分支有 `pushLog`。）

**影响**：控制台的流言扫描/滥用视图看不到这一类请求；也拿不到「客户端在多大 body 上断开」的观测。低危，但与项目「门槛前的拒绝也要进审计」（P3 原则，`gateway.ts:702` 注释）不一致。

**修复建议**：该分支补 `pushLog(baseLog(...), { status: 499, ok: false, error: 'client aborted during body read' })`（`baseLog` 不读 body，安全）。

---

### A-11（P3 建议）[待核实] `extraHeaders` 无名称/取值校验：一个含 CR/LF 或非法字符的配置会让该渠道每次请求都失败并连带冷却 key

**结论**：`sanitizeExtraHeaders` 只做类型过滤，不校验 header 名/值；`buildHeaders` 直接 `Object.assign` 后交给 `fetch`。非法值会被 undici 抛 TypeError → 走 `attemptRoute` 的 catch → `recordFailure(...,'upstream')`，把**配置错误**记成 key 故障。

**证据**
- `src/store.ts:191-199`（无字符校验）
- `src/upstream.ts:36` `if (channel.extraHeaders) Object.assign(headers, channel.extraHeaders);`
- `src/gateway.ts:356-366`（catch 里 `recordFailure(channel, key, 'upstream', msg)`）

**影响**：配置手误的代价是整条渠道持续 502 + key `totalErrors` 累积冷却，排障时错误信息指向网络而非配置。**待核实**：实际可达路径（管理台 UI 是否允许编辑 extraHeaders）未确认；undici 的校验行为未单独实验（静态推断为 TypeError）。

**修复建议**：`sanitizeExtraHeaders` 增加 `/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/` 名称与 `/[\r\n]/` 取值校验，非法项在配置入口 400 拒收。

---

## 2. 设计取舍（非缺陷，已实测确认按文档工作）

| 编号 | 现象 | 判定依据 |
| --- | --- | --- |
| D-1 | auto 存活集为空且只有软排除（key 全冷却/结构不匹配/视觉）→ **404**（`code:model_not_found`），不合成 429 | 文档 §2 G1「仅软排除 → 维持 404」；实测 `/tmp/a-gw/run3.ts t10`（weight=0 → 404 带 `weight=0（禁用）` 明细）、`run2.ts t4`（key 全冷却 → 404） |
| D-2 | 单 key 渠道下 `maxKeyRetries=3` 实际只打 1 次上游 | `tried` 集合同请求内禁止重选同一 key（`gateway.ts:335` + `pool.ts:36`），属「key 级重试=换 key」的既定语义（`gateway.ts:325` 注释）；代价是瞬态 5xx 不做同 key 重试 |
| D-3 | 号池负载用累计 `totalRequests/weight` 而非滑窗 | `pool.ts:39` 注释「审查 I4，文档化」；`pickKey` 为同步函数，实测无并发竞态（两次并发选取会因首次自增而自然错开） |
| D-4 | 直连（非 auto）路径不参与饱和退避 | 单路由无候选概念，`gateway.ts:396` 注释「只对真实路由记」；但由此产生的 A-3 是缺陷而非取舍 |
| D-5 | 上游 3xx 一律拒绝（SSRF 闸）并映射 502 | `upstream.ts:134-147`；副作用是重定向也被算作 `upstream` 失败并推进 key 错误streak——建议后续把「网关侧拒绝」与「上游故障」分开计数（观察项，不计为缺陷） |

已实测按文档正确工作的关键机制（正向确认）：
- **饱和触发 (a)**：2 key 渠道链内两 key 均 429 → `saturationSnapshot` 出现 `n=1, leftSec≈60`；下一发直接 **429 + `Retry-After: 60` + 文案「所有候选饱和（最早 60s 后恢复）」**（`/tmp/a-gw/run3.ts t9`），与 G1/F2.2/SAT-3 一致。
- **C11 隔离**：真正 429 的 `shA` 在健康窗内 ok/fail 全 0（A-1 泄漏只发生在兄弟候选侧）。
- **G1 合成 429 不经 `retryAfterHeader` 钳制**：`gateway.ts:946-951` 独立构造（60s 原样输出，未被 900s 口径改写）。
- **配额对称性**：`estTokens` 经 `ctx.setEst(daily.reserved)` 回写外层闭包（`gateway.ts:976/983`），`finalize` 幂等（`gateway.ts:753-761`）保证 `releaseQuota` 恰一次；未发现预占泄漏路径（`usage.ts:91-115` 的 `reserved` 语义自洽）。
- **DR-16 `best` 首跳**：实测确定性选 `ew` 最高者（A-1 复现中 `shA`(w=10) 恒先于 `shB`(w=1)），`pickBasis` 落 `best`/`chain`/`sticky`/`weighted` 四值（`gateway.ts:1080`）。
- **取消语义**：`attemptRoute` 在 `callUpstream` 抛出、`up.status>=400` 分支、`readJson` 之后均复查 `isAborted()` 并走 `client_abort`（`gateway.ts:324/359/371/578`），不记 key 故障（§8-4）。

---

## 3. 覆盖度

### 覆盖并给出结论的文件
| 文件 | 覆盖内容 |
| --- | --- |
| `src/gateway.ts` | 鉴权/限流/body 上限/模型解析/auto 选路/单候选管道/key 级重试/流式与 JSON 双路径/预算 N10/五格终态聚合/`/v1/models`；逐段精读 + 11 条实证 |
| `src/auto.ts` | 健康窗（含 F6.1 限频、`total<3` 守卫）、粘性 Map/TTL/degraded、饱和状态机（触发 a/b、单调、24h 帽、探测例外）、`pickWeighted`（NAN-1）、速度因子（EMA/半衰期/读侧四修/慢降级迟滞）；静态精读，饱和与权重部分动态验证 |
| `src/pool.ts` | `pickKey` 加权最小负载、`isAvailable` 冷却恢复、`classifyFailure` 五类、`recordFailure` 冷却公式、`recordSuccess` 清零、`parseRetryAfter` 容错；静态精读 + 动态验证（A-1/A-3） |
| `src/ratelimit.ts` | 固定窗桶、FIFO 逐出、`clientIp` 归一（`::1`→`127.0.0.1`）、M0-b 成功不清零；静态精读（未做爆破压测） |
| `src/upstream.ts` | URL 拼接、鉴权头、双层超时（头/空闲）、错误体限读 8KB、SSRF 3xx 闸、`guarded` 流的 pull/cancel、`sniffStreamBody` 重放；静态精读 + 动态验证（A-6 的调用次数） |
| `src/vision.ts` | 家族先验、`VISION_UNSUPPORTED_RE`、含图检测、尺寸嗅探、`imageDataTokens`、指纹、学习门槛/冷却；静态精读 + 动态验证（A-5/A-7） |

### 未覆盖 / 未验证（如实声明）
1. **真实 SSE 端到端路径未动态验证**：`sniffStreamBody` 的 sse 分支、`passthroughStream`/`anthropicStreamToOpenai`/`openaiStreamToAnthropic`/`chatStreamToLegacy`、`track()` 的三终态、watchdog 进度重挂（`gateway.ts:538-561`）、提交点后客户端中途断开记 499 —— 本次只做了静态阅读与流式入口的 404 调用计数（A-6），**没有**用 mock 造 SSE 流复现取消/半开/看门狗。`src/sse.ts`(664) 不在本审查范围。
2. **粘性状态机未动态验证**：TTL 命中续期、瞬态绕行不覆写（C3/C6）、F1.1 饱和绕行 `degraded` 续期（SAT-5）、SPD-3 慢降绕行与 2× 回粘（STK-2）、`clearStickyForRoute` 生效性 —— 需要时钟注入与多轮会话，本次仅静态核对与文档一致。
3. **速度因子未动态验证**：EMA 衰减、窗内/窗外口径、`bench` 中位数域、墙钟回拨下钳、设置热改重钳 —— 静态核对与 `docs/speed-insights-design.md` 一致，未造样本序列实测。
4. **未运行任何既有测试套件**（约束；Lead 独占端口），故所有「已钉行为未破」的判断均来自阅读 + 本次自建用例，非回归证据。
5. **`decode 窗 ≥50ms` / `completionTokens≥16` 的采样准入、`isPromptTooLong` C 格续链、视觉学习白名单命中顺序（F2.1）**：静态确认，未逐一构造用例。
6. **管理台/Web 消费面**（`admin.ts`、`web/`）：仅在与结论相关处引用（如 extraHeaders 可达性标「待核实」）。
7. **`translate.ts`/`usage.ts` 统计侧**：仅覆盖与请求路径直接相关的协议转换调用点与配额准入/释放，未审内容级转换正确性。

### 本次使用的临时脚本（均在 `/tmp`，不污染仓库）
`/tmp/a-gw/mock.ts`（18911 上游暗桩：200/400 vision/402/404/429 可控）、`run.ts`、`run2.ts`、`run3.ts`、`run4.ts`、`run5.ts`、`run6.ts`；环境固定 `OWN_API_DATA_DIR=/tmp/a-gw/data OWN_API_DB_FILE=/tmp/a-gw/data/db.json`，DB 每轮删除重建。

## 4. 自评

- **优点**：11 条发现中 8 条有可复现的运行时证据（A-1~A-7、A-3 附上游调用计数），最重的 A-1 做到了「上游调用次数 = 0 却记 3 个失败样本」的闭环证明；每条均给 `file:line`，并把「已证实缺陷 / 设计取舍 / 疑似」三类显式分开（A-8/A-9/A-11 均为疑似并说明未复现原因）。
- **局限**：覆盖面偏「请求入口 → 决策 → key 选择 → 上游调用/首包」，**流式持续过程与粘性/速度两个时间状态机是静态结论**；未跑回归套件，无法证明既有 472/220 钉未破。
- **建议 Lead 后续动作**：① 让修复方按 A-1 补一条 e2e 钉（同渠道双候选 + 单 key 429 → 断言第二个候选健康窗为空、链记录非 502）；② A-2 补 402 终态钉；③ A-4 把 `visibleModelsForVKey` 与 `resolveRoute` 收敛为共享判定函数（机制化，符合工程文化）。
