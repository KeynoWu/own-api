# 渠道与路由快速导入（Config Bundle）— 设计 v2.1（方案，未实现）

> 状态：**已实现（2026-09-14）**（v2.1 按稿落地；守护断言：test/e2e.ts §19-21、test/hardening.ts「CB-1/CB-3 DOM 钉」。v2.2：实现后安全/正确性/前端/测试四路评审修订——candidatesMerged 回执、baseUrl/weight/stickyTtl/tag 闸前移、三闸（5000/1000/16）、disabled-only 算待填、导出文案与启发式扩充、两步弹窗失败保幕、待填第三幕直达）。
> 受众定位：员工本机各跑一个桌面实例，公司发 N 个模型端点 + 每人自己的 token。
> v1→v2 的关键修正：**bundle 里没有密钥，密钥由用户导入时/导入后手动填入**——
> 每个人的 token 不一样，导出来自别人 bundle 的 key 是有害无益的。
> 由此撤销 v1 的明文导出、isLocalish 明文闸、replace 恢复、vkeys/settings 子集（全部转非目标）。
>
> **引用约定**：本文 DR-CB-* 为本文私有编号；裸引 C*/W* 一律指
> docs/model-auto-design.md §11 决策总表（如「C8（model-auto §11）」首次出现带出处）。
> 代码引用一律符号锚（`文件#符号`），行号仅作辅助注记。

---

## 1. 范围（就这三类东西）

| 内容 | 进 bundle | 说明 |
| --- | --- | --- |
| 渠道 | ✅（**不含密钥**） | name / baseUrl / protocol / authStyle / extraHeaders / testModel / modelList / note / **enabled / timeoutMs**（v2.1 补齐：v2 字段域漏掉这两个，往返等价钉按字面不可实现；用户裁决补入） |
| 单模型路由 | ✅ | publicName / channelName 引用 / upstreamModel / protocol / enabled / contextWindow / maxOutputTokens / supportsStreaming / supportsTools / 价格 / tags |
| 自动路由 | ✅ | publicName / stickyTtlMs / candidates（按候选 publicName 引用 + weight） |
| 渠道密钥 | ❌ | **用户手动填**（§4） |
| vkeys / settings / 日志 / 额度 / 运行时态 | ❌ | 非目标（§7） |

**典型流程**：先行同事配好一切 → 导出 bundle.json 经**公司内部渠道**发到同事手里（无密钥，但仍是内部资料，§6）→
同事导入 → 预览回执 + 内联粘自己的 token → 确认 → 连通测试 → 完事。

## 2. 格式

```jsonc
{
  "kind": "own-api-config-bundle",
  "version": 1,
  "exportedAt": "2026-09-14T…Z",
  "channels": [{
    "name": "公司-DeepSeek",              // ← 幂等锚点与引用锚点（歧义处理见 §4.2-R，渠道名本机可重复！）
    "baseUrl": "https://…/v1",
    "protocol": "openai",                 // openai | anthropic
    "authStyle": "bearer", "extraHeaders": {}, "testModel": "deepseek-chat",
    "modelList": ["deepseek-chat", "…"],  // 可选，导入后可点「连通测试」重新拉取
    "enabled": true, "timeoutMs": null,   // v2.1 补入；timeoutMs null=默认
    "note": "公司统一网关"
  }],                                      // 注意：无 keys 字段
  "routes": {
    "singles": [{
      "publicName": "deepseek-chat",       // ← 幂等锚点（全局唯一，W7）
      "channelName": "公司-DeepSeek",      // ← 按名引用渠道
      "upstreamModel": "deepseek-chat", "protocol": null, "enabled": true,
      "contextWindow": 131072, "maxOutputTokens": 8192,
      "supportsStreaming": true, "supportsTools": true,
      "priceInput": 0.27, "priceOutput": 1.1, "priceCacheRead": null, "priceCacheWrite": null,
      "tags": [], "note": ""
    }],
    "autos": [{
      "publicName": "model_auto", "enabled": true, "stickyTtlMs": 300000, "note": "",
      "candidates": [{ "publicName": "deepseek-chat", "weight": 10 }]   // 按名引用；解析域只含 single（§4.4）
    }]
  }
}
```

