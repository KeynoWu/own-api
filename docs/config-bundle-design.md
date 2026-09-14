# 渠道与路由快速导入（Config Bundle）— 设计 v2（方案，未实现）

> 状态：**方案评审中**（2026-09-14；v2 按受众裁决**大幅裁剪范围**）。
> 受众定位：员工本机各跑一个桌面实例，公司发 N 个模型端点 + 每人自己的 token。
> v1→v2 的关键修正：**bundle 里没有密钥，密钥由用户导入时/导入后手动填入**——
> 每个人的 token 不一样，导出来自别人 bundle 的 key 是有害无益的。
> 由此撤销 v1 的明文导出、isLocalish 明文闸、replace 恢复、vkeys/settings 子集（全部转非目标）。

---

## 1. 范围（就这三类东西）

| 内容 | 进 bundle | 说明 |
| --- | --- | --- |
| 渠道 | ✅（**不含密钥**） | name / baseUrl / protocol / authStyle / extraHeaders / testModel / modelList / note |
| 单模型路由 | ✅ | publicName / channelName 引用 / upstreamModel / protocol / contextWindow / maxOutputTokens / supportsStreaming / supportsTools / 价格 / tags |
| 自动路由 | ✅ | publicName / stickyTtlMs / candidates（按候选 publicName 引用 + weight） |
| 渠道密钥 | ❌ | **用户手动填**（§4） |
| vkeys / settings / 日志 / 额度 / 运行时态 | ❌ | 非目标（§7） |

**典型流程**：先行同事配好一切 → 导出 `bundle.json` 发到群里（无密钥，随便传）→
同事导入 → 预览回执 → 给自己新建的渠道粘上**自己的** token → 连通测试 → 完事。

## 2. 格式

```jsonc
{
  "kind": "own-api-config-bundle",
  "version": 1,
  "exportedAt": "2026-09-14T…Z",
  "channels": [{
    "name": "公司-DeepSeek",              // ← 幂等锚点与引用锚点
    "baseUrl": "https://…/v1",
    "protocol": "openai",                 // openai | anthropic
    "authStyle": "bearer", "extraHeaders": {}, "testModel": "deepseek-chat",
    "modelList": ["deepseek-chat", "…"],  // 可选，导入后可点「连通测试」重新拉取
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
      "candidates": [{ "publicName": "deepseek-chat", "weight": 10 }]   // 按名引用
    }]
  }
}
```

**ADR（承接 v1，不变）：跨实例引用一律按名、不按 id**——`channelId`/`AutoCandidate.routeId` 在 bundle
里是 `channelName`/候选 `publicName`，导入端两级解析（已存在实体 → 本包新建实体）。bundle 因此可跨机、可 hand-edit。

**schema 里没有 key 字段**；导入遇到 bundle 里出现任何 key 形态字段（`keys`、`api_key`…）→
忽略 + warning「每人密钥不同，bundle 中的密钥字段已忽略，请导入后手动填入」。宁可不导入密钥，
也不让员工手里躺着别人的 token（决策 DR-B）。

## 3. 导出

`GET /api/config/export` —— 无参数、无选项、不导密钥，bundle 天然是**低敏文件**（渠道地址+模型配置），
可以直接发群。导出恒含全部渠道+路由（v1 不做选择性导出勾选）。

管理台「模型路由」或「渠道」页顶部一个「导出配置」按钮即可，落盘 `own-api-config-YYYYMMDD.json`。

## 4. 导入与「手动填密钥」闭环（本设计的正主）

`POST /api/config/import`，body `{ bundle, keys?: Record<string, string[]>, dryRun?: true }`。
`keys` = 渠道名 → 本次要追加的密钥数组（用户手填，**只存在于这一次请求**，不落 bundle、不回显）。

### 4.1 两步 UI 流程（快速是硬要求）

1. **选/粘 bundle** → 自动 `dryRun` 预览：回执卡（将创建/合并/冲突逐条）+ **每个新渠道一个密钥粘贴框**
   （一行一个，复用现有渠道页的 key 粘贴交互）。密钥可现在填，也可以留空——不阻塞导入。
2. **确认导入** → 落盘 + 回执；对**密钥仍为空**的渠道，回执尾部给出「待填密钥」清单（可点击直达该渠道的密钥输入）。

导入后渠道列表给无可用 key 的渠道挂「**待填密钥**」红徽章，直到有 active key 为止。
网关侧零新语义：无可用 key 的渠道命中现有 ①-b 硬过滤 / 502 文案，行为不变。

### 4.2 merge 幂等（锚点 = name）

| 实体 | 已存在且配置一致 | 已存在但配置不同 |
| --- | --- | --- |
| 渠道（按 name） | 合并 keys（`keys` 参数里的走 `addKeys` 既有去重；bundle 字段不覆盖） | `conflict`，不动（同名不同 baseUrl = 环境漂移，人来裁决） |
| 单模型路由（按 publicName） | skipped | `conflict`，**不覆盖** |
| auto（按 publicName） | 候选按 publicName 合并 weight | `conflict`；候选引用不到模型 → warning + 跳过该候选（悬空同 C8） |

