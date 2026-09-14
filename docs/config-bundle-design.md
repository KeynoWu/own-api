# 配置整包导入/导出（Config Bundle）— 设计 v1（方案，未实现）

> 状态：**方案评审中**（2026-09-14，受众定位讨论产出）。
> 解决这个受众传播链上的第一道门槛：公司发了 N 个模型端点（各有 baseURL+key），
> 员工现在要在管理台一个个填渠道 → 选协议 → 粘 key → 再建模型路由。一行命令/一次导入应该搞定。

---

## 1. 场景与目标

| 场景 | 诉求 | 本设计覆盖 |
| --- | --- | --- |
| A 团队分发 | 先行同事/IT 配好 N 渠道+模型+auto 权重，导出一个文件，同事导入即用 | ✅ |
| B 个人备份/迁移 | 换机器重装，把配置干净地搬走（现在只能整份拷 db.json，连日志额度一起） | ✅ |
| C 环境间同步 | 公司机 ↔ 家里机 | ✅（导出→导入即同步） |
| D 在线同步/URL 自动拉取 | IT 发个链接自动更新 | ❌ 非目标（§8） |

**目标**：一个自描述 JSON 文件承载 `channels + routes(单模型/auto) + 可选 vkeys + 可选设置子集`；
导出默认脱敏、导入按名幂等 merge、全程有回执（沿用 import-models 的 created/skipped 回执风格）。

## 2. 格式

```jsonc
{
  "kind": "own-api-config-bundle",
  "version": 1,                    // 不认识的 version → 400 拒绝，不猜语义
  "exportedAt": "2026-09-14T…Z",
  "options": { "keys": true, "vkeys": false, "settings": true },   // 导出时选了什么，供导入端警示
  "channels": [{
    "name": "公司-DeepSeek",       // ← 跨实例引用的锚点
    "baseUrl": "https://…/v1",
    "protocol": "openai",
    "enabled": true,
    "authStyle": "bearer", "extraHeaders": {}, "timeoutMs": null, "note": "",
    "testModel": "deepseek-chat", "modelList": ["deepseek-chat", "…"],
    "keys": [{ "name": "k1", "weight": 10, "key": "sk-…" }]   // keys=0 时为 "sk-…***" 掩码串
  }],
  "routes": {
    "singles": [{
      "publicName": "deepseek-chat",            // ← 锚点（全局唯一，W7）
      "channelName": "公司-DeepSeek",           // ← 引用渠道按 name，不带 id
      "upstreamModel": "deepseek-chat", "protocol": null, "enabled": true,
      "contextWindow": 131072, "maxOutputTokens": 8192,
      "supportsStreaming": true, "supportsTools": true,
      "priceInput": 0.27, "priceOutput": 1.1, "priceCacheRead": null, "priceCacheWrite": null,
      "tags": [], "note": ""
    }],
    "autos": [{
      "publicName": "model_auto", "enabled": true, "stickyTtlMs": 300000, "note": "",
      "candidates": [{ "publicName": "deepseek-chat", "weight": 10 }]   // 候选也按 publicName 引用
    }]
  },
  "vkeys": [{ "name": "claude-code", "enabled": true, "allowedModels": ["claude-sonnet"],
              "rpmLimit": 30, "dailyTokenLimit": 0, "note": "" }],   // options.vkeys=1 时；不含 key 值
  "settings": {                                   // 可选子集（adminToken/maxBodyBytes 永不导出）
    "defaultUpstreamTimeoutMs": 300000, "upstreamIdleTimeoutMs": 120000,
    "maxKeyRetries": 3, "errorThreshold": 3,
    "cooldownBaseMs": 300000, "cooldownMaxMs": 3600000,
    "logRetention": 2000, "autoMaxChainSeconds": 300,
    "debugHeaders": false,
    "fallbackChannelName": "公司-兜底"            // ← fallbackChannelId 导出为渠道名，导入反解
  }
}
```

**ADR：跨实例引用一律按名字，不按 id。** `AutoCandidate.routeId`、`ModelRoute.channelId`、
`Settings.fallbackChannelId` 在 bundle 里分别转成候选 `publicName`、`channelName`、`fallbackChannelName`；
导入端按「已存在实体 → bundle 新建实体」两级解析回 id。理由：id 是本机 `newId` 生成的随机值，跨实例无意义；
按名引用同时让 bundle 可 hand-edit，正是团队分发的常见动作。