**ADR（DR-CB-A，承接 v1）：跨实例引用一律按名、不按 id**——`channelId`/`AutoCandidate.routeId` 在 bundle
里是 `channelName`/候选 `publicName`，导入端两级解析（已存在实体 → 本包新建实体）。bundle 因此可跨机、可 hand-edit。

**schema 里没有 key 字段**；导入遇到 bundle 里出现任何 key 形态字段（`keys`、`api_key`…）→
忽略 + warning「每人密钥不同，bundle 中的密钥字段已忽略，请导入后手动填入」。宁可不导入密钥，
也不让员工手里躺着别人的 token（决策 DR-CB-B）。

## 3. 导出

`GET /api/config/export` —— 无参数、无选项、不导密钥，导出恒含**全部**渠道+路由（v1 不做选择性导出勾选）。

- **入口**：「模型路由」与「渠道与号池」两页工具栏各放同一个「**导出全部配置**」按钮（同一端点、同一文件），
  按钮旁固定微文案「不含渠道密钥；extraHeaders 原样导出——内部资料」——全量导出课题不变；extraHeaders 可能含认证头，文案不承诺「无敏感信息」（v2.2 安全评审订正）。
  落盘 `own-api-config-YYYYMMDD.json`。
- **导出前置检查（v2.1 新增，用户裁决）**：① 全部出包字符串字段（name/note/extraHeaders 值/modelList/tags）
  跑疑似密钥启发式 `/(sk|xoxb|sk-ant)[-_A-Za-z0-9]{16,}|[A-Za-z0-9_-]{40,}|\b[0-9a-fA-F]{32}\b|eyJ[A-Za-z0-9_-]{20,}/`（v2.2 扩 JWT/32-hex），命中即弹确认框**标黄提示
  「疑似密钥文本」并列出字段路径，不阻断导出**（「把 key 记在备注里」是真实使用模式，已知 key 哨兵拦不住自由文本）；
  ② 本机存在同名渠道时提示「存在同名渠道，导入方将按 §4.2-R 判定冲突」。
- **敏感度定级（v2.1 收紧）**：bundle 不含渠道密钥，但**不是公开文件**——它包含内部端点地址、extraHeaders
  （可能含认证头）与内部定价。按内部资料对待：仅经公司内部渠道分发（内网 wiki / 内部群），不得外传公司之外；
  转发前人工检查 extraHeaders 与 note。（v2 的「无密钥随便传/直接发群」措辞作废，与 §6 统一。）

## 4. 导入与「手动填密钥」闭环（本设计的正主）

`POST /api/config/import`，body `{ bundle, keys?: Record<string, string[]>, dryRun?: true }`。
`keys` = 渠道名 → 本次要追加的密钥数组（用户手填，**只存在于这一次请求**，不落 bundle、不回显）。

### 4.1 两步 UI 流程（快速是硬要求）

1. **粘贴 bundle**（v1 仅 textarea 粘贴，复用渠道页 key 批量粘贴交互；「选文件」需 FileReader+form() 新字段
   类型，超出一期，列 §7 非目标）→ 自动 `dryRun` 预览：**第二幕弹窗**（链式 form，DOM 桩已有同构先例可钉）
   = 回执摘要静态区 + **每个「无可用密钥」渠道一个密钥粘贴框**（一行一个）+ 确认导入按钮。
2. **确认导入** → 落盘 + 回执；对**密钥仍为空**的渠道，回执后仍有待填渠道 → 自动弹「按渠道填 key」第三幕（填写即走 addKeys 写入；取消则留琥珀徽章到渠道页补）。