唯一性复用 `routeNameTaken`（W7 双向）；字段清洗复用 `UPDATABLE_*` 白名单与 createModel 数字闸
（NaN/负数 → 该实体 conflict 条目，不炸整包）。**不新写一套校验。**

### 4.3 原子性：按实体原子 + 依赖级联（承接 v1 DR-D）

每个实体独立成功/失败，回执如实（created/merged/skipped/conflicts/warnings）；重跑幂等补齐。
渠道创建失败 → 其下模型级联 conflict，不制造悬空渠道。

### 4.4 导入顺序

渠道（建 name→id 映射，含 `keys` 参数落 key）→ 单模型路由 → auto 路由（候选此时才可解析）。
畸形 bundle（kind/version 不符/渠道缺 baseUrl/模型缺 publicName/candidates 越界）→ 400 逐条原因、**零落盘**。

## 5. 回执

```jsonc
{ "dryRun": false,
  "channels": { "created": 3, "merged": 1, "conflicts": [{ "name": "x", "reason": "baseUrl 不同" }],
                "keysAdded": 2 },
  "routes":   { "created": 8, "skipped": 2, "conflicts": [],
                "warnings": [{ "publicName": "model_auto", "reason": "候选 gpt-4o 不存在，已跳过" }] },
  "pendingKeyChannels": ["公司-DeepSeek", "公司-GLM"]   // 无 active key 的渠道（新建+已存在都算）
}
```

## 6. 安全边界

1. bundle 无密钥 = 低敏，可发群、可进内网 wiki；仍含内部端点地址，文档提示"内部分享为宜"。
2. 密钥只经两条路进系统：既有渠道页添加 key、本次导入的 `keys` 参数（admin 令牌 + 限速不变；
   写入仍走 addKeys 去重与 `db.json` 0600 落盘）。
3. 导入是配置写面：不触碰 `settings`、vkeys、网关鉴权语义。
4. bundle body 走全局 `maxBodyBytes` 与 JSON 形状守卫（对齐 store.load「损坏不崩」）。

## 7. 非目标（v2 收缩后的完整清单）

- **导出密钥**（含明文导出、isLocalish 明文闸）——v1 设计整体撤销：受众模型里密钥人人不同，无导出场景。
- vkeys / settings 子集进 bundle。
- replace / 恢复备份模式——个人全量备份就是拷 `~/.own-api/db.json`，bundle 不承担该职责。
- 在线同步（URL 拉取）、选择性导出勾选、bundle diff 可视化。
- 冲突自动合并（三方 diff / last-write-wins）——一律 conflict 上报。
- 导入后自动跑连通测试（网络行为不做隐式，用户手点；待填徽章已给出指引）。

## 8. 测试钉（实现时固化进 test/e2e.ts）

| 场景 | 断言 |
| --- | --- |
| 往返等价 | 导出→清库→导入→再导出，语义相等；导出体**不含**任何 key 子串（已知 key 哨兵，先例同 auto key 泄漏哨兵） |
| 密钥闭环 | bundle 不带 key + `keys` 参数带 key → 渠道有可用 key；不带 → `pendingKeyChannels` 列出、渠道徽章可见、走该渠道请求得 502 现有文案 |
| 忽略外来 key | bundle 里塞 `keys` 字段 → warning + 不写入 |
| merge 幂等 | 同 bundle 两遍：第二遍全 skipped/merged，零 created；`keys` 参数重复值被 addKeys 去重 |
| 撞名不覆盖 | 同名不同 baseUrl 的渠道 / 同 publicName 不同 upstreamModel 的路由 → conflict，现有配置逐字段不变 |
| 悬空候选 | 引用不存在的候选名 → warning + 该候选跳过，auto 其余候选正常 |
| dryRun | 回执完整 + db.json 字节级不变 |
| 畸形输入 | version:2 / 渠道缺 baseUrl / 价格 "abc" / candidates 越界 → 400 或逐条 conflict，零落盘 |

## 9. 决策记录

| 编号 | 争点 | 裁决 | 理由 |
|---|---|---|---|
| DR-A | 跨实例引用 id vs 名 | **名**（承接 v1） | id 本机随机；bundle 要可 hand-edit、可跨机 |
| DR-B | bundle 含不含密钥 | **恒不含**；导入时用户手填（`keys` 参数） | 受众裁决：每人 token 不同；导入别人的 key 是负资产（误用他人配额/泄漏他人凭证） |
| DR-C | merge 撞名不覆盖 | conflict 上报（承接 v1） | 个人手配被静默冲掉是本受众最恶性事故 |
| DR-D | 原子性 | 按实体原子 + 依赖级联（承接 v1） | 全回滚太脆、裸写留半截，回执如实即真相 |
| DR-E | 待填密钥的呈现 | 导入预览内联粘贴框 + 回执清单 + 渠道红徽章 | 「快速」是硬要求：密钥要填在最发生的地方，不能让用户自己去渠道页逐个找 |
| DR-F | 范围 | 只 channels+singles+autos；vkeys/settings/replace 全撤 | 用户裁决「只需要快速导入这三类」；砍掉明文导出连带砍掉整层 isLocalish 安全面 |