**永不导出**：`logs`、`quotas`、健康分/粘性（运行时态，同 C0/C15 边界）、`settings.adminToken`、
`vkeys[].key`（对外密钥值是本机生成资产；导出只带配置与限额，导入只补缺）。

## 3. 导出

`GET /api/config/export?keys=0|1&vkeys=0|1&settings=0|1`（默认全部安全侧）。

- **`keys=1`（明文上游 key）与 `?reveal=1` 同闸：仅 `isLocalish` 放行**——LAN 持令牌者不得收割明文
  （对齐 reveal 明文回环闸与"写响应同闸"的既有修复）。桌面场景是员工本机导出，不受影响。
- `keys=0` 时 key 字段输出掩码占位；导入端遇掩码串一律拒绝写入（`sk-…***` 形态识别）并回执 warning——
  **半脱敏 bundle 只会制造"导入成功但打不通上游"的诡异现场，必须 fail-fast**。
- UI：设置页顶部「导出配置」→ 弹窗勾选三个选项；勾选"含明文 key"出现一次性警示
  （"等同 db.json 机密级别，请勿发到公开群"）。文件名默认 `own-api-config-YYYYMMDD.json`。
- 响应 `Content-Disposition: attachment`，方便浏览器直接落盘。

## 4. 导入

`POST /api/config/import`，body `{ bundle, mode: "merge" | "replace", dryRun?: true, confirm?: "replace" }`。

### 4.1 幂等锚点与 merge 语义（默认模式）

| 实体 | 锚点 | 已存在且配置一致 | 已存在但配置不同 |
| --- | --- | --- | --- |
| 渠道 | `name` | 合并 keys（按 key 全值去重，复用 addKeys 既有去重），非 key 字段**不覆盖** | `conflict`：不覆盖、不新建（同名不同 baseUrl = 环境漂移，交给用户裁决） |
| 单模型路由 | `publicName` | skipped | `conflict`：不覆盖（个人手配不被静默冲掉） |
| auto 路由 | `publicName` | 候选按 publicName 逐个合并 weight | `conflict`；候选引用不到模型 → warning + 跳过该候选（悬空引用同 C8 精神） |
| vkey | `name` | 仅补 `allowedModels`/限额中的缺失项？——**不，v1 整条 skipped**；不同则 conflict | 同左 |
| settings | 字段级 | 相同跳过 | 覆盖前过 `sanitizeSettings`（NUM_BOUNDS/白名单原样复用）；`fallbackChannelName` 解析不到 → warning 并保留现状 |

- 唯一性校验全部复用 `routeNameTaken`（W7：publicName × tags × auto 名双向互斥）；撞名走 skipped/conflict，
  绝不进 createModel 抛错面。
- 字段清洗复用既有白名单：`UPDATABLE_CHANNEL_FIELDS` / createModel 契约（数字字段 NaN/负数 → 该实体 400 级错误条目）/
  `sanitizeExtraHeaders`。**不新写一套校验**。

### 4.2 原子性粒度：按实体原子，整包尽力而为

单事务"一处冲突全部回滚"会让 1 个撞名卡死 50 个渠道，太脆；完全不管又可能留半截配置。裁决：
**每个实体独立成功/失败**，回执如实列 created / merged / skipped / conflicts / warnings；
导入幂等，重跑补齐。渠道创建失败 → 其下模型自动级联为 conflict（依赖失败不制造悬空渠道）。
dryRun 走完整校验链、零落盘，回执结构完全相同——"预览 → 确认"闭环。

### 4.3 replace 模式（场景 B 恢复备份）

- 要求 `confirm: "replace"`，否则 400。
- 语义：按现有 `deleteChannel`/`deleteModel`/auto 删除的既有引用保护逐个清空，再按 4.1 全量创建；
  bundle 未含 vkeys 时**保留**现有 vkeys（密钥是本机资产，备份恢复不该清掉钥匙）。
- 回执含 `deleted: { channels, routes }`；删除期在途请求不受影响（内存态即时生效，同现有 DELETE 行为）。
- UI 二次确认，明确列出将被删除的渠道/模型计数。

### 4.4 导入顺序

渠道 → 建 `name→id` 映射 → 单模型路由 → auto 路由（候选此时才可解析）→ vkeys → settings（最后，
依赖渠道名解析）。顺序失败不级联阻断无关实体。

## 5. 回执