**粘贴框呈现口径（v2.1，与 §5 pendingKeyChannels 严格同口径）**：新建渠道 + **已存在但号池里没有
`status==='active'` key 的渠道**都给框——「同事重发 bundle、首导留空」的合并渠道同样在发生现场填 key（DR-CB-E）。
「无可用」判据 = 不存在 active key；**仅剩 cooldown key 的渠道不算待填**（冷却是临时态，混入会把网络故障误报成没配 key）。

**预览/确认同源约束（v2.1，防「回执≠落盘」双路径漂移）**：bundle 文本任何变更即作废当前预览，
「确认导入」置灰并提示「预览已过期，请重新预览」；重新预览**按渠道名保留已输入密钥草稿**（仅内存、不回显不落盘），
渠道已不在新 bundle 中的粘贴框连同内容一并移除。

**导入后徽章（v2.1 判据收窄）**：渠道**号池为空**（keys.length===0）且渠道启用 → 渠道行挂**琥珀色**
「待填密钥」徽章（warn 语义），点击直达该渠道 key 输入；冷却/手动禁用/渠道停用沿用现有「可用 key N/M」
与「冷却 Ns」徽章体系，**不叠加红色**——红在本页专属「不可用」，同屏「红·待填」+「黄·冷却 30s」自相矛盾，
误报两次就没人信。有 active key 即摘徽章。

网关侧零新语义（v2.1 按实现校准）：单模型路由直连无可用 key 渠道 → **502** 现有文案
（gateway.ts 无 key 拒绝分支）；该渠道若仅经 auto 候选触达且全部候选无 key → **404**「没有满足本请求约束的候选」
（evaluateCandidates 对无 key/全冷却渠道是**瞬态软过滤**（soft，粘性保留）而非硬过滤——
model-auto §4.1 ①-b 的「硬过滤」措辞与实现有出入，属 model-auto 侧待修订正，本文按实现陈述）。

### 4.2 merge 幂等（锚点 = name）

**§4.2-R 渠道名解析规则（v2.1 新增，地基性）**：现状 store **不保证渠道名唯一**——createChannel 不查重
（store.ts#createChannel），PATCH 改名亦不撞名（UPDATABLE_CHANNEL_FIELDS 仅类型闸）；路由侧才有 W7 双向撞名。
按 name 匹配（trim 后精确相等）分四档：
- bundle 内 `channels[]` 自身出现归一化重名 → **整包 400**（引用锚不唯一，无法解析）；
- 本机命中 **0** 个 → 新建；
- 本机命中 **恰 1** 个 → 走 merge/conflict 表；
- 本机命中 **≥2** 个 → 该渠道及其下所有 `channelName` 指向它的条目**一律 conflict**，
  reason「本机存在 N 个同名渠道，无法判定合并目标，请先改名」；**绝不静默取第一个**，`keys` 该名下亦不写入。

| 实体 | 已存在且配置一致 | 已存在但配置不同 |
| --- | --- | --- |
| 渠道（按 name） | 合并 keys（`keys` 参数走 addKeys 既有去重；bundle 字段不覆盖） | `conflict`，不动（同名不同 baseUrl = 环境漂移，人来裁决） |
| 单模型路由（按 publicName） | skipped | `conflict`，**不覆盖** |
| auto（按 publicName） | 候选并集合并；同候选 weight 冲突**以 bundle 为准**（导入=对齐意图），回执 candidatesMerged 列合并明细（新增候选 X（wN）/权重 X：a→b；并集 >16 整条 conflict） | `conflict`；候选解析失败 → warning + 跳过该候选（悬空同 C8） |

**「配置一致」判定 = 双侧先过与创建路径相同的归一化，再比 bundle 字段域（含 v2.1 新补的 enabled/timeoutMs）**：
baseUrl 过 `normalizeBaseUrl`（尾斜杠差异不算漂移）；extraHeaders 键排序后序列化比较，`{}` ≡ 缺失；
modelList 过 `toStrList`（去重去空）后**按集合**比较，顺序不敏感；价格 **null ≡ 缺失，但 ≠ 0**（0=免费是显式配置）；
protocol `null ≡ 缺失 = 继承渠道`；布尔缺省按各自 create 默认展开后再比。

**字段清洗按路径分述（v2.1，戳破「复用白名单」的糊话）**：UPDATABLE_* 是 **PATCH 白名单**，新建实体走
createChannel/createModel 的另一套归一化，两条路径**并不同规**（如 createChannel 对 note/testModel 原样透传）。
导入器在解析层自补齐 create 侧缺口：protocol ∈ {null,'openai','anthropic'}、数字闸（NaN/负数 → 该实体
conflict 条目，不炸整包）、extraHeaders 走 `sanitizeExtraHeaders`——**不新写一套校验，但必须显式点名调谁**。

### 4.3 原子性：按实体原子 + 依赖级联（承接 v1 DR-CB-D）

每个实体独立成功/失败，回执如实（created/merged/skipped/conflicts/warnings）；重跑幂等补齐。
渠道创建失败/无法解析（重名歧义）→ 其下模型级联 conflict，不制造悬空渠道。
渠道 **conflict（已存在但不一致）时引用它的 singles 照常按「已存在实体」导入**（指向的是本机那条真实渠道），
回执对每条加 warning「引用了 conflict 渠道 X（本机配置不同），请人工核对」。

**keys 参数消费规则（v2.1，与 merge 结果正交但保守）**：
- 仅对**解析成功且判定为 created/merged** 的渠道写入；回执按渠道名列出 `keysAdded` 明细
  （**净新增数**——addKeys 去重不回报，导入层须自算差集）；
- 渠道 conflict / skipped → keys **一律不消费**（防止用户 token 被静默灌进配置漂移的端点），
  回执逐条 warning「x 的密钥未写入，冲突解决后请到渠道页填写」；
- keys 引用 bundle 与本机都不存在的渠道名 → warning「渠道 x 不存在，密钥未写入」；
- 确认导入整体失败（网络/4xx/5xx）→ 前端**保留对话框与全部已输入内容**，重试无需重粘。

### 4.4 导入顺序与畸形收敛

渠道（建 name→id 映射，按 §4.2-R 解析，含 keys 落 key）→ 单模型路由 → auto 路由。
**auto 候选解析域 = single 全集（本包新建 singles ∪ 本机已有 singles），不含任何 auto**——候选 publicName
命中本包或本机的 auto 名 → 视同引用不到模型，warning + 跳过该候选（承接 store#sanitizeCandidates 的
「禁嵌套」既有语义，名字世界同样封死）。

**畸形判定收敛为两档（v2.1，消 v2 三处口径不一）**：
- **结构畸形**（kind 不等于 `own-api-config-bundle`、version 大于已知集合、非对象顶层、渠道缺 baseUrl、
  路由缺 publicName、bundle 内渠道重名、**channels+routes 全空**）→ **400 逐条原因、零落盘**；
- **字段级脏值**（价格 "abc"、weight NaN、candidates 越界、未知字段）→ 实体 conflict / 忽略 + warning，不炸整包。
- 未知顶层/实体字段 → 白名单外忽略 + 回执 warnings 列字段路径（与 DR-CB-B 的 key 字段「忽略+warning」同构；
  低频 hand-edit 文件，错拼字段静默丢弃比报错更糟——必须回显）。

### 4.5 中断、半截态与落盘时序（v2.1 新增）

导入**无跨请求会话状态**。任一时点中断（关页/进程被杀/断电）后重进管理台，看到的是：已落盘的那部分实体
（号池为空的渠道挂「待填密钥」琥珀徽章）+ 缺席的其余实体——没有「导入未完成」残留指示，也不需要。
唯一恢复动作 = 重新导入同一 bundle：已存在实体走 merge/skipped 幂等补齐；keys 属单次请求，重跑需重新粘贴，
已落 key 由 addKeys 去重兜底。半截期间网关行为由既有语义兜底（§4.1 末段）。