```jsonc
{ "dryRun": false, "mode": "merge",
  "channels": { "created": 3, "merged": 1, "skipped": 0, "conflicts": [{ "name": "x", "reason": "baseUrl 不同" }] },
  "routes":   { "created": 8, "skipped": 2, "conflicts": [], "warnings": [{ "publicName": "model_auto", "reason": "候选 gpt-4o 不存在，已跳过" }] },
  "vkeys":    { "created": 0, "skipped": 2, "conflicts": [] },
  "settings": { "applied": ["autoMaxChainSeconds"], "warnings": [{ "field": "fallbackChannelName", "reason": "渠道不存在，保留现状" }] } }
```

畸形 bundle（非对象/缺 kind/version 不符/渠道缺 baseUrl/模型缺 publicName/auto 候选为空数组越界）
→ 400 附逐条原因，**不落任何实体**；单实体级脏数据（价格 NaN、weight 字符串）→ 该实体进 conflicts，不炸整包。

## 6. 安全边界

1. 含明文 key 的 bundle ≡ db.json 机密等级（README「注意」同口径）；文档与 UI 双重提示，不落公开仓库。
2. 明文导出 `isLocalish` 闸（§3）；导入无明文暴露面，维持 admin 令牌 + 鉴权失败限速不变。
3. bundle body 走全局 `maxBodyBytes`（默认 64MB）与 JSON 形状守卫（对齐 store.load 的"损坏不崩"精神）。
4. 导入是**配置写面**，不触碰网关鉴权语义：不会创建/改动 `settings.adminToken`，不会解除 vkey 限额
   （allowedModels 空数组=全允许 是既有语义，bundle 照原样带，由用户自己负责）。

## 7. 测试钉（实现时固化进 test/e2e.ts + hardening）

| 场景 | 断言 |
| --- | --- |
| 往返等价 | 导出→清库→导入→再导出，两份 bundle 语义相等（渠道/模型/auto 候选权重/设置子集全等） |
| merge 幂等 | 同一 bundle 导两遍：第二遍全 skipped/merged，零 created |
| 撞名不覆盖 | 同名不同配置的渠道/模型进 conflicts，现有配置逐字段不变 |
| 悬空候选 | 引用不存在的候选名 → warning + 该候选跳过，auto 其余候选正常 |
| 脱敏哨兵 | keys=0 导出体不含任何真实 key 子串（对 mock 上游的已知 key 做全量哨兵，同 key 泄漏哨兵先例）；掩码串导入被拒 |
| 明文闸 | 非 isLocalish 来源 `keys=1` 被拒/降级（与 reveal 行为一致） |
| dryRun | 回执完整 + db.json 字节级不变 |
| replace | 缺 confirm → 400；正常执行后 vkeys 保留、被删计数准确 |
| 畸形输入 | version:2 / 渠道缺 baseUrl / 价格 "abc" / auto 越界候选数 → 400 或逐条 conflict，零落盘 |

## 8. 非目标

- 在线同步：`importFromUrl` / IT 托管 bundle 自动拉取（安全面大：远程可推明文与限额变更；留待真实需求）。
- 选择性导入 UI（勾选渠道）、bundle diff 可视化（回执文本已支撑决策）。
- 导出含日志/额度/健康分/粘性。
- 跨实例 id 保持（锚点全部按名，见 ADR）。
- 冲突自动合并策略（三方 diff、last-write-wins）——v1 一律 conflict 上报，人是最终裁决。

## 9. 决策记录

| 编号 | 争点 | 裁决 | 理由 |
|---|---|---|---|
| DR-A | 跨实例引用用 id 还是名 | **名** | id 本机随机；bundle 要可 hand-edit、可跨机 |
| DR-B | 明文 key 导出 | 默认脱敏；`keys=1` 仅 isLocalish | 对齐 reveal 回环闸与写响应同闸的既有修复 |
| DR-C | merge 撞名 | 不覆盖，conflict 上报 | 个人手配被静默冲掉是本受众最恶性的事故 |
| DR-D | 原子性 | 按实体原子 + 依赖级联 conflict | 全回滚太脆、裸写留半截，回执如实即真相 |
| DR-E | vkey 进 bundle | 配置可带（默认关）、密钥值永不带、replace 不清 vkeys | 对外 key 是本机资产，团队分发也不该共享同一密钥值 |
| DR-F | 掩码 key 导入 | fail-fast 拒写 | 半脱敏导入制造"成功但打不通"的诡异现场 |
| DR-G | replace 保留 vkeys | 保留 | 备份恢复不该弄丢钥匙 |