**回执前 flushSync**：store 是 400ms 防抖落盘，导入 handler 在构造回执**之前**同步 `store.flushSync()`——
消除「回执宣称已创建、此刻盘上还没有」的观测窗（桌面场景：回执后 1 秒拔电源也是真）。

## 5. 回执

```jsonc
{ "dryRun": false,
  "channels": { "created": 3, "merged": 1, "conflicts": [{ "name": "x", "reason": "baseUrl 不同" }],
                "keysAdded": 2, "keysAddedByChannel": { "公司-DeepSeek": 2 } },
  "routes":   { "created": 8, "skipped": 2, "conflicts": [],
                "warnings": [{ "publicName": "model_auto", "reason": "候选 gpt-4o 不存在，已跳过" }],
                "candidatesMerged": [{ "publicName": "model_auto", "changes": ["新增候选 b（w3）", "权重 a：1→9"] }] },
  "pendingKeyChannels": ["公司-DeepSeek", "公司-GLM"]   // 无 status==='active' key 的渠道（新建+已存在都算；冷却不算）
}
```

- `keysAdded` = **净新增**计数（§4.3 消费规则）。
- **零变更形态**：全部 skipped/merged 的确认导入，回执卡首行固定显示「没有新变更：N 项一致、M 项冲突」，
  pendingKeyChannels 照常列出。

## 6. 安全边界

1. **分发口径**见 §3（内部资料级，非公开文件）。
2. 密钥只经两条路进系统：既有渠道页添加 key、本次导入的 `keys` 参数。**导入路径任何错误消息/回执字段
   禁止插值 keys 值**；非法 keys 项静默丢弃或计数，不进文案。鉴权不变：admin 令牌覆盖导入/导出
   （GET 同样过 createAdmin 的鉴权中间件）；`adm:IP` 桶不变——**注意它是鉴权失败锁定而非请求节流**，
   成功请求无速率限制（既定取舍），导入的体量防护由本端点 body 闸 + 实体条数上限（5000 实体 / 1000 key 条 / 单 auto 候选 16，超限 400 或 conflict）承担。
3. 导入是配置写面：不触碰 `settings`、vkeys、网关鉴权语义。
4. **body 限额为本端点新增闸（v2.1 事实校准）**：现状 `/api/*` **没有**任何 body 体积守卫
   （maxBodyBytes 仅在网关 /v1/* 与 count_tokens 生效；admin 各处理器 `c.req.json()` 裸读）。
   import handler 自建：content-length 预拒 + reader 流式累计，超 `settings.maxBodyBytes` → 413
   （口径对齐网关 fail413）；JSON 形状守卫复用 store.load「损坏不崩」精神，畸形 400 逐条、零落盘。
5. **dryRun 的枚举面声明**：回执对渠道名构成存在性/一致性 oracle（merged 与「baseUrl 不同」可区分），
   与 admin 令牌既有可见性（GET /channels 返回全量 name/baseUrl）等价，**接受**；
   若未来引入只读/低权令牌，本端点不得降权开放。

## 7. 非目标（v2.1 全清单）

- **导出密钥**（含明文导出、isLocalish 明文闸）——v1 设计整体撤销（DR-CB-B）。
- vkeys / settings 子集进 bundle。
- replace / 恢复备份模式——个人全量备份就是拷 `~/.own-api/db.json`，bundle 不承担该职责。
- 在线同步（URL 拉取）、选择性导出勾选、bundle diff 可视化。
- 冲突自动合并（三方 diff / last-write-wins）——一律 conflict 上报。
- 导入后自动跑连通测试（网络行为不做隐式，DR-CB-H）。
- **「选文件」导入**：file input 需 FileReader + form() 新字段类型；v1 仅粘贴（§4.1）。
- **OS 系统通知**：壳现状零通知依赖（src-tauri 仅 shell/autostart/single-instance）；页内 toast +
  琥珀徽章已覆盖 v1 全部反馈场景。重评估触发条件：出现「页面关闭后仍需提醒」的异步长任务。

## 8. 测试钉（实现时固化；**API/库层 → test/e2e.ts，UI/DOM → test/hardening.ts DOM 桩**）

> v2.2 偏差说明：两步链式下「预览后 bundle 被改→置灰」结构性不可达（确认幕 bundle 不可变、keys 提交时服务端重算）；DOM 钉落地为链式结构级 + 粘贴幕 throw 保幕。待填直达：导入完成后自动弹「按渠道填 key」第三幕（直走 addKeys）。

| 场景 | 层 | 断言 |
| --- | --- | --- |
| 往返等价 | e2e | **spawn 隔离双实例**（OWN_API_PORT=18823/18824，避让 e2e 18787 与 hardening 18810-18821；先例 hardening 迁移块）：A 配置→导出；B 全新库导入→再导出；两次导出**语义相等** = 忽略 exportedAt 与顶层 version、channels/routes 按 name/publicName **集合**比较不比数组序、字段深比较（extraHeaders 键序无关）；导出体不含已知 key 哨兵三形态（原文/URL 编码/base64，复用 leaky() 先例） |
| 密钥闭环 | e2e+DOM | bundle 不带 key + `keys` 参数带 key → 渠道有可用 key；不带 → pendingKeyChannels 列出、徽章可见（DOM 桩）、走该渠道请求 502 现有文案；**已存在无 active key 渠道经 merge 导入时预览内联框可见、填入即落 key**；仅剩 cooldown key 的渠道**不在** pendingKeyChannels |
| keys 四路径 | e2e | ①created 渠道落 key、②merged 渠道落 key（两路都真入号池且 keysAdded 只计净新增）、③不存在渠道名 → warning 零写入、④conflict 渠道 → 键不落 + warning；回执与 GET /channels 不含 key 原文 |
| 忽略外来 key | e2e | bundle 塞 `keys`/`api_key` 字段 → warning + 不写入 |
| merge 幂等 | e2e | 同 bundle 两遍：第二遍全 skipped/merged 零 created；keys 参数重复值被 addKeys 去重 |
| 同名歧义 | e2e | 本机预置两条同名渠道 → 该 name 及其下游条目 conflict、keys 不落、可预期回执；bundle 内同名渠道 → 整包 400 |
| 撞名不覆盖 | e2e | 同名不同 baseUrl / 同 publicName 不同 upstreamModel → conflict，现有配置逐字段不变 |
| 候选解析 | e2e | 悬空候选 → warning+跳过，其余正常；**同包正向**：候选引用同 bundle 先建的 single → created 无 warning（不得只查存量表）；候选名=任何 auto 名 → warning+跳过；merge weight 冲突 → 合并后 candidates 逐项（publicName,weight）断言（bundle 胜） |
| dryRun | e2e | ①主断言：`flushSync()` → 静默 ≥500ms → 读基线 → dryRun → 再 flushSync → **channels+routes+settings 三子树深相等且 logs.length 不变**（防抖+迟到 finalize 下唯一稳写法；整文件 Buffer.equals 仅辅助）；段内禁发 /v1 请求（每次网关请求都标脏）；②**等价钉：同一 bundle+keys 先 dryRun 后真导入，两份回执除 dryRun 布尔外逐字段相等**（实现约束：预览与提交共享同一计划构建函数，仅落盘一步分叉） |
| 畸形输入 | e2e | version:2 → 400 且文案含升级指引；渠道缺 baseUrl → 400；空 bundle → 400；价格 "abc" → 该实体 conflict（字段级），其余照常落盘；未知字段 → 忽略 + warnings 列路径 |
| body 闸 | e2e | 超 maxBodyBytes 的 bundle → 413 零落盘 |
| 零外呼 | e2e | dryRun 与提交导入期间 mock 上游 /__hits 增量 = 0（bundle baseUrl 填不可达地址也不产生连接尝试） |
| keys 不回显 | e2e | 导入的 200/400 响应体不含 keys 参数哨兵三形态 |
| 两步 UI | DOM | 链式弹窗：粘贴幕→预览幕（回执摘要+密钥框）；bundle 变更→确认置灰；确认幕密钥草稿按渠道名留存（复用链式 form DOM 桩基建） |

## 9. 决策记录（编号仅限本文）

| 编号 | 争点 | 裁决 | 理由 |
|---|---|---|---|
| DR-CB-A | 跨实例引用 id vs 名 | **名**（承接 v1） | id 本机随机；bundle 要可 hand-edit、可跨机 |
| DR-CB-B | bundle 含不含密钥 | **恒不含**；导入时用户手填（`keys` 参数） | 每人 token 不同；导入别人的 key 是负资产（误用他人配额/泄漏他人凭证） |
| DR-CB-C | merge 撞名不覆盖 | conflict 上报（承接 v1） | 个人手配被静默冲掉是本受众最恶性事故 |
| DR-CB-D | 原子性 | 按实体原子 + 依赖级联（承接 v1） | 全回滚太脆、裸写留半截，回执如实即真相 |
| DR-CB-E | 待填密钥的呈现 | 导入预览内联粘贴框（新建+已存在无 active key 都算）+ 回执清单 + 渠道琥珀徽章 | 「快速」是硬要求：密钥要填在最发生的地方；徽章判据收窄防误报（冷却/禁用不算待填） |
| DR-CB-F | 范围 | 只 channels+singles+autos；vkeys/settings/replace 全撤 | 用户裁决「只需要快速导入这三类」；砍明文导出连带砍掉整层 isLocalish 安全面 |
| DR-CB-G | bundle 版本演进 | kind 恒精确匹配；version **只接受 ≤ 已知集合**，大于 → 400 且文案「该 bundle 由更新版本 own-api 导出，请升级后重试」、零落盘；同 version 内新增**可选**字段不升版（读取端白名单忽略未知字段 + 回执 warnings 回显，天然前向兼容）；破坏性变更（改义/必填化/重排）才升 version，单调递增 | 旧端无法安全解释新版语义，拒绝优于猜测；bundle 是低频 hand-edit 文件，静默丢字段必须回显 |
| DR-CB-H | 导入过程网络行为 | **dryRun 与提交全程零外呼**：不 fetch、不解析 DNS、不自动连通测试；连通测试仅既有「测试连通」按钮由用户显式触发 | bundle 的 baseUrl 是不可信输入，任何隐式外呼 = 本机对任意第三方 URL 发请求；与内联密钥框（DR-CB-E）叠加等于把用户 token 送进恶意 bundle 指向的端点 |
| DR-CB-I | 同名渠道解析 | ≥2 同名 → 该 name 全链 conflict，绝不取第一个 | 渠道名现状不唯一（store 不查重）；静默择一是「取错端点+灌错 token」复合事故 |
| DR-CB-J | keys×conflict | conflict 渠道的 keys 不消费 + warning | 用户裁决评审分歧后取保守案：宁可漏灌（渠道页可补），不可把 token 发给配置漂移的端点 |
| DR-CB-K | 导出密钥启发式 | 出包字符串跑 key 形态正则，命中确认框标黄不阻断 | 用户拍板；自由文本藏 key 是真实模式，哨兵拦不住 |
| DR-CB-L | 字段域 | 渠道补 enabled/timeoutMs，「一致」= 全字段域归一后比较 | 用户拍板；往返等价钉字面成立 |

## 10. 实现后同步面（实现 PR 的 checklist）

- [x] 状态行已翻（e2e §19-21 / hardening DOM 钉）
- [x] README 能力表已加行并链本文；目录补 src/config-bundle.ts
- [x] CHANGELOG Unreleased 节已补（含 speed 合并条目）
- [x] 自测计数已更新（211+141）
- [x] gen:web 已同步，WEB_HTML 同步钉绿
- [ ] model-auto-design.md §4.1 ①-b「硬过滤」措辞订正（留给 model-auto 侧下一轮，非本 PR 阻塞项）
