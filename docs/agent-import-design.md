# Agent 一键接入（Agent Import）— 设计 v1

> 状态：**PR1 已实现**（基建 + JSON 原语 + ZCode 适配器）、**PR2 部分实现**（`yaml` 引擎 + **omp** 适配器 + sync 闭环
> + **Claude Code** 适配器 + **dsh** 适配器）；钉编号见 §11.1 / §11.2 / §11.3 / §11.4 / §11.5。
> P0 四个适配器只剩 opencode（属 P1，卡 §14-V3，且已明确暂缓）。
> 实机验证范围：ZCode 3.10.2 端到端跑通（§4.3）+ **omp v18.1.20 真二进制端到端跑通（§4.2）**；
> **dsh 的规格取自本机正在运行的那份实现（v0.1.5-rc.2）并在真机配置的沙盒副本上彩排过（§4.4）**——
> 但「dsh 进程是否真的热发布我们写的这份文件」这一条只在文档层核实，**未做真机写入实验**（§14-V11）；
> **Claude Code 已实现但零实机验证**（本机已卸载，§14-V7 仍开着）：字段形态取自本机残留配置的真实键集，
> **行为结论为零**——能用 ≠ 已验，交付与验收都按这条口径。
> 实机验证范围：ZCode 3.10.2 端到端跑通（§4.3）+ **omp v18.1.20 真二进制端到端跑通（§4.2）**；
> **Claude Code 已实现但零实机验证**（本机已卸载，§14-V7 仍开着）：字段形态取自本机残留配置的真实键集，
> **行为结论为零**——能用 ≠ 已验，交付与验收都按这条口径。
> 受众定位：本机跑一个 own-api 桌面实例 + 同时使用多个 coding agent 的个人开发者。
> 目标：网关配好对外 base_url + key 之后，**一条命令把它们落到目标 agent 的配置文件里**，
> 让 agent 立刻可选到网关登记的模型——免去用户手工在各 agent 里复制粘贴、改 JSON、猜字段名。
>
> **立论前提（与 cc-switch 的关系，必须先读）**
> cc-switch 这类工具写进 agent 的是**真实上游地址**，所以它必须持有 provider profile 库、做切换、
> failover 队列、健康检查、session history 归并、db 备份回滚（实测其 sqlite 有 11 张表、支持 8 个 app）。
> own-api 写进 agent 的**恒为 `http://127.0.0.1:<port>` + 一把对外 key**，真实上游永远留在网关侧。
> 推论：**在 own-api 的世界观里「切换 provider」这个动作不存在**——加渠道、换 key、模型降级全部在
> 网关内完成，agent 侧零改动。因此本功能替代的是 cc-switch 的**结果**（agent 里出现一个可用 provider），
> 不是它的**机制**（profile 切换器）；它最重的那一半功能在本设计里被架构消解，而非实现。
> 真正的持续需求换成了另一件事：**模型清单同步**（§2.2），这是 cc-switch 结构性做不到的——
> 它手上没有模型的语义信息，只能让用户手贴 catalog。
>
> **对外口径**：功能名「**一键接入 Agent**」。**不写「替代 cc-switch」**——一旦写替代，
> 用户会拿它的 app 全集 + MCP + prompts + skills 同步当 parity 清单来对（§7 非目标已逐条划界）。
>
> **引用约定**：本文决策编号 DR-AI-*（仅本文私有）；裸引 C*/W* 指 docs/model-auto-design.md §11；
> DR-CB-* 指 docs/config-bundle-design.md §9。代码引用一律 `文件#符号` 符号锚，行号仅辅助注记。
> **§14 是「真机待核实」清单**：本文所有关于第三方 agent 的字段结论均来自本机实测（macOS），
> 已核实/未核实逐条标注，不许把猜测当已确认。

---

## 1. 范围与分期

| 期 | 内容 | 判据 |
| --- | --- | --- |
| **P0** | 适配器基建（spec 契约 + 三原语 + 计划/应用/回读/探针流水线）+ 四个适配器：**zcode、Claude Code、omp、dsh** + 两段式 UI（预览 diff → 确认）+ **接入后探针** + 撤销 | zcode 已实机验收（§4.3）；Claude Code 只能「实现 + 钉覆盖 + 交付标注未实机验证」（§14-V7） |
| **P1** | **opencode** 适配器 + **模型清单同步**（catalog sync）+ **接入登记账本** + **漂移检测** + 已接入 Agent 管理页 | 同步与漂移是「接入一次长期有效」的必需闭环，但不阻塞首次接入 |
| 不在本文 | Codex CLI（`/v1/responses` 缺口，§7）、gemini / grokbuild / openclaw / hermes / claude-desktop / Cline | — |

分期不是排期承诺：P0 落地即可独立交付价值，P1 是把「一次性写入」升级为「长期有效」的必要工程。

**落地顺序（2026-09-15 本机实况调整后）**：Claude Code 已从本机卸载（§14-V7），不能再当首发验收对象。
**pilot 换成 zcode**——它同为 JSON 格式，能把基建全链（plan/apply/回读/探针/账本/撤销/DOM 钉）全跑通，
且已实机证明可验。于是拆两个 PR：**PR1 = 基建 + zcode 一个适配器（零新增依赖）**；
**PR2 = Claude Code + omp + dsh（引 `yaml`，DR-AI-F）**。理由：适配器契约要被第二、第三个适配器用过才知
对不对，但基建只需要一个适配器就能全验；同时把 YAML 这个唯一的新增依赖独立成一个 PR，出问题好归因。

## 2. 概念模型：两条半边 + 一本账

一个 agent 的「能用了」由两个正交部分组成，混在一起谈是本功能最常见的失败根源：

### 2.1 provider 半（几乎不变）
base_url + key 的落点。**实测共有三种落点形态**，这决定了适配器必须是声明式的（§3）：

| 形态 | 代表 | 事实来源 |
| --- | --- | --- |
| 内联在 provider 条目 | zcode `provider.<id>.options.apiKey`、omp `providers.<id>.apiKey` | 本机实测 |
| 环境变量块 | Claude Code `settings.json` 的 `env.ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | 本机实测 |
| **只存环境变量名，密钥另存** | dsh `providers.<id>.apiKeyEnv`（明文落 `~/.dsh/.credentials.yaml` 的 `refs.<ENV名>`，profile **没有**内联 apiKey 字段） | **已核实**：运行的 v0.1.5-rc.2 的 schema + 包内文档（§4.4、V1/V2 已关闭） |

### 2.2 catalog 半（随路由表变，本功能的正主）
**每一个 agent 都要求显式声明模型清单，否则模型选择器里根本不会出现该模型**（本机实测五例皆然）：
omp `models[]`、zcode `models.<名>`、dsh `models[]`、Claude Code 的 `ANTHROPIC_MODEL`/`_HAIKU_`/`_SONNET_`/`_OPUS_`、
（opencode `models`，§14-V3 待核实）。cc-switch 也得为 Codex 生成 `model_catalog_json`（本机存在该文件，93KB）。

**本设计的关键复用（DR-AI-C）**：catalog 不新造聚合逻辑，**它是 `GET /v1/models` 按该 vkey ACL 过滤后结果的
适配器投影**——`src/gateway.ts#listModels` 已经在做「enabled ∧ `allowedForKey`」过滤，且已经吐
`context_length` / `max_output_tokens` / `owned_by`。于是获得一个强不变式：

> **G1（选择器一致性）**：接入完成后，agent 模型选择器里出现的集合 ≡ 这把 key 有权调用的集合。
> 探针（§6.4 L1）与 catalog 出自同一个 `listModels` 调用，因此「选得到但调不通」在设计上不可表示。

### 2.3 接入登记（link，本机绑定态）
每次成功接入记一条 link：

```jsonc
{ "agentId": "claude-code",         // 适配器 id，一 agent 一条（同 agent 重复 apply = 更新）
  "vkeyId": "vk_...", "model": "model_auto", "roles": { "haiku": "glm-5.3-flash" },
  "providerId": "own-api",          // 写进对方文件的命名空间（撤销与漂移检测的锚点）
  "baseUrl": "http://127.0.0.1:8787",
  "fingerprint": "sha256:…",        // 托管块规范化指纹，漂移检测用（§6.5）
  "targets": ["~/.claude/settings.json"],
  "linkedAt": 0, "lastSyncAt": 0, "lastProbe": { "ok": true, "status": 200, "at": 0 } }
```

**存 `db.json`，不另起 agents.json（DR-AI-D）**：复用既有原子写 + `0600` + `store#flushSync`（store.ts#~348）
与「拷一个文件即全量备份」的既有语义；代价是 `DBShape.version` 3→4 加一次迁移（store.ts#load 迁移块）。
link 不含任何密钥明文（只存 vkeyId，密钥现取），因此不进 bundle、不进日志。

## 3. 适配器契约：数据不是代码

六个 agent ≠ 六份代码。适配器是一份声明，执行器只有三个原语。

```ts
// src/agent-import.ts（新增；网关主链路零依赖不变，见 DR-AI-F）
interface Adapter {
  id: string;                      // 'claude-code' | 'omp' | 'zcode' | 'dsh' | 'opencode'
  label: string;
  detect(): Target[];              // 存在性探测：文件/目录在不在，绝不全盘搜索
  targets: Target[];               // 每项一个「写点」：一个文件 + 一个内部路径
  roles: RoleSlot[];               // 需要哪些模型槽；required 决定 plan 是否可提交
  verify: string;                  // 「怎么确认真的生效」文案（重启？/model？）——不编造未验证的 UI 路径
  probe: 'openai' | 'anthropic';   // 探针打哪个协议端点（= 该 agent 实际使用的协议）
}
interface Target {
  file: string;                    // 由 homedir() + 常量派生，永不来自请求（§9-1）
  format: 'json' | 'yaml';
  op: 'upsert' | 'merge-env' | 'append-secret';
  path: string[];                  // 托管路径，如 ['provider','own-api'] / ['env']
  secret?: { inline?: string; envVar?: string };  // 密钥落点（三形态之一）
  writtenKeys: string[][];         // 我方负责声明的字段路径集合——漂移指纹只覆盖这些（§6.5，实测必需）
  eol?: 'preserve';                // 结尾换行按原文件保持（zcode 实测无尾换行，§4.3）
  managedByUs?: boolean;           // 撤销时是否删除托管块
}
```

三个原语（P0/P1 只需 JSON + YAML，**不需要 TOML**——TOML 只被 Codex 用到，Codex 不在范围）：

| 原语 | 实现约束 | 用在 |
| --- | --- | --- |
| `json-upsert` | `JSON.parse` → 只改托管子树 → 2 空格写回。**未知字段一个不碰**；解析失败（含带注释的 JSONC）→ **拒写**不猜 | Claude Code、zcode、opencode |
| `yaml-upsert` | **必须用保注释/保格式的 round-trip API**（`yaml` 包的 Document API），禁止 `load`+`stringify` 整文件重排 | omp、dsh |
| `secret-ref` | 需要第三方私有凭据格式时**不写**，改为如实报告「密钥未落盘」+ 给出 env 名与值的复制口（§6.3、§14-V1） | dsh |

**DR-AI-F（依赖裁决）**：引入 `yaml` 一个运行时依赖。本项目现状只有 `hono` + `@hono/node-server` 两个 dep，
自研 YAML 子集看似守住「零依赖」，实际是本项目最不该碰的雷区——锚点、块标量、tab、引号转义任一处出错，
后果是**毁掉用户 agent 的配置文件**，而这类 bug 在测试里偏偏容易全绿（测试样本永远是干净写的）。
`yaml` 的 Document API 正是为「改一个键、其余字节不动」设计的。约束：**依赖只进 `src/agent-import.ts`，
网关主链路（gateway/pool/translate/sse/usage/auto）保持零新增依赖**；SEA 打包走既有 esbuild 路径，体积增量可接受。

## 4. 四个 P0 适配器的实测规格

### 4.1 Claude Code — `~/.claude/settings.json`（JSON）　**〔已实现；行为仍未实机验证：本机已卸载，见 §14-V7〕**
```jsonc
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",  // anthropic 协议不追加 /v1（残留实测亦无）
           "ANTHROPIC_AUTH_TOKEN": "<vkey>",               // 不是 ANTHROPIC_API_KEY；网关 extractClientKey 认 Bearer
           "ANTHROPIC_MODEL": "<model>",
           "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<roles.haiku>" },
  "model": "<model>" }
```
- 键集来自**本机残留 settings.json 的实测**（`ANTHROPIC_AUTH_TOKEN` 而非 `API_KEY`、BASE_URL 不带 `/v1`、
  顶层 `model` 与 env 里的模型名同值），不是推测出来的命名风格。
  **行为仍未验**：env 与顶层 `model` 谁优先、新会话是否重读 env、`/status` 读的是哪一处 —— 全在 §14-V7。
- **两个写入点、同一个文件**：`env`（合并型：静态键 BASE_URL/AUTH_TOKEN + 角色键）与**文件根**
  （合并型：静态键 `model`）。为撑住这个形状，引擎扩了三处，见 §11.4——都是被 Claude 逼出来的。
- 顶层 `model` 只在接管了 `default` 槽时才写（挂在 `extra` 上跟着 roles.default 走），且真要改动时预览里
  单独一行黄字（`TargetSpec.warn` → `plan.warnings`）。这就是 §15-3 的落地答复：**写，但用人话讲清这动的是用户的默认模型**。
- 只 upsert 上述键。**该文件实测含 24 个 `enabledPlugins`、`extraKnownMarketplaces`、`statusLine` 里带嵌套转义的
  shell 命令**，整包重写 = 毁环境。AI-51 把这些邻居逐个钉住（连那句 shell 的引号都没动）。
  这是相对 cc-switch 的真实差异点：它对 Codex 是整段 TOML 全量替换（实测其 db 存 `config` 整串）。
- 角色槽 `default/haiku/sonnet/opus` → `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL`，写**裸模型名**
  （Claude 没有 provider 命名空间，不是 `own-api/xxx`）。`haiku` 属"不接管就出故障"级：不填时 Claude 拿自己的
  默认小模型名发过来 → 404「未登记模型」，现象看起来像网关坏了，故进 `requiredSlots`（UI 预勾、仍可取消），
  并且**不替用户猜便宜模型**（DR-AI-H）；接管了但等于主模型 → 换一条提示让你知道后台任务会烧贵的。
- **归属判据必须自带**（`Adapter.ownsKey`）：写裸值就没有 `own-api/` 前缀可判。返回三态而不是布尔——
  `true` 是我们的 / `false` 用户改走了（跳过该键并在回执点名）/ `'unknown'` 我查不了（key 已删，token 无从比对）。
  `unknown` 与 `false` 的区别是**账本必须留着**：那枚 token 还躺在别人文件里，账本一删它在 UI 上就隐身了（AI-56）。
- `catalogInFile: false`：这个文件里没有模型清单可投影。不关掉的话 `catalogIdsOf` 会把 env 的变量名当模型名，
  「模型清单待同步」永真（AI-58）。
- 撤销：逐键还原写前值（旧 provider 的 URL/token/模型名连同顶层 `model` 一起回去），没记到 prev 的键才删，
  用户改过的键跳过并点名（AI-54/AI-55）。
- **写路径已在沙盒里吃过真身残留文件**（`/tmp` 副本 + `applyLink`，**不是真身运行**）：24 个 `enabledPlugins`、
  `statusLine` 的转义 shell、`extraKnownMarketplaces` 全部逐字节不变，顶层键集合不变，未接管的
  `ANTHROPIC_DEFAULT_{SONNET,OPUS}_MODEL` 原样留着旧 provider 的值。**由该实验得知的已知副作用**：残留的
  `deepseek-v4-flash[1M]` 在 own-api 里根本没登记，用户 `/model` 切到 sonnet/opus 档会 404「未登记模型」——
  想一并接管就在向导里勾上那两个槽（默认不勾，理由同 DR-AI-I：不越权抢用户没要求的槽）。
- 生效：新开 Claude Code 会话（无需重装/登录）。`verify`: 会话内 `/status` 看 base_url，或 `/model` 看清单。
### 4.2 omp（oh-my-pi）— `~/.omp/agent/models.yml`（YAML）+ `~/.omp/agent/config.yml`（YAML）
```yaml
providers:
  own-api:
    baseUrl: http://127.0.0.1:8787/v1
    api: openai-completions
    apiKey: <vkey>                     # 内联
    models: [{ id: model_auto, name: model_auto, contextWindow: 256000, maxTokens: 8192 }]
```
**已实机验收（2026-09-15，`omp v18.1.20`，临时 HOME + 真二进制 + 真网关）**：形态取自真机 `~/.omp/agent/*.yml`
（5 个 provider 一律 `api: openai-completions` + baseUrl 带 `/v1` + `apiKey` 内联，无 env 引用）。
`HOME=/tmp/... omp -p` 走 `modelRoles.default → own-api/model_auto` 返回正常；网关日志侧同步出现
`200 in=219 out=64 model_auto`，两侧对上才算验收。

- **第二个写点是 `modelRoles`，且它是这件事的主菜**：只写 provider 段而角色仍指向原供应商的话，
  用户在 omp 里什么都看不见变化——「替换 cc-switch 的产物」在 omp 上就没发生。实现为**逐键合并写入点**
  （`merge`）：勾中哪个槽改哪个，未勾的一字不动（真机验证：9 个槽只改了勾选的 `default`/`smol`）。
  默认勾选见 §15-4。
- **撤销是逐键还原写前值，不是「只报告不改」**（本稿早期说法作废）：apply 前把被覆盖槽的原值记进账本
  `link.prev`（真机记到 `smol: jyld/glm-5.3-flash:auto` 这种带思考后缀的原值），撤销时逐键还原；
  当时本无此键的才删。安全闸同块型：**现值仍以 `own-api/` 打头才动手**，用户改指别处就 `kept` 且账本保留
  （钉 AI-32/32b/33）。
- **omp 是「礼貌的活写入者」，与 zcode 相反**：真机连跑两次启动循环，`models.yml` 与 `config.yml` **零改动**，
  我方块没被补字段、别人的 5 个 provider 也没被裁剪（对照 §4.3：zcode 启动即规范化我方块）。
  这条差异直接决定两件事：omp 的 `missing` 漂移是**真信号**（没有正常机制会动它），而 zcode 的 `missing` 才需要留一分疑心。
- 指纹域按字段声明（`baseUrl/api/apiKey` + `models[*].{id,name,contextWindow,maxTokens}`），块内被对方补字段不算漂移。
- 注意：`~/.omp/agent/config.yml.lock` 存在 → 文件锁纪律见 §9-6。anthropic 分支的 `api` 名与 `contextWindow`
  是否强制，均未实测（§14-V9/V10）。

### 4.3 zcode（GLM 官方 agent，实测 ZCode.app 3.10.2 / Electron 41）— `~/.zcode/v2/config.json`（JSON）
```jsonc
{ "provider": { "own-api": {
    "name": "own-api", "kind": "openai-compatible", "enabled": true, "source": "custom",
    "options": { "apiKey": "<vkey>", "baseURL": "http://127.0.0.1:8787/v1" },
    "models": { "model_auto": { "limit": { "context": 256000, "output": 128000 },
                                "modalities": { "input": ["text"], "output": ["text"] },
                                "zcode": { "modified": false, "priority": 200 } } } } } }
```
- **已实机验证（2026-09-15 本机）**：写入 `provider.own-api` 后启动 ZCode → 条目被**完整接受**，
  id / kind / options / apiKey / 五个模型（含 `model_auto`）全部保留，未要求 UUID、未被移入其它命名空间。
  用可读字符串 id 是官方自家做法：app 自带目录 `Contents/Resources/model-providers/*.json`
  （`schemaVersion: zcode.model-providers.v1`，10 个 provider）里 id 就是 `moonshot-kimi`、`deepseek`、`zai`。
  用户手添的条目用 UUID，但那只是 UI 生成习惯，**不是校验约束**（§14-V4 由此清零）。
- **`kind` 合法值是 `anthropic` | `openai-compatible`**（自家目录实测 124 anthropic / 38 openai-compatible）。
  **写 `"openai"` 无效**——本稿早期版本写错，已按实测订正；映射：openai 协议 → `openai-compatible`。
- **zcode 是活写入者，会规范化我们写的块**（实测启动即改，config.json 14115 字节落盘）：给
  `GLM-5.3-Flash` 补了 `reasoning:{enabled,variants,defaultVariant}`，并把我们保守写的
  `modalities.input:["text"]` **按它自家模型目录改回 `["text","image","video"]`**；同一趟还剪掉了某
  `builtin:` 条目里的 `GLM-5-Turbo`、改写了 4 个 `builtin:` 条目。三条推论都进了设计：
  ① 对 zcode **不投影 modalities / reasoning**（投了也被覆盖，白写且污染指纹）；
  ② §5 的 `supportsVision → zcode` 映射**划掉**；
  ③ 漂移指纹只覆盖**我方声明写入的字段子集**，不覆盖整块（§6.5，否则每次启动必误报「被改」）。
- 写法约束：2 空格缩进、`ensure_ascii:false`、**结尾无换行**（实测整文件 JSON round-trip 只差这 1 字节；
  不保持就会每次写入产生噪音，并让「幂等 = 字节相等」的钉假失败）。
- **baseURL 拼法随 `kind` 变，错一次就是首发 404（实测惯例）**：`openai-compatible` 的 baseURL **含 `/v1`**
  （本机三个自建条目一律 `…/v1`：`https://opencode.ai/zen/go/v1`、`https://api.stepfun.com/step_plan/v1`、
  `http://106.74.14.194:…/v1`；我们写的 `http://127.0.0.1:8787/v1` 与之同构。双拼 `/v1/v1/chat/completions`
  在网关实测 404，是这一类配错的标准失败签名）；`anthropic` 的 baseURL **不带路径后缀**（内置条目形态
  `https://api.z.ai/api/anthropic`）。→ **适配器必须按路由的有效协议分别构造 baseURL**，
  不能一把 baseURL 通吃（同一条规则也适用于 omp/dsh 的 `baseUrl`，各自惯例另行核实）。
- 撤销：删 `provider.own-api` 整个子树，且仅当 `options.baseURL` 仍指向本网关时才删（防误删用户自建同名条目）。
- 权限现实：该文件现状 `0644`（zcode 自己的 key 也在里面）。**保持原权限，不擅自 chmod 别人的文件**（§9-5）。
- **端到端已实机跑通（2026-09-15，用户在本机 ZCode GUI 选用 `own-api/model_auto` 发起，返回正常）**；
  同日 14:40 该条目被**本机所有者手动删除**以便重做一次全新写入验证（曾被误判成 ZCode 自行裁剪，见 §14-V8 的教训）。
  驻留性没有反证，但也没做过长周期观察——**不声称「写入即永久驻留」**，只声称「写入即被接受、可对话」。
  若日后条目真的凭空消失，「已接入」页的 `missing` 态会当场显红字，而不是让用户以为配好了。
  注意验证边界：启动本身不发请求（只持久化配置，zcode 日志零命中我们的 baseURL），
  必须真发一次才算通——所以 apply 之后的「L1/L2 探针 + 请你在 agent 侧点一次」两步都不能省（§6.4、DR-AI-G）。

### 4.4 dsh — `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml`（YAML）**已核实并实现**

> 规格来源不是猜测：本机**正在运行**的那份实现（`@deepseek-ai/dsh` shim → profile 插件栈，
> `@deepseek-ai/dsh-llm-pi-ai` / `-settings-file` / `-credentials-local`，均 **v0.1.5-rc.2**）的包内
> 文档 + 其 zod schema 与解析代码，以及真机 `~/.dsh/` 两份文件的只读比对。
> 先前 §4.4 那份「partial、密钥不落盘」的方案作废——它建立在两个错误假设上（见 V1/V2 关闭记录）。

三个写入点（一个适配器三种形状，`build()` 用 `blockKeys` 切分，见 §13.5）：

| # | 文件 | 路径 | 型 | 我们托管的键 | 撤销 |
|---|---|---|---|---|---|
| 1 | `settings.yaml` | `llm-pi-ai.providers.own-api` | **块** | displayName / api / baseURL / apiKeyEnv / models[] | 整块摘除 |
| 2 | `.credentials.yaml` | `refs` | 合并 | `OWN_API_API_KEY`（唯一格） | 还原写前值，无写前值才删 |
| 3 | `settings.yaml` | `agent-default-model` | 合并（承接 `default` 槽） | `provider`(恒 own-api) + `model`(裸模型名) | 逐键还原 |

核实结论（每条都有出处，别再当 folklore）：

| 断言 | 出处 |
|---|---|
| profile **没有**内联 `apiKey` 字段；白名单是 apiKeyEnv/displayName/api/baseURL/models/modelOverrides/compat/default*/headers/reasoning/thinkingBudgets/cacheRetention/transport/*TimeoutMs/retryPolicy | `dsh-llm-pi-ai` README + `lib/index.js` zod schema |
| `apiKeyEnv` 是「按请求解析的凭据引用」；**配了引用却解析不到值 → `MISSING_CREDENTIAL` 明确失败**，不放行去用环境里恰好有的无关密钥 | 同上（`namesCredential`、`credential-ref` role） |
| `apiKeyEnv` **优先于**已存凭据记录（`records.llm-pi-ai/<providerId>`），所以我们的写入是确定生效的，不会被一条陈旧记录压住 | `credentialStoreFrom(ctx).read` → `readRecord(credentialKey("llm-pi-ai", id))` |
| 凭据文档是 `{version: 1, refs: {<ENV名>: 值}, records: {<owner>/<id>: …}}`；`records` 属其它插件 | 真机文件 + `dsh-credentials-local` README |
| **外部编辑被明确支持**：两个文件都有 watcher（`watch: true`，settings 侧 debounce 100ms），热发布 | 两个插件的 `watch` 配置项 |
| dsh 自己写 settings 是「持 `<file>.lock` 跨进程锁的读-改-写，保留注释与未加载插件的 namespace」→ 它是**礼貌的活写入者**，漂移对我们是真信号 | `dsh-settings-file` README「每次写入都是一次读-改-写」 |
| 代价：非法文档 / 未知顶层键 → **启动失败**；凭据库被其它用户可读 → **拒绝加载**（提示 chmod 600）。所以我们只写声明路径、且**必须保住 0600** | 两个 README 的校验段 + `AI-64` 钉 |
| `models[]` 条目除 `id` 外**全部可选**（`contextWindow`/`maxTokens`/`input`/`reasoningEfforts`/`compat`），且有 profile 级 `defaultContextWindow` 兜底 → 我们**只在路由真登记了才写数字**，不拿 128k 冒充 | `modelFields` schema（只有 id `.required()`） |
| 凭据解析四层：继承进程环境 > `refs` 文件 > `<cwd>/.env` > `~/.dsh/.env` | `dsh-credentials-local` 优先级表 |

**生效路径与别人不同**：claude/zcode/omp 都要「开新会话」，dsh 因为有 watcher，**写完不用重启**（verify 文案照此写）。

非目标（明确不做）：
- 不碰 `records`（那是别的插件的授权，含 grant payload）；除我们那一格外不碰 `refs` 任何键；不碰 `version`。
- 不接管 `subagent-model-selection.allowedModels`——那是**清单**（list merge 是另一种原语，P2）。
- `DSH_HOME` 指向别处 → **拒写**（往错位置写 dsh 配置比不写糟得多）；`preflight` 报错。
- `.credentials.yaml` 不存在 → **拒写**：那是 dsh 自己的版本化文档，我们只加一格 refs，不替它发明格式。

真机彩排（沙盒里跑真文件的**副本**，`AI-0b` 哨兵确认真 `~/.dsh` 两份 mtime 全程未动）：
用户自己手写过 `providers.own-api`（同端口 8787）→ 判为「我们的形态」走 **update**；指针那格真机已指着
`own-api/model_auto` → **noop**。撤销后逐字段深比较：`.credentials.yaml` **语义零差异**；
`settings.yaml` 只剩一处差异——用户手写的那块 provider（含他手写的 `defaultInput` 与 5 个模型各自的
`input`/`maxTokens`）被我们的投影整块替换、撤销不还原（块型语义，原文在 `.bak`）。为此加了通用告警
**AI-67e**：整块覆盖前点名「这些不托管字段会消失」。


### 4.5 opencode（P1）— `~/.config/opencode/opencode.json`
形态与 zcode 同构（`provider.<id>.options.{baseURL,apiKey}` + `options.apiKey`，`npm` 字段选 SDK 包名）。
本机未安装，字段域只对着官方 providers 文档核过一半 → **§14-V3 核实后才开工**。

## 5. 字段映射表（本功能的核心资产）

网关路由字段是唯一真源；左列存在即投影，右列缺该键就整体省略（不写 null）。

| `ModelRoute` / `AutoRoute`（types.ts） | omp | zcode | dsh | Claude Code | 说明 |
| --- | --- | --- | --- | --- | --- |
| `publicName` | `models[].id/name` | `models.<名>` 键 | `models[].id/name` | `ANTHROPIC_MODEL` | 对外名，唯一对 agent 暴露的标识 |
| `contextWindow` | `contextWindow` | `limit.context` | `contextWindow` | —（无字段） | 缺省时省略键，不写猜测值 |
| `maxOutputTokens` | `maxTokens` | `limit.output` | `maxTokens` | — | 同上 |
| `supportsVision` | `input:[text(,image)]` | **—（实测会被它自家目录覆盖，不投影）** | `input[]` | — | **三态**：`true`→含 image；`false`/`unknown`→仅 text（unknown 宁少报，避免 agent 让用户传图后 400）。zcode 一栏 2026-09-15 实测划掉 |
| `supportsTools` | — | — | — | — | 无对应字段，**不进 catalog**；仅用于 plan 的可选性提示 |
| `enabled=false` | 不投影 | 不投影 | 不投影 | 不可选 | 与 `listModels` 过滤同口径（G1） |
| auto 路由 `publicName` | 作为一个模型条目 | 同 | 同 | 同 | **候选清单不外泄**，与 `listModels` 对 auto 的既有处理一致 |
| `priceInput/Output` | — | — | — | — | 各 agent 无定价字段；花费统计留在 own-api 侧 |
| 协议（路由或渠道继承） | `api: openai-completions`/`anthropic` | `kind: openai-compatible`/`anthropic` | `api` | 决定探针协议 | 与 `src/upstream.ts` 同口径；zcode 的 `openai-compatible` 拼写为实测枚举（§4.3） |

## 6. 流程

### 6.1 detect（`GET /api/agents`）
返回每个适配器的 `{ id, label, configPresent, binaryFound, targets: [{file, exists, parseOk}] }`。
`parseOk=false`（文件损坏/JSONC）→ UI 直接标红「无法安全写入，需人工处理」，后续 apply 硬拒。

**两级判据，不合并成一个 `installed`（2026-09-15 实测后新增）**：本机 Claude Code 已卸载，但
`~/.claude/settings.json` **连同 20+ 插件配置完整残留**，而 npm 全局 `@anthropic-ai/` 已是空目录——
**「配置文件在」与「agent 装着」是两件事**。只判前者的话，detect 会对一个不存在的 agent 报「已安装」，
用户点接入、我们写盘、回执报成功，而它对着一份永远没人读的配置。所以：
- `configPresent` = 配置文件或数据目录存在（可写的前提）；
- `binaryFound` = 可执行体在既定位置存在（PATH 上的命令名 / 既定安装目录，如 `/Applications/<App>.app`、
  `~/.nvm/versions/*/bin/<cmd>` 这类**有限枚举**）；
- apply 要求 `configPresent`；`binaryFound=false` 时 plan 顶部黄字「未检测到已安装的 <label>，
  写入不会报错但该 agent 当前不存在于本机」并需勾选确认。`installed` 这个单字段本稿作废。
- **绝不做 PATH 全盘扫描或目录递归搜索**。

### 6.2 plan（`POST /api/agents/plan`）—— 两段式的第一段
body `{ agentId, vkeyId, model, roles?, modelRolesDefault? }`。**服务端重算一切，不信任前端**：
- 校验 vkey 存在且 enabled、`model` 在 `allowedForKey` 内（不在 → 400，只列有权限的名字）；
- 从 `listModels` 同源取 catalog（§2.2 G1）；
- 对每个 target 读现值，产出 **unified diff**（只含托管路径的 before/after，非托管字段不进 diff）
  与三态判定：`create` / `update`（值不同）/ `noop`（指纹相同）；
- **零写入、零外呼**（DR-CB-H 直接继承：plan 期间不 fetch 任何东西）。

### 6.3 apply（`POST /api/agents/apply`）
body 同 plan + `confirm: true`。逐 target 执行，**顺序固定：备份 → 写 → 回读校验**：
1. 目标存在 → 复制 `<file>.own-api-bak`（同日重复 apply 覆盖同一 bak 名，不产生垃圾堆积）；不存在 → 记录「将新建」；
2. 解析 → 只改托管子树 → **临时文件 + fsync + rename** 原子替换（与 store.ts 同一套写法与 mode 规则）；
3. **回读**重新解析，按托管路径提取值与 `fingerprint` 比对；不等 → 该 target 记 `failed` 并在回执给出
   bak 路径与人工恢复命令（**不自动回滚**——自动回滚会覆盖第 3 步之后用户自己的手改，DR-AI-E）；
4. 全部 target 完成后 `store` 侧同步落 link（**同步落盘不防抖**，遵循 DR-CB 的「回执前 flushSync」，
   消除「回执宣称已接入、盘上还没有」观测窗）；
5. 密钥类 target 未写入（dsh）→ 整体状态 `partial` + 明确的下一步文案。

### 6.4 probe（apply 成功后自动提议，用户点一次）
**这是本功能相对「写完你自己试」的最大增值，也是它必须显式的原因**：
- **L1（默认执行）**：`GET /v1/models` 带这把 vkey，**in-process 直调 `app.request`，不出网卡**。
  证明「URL 可达 + key 有效 + ACL 可见模型清单」，并顺带验证 G1。实测该端点走 `usage.ts#admitRequest`：
  **占用一个 RPM 名额**（`rpmLimit>0` 时），并受**每日 token 额度闸门**约束（已用尽 → 429，此时探针如实报额度耗尽）；
  自身不调 `recordQuota`、不走上游、不产生 token 花费。回执如实写明「消耗 1 次 RPM 额度」。
- **L2（必须用户显式勾选）**：真打一次 `POST /v1/chat/completions` 或 `/v1/messages`（按 §4 `probe` 字段），
  `max_tokens=1`，`model` = 所选对外名。这是**全流程唯一产生真实上游花费的一步**，因此默认关，
  勾选框文案写明「1 次真实上游请求，max_tokens=1」。走真实网关链路（含 auto 候选链），日志正常记账——
  它本来就是真请求，**不新增日志语义**（否决「加 probe endpoint 标记」：endpoint 值域是既有统计口径，为一个探针开新值不值）。
- 探针验的是**网关侧**，不是「agent 会读这份配置」。回执固定挂 `verify` 文案告诉用户怎么在 agent 侧确认。
  不把「探针绿」表述成「agent 已就绪」（DR-AI-G）。

### 6.5 sync 与 drift（已实现）
- **sync**：路由表变了（加模型/改窗口/标视觉）、网关换了端口、块被第三方工具覆盖 → 已接入 agent 落后。
  「已接入」页每行的 **同步** 按钮打开的就是同一个接入向导（**预览 diff → 确认两步一步不省**，
  只是选择控件按账本预置并禁用——服务端不按前端走，界面就不许演「假可改」）。**红线不变：绝不自动/定时/
  启动时写别人的配置文件**，只有人点一下才写（DR-AI-B）。
- **sync 的入参纪律**：`POST /api/agents/:id/sync` 的请求体**只允许 `confirm`**，`vkeyId/model/roles` 一律由账本
  重建（钉 AI-41：body 里塞 `model`/`roles`/`agentId` 全部无效）。若允许覆盖，sync 就成了绕过向导的第二条
  写入通道。预览则复用 `/agents/plan` 的**账本回落**（缺 `vkeyId/model/roles` 时按账本补，钉 AI-44）——
  不为同步另造一套预览算法，两套迟早漂移。
- **sync 会拒绝而不是硬刷的四种情形**（都是 409，说清下一步该干什么）：适配器定义已不存在、
  账本里的 key 已删除（**不替你猜一把新 key**）、key 已停用（不静默写一把停用的）、
  主模型已不在这把 key 的授权内（**不替你挑新模型**——悄悄换个模型写进去比报错糟）。钉 AI-42/42b/43。
- **时间语义**：同步刷新 `lastSyncAt` 但**不刷新 `linkedAt`**——「接入于」是历史，「同步于」是动作（钉 AI-45）。
- **drift**：打开管理页时对每个 link 重算托管块指纹，三态报告：
  `一致` / **被改**（值与托管块不同——用户手改，或 cc-switch 等第三方工具覆盖）/ **缺失**（被删）。
  本机现状即共存场景：cc-switch 对 Codex 整段替换 TOML，会把我们写过的东西抹掉。
  检测到 drift **只提示 + 给「重新对齐」按钮**，绝不静默重刷——两个工具互相静默覆盖是用户无法理解的灾难。

  **指纹的定义域（2026-09-15 实测后新增，否则本功能每次启动都误报）**：目标 agent 是**活写入者**，
  它自己会规范化我们的块——zcode 启动即给我们写的条目补 `reasoning`、把 `modalities.input` 按它自家
  模型目录改写（§4.3）。因此 `fingerprint` **只覆盖「我方声明写入的字段子集」**：适配器每个 Target
  必须同时声明 `writtenKeys`（我方负责的路径集合），指纹 = 规范化(仅这些路径的值)。
  我方字段之外的一切增改**不进指纹、不算 drift**，由 sync 时重新写入自然覆盖。
  三态里的「被改」因此精确含义是「**我方负责的那些值被改了**」，回执文案要照这个口径写。

### 6.6 revoke（撤销）
按适配器声明的 `managedByUs` 目标逐个删除托管块/托管键（仅当值仍等于我们写入的值），
同样走备份 + 原子写 + 回读。删不掉的（如 omp `modelRoles` 里被改写过的引用）列清单让用户处理。

## 7. 非目标（明确划界）

- **Codex CLI**：本机实测其 `wire_api = "responses"`，而 own-api 明确不支持 `/v1/responses`（README 首表已声明）。
  导进去的配置必然不可用 = 自己招 bug。前置条件是补 Responses 转换层，那是独立设计（另文），
  补上后 Codex 适配器一并落地。**在此之前：Codex 走现有「接入方式」页的文本片段 + 文档里写明为什么不支持。**
- **provider profile 多套切换 / failover / profile 库**——own-api 世界观里不存在（前言）。
- skills / prompts / MCP servers 同步、session history 归并、模型定价同步（网关已有价格与花费统计，更强）。
- **gemini / grokbuild / openclaw / hermes / claude-desktop / Cline**：前四个属 P2 逐个补；
  claude-desktop 是 GUI 态、Cline 要动 VSCode `state.vscdb`（SQLite 内部结构，不做写入）。
- 自动/定时写盘；启动时自动补写；plan 之外任何形式的静默 apply（§6.5）。
- 同一 agent 配多个 own-api provider（Claude Code 的 env 只有一份；一 agent 一条 link 已够用）。
- **接入态进 config-bundle**：link 是**本机绑定态**（路径、homedir、装的 agent 集合都是本机的），
  跨机无意义；bundle 恒不含（DR-CB-F 同构）。
- Windows 路径的**实测**：路径按 `homedir()` + 常量派生，Windows 自动落到 `%USERPROFILE%\…`，
  规则同一等，但本文全部字段结论仅在 macOS 实测 → Windows 首验为 §14-V5。
- 用第三方格式库读 Codex TOML（TOML 原语整体随 Codex 一起推迟，§3）。

## 8. API

| 端点 | 说明 |
| --- | --- |
| `GET /api/agents` | 适配器清单（`configPresent`/`binaryFound` 两级 + 逐 target 可解析状态）+ 已接入 link（无密钥，含 `drift` 四态、`catalogStale`、`vkeyDangling`） |
| `POST /api/agents/plan` | body `{agentId, vkeyId, model}`。校验 + 托管块 unified diff（密钥掩码）+ 三态判定。**零写入零外呼** |
| `POST /api/agents/apply` | 同上 + `confirm:true`。**服务端重算计划**，不接受前端传回的计划。缺 confirm → 428 |
| `POST /api/agents/:id/probe` | `{level:'L1'\|'L2', confirm?}`；L2 需 `confirm:true`（否则 428）。目标 URL 恒取本进程监听地址 |
| `POST /api/agents/:id/sync` | **已实现**：ctx 全部由账本重建（体里只允许 `confirm`），漂移/换端口/清单旧一键刷回（§6.5） |
| `DELETE /api/agents/:id` | 撤销（§6.6）。`?keepLink=1` 只清账本；`?force=1` 在有残留时仍清账本（默认**保留**，见下） |

鉴权不变：全部在 `createAdmin()` 的鉴权中间件之内（admin.ts#createAdmin 的 `app.use('*', …)`，含 `adm:IP` 鉴权失败限速）。
**另加两道本功能专属闸（§9）**，实现侧两条比设计更严的地方：

- **`plan` 也纳入回环闸**。设计原写「apply/sync/revoke 回环」，但 plan 会读本机文件并回报
  「文件是否存在 / 能否解析 / 托管块在不在」——这已是本机文件系统事实的泄露面，故与写面同闸。
- **撤销有残留时不清账本**（`ok:false, partial:true`）。§6.6 原文只说「删不掉的列清单让用户处理」，
  但账本一删，那个仍躺在 agent 里的孤儿块就在 UI 上永久隐身了，用户会以为已清理干净。

## 8.1 落地增量（实现期发现，设计正文未预见）

- **指纹域支持 `*` 通配**（`agent-import.ts#domainOf`）：`[['models','*','limit']]` 逐模型只取 `limit`，
  `[['models','*']]` 取键集合。原因见 §11-AI-18——zcode 会给**每个**模型补 `modalities`，
  把整棵 `models` 划进指纹域等于每次启动都误报「被改」。
- **link 增 `byFile`**（逐写入点各存一份指纹）：只有聚合指纹时 drift 只能说「整体不符」，
  说不出是哪个文件；`§6.5` 的 detail 靠它。
- **`visibleModelsForVKey(vkey)`**（gateway.ts 抽出）：`GET /v1/models` 的 `data` 与 catalog 投影
  共用这一个函数，G1「选择器集合 ≡ key 可用集合」由**构造**保证而非靠两处各自实现。
- **探针 URL 由 `setSelfBaseUrl()` 从 index.ts 注入**（与 `setShutdownHook` 同方向），
  请求体里没有任何 URL 字段——§9-7 的「不构成 SSRF 面」在实现上是这句话。

## 9. 安全边界（按「常驻写盘能力」定级，不是加个按钮）

现状是：本功能上线前，own-api **服务端进程的写盘恒在数据目录内**（`db.json` 与其 `.tmp`/`.lock`/损坏备份、
桌面交接用的 `last-session.json`——实测 src/index.ts、src/store.ts 全部写点，均在 `getDataDir()` 下）。
上线后它成为一个能写用户六处配置的常驻服务，
必须按这个事实定级，而不是沿用「admin 令牌 = 完全控制」的旧边界。

1. **零路径入参（地基）**：请求体只接受 `{agentId, vkeyId, model, roles, confirm}`。所有路径 = 代码内常量
   + `homedir()` 派生，`agentId` 必须命中适配器表（未知 id → 400）。
   推论：任何路径穿越（`../`、绝对路径、符号链接）在协议层不可表示——不是「被过滤掉」，是**没有入口**。
   符号链接额外加一道：目标若是 symlink → 拒写并报告（不跟随写进 `/etc`）。
2. **回环硬闸**：apply/sync/revoke 必须 `isLocalish(c)`（admin.ts#isLocalish，socket 对端口径，XFF 即否）。
   LAN 模式下拿到管理令牌的人能改渠道、能读 key 明文之外，**不得触发本机任何写盘**。403 `loopback only`。
3. **merge-only，永不整包重写**：只操作适配器声明的托管路径；未知字段保留是**契约**不是风格（§4.1 的
   Claude Code 20+ 插件就是反例标本）。解析失败 → 拒写并报告，绝不「当作新文件覆盖」。
4. **命名空间独占**：只写/只删自己的 `providerId`（`own-api`）。非自己创建的 provider 条目一律不碰；
   同名但非我们创建 → plan 阶段 conflict 上报（DR-CB-C 同构：个人手配被静默冲掉是本受众最恶性事故）。
   唯一例外：**账本记着的旧基址算我们的**（网关换端口之后旧块对本次要写的地址不再匹配，认账本不算猜——
   那是我们自己写下去的证据）；无账本时不放松，见 §15-5 落地记录与 `AI-70`/`AI-70b`。
5. **密钥处置**：明文 key 出 `db.json` **不违背 DR-CB-B**——那条禁的是「把别人的 token 装进跨机分发的文件」，
   这里是本机用户授权写入自己 key 到自己 agent 的配置。**三条硬约束**：
   ① 新建文件 `0600`，已存在文件**保持原 mode**（zcode 现状 0644 是其既有行为，不擅自改别人文件的权限）；
   ② 密钥禁止出现在任何回执字段、diff 文本、错误消息、`agents.json`/link、日志（含被裁剪前的内存日志）——
   diff 里密钥一律渲染为 `sk-lm-***（新写入）`，沿用 `maskKey`；
   ③ plan/apply 全程 `scrubSecret` 口径。第三方私有凭据格式（dsh）不逆向（§4.4）。
6. **并发**：own-api 自身有单实例锁（store.ts#acquireLock，占用即 `process.exit(1)`），第二实例起不来，所以内部无并发；
   风险全在外部——目标 agent 正在跑（`config.yml.lock`、`setting.json.lock` 实测存在）。
   做法：**不实现对方的锁协议**（猜锁等于假设锁语义），只做「原子 rename + 回读校验 + drift 检测」兜底：
   rename 保证读者不会看到半截文件；被运行中的 agent 回写覆盖由 drift 检测在下次打开管理页时暴露。
   检测到 `.lock` 存在 → plan 挂 warning「该 agent 正在运行，配置可能需要重启才生效，且可能被其自身回写覆盖」。
7. **探针不是 SSRF 口**：探针只打**自己**（in-process 请求，URL 由本进程监听地址构造），
   不接受任何 URL 入参；L2 是唯一真实外呼且必须显式勾选（DR-CB-H 的边界在此同样成立）。
8. **UI 复制语义**：非回环场景拿不到明文 key（`reveal` 既有口径），此时 apply 也必须拒（不能出现
   「看得见按钮、写进去的是掩码串」——`copy()` 已有同类哨兵先例，web/index.html#copy）。

**新增攻击面自评**：最坏情形是「已持管理令牌 + 已在回环」的进程可写这六个已知路径下的托管块。
不构成任意文件写（无路径入参）、不构成提权（写的是自己 home 下的配置文件）、不产生外呼（§9-7）。
它构成的是「静默改变本机 agent 行为」的可能——因此 §9-2/§9-3/§6.2 的显式预览是不可协商的。

## 10. UI

不引入新顶层概念，长在既有对象上：

1. **「对外 Key」页每行加「接入 Agent」**（web/index.html#views.vkeys 行操作区）——接入的主体本来就是这把 key，
   README 早就建议「按 agent 分 key」。入口带 key 上下文，省掉一次选择。
2. **两段式弹窗**（复用 `form()` 与其链式弹窗基建，同 config-bundle §4.1 的先例）：
   选 agent（未安装灰显 + 文件状态）→ 选模型（**只列这把 key 有权限的**，默认建议 auto 路由名）→
   角色槽（Claude Code 的 haiku 等，带默认值与黄字建议）→ **预览 diff** → 确认。
   apply 成功后就地显示：逐 target 结果 / 回读校验 / L1 探针结果 / `verify` 文案 /（partial 时的下一步）/
   勾选则跑 L2。
3. **「已接入 Agent」**挂在「接入方式」页顶部（不新增一级导航）：每个 link 一行 = agent / 用的哪把 key /
   主模型 / drift 状态 / catalog 是否落后 / 「同步」「重新接入」「撤销」。零 link 时给一句引导文案。
4. diff 呈现用现有 `.code` 样式；被改字段用现有 ok/err 配色。**密钥行恒显掩码**（§9-5②）。

## 11. 测试钉（实现时固化；API/库层 → `test/e2e.ts`，DOM → `test/hardening.ts` DOM 桩）

> 全部适配器测试在 **临时 HOME 沙箱**里跑：`OWN_API_*` 走临时数据目录，适配器根路径注入 `HOME`/`homedir()`
> 覆写口（`agentRootFor(home)` 纯函数），**绝不在真实 `~` 上测**（钉 AI-0）。
> 新用例占端口 18830-18832（18787=e2e、18810-18813 与 18820-18822=hardening、18823/18824=config-bundle 双实例，均已占）。
>
> **对比范围的方法论（2026-09-15 实测教训，别把钉写歪）**：真实 agent 是**活写入者**——本机 zcode 启动即
> 改写了我们刚写的块并自行增删了别家 provider 的模型（§4.3）。所以凡是「非托管部分不变」类的断言，
> **只能比较我方 apply 这一次写入的前后两态**，绝不能跨「agent 运行」这道边界去断言字节不变，
> 否则钉在真实环境下必红（临时 HOME 里则永远绿——正是最坏的那种假绿）。

| 编号 | 场景 | 断言 |
| --- | --- | --- |
| AI-0 | 真实 home 零污染 | 全量用例跑完后 `~/.claude`、`~/.omp`、`~/.zcode`、`~/.dsh` 的 mtime 与内容不变（哨兵：用例前记录指纹） |
| AI-1 | 零路径入参 | `agentId` 传 `../../evil`、绝对路径、未知 id → 全部 400，且临时 HOME 下文件数不变 |
| AI-2 | 回环闸 | 伪造 `X-Forwarded-For` 的请求打 apply/sync/revoke → 403，文件零改动（对齐 isLocalish 的 socket 口径） |
| AI-3 | **未知字段保留** | 目标 JSON 预置 20 个无关键（含嵌套数组、中文、unicode、深对象）+ YAML 预置注释/块标量/锚点 → apply 后**非托管部分逐字节相等**，注释仍在 |
| AI-4 | 拒写不猜 | 目标文件写成坏 JSON / JSONC 带注释 / YAML tab 缩进错误 → apply 409 类拒写、文件逐字节不变、回执含 bak 缺失说明 |
| AI-5 | 幂等 | 同参数 apply 两遍：第二遍 plan 全 `noop`、文件字节相等、link.fingerprint 不变、不产生第二个 provider 条目 |
| AI-6 | 原子写与备份 | apply 后存在 `<file>.own-api-bak` 且等于改写前；模拟写入中途抛错 → 原文件未被破坏（rename 未发生） |
| AI-7 | 回读校验失败 | 注入「写后回读值不符」桩 → 该 target `failed`、回执含 bak 路径、link 不落、**不自动回滚**（断言文件仍是新值） |
| AI-8 | 符号链接 | 目标文件替换为 symlink → 拒写并报告，链接指向的文件不变 |
| AI-9 | ACL 一致（G1） | vkey `allowedModels` 不含所选 model → plan 400 且只列有权限名字；catalog 投影的模型集合与探针 L1 返回的 `/v1/models` id 集合**逐元素相等**；auto 候选名不出现在 catalog；`enabled=false` 的路由不出现 |
| AI-10 | 三态视觉 | `supportsVision` = true/false/unknown 三种路由 → 投影后 `input`/`modalities.input` 分别含 image / 不含 / 不含 |
| AI-11 | 密钥不外泄 | apply/plan/probe 的 200 与 4xx 响应体、diff 文本、link、`db.json`、日志（leaky 三形态：原文/URL 编码/base64，复用现有哨兵基建）均不含 vkey 明文；diff 里渲染为掩码 |
| AI-12 | 探针成本 | 未勾选 L2 时全链零上游请求（mock 上游 `/__hits` 增量 0）；勾选 L2 后增量恰 1 且 `max_tokens=1`；L1 消耗 1 次 RPM（rpmLimit=1 时第二次 L1 → 429） |
| AI-13 | partial 语义 | dsh 适配器 apply → 状态 `partial`、provider 段已落盘、回执含 env 名与「密钥未落盘」文案，且**不含** success 措辞 |
| AI-14 | drift 三态 | 手改托管块 → `被改`；整块删除 → `缺失`；同步后 → `一致`；三种状态下 apply 均不静默覆盖非托管字段 |
| AI-15 | 撤销完备 | apply → revoke → 目标文件与接入前**逐字节相等**（bak 兜底路径同样验证）；值被用户改过时不删并列入清单 |
| AI-16 | 迁移 | v3 库加载 → `version=4` 且 `agentLinks=[]`；已有 vkeys/channels 逐字段不变；link 内 vkey 被删除后 → GET /api/agents 显示悬空但不炸、revoke 可清账本 |
| AI-17 | DOM | 非回环时「接入」按钮不可用并说明原因（不出现写掩码串的路径）；diff 里密钥行显掩码；未安装 agent 灰显 |
| AI-18 | **活写入者容忍**（zcode 实测形态） | 我方写入后，模拟对方规范化：在我方块内**新增** `reasoning` 键、把 `modalities.input` 改成别的值、在块外**删除**另一个 provider 的一个模型 → 三态必须仍是 `一致`（这些都在 `writtenKeys` 之外，§6.5）；再次 apply **不得**因这些差异判 update，也不得把被对方删掉的字段当成冲突；只有改动 `writtenKeys` 内的值（如 baseURL/kind/模型名集合）才判 `被改` |
| AI-19 | detect 两级 | 预置「有配置无二进制」的沙箱形态（Claude Code 实测形态：配置文件在、PATH 与既定安装位置皆空）→ `configPresent=true` 且 `binaryFound=false`、apply 可过但 plan 出黄字；反之只有二进制无配置文件 → 黄字「未检测到配置」，不得凭残留文件谎报可用 |
| AI-20 | 写法保真 | 目标文件带/不带结尾换行、2 空格与 4 空格缩进、`ensure_ascii` 中文转义两种形态各一例：apply 后**除托管子树外逐字节不变**，其中「不带结尾换行」一例断言结果仍不带（zcode 实测形态，防幂等钉假失败） |

### 11.1 PR1 落地映射（实现在 `test/e2e.ts` 第 17 节，编号 AI-0…AI-23，与上表**不同源**，故给出对照）

PR1 = 基建 + JSON 原语 + **zcode 单适配器**（§1 落地顺序）。所以「YAML / 三家未落地适配器」相关的钉
在 PR1 无从存在——下表把这些明确标 `待 PR2`，**不许用「跑通了 zcode」冒充全绿**。

| 本文编号 | 落地情况 | 实现编号 / 缺口 |
| --- | --- | --- |
| AI-0 真实 home 零污染 | 部分 | e2e `AI-0`（路径恒源自注入根）+ `AI-0b`（真实 `~/.zcode` mtime 哨兵）。**`.claude`/`.omp`/`.dsh` 三家的哨兵待 PR2** 随适配器补 |
| AI-1 零路径入参 | ✅ | e2e `AI-2`（6 种恶意/未适配 agentId → 全 400 且零落盘） |
| AI-2 回环闸 | 部分 | e2e `AI-14`（XFF → 403、零改动）。`sync` 端点 P1 才有，无从打 |
| AI-3 未知字段保留 | 部分 | e2e `AI-6`（别家条目 + 顶层无关键逐字段/键序不变）。**YAML 注释/块标量/锚点待 PR2** |
| AI-4 拒写不猜 | 部分 | e2e `AI-10`（坏 JSON → 409 + 原文一字节不动 + errors 含原因）、`AI-11`（symlink 拒跟随 + 目标文件不动）。JSONC/tab 缩进属 YAML 侧，**待 PR2** |
| AI-5 幂等 | ✅ | e2e `AI-5`（二次 apply 全 `noop` 且盘上字节完全相同） |
| AI-6 原子写与备份 | 部分 | e2e `AI-8`（bak 存在且不产生 bak 堆积）。**「写入中途抛错原文件未破坏」需注入桩，未钉** |
| AI-7 回读校验失败 | ⏳ 未钉 | 需要「写后回读不符」桩（现无注入口）。代码路径存在（`applyLink` 回读比对），PR2 一并补桩 |
| AI-8 符号链接 | ✅ | e2e `AI-11` |
| AI-9 ACL 一致（G1） | ✅ | e2e `AI-4`（写进 agent 的 catalog 与 `GET /v1/models` **同一把 key 的返回集逐元素相等**）+ `AI-15`（越权模型 400） |
| AI-10 三态视觉 | 不适用（PR1） | zcode 侧实测**不投影** modalities（§4.3/V6），故此钉对 zcode 无意义；随会投影该字段的适配器在 PR2/P1 再钉 |
| AI-11 密钥不外泄 | 部分 | e2e `AI-3`（plan/diff 掩码）、`AI-12`（apply 回执无明文）、`AI-20`（探针 note 无明文，走 `scrubSecret`）。**leaky 三形态哨兵基建复用未接**，PR2 补 |
| AI-12 探针成本 | 部分 | e2e `AI-20`（L2 缺 confirm → 428；L2 经 mock 上游走通全流程并记 `lastProbe`）。「L1 挤占 RPM → 429」不钉为失败，语义按 §15-2 裁决改为 `rate_limited` |
| AI-13 partial 语义 | ⏳ 待 PR2 | dsh 适配器未落地 |
| AI-14 drift 态 | ✅ 超额 | e2e `AI-17`…`AI-19`：**四态**齐全（一致/被改/缺失/读不到） |
| AI-15 撤销完备 | 口径已更正 | e2e `AI-21`/`AI-22`。**原文「与接入前逐字节相等」这条口径不对**：我们只删自己那块、不整文件还原（还原会吞掉用户在两次操作之间的改动），故断言为「我方块消失 + 其余原样 + 值不是我们的就不删」 |
| AI-16 迁移 | ✅ | hardening「v2 直升当前版 v4」两条（`version=4` ∧ `agentLinks` 为数组 ∧ 旧双表已消失）+ e2e `AI-23`（vkey 删除后悬空可见、探针明确 409、账本可清） |
| AI-17 DOM | ⏳ 未钉 | 「非回环时按钮不可用」等需 hardening 的 DOM 桩；当前仅由既有「控制台脚本 vm 全量执行零异常」覆盖语法与顶层求值 |
| AI-18 活写入者容忍 | ✅ **本轮最值钱的钉** | e2e `AI-18`（对方在我们块内补 `modalities`/`reasoning`、块外删别家模型 → 仍 `一致`；改 `limit` 或增删模型键 → `被改`；再 apply → `一致`）。**它当场抓出实现里指纹域划得过粗（`['models']` 整棵入域）的真 bug**；实机侧同样验过：ZCode 启动给全部 5 个模型补字段后 drift 仍 `一致`（§4.3） |
| AI-19 detect 两级 | 部分 | e2e `AI-1`（空沙箱 `configPresent=false`；`binaryFound` 期望值由本机实况推导，证明两判据互不污染）。「有配置无二进制」的黄字分支在装了 ZCode 的机器上造不出来——**`binary.apps` 需要可注入的判据才能钉住**，PR2 处理 |
| AI-20 写法保真 | ✅ | e2e `AI-7`（无尾换行 + 2 空格 + 0644 保持）、`AI-7b`（有尾换行 + 4 空格 + 0600 不升级）、`AI-8`（新建文件 0600）；`ensure_ascii` 中文形态含在 `FOREIGN` 样本里随 `AI-6` 一并逐字节比较 |

### 11.2 PR2（omp + YAML 引擎）落地映射（e2e 第 17 节 `AI-25`…`AI-38`）

| 钉 | 钉的是什么 |
| --- | --- |
| `AI-25` | omp 被检出，且 `roleSlots` 随 detect 交给 UI（不传就等于角色在界面上够不着） |
| `AI-26` | plan 列**两个**写入点并各标 `kind`（block/role）；plan 全链无 key 明文 |
| `AI-27` | provider 块形态与真机同构；**merge-only 用语义比对钉死**（别人 provider 的逐字段值 + 行尾注释原样） |
| `AI-28` | 角色**逐键合并**：未勾选的 `plan`/`tiny` 连 `:auto` 思考后缀都原样保留 |
| `AI-29` | 注释/块标量无损、200 字符长值不被折行（`lineWidth:0`）；**已知让步如实钉住**：空 flow 序列折叠 |
| `AI-30` | 保持原 mode 0600 + 落备份 |
| `AI-31` | 漂移四态在 YAML 上全跑通：改我方字段→`modified`、改别人 provider→`consistent`、我方键全没→`missing`（映射还在也算）、重 apply 即修复 |
| `AI-32/32b` | 撤销语义=**还原到最近一次写入之前**（那条写入时本无此键则删，不凭空造值）；干净周期逐键还原 `jyld/m1`；只删自己的 provider 块 |
| `AI-33` | 角色被用户改指别处 → `kept` 且**账本保留**（不留看不见的孤儿） |
| `AI-34` | 托管路径落在 YAML **别名**上 → plan 就拒并说清「会改到锚点公共内容」（`yaml` 本来抛异常，这里变成人话且不打成 500） |
| `AI-35` | 坏 YAML 拒写并给原因，**不整文件重写「修好」它** |
| `AI-36` | 未在 `roleSlots` 声明的槽名（`../evil`）直接丢弃——槽名是目标文件里的路径段，放开=路径注入重新开回来 |
| `AI-37` | 新装态（目录都不存在）能 `mkdir -p` 落盘，新建文件一律 0600 |
| `AI-38` | **zcode 指纹 golden**：动指纹域必红，逼实现者连带处理老账本迁移（键法一改，升级即全员误报「被改」）；附带钉「域外字段（agent 补的 `modalities`）不进指纹」 |

真机哨兵同步扩到 **`~/.omp/agent/{models,config}.yml`**（`AI-0b` 一并比 mtime）。
Claude Code / dsh / opencode 的钉随各自适配器落地，**现在一钉都没有**。

### 11.3 sync（e2e `AI-39`…`AI-47`）与 UI 真点击钉（hardening `UI 钉` ×23）

| 钉 | 钉的是什么 |
| --- | --- |
| `AI-39` | sync 不带 confirm → **428 且盘上一字未动**：新端点不豁免写面纪律 |
| `AI-40` | 块被改坏后 sync 刷回我方声明值，`drift.state` 回到 `consistent` |
| `AI-41` | **ctx 只认账本**：body 覆盖 `model`/`roles`/`agentId` 全部无效（否则 sync 是第二条写入通道） |
| `AI-42/42b/43` | key 停用 / key 已删 / 主模型掉出授权 → 三种 409 各说清下一步，**不猜 key、不挑模型** |
| `AI-44` | `plan` 缺 `vkeyId/model/roles` 时回落账本（同步预览与接入预览是同一条通路） |
| `AI-45` | 同步刷新 `lastSyncAt` 不刷新 `linkedAt` |
| `AI-46` | sync 也吃回环硬闸（XFF → 403，不因为「只是同步」就放行） |
| `AI-47` | `roles` 的 `{槽: 模型}` 对象形态被认——**这条分支曾因 dangling-else 从未执行过**（§13.2） |

UI 侧不再只有静态钉：hardening 把 `agentWizard` 连同 `api`/`agentPost`/`probeVerdict`/遮罩处理器一起搬进
DOM 桩，**假 fetch 记账请求体、真点按钮**。这 23 条覆盖：选择态渲染（`roleSlots` 才长出勾选框）、
plan/apply/sync 各发了什么体、浏览器 confirm 答否时零请求、回执自己讲结论、遮罩关闭的三种坐标判定、
同步模式自动出 diff + 控件禁用 + **只带 confirm 且不走 apply**。
**证伪验证已做**：把 L2 的 `confirm:true` 与 sync 的「只带 confirm」两处保护拆掉，对应两条立刻红并打印出真实 body。

**为什么值得为 UI 单独搭一层**：交付时那条 L2 bug（弹了确认框却没把 `confirm` 带上 → 恒 428 → 被渲染成
「探针未通过」）在源码静态钉（AI-24）里长得**完全正确**——静态钉读的是字面量，看不见运行期拼出来的 body。

### 11.4 Claude Code（e2e `AI-48`…`AI-60` + `AI-40b`，hardening `UI 钉` ×2）

**未实机验证的适配器，钉子就是它的全部证据面**，所以 fixture 直接取本机残留 settings.json 的真实形状：
24 个 `enabledPlugins`、`extraKnownMarketplaces`、`statusLine` 里带嵌套转义的 shell 命令、用户自己的
`HTTPS_PROXY`、旧 provider 留下的 6 个 env 键——邻居不真实，merge-only 就等于没测。

| 钉 | 钉住什么 |
| --- | --- |
| AI-48 | detect 得出 claude-code；`requiredSlots` 随 `AgentStatus` 交给 UI（预勾是**适配器**的权利，不是 UI 的猜测） |
| AI-49 | 同文件两个写入点都进计划且各自 `kind`/`path` 正确；anthropic 协议不追加 `/v1`；`ANTHROPIC_AUTH_TOKEN` 在预览里被掩码（`SECRET_KEYS` 认得 `*_TOKEN` 这种形状）；`beforeView` 不含用户的 `HTTPS_PROXY` |
| AI-50 | haiku 未接管 / 接管成主模型 → 两条不同提示；**没接管 default 就不碰顶层 `model`** |
| AI-51 | 我方 env 键写满 + 顶层 `model` 改动；邻居逐个钉死（`HTTPS_PROXY`、插件表、statusLine 那句 shell 的引号、theme、effort）；**文件根上不得长出角色名垃圾键**；角色值只落 env（`roleKey` 映射生效） |
| AI-52 | 二次 apply 全 noop，盘上字节完全相同 |
| AI-53 | 我方键的值被改走 → `modified`；用户自己的 env 键与无关字段增改 → `consistent`；我方键全没（env 映射还在、装着用户的 OPUS）→ `missing`；apply 可修回 |
| AI-54 | 撤销逐键还原写前值（旧 provider 的 URL/token/模型名连同顶层 `model` 一起回去）；用户自加的 OPUS 槽必须活着 |
| AI-55 | 部分键被用户改走：那一个不碰、其余照原样还原、**回执点得出名**；「残留的已经不是我们的」才允许清账本 |
| AI-56 | key 已删 → `ANTHROPIC_AUTH_TOKEN` 判 `unknown`（不是 `false`）：`kept` + 账本留着；同文件里认得出的键照旧还原（三态不是整份文件一刀切冻结） |
| AI-57 | 同文件两个写入点各占一个 `byFile` 键；刚写完 `consistent` |
| AI-58 | `catalogInFile:false` → 不报「模型清单待同步」；**AI-58b** 同步按钮对 claude 同样成立（只吃 `confirm`、两点一起修回、`linkedAt` 不被改写） |
| AI-59 | 全新装态（settings.json 不存在）能建文件，默认 0600 |
| AI-60 | 作者级守卫：`roleTarget` 缺失 → plan 报错 + apply 拒绝 + 目标文件一字节没动 |
| UI ×2 | claude 四个槽全渲染、预勾的恰是 `requiredSlots` 那两个；plan 请求体真把 `["default","haiku"]` 带上 |

`AI-40b`（omp 段）与 `AI-53`（claude 段）是一对，钉的是同一处**引擎修复**：合并型写入点的聚合指纹域曾经
直接吃 `target.writtenKeys`，而合并型那里它是空数组，`fingerprintOf(x, [])` 塌成 `sha256("{}")` 常量 ——
等于把 omp 的 `modelRoles` 整个排除在漂移之外（用户把 `default` 改成别家照样报「一致」）。

**证伪记录**（不弄坏不会红的钉子是假钉）：
① 把 `fingerprintOfTargets` 的域退回 `target.writtenKeys` → 恰好 `AI-40b` + `AI-53` 两条红（424→422），恢复即绿；
② 把 `web/index.html` 里 `defaultRoles` 的 `requiredSlots` 分支删掉 → 恰好两条新 UI 钉红，并打印出真实 body `roles:["default"]`，恢复即 216 绿；
③ `AI-51` 的垃圾根键那条是**先有真缺陷后有钉**（见 §13.3），它红过一次，无需再造。

### 11.5 dsh（e2e `AI-61`…`AI-69` 含 `AI-61b`/`AI-62a`/`AI-62`×4/`AI-63`×2/`AI-64`×3/`AI-65`×2/`AI-66`×3/`AI-67`×5）

| 钉 | 钉的是什么 | 为什么会写错 |
|---|---|---|
| AI-61 / AI-61b | 凭据库不存在 → 拒写并说清理由；`DSH_HOME` 指向别处 → 拒写（指回默认位置放行） | 往错位置写 dsh 配置、或替它发明凭据文档格式，都比不写糟得多 |
| AI-62a | 同名 `own-api` 指向别处 → 判「不是我们的形态」拒覆盖，**且把现值印在报错里**（§9-4） | 端口换过的旧条目长得很像我们的；无账本时仍按严格判（放松见 §15-5） |
| AI-62 ×4 | 三个写入点各就各位且 kind 不混；**`blockKeys` 切分**（provider 块里不得混进凭据引用与模型指针）；baseURL 带 `/v1` 且明文 key 不进 settings；refs 那格预览被掩码；指针的 before 是别人家默认且预览可见 | 一份 `build()` 供三个写入点，块型整包吞 built 就会把 key 和指针当 provider 字段写出去 |
| AI-63 ×2 | apply 写满三处；catalog 只在路由登记了窗口才写数字 | dsh 的 models 条目除 id 外全可选，编造 128k 是替用户撒谎 |
| AI-64 ×3 | 头注释/行尾注释/别人 provider/无关 namespace 全原样；`records` 与他人 ref 与 `version` 全活；**两份文件仍 0600** | dsh 见多用户可读的凭据库会**拒绝加载**，写宽一个 bit 就是让用户 dsh 起不来 |
| AI-65 ×2 | 二次 apply 全 noop（含凭据）；刚写完 drift=consistent | noop 判不准就会每次同步都重写用户凭据库 |
| AI-66 ×3 | 用户在 dsh 里换默认模型 → `modified`；同步按账本刷回（两段一起回）；改别人家/无关 namespace 不算漂移 | 漂移域多一格就把 dsh 自己的正常动作全报成冲突 |
| AI-67 ×2 | 块型整块摘除 + 指针逐键还原；**noop 过的写入点撤销放回原值，不掏成空映射** | 真机彩排第一次就踩到：用户本就指着 own-api → 第一轮是 noop → 不记写前值的话撤销只能删键 |
| AI-67b | sync 没动凭据那格时，撤销仍还原成**用户最早那把 key** | 账本被新回执整条替换 = 忘掉最早的原值，把「还原」变成「删除」 |
| AI-67c–e | 指针 noop 但仍记账；noop 撤销放回；**整块覆盖前点名会吞掉哪些不托管字段** | 用户手写的 `defaultInput` 与逐模型 `input`/`maxTokens` 会静默消失（真机实测） |
| AI-68 | 不勾 `default` 就完全不碰 `agent-default-model` | 那是用户每次新建 agent 的起点，不是接入的默认赠品 |
| AI-69 | 备份文件的权限**一律收紧到 0600**，而源文件保持用户自己的宽度 | 备份是同一份明文的第二个副本；用户把源文件放 0644 是他的选择，我们的产物没理由比它更松 |

**反证记录**：① 摘掉 `blockKeys` → AI-62 立刻报出被污染的键集
`[…, OWN_API_API_KEY, provider, model]`（且 AI-66 连带失败）；② 摘掉 noop 的 prev 记账 → AI-67b 单独失败
（还原值变 `undefined`，即用户原 key 丢失）。两条都验证过「有牙」。

| AI-70 / AI-70b | 换端口后 sync 凭账本基址认回我们自己写的那一块并刷成新地址；现值指向第三家时仍拒 | §15-5 放松的边界：只放松到「账本证明的那一份」，不放松成「看着像就抢」 |

**测试基建的坑 ①（已修）**：`AI-69` 原先在测试进程里改 `process.env.DSH_HOME` 再打 HTTP——服务端是**另一个
进程**，改不到，那条"绿"是环境里本来就存在的 `DSH_HOME` 造成的假绿，还顺手把 dsh 全组钉子压住（apply 一直被拒）。
判据改为进程内直调 `adapter.preflight()`。**凡是依赖环境变量的判据，都要问一句"这个 env 是执行侧的还是决策侧的"。**

**测试基建的坑 ②（`AI-70` 差点是第二条假绿）**：要模拟「网关换了端口」，最自然的写法是 fetch 时带
`Host: 127.0.0.1:9999`。实测**undici 吞掉手工设置的 Host**（起了个回显 server 验证：服务端看到的还是原端口），
于是那次「同步 success」其实是原址 noop——断言只差一点就只查 `status === 'success'`。改走 `node:http`
（核心模块认 Host）之后派生基址才真的变。**教训：凡是"我们构造的前提条件"，先单独证明它成立**，
别拿结果绿了反推前提成立。

## 12. 决策记录（编号仅限本文）

| 编号 | 争点 | 裁决 | 理由 |
|---|---|---|---|
| DR-AI-A | 做「导入片段」还是「替代 cc-switch」 | **做接入登记（写入+同步+撤销）**，不做 profile 切换器 | 写的是网关不是真实上游 → 切换语义不存在；持续需求是 catalog 同步，这才是 cc-switch 做不到且网关有真数据的 |
| DR-AI-B | 是否自动同步/自动补写 | **绝不自动**，只提示 + 人点 | 静默改别人的 agent 配置在用户眼里不是便利是失控；与 cc-switch 的用户显式模型一致 |
| DR-AI-C | catalog 从哪来 | **`/v1/models` 按 vkey ACL 的投影**，不新造聚合 | 复用既有过滤（enabled ∧ allowedForKey）与既有字段；换来强不变式 G1 |
| DR-AI-D | link 存 db.json vs agents.json | **db.json（version 3→4）** | 单文件备份语义、0600+原子写+flushSync 全复用；link 不含密钥故无敏感度增量 |
| DR-AI-E | 回读失败是否自动回滚 | **不自动回滚**，报 bak 路径 + 人工命令 | 自动回滚会覆盖第 3 步之后用户自己的手改；且回滚本身可能再失败 |
| DR-AI-F | YAML 自研 vs 引库 | **引 `yaml`（Document API 保注释/格式）**，仅限适配器层 | 自研 YAML 子集出错=毁用户配置且测试容易全绿；主链路零依赖不变。**让步已量化（真机文件上量的，不是估计）**：`models.yml` 往返 0 行差异；`config.yml` 唯一重排是空 flow 序列折叠；注释/锚点/块标量在 `setIn` 后全保住。**但 `lineWidth` 必须置 0**——默认 80 列会把用户无关的长带空格标量折行，那是真破坏（钉 AI-29）；`yaml` 对别名节点 `setIn` 会抛异常，我们前置检查变成人话拒写（钉 AI-34） |
| DR-AI-G | 探针绿是否等于「已生效」 | **不等于**，回执必须分「网关侧已验证」与「agent 侧请确认」两段 | 探针只能证明网关链路；agent 如何读配置不在我们控制内，混讲是给用户假信心 |
| DR-AI-H | haiku/便宜模型槽自动挑 | **不猜**，给默认值 + 黄字建议 | 「哪个模型便宜」是用户的定价与偏好判断；猜错是每次后台任务多烧钱，且不可见 |
| DR-AI-I | 是否顺手写 omp `modelRoles` | ~~默认不写，plan 里显式勾选~~ → **实现改为默认只勾 `default` 一个槽**（2026-09-15，见 §15-4 待裁决） | 原判断（那是用户的角色偏好表，不是 provider 配置）依然成立，但「一个都不勾」会让接入在 omp 上毫无效果——用户看到的仍是原供应商，功能等于没发生。折中：只碰 `default`（不打角色时用的就是它），其余 8 个槽默认不动、可勾、撤销逐键还原 |
| DR-AI-J | 逆向 dsh `.credentials.yaml` | ~~不逆向，标 partial 并给复制口~~ → **前提变了，2026-09-15 重开并关闭：全自动**（写 `refs` 那一格） | 当初「不可核实」是因为把它当第三方黑盒。实际上我们就跑在 dsh 里：真身在 `@deepseek-ai/dsh-credentials-local`（v0.1.5-rc.2）的文档与代码里写得明明白白，而且**外部编辑是被官方支持的场景**（watcher 热发布、写保注释、锁内读-改-写）。核实过的写入不是逆向，是照契约写。**残留的谨慎**：只写我们那一格、保住 0600、文档不存在就拒写 |
| DR-AI-N | noop 的写入点记不记写前值 | **记**：优先继承上一轮账本的值，没有则记盘上现值；**真写过的写入点绝不继承** | 两头都咬过人：不记 → 撤销把用户自己设的 `agent-default-model` 掏成空映射（真机彩排）；无脑继承旧值 → 撤销删不掉我们新建的键（AI-32）。区分点只有「本轮有没有真的动它」 |
| DR-AI-O | 整块覆盖会不会吞掉用户的不托管字段 | 会，且**必须预览时点名**（新增通用告警，非 dsh 专属） | 真机彩排里用户手写的 `providers.own-api` 带着 `defaultInput` 与逐模型 `input`/`maxTokens`，我们的投影没有它们。块型语义（不还原、只有 `.bak`）不变，但静默吞是另一回事 |
| DR-AI-K | Codex 是否进 P0 | **不进**，等 `/v1/responses` | 导出一份必然不可用的配置等于自招 bug |
| DR-AI-L | 探针是否新增日志语义 | **不新增**，走真实链路正常记账 | endpoint 值域是既有统计口径；探针本来就是真请求 |
| DR-AI-M | 一 agent 多 provider | **非目标** | Claude Code env 只有一份；多实例诉求未见，先不开面 |

## 13. 实现后同步面（实现 PR 的 checklist）

- [x] 状态行翻为「PR1 已实现（zcode）」并列出钉编号（§11.1 对照表）；PR2/P1 未完成部分不得冒充已交付
- [x] README 能力表加行「一键接入 Agent」并链本文；「接入各 agent」小节说明自动写入与文本片段两条路
- [x] README 目录树补 `src/agent-import.ts`；`package.json` 依赖：PR1 无新增，**PR2 起多一个 `yaml`**（DR-AI-F 的让步已兑现，打包链是 `esbuild bundle:true`，SEA 单文件与桌面安装包自动吃进）
- [x] SECURITY.md「已内建的安全机制」补：写盘面零路径入参 + 回环硬闸 + merge-only + 备份
- [x] CHANGELOG Unreleased 补条目
- [x] 自测计数更新：e2e **359**（+47 条 AI-*）、hardening **191**（迁移两条断言随 v4 更正）
- [x] `npm run gen:web` 已同步，WEB_HTML 同步钉绿
- [x] 「接入方式」页 Codex 片段旁补一句「own-api 暂不支持 Responses API」的现状说明（§7）——**已存在**，无需再动
- [x] PR2 部分落地：**`yaml` 依赖 + Document API 保注释写入引擎 + omp 适配器（含角色槽）**，已实机验收（§4.2）。
      当时剩 **Claude Code / dsh** 两个适配器未开工
- [x] **Claude Code 适配器已实现**（`~/.claude/settings.json`，env 合并 + 顶层 `model`，钉 AI-48…AI-60 + UI ×2）。
      **未实机验证**：形态来自残留配置，行为一条都没测（§14-V7 保持开放）
- [x] **dsh 适配器已实现**（`~/.dsh/settings.yaml` 三写入点 + `.credentials.yaml` 的 `refs`，钉 AI-61…AI-69，§11.5）。
      V1/V2 已用**运行中的实现**核实并关闭（§4.4）；真机配置副本彩排过，真实 `~/.dsh` 由 AI-0b 哨兵守着一字节未动
- [ ] PR2 附带还债（本轮识别出的三处不可钉形态）：AI-6 的「写中途抛错」桩、AI-7 的「回读不符」桩、AI-19 的 `binary.apps` 判据注入
- [x] **P1 的 sync 闭环已落地**：`POST /api/agents/:id/sync`（账本重建 ctx，钉 AI-39…AI-47）+ 「已接入」行内
      **同步**按钮（复用向导的预览→确认，钉 UI 钉 ×23）+ 漂移高亮；drift 三态本来就在
- [ ] P1 余下：opencode 适配器（卡 §14-V3）、「同步全部」一键（卡 §15-1 裁决）

## 13.1 实现期回填（2026-09-15，PR1）

实机 + 测试期改动了设计的三处（1–3），另记一条交付质量事故（4），均已回写正文（不再另立说法）：

1. **§6.5 指纹域**：`writtenKeys` 从「整棵子树」细化为带 `*` 通配的字段域（§8.1）。设计原文只说了
   「只覆盖我方声明字段」，但**没规定粒度**——`['models']` 严格说也符合原文，而它每次启动都误报。
2. **§6.6 撤销残留不清账本**（§8）。设计只写「删不掉的列清单」，漏了账本本身的处理，会让孤儿配置隐身。
3. **§9-2 回环闸扩到 `plan`**（§8）。plan 的返回值已含本机文件系统事实，不属于「只读安全」范畴。

另有两条实测事实进 §4.3：ZCode 会给我们块内**每个**模型补 `modalities`（不只是首个），
且启动即重写；这直接决定了第 1 条的形状。

**第 4 条：PR1 交付后由用户实机踩出的 UI bug（探针 L2 恒失败）**。向导里点 L2 时弹了浏览器
`confirm()` 对话框，**却没把 `confirm: true` 放进请求体**，于是服务端恒返回 428，UI 把它渲染成
「探针未通过」——用户看到的是「链路坏了」，真相是「我没带确认」；而他人在 ZCode 里发消息一直是通的。
定位过程中先差点把日志里那条 `499 客户端已断开` 当成凶手（那是另一条正常流式请求被中途断开，
`stream:true` + 巨大 prompt，与探针形态完全不符），靠「探针请求在日志里是 `in=56 out=1` 且 **200**」
才排除掉。**教训有两条**：① §11.1 标的 DOM 桩缺口（AI-17）不是理论风险，它已经吃掉了一次交付质量；
② 「探针失败」的文案不能把所有非 200 都算成链路故障——`428`（花费保险）、`429`（额度闸门）、`409`（key 已删）
三类现在在 `probeVerdict()` 里分开渲染。临时防线是钉 **AI-24**（静态结构钉：UI 每个 `/probe` 调用点必须
透传 `confirm`；已做反证——摘掉任一处即翻红），DOM 桩仍待 PR2 补。

### 13.2 实现期回填（2026-09-15，PR2：omp + sync + UI 真点击钉）

1. **一条从未执行过的分支，在 395 条全绿里活了很久。** `agentCtx` 里那段角色解析写成：
   ```ts
   if (Array.isArray(body.roles)) for (const s of body.roles) if (typeof s === 'string') wantRoles[s] = model;
   else if (body.roles && typeof body.roles === 'object') …   // ← 挂的是里层 if，不是外层
   else if (saved?.roles) …
   ```
   `else if` 语法上属于**里层 `if`**，整条链被吞进循环体。后果：`{槽: 模型}` 对象形态与 sync 的账本回落
   **两条路一次都没跑过**。为什么全绿：UI 一直传数组，而数组那条恰好是对的，于是测试也只见过数组。
   **暴露它的不是审查，是新功能**——sync 是第一个「不带 roles 来」的调用方。
   教训两条：① 给同一入参加新形态时，必须把**已有调用方也切到新形态**跑一遍，否则新形态就是死代码而测试是绿的；
   ② `if` 带循环/条件单语句时一律加花括号。已补钉 `AI-47`（对象形态）与 `AI-44`（账本回落），
   并全库扫了同形状：另三处的 `else` 语法上只能挂外层 `if`（循环体不是 `if`），行为正确，未动。
2. **UI 有了真点击层**（hardening 的 DOM 桩此前只搬过 `el`/`form`）。判断依据不是「终于能测 UI 了」，而是
   静态钉在 L2 事故上明确失效过：读字面量看不见运行期拼出来的请求体。
3. 角色勾选默认只接管 `default`（改动 DR-AI-I，待 §15-4 追认）；同步模式禁用的理由写在代码里：
   **服务端不按前端走，界面就不许演「假可改」**。
4. 计数：e2e **395**、hardening **214**；`npx tsc --noEmit` 干净；`gen:web` 101.3 KB。

### 13.3 实现期回填（2026-09-15，PR2：Claude Code 适配器，**零实机验证**）

1. **`keysOfTarget` 把角色键发给了每一个合并型写入点，Claude 因此在 settings.json 的根上写出 `default`/`haiku`
   两个垃圾键。** 起因是「顶层 `model` 与 `env` 同在一份文件」：原先的推断是「合并型 ⇒ 域就是角色键集」，
   于是根写入点也认领了角色键，`mergeValuesOf` 照单落盘。**发现方式不是审查**——是 `AI-55` 的撤销回执写着
   「`default`、`haiku` 的现值不是本次写入的值，未动」：那两个键从来不是我们的，**是我们自己刚写进去的**。
   修法不给根写入点打补丁，而是把「谁承接角色」变成显式声明：`TargetSpec.roleTarget`（每适配器唯一，
   planLink 先校验后写，缺失或重复一律拒绝落盘），另补 `AI-51`（根键集合必须与 fixture 逐字相同）与 `AI-60`。
   教训：**同文件多写入点会让「按类型推断语义」失配**——一处装角色、一处装标量，merge/block 二分推不出来，只能声明。
2. **合并型写入点的聚合指纹一直是常量**（详见 §11.4 末）。为什么 395 条全绿：omp 的漂移钉测的全是「键整段没了」
   （走 `gone` 分支），没人测过「值被改」。盲区形状值得记下来：**一条判据有两条路时，测试容易只铺那条更显眼的**。
   补 `AI-40b`（omp）+ `AI-53`（claude）成对守住；键法改动刻意保持「单写入点文件仍用裸 `rel`」，
   否则 zcode 老账本升级即全员误报「被改」（同 AI-38 golden 的约束）。
3. **撤销的归属判据从写死的 `providerId/` 前缀抽成 `Adapter.ownsKey`，且返回三态。** `false`（用户改走 → 可清账）
   与 `'unknown'`（key 已删，token 无从比对 → 账本必须留）在旧模型里是同一个值；混起来的后果是删过 key 的机器上
   那枚 token 静默留在别人文件里而 UI 再无痕迹（`AI-56` 钉住）。
4. 计数：e2e **425**（+30）、hardening **216**（+2）；`npx tsc --noEmit` 干净；`gen:web` 101.4 KB。
   顺手发现 `test/e2e.ts` 里「迟滞松手」那条路由健康度钉是**既有 flaky**（与 agent-import 无关，连跑两次一红一绿），
   未处理，记账在此。
5. **交付口径**：本轮全程未接触真实 `~/.claude`（`AI-0b` 哨兵已把它纳入 mtime 比对），
   §4.1 有字段结论、无行为结论。

### 13.4 实现期回填（2026-09-15，PR2：dsh 适配器）

dsh 是第一个「**一份 build() 供三种写入形状**」的适配器，引擎因此多了四件东西（都对既有适配器零行为变化，
由原全量绿 + 黄金指纹 `sha256:d47361…` 未动来保证）：

| 新增 | 位置 | 为什么不是适配器自己的事 |
|---|---|---|
| `TargetSpec.blockKeys?: string[]` | `blockValueOf()` | 块型写入点原本整包吞 `build()`。dsh 的 built 同时带着 provider 块、凭据引用、模型指针三段，不切分就会把 **key 明文与指针当 provider 字段**写进 settings.yaml。（块型仍是 `writtenKeys` 之外的独立语义，指纹域不受影响） |
| `Adapter.preflight?(ctx)` | planLink 报错面 | 「配置文件根本不在我们能写的位置」是**环境级否决**，不是黄字提示：`DSH_HOME` 非默认、凭据库尚未生成，两种都该拒写而非警告 |
| `PlanCtx.prevLink` + noop 记账 | applyLink noop 分支 | 见 DR-AI-N。账本被新回执整条替换是既有事实，「noop 也是我方声明的一部分」这件事以前没人记 |
| 块型覆盖告警 | planLink warnings | 见 DR-AI-O。这是 zcode/omp 同样适用的通用真话，不写在 dsh 私有 warn 里 |

**踩到的两个测试侧假象**（都不是产品缺陷，但都差点让我把结论写错）：
- `ai.readYamlFile()` 返回的是 `{ ok, state }`，取内容要 `.state.data`；我按「返回文档」写，读出来是
  `{ok,state}` 的键名，一度以为写入把整个 namespace 弄坏了。
- `JSON.stringify([undefined])` 打成 `[null]`。AI-67 的 detail 因此显示「块还在，值是 null」，
  而盘上根本没有那个键——**detail 里别放裸 stringify 的可疑值**，改成一排布尔。

**交付口径**：dsh 的规格是代码级核实（v0.1.5-rc.2 的 zod schema + 解析代码 + 包内文档）+ 真机配置**副本**
彩排（撤销后凭据库语义零差异）；**没有做真机写入实验**——我们就跑在那份配置上，写坏了是自我毁灭，
不适合当测试床。未实测的三条挂 V11/V12。计数：e2e **453**、hardening **216**（UI 是适配器无关的，未新增）。另收紧一处与 dsh 无关的全局面：`.own-api-bak` 备份一律 chmod 0600（钉 AI-69）——历史上 zcode 那种 0644 源文件的备份会带着明文 key 躺在世界可读的权限上。

## 14. 真机待核实（**开工前必须清掉，不许把猜测当已确认**）

| 编号 | 待核 | 影响 | 核实方法 |
| --- | --- | --- | --- |
| V1 | ~~dsh 凭据登记是否有官方写入口，`refs` 能否安全追加~~ | **已核实（2026-09-15，读运行中的实现）**：官方写入口是**进程内 seam**（`ctx.settings.mutate` / `ctx.credentials.set`），**没有 CLI 命令**；但两个文件的**外部编辑是官方支持的场景**（`watch:true` 热发布；settings 侧写持 `<file>.lock` 跨进程锁 + 保注释 + 保留他人 namespace；credentials 侧「你可以直接编辑该文件——存储会自动重载」）。所以照契约写文件即可，`refs` 是纯 map，追加一格安全。DR-AI-J 随之重开并关闭 | 已完成（出处：`@deepseek-ai/dsh-settings-file`、`-credentials-local`、`-llm-pi-ai` v0.1.5-rc.2 README + `lib/index.js`） |
| V2 | ~~`providers.<id>` 是否支持内联 `apiKey`~~ | **已核实：不支持**。profile 字段白名单里没有 `apiKey`，只有 `apiKeyEnv: z.string().role("credential-ref")`。两条硬结论直接进了设计：① 明文**必须**落凭据库 `refs`（不是 settings.yaml）；② 配了引用却解析不到值 → `MISSING_CREDENTIAL` **明确失败**，不会静默用环境里的无关密钥，也不会回落到陈旧 `records`（`apiKeyEnv` 优先于已存记录） | 已完成（同上） |
| V3 | opencode 配置字段域（`npm` 包名、`options.baseURL`/`apiKey`、`models` 必填性） | P1 opencode 开工前置 | 本机装一份实测 + 官方 providers 文档对表 |
| V4 | ~~zcode 自定义 provider 是否接受非 UUID 的 id~~ | **已核实（2026-09-15 实机）**：接受，`provider.own-api` 启动后完整存活；顺带核实 `kind` 枚举是 `anthropic`/`openai-compatible`，并发现它会规范化我们写的块（§4.3） | 已完成：备份 → 写入 → 启动 ZCode 3.10.2 → 比对 |
| V5 | Windows 下各配置目录与文件（`%USERPROFILE%\.claude` 等）与 0600 语义 | 安装包是双平台的；Windows 侧当前仅「规则推导」未实测 | Windows 机器实装一轮；权限退化按 README 既有 EFS/BitLocker 口径说明 |
| V6 | ~~zcode/dsh 的 `reasoning.variants` 是否可由我们投影~~ | **部分核实**：zcode 侧字段存在且**它自己会按模型名补全**（实测 `GLM-5.3-Flash` 被补 `low/max/high`）→ 结论是**不投影**（投了被覆盖）。网关侧本就没有 reasoning 档位数据，dsh 的 `reasoningEfforts` 同理不投影 | 已完成（zcode 侧）；dsh 侧随 V1 一并看 |
| V7 | **Claude Code 无法本机验证**：本机已卸载（PATH 无 `claude`、npm `@anthropic-ai/` 空目录），只剩 `~/.claude` 残留配置。**〔实现已按 §1 口径交付：425 条 e2e 钉 + 2 条 UI 钉全绿，真身 0 次运行〕** | §4.1 全部字段来自**残留文件反推**，属「有配置无产品」；探针/撤销/生效方式（新开是否重读 env）均未跑过真身。**已知待实测的四条**：① env 与顶层 `model` 谁优先（§15-3）；② `ANTHROPIC_AUTH_TOKEN` 走 Bearer 是否被真身发出（网关侧 `extractClientKey` 已确认认 Bearer，反向未验）；③ 真身会不会自己重写 settings.json 从而弄乱我们的块（zcode 会规整、omp 不会，Claude 未知——这决定 drift 是不是真信号）；④ `/status` 到底读哪一处；⑤ `ANTHROPIC_DEFAULT_{SONNET,OPUS}_MODEL` 是否真按档生效（决定上面那条「切档 404」副作用有多常见，见 §4.1 末） | 需要一台装着 Claude Code 的机器（或临时重装）。**在此之前 §4.1 一律按「未实机验证」交付，不得写进 P0 完成口径**；测试侧唯一硬承诺由 `AI-0b` 哨兵守着：真实 `~/.claude/settings.json` 的 mtime 全程不变 |
| V8 | ~~ZCode 会在我们写入之后整块删掉 `provider.own-api`~~ | **已排除，且是一次错误的怀疑（2026-09-15）**：那条时间线（`14:37:39` 写入 → `14:39` 读到完好 → `14:40:48` 条目消失而它自家 9 个 provider 全在）**是本机所有者手动删除该条目以重做一次全新写入验证**造成的，不是 ZCode 裁剪。当时我只有文件时间戳、ZCode 又无可读日志，就写了两个候选根因——**这就是「拿时间线当证据」的代价**：观测面不够时，最省事的归因往往是最近动过手的那个 | 已关闭（人工确认）。**残留的真问题只有一个**：agent 运行/退出窗口内写入是否会被它退出时的回写吞掉——§4.3 已实测 zcode 启动即规范化并在退出时回写盘，故 §6.1 的「目标 agent 正在运行」判据仍应在 P1 补上；`missing` 态漂移检测是这类「条目凭空消失」的常驻兜底 |

| V9 | omp 的 `api` 在 **anthropic 协议**下该写什么（代码里暂写 `anthropic-messages`） | 本机这条链路是 openai 协议，openai 分支已实机验收；anthropic 分支是**按惯例推的**，写错=首发即失败 | 装一个只暴露 anthropic 端点的网关路由，或用真 Claude 上游跑一次；拿不到就在适配器交付口径里标注「anthropic 协议未实测」 |
| V10 | omp 是否**强制**要求模型条目带 `contextWindow`/`maxTokens` | 网关 catalog 若某模型没报限制，代码兜 `128000/8192`。兜底值本身是猜的 | 真机跑一次「模型缺这两个字段」的 catalog，看 omp 是报错还是自己兜底 |
| V11 | **dsh 的热发布未做真机写入实验**：文档说 settings/凭据两个 watcher 都会热发布（写完不用重启），但我们就跑在那份配置上，不做写坏即自毁的实验 | §4.4 与 UI 的 verify 文案「不用重启」目前是**文档级结论**，不是实测结论；若实际仍需重启，文案要给错 | 在一台不影响本会话的机器（或另一个 `DSH_HOME` + 独立 dsh 实例）上：写入 → 不重启 → 看模型清单是否出现 own-api |
| V12 | dsh 侧两处**不可见的外部因素**：① 若启动 dsh 的 shell 里已 `export OWN_API_API_KEY`，它会**遮蔽**我们写进 `refs` 的值（四层优先级第一层），我们从外部看不见；② 我们与 dsh 并发写 settings.yaml 的窗口（它持 `<file>.lock`，我们不持该锁） | ① 用户会看到「同步成功但 agent 用的还是旧 key」；② 极端时序下可能吞掉 dsh 刚写的一格（我们读-改-写之间它写了；反向由它的读-改-写兜住） | ① plan 阶段能否探到进程环境里同名变量（做不到就只在文档/UI 说明）；② 若要修就照它的协议先取 `<file>.lock`（`wx` 创建 + 2s 期限），或把写入窗口收到一次 rename 内 |

## 15. 遗留争点（评审时请逐条裁决）


1. **P1 的 catalog sync 是否需要「同步全部」一键**：逐个点在某些用户手里是五次点击。
   本设计倾向「同步全部」也必须有（预览仍是逐个 diff 汇总），但确认弹窗要显示全部将变更文件清单。
2. **探针 L1 消耗 RPM**：**已裁决并落地（PR1）**——不加「跳过探针」开关，改判语义：
   L1 遇 429 时回执 `verdict:"rate_limited"` 而非 `failed`，UI 显黄字「配置没问题，稍后再试」。
   理由：429 恰恰**证明**了鉴权与路由都通了（它是网关自己发的，没打到上游），把它算失败会逼用户
   去调高 rpmLimit 来「让探针变绿」——那是为了测试方便改生产配置，方向反了。
3. **Claude Code 的 `model` 顶层键**：写它会改变用户的默认模型。是否只做 `env.ANTHROPIC_MODEL`、把顶层 `model` 留空？
   （本设计当前写两者，因为只写 env 时部分版本仍以顶层 `model` 为准；此点未实测版本差异 → 评审裁决。）
   **2026-09-15 补充实况**：本机 Claude Code 已卸载（§14-V7），这条**在本机无法实机裁决**，只能靠另一台机器
   或临时重装。设计侧的缓解措施先定下，无论怎么裁决都成立：**顶层 `model` 的改写在预览里单独一行标黄**
   「这会改变 Claude Code 的默认模型（`X` → `Y`）」，撤销沿用「值仍等于我们写的值才还原」。
   倾向保留写两者——只写 env 会把上一家 provider 留下的 stale 顶层 `model`（本机残留实测是
   `deepseek-v4-flash[1M]`，在 own-api 里根本没登记）留在原地，那才是启动即 404 且看不出根源的形态。
   **2026-09-15 落地（仍未实机验证）**：按「写两者」实现，缓解措施照已定方案落进代码——顶层 `model` 真要改动时
   预览必出一条黄字（`TargetSpec.warn` → `plan.warnings`，钉 AI-49/AI-50），且**只在接管了 `default` 槽时才碰它**。
   裁决本身仍等有真身的机器：若实测证明 env 优先，撤掉顶层那条只要把 `CLAUDE.extra` 改成返回 `[]`，一行，
   不动其余设计——这正是当初把它单列成 `extra` 写入点的原因。
4. **omp 默认接管哪个角色槽（实现已如此，请追认或推翻）**：新接入默认勾上 `default` **一个**槽。
   一个都不勾的话 omp 仍走原供应商——用户点完「接入」看不到任何变化，功能等于没发生；
   九个槽全勾则是替用户改偏好，越过那条线了。折中点选 `default`（不打角色时用的就是它），
   其余 8 个槽默认不动、可勾、撤销逐键还原（DR-AI-I 已按此改注，真机验证只改勾选的两个）。
5. **换端口之后「同步」会被自己的规则拒掉（dsh 实现期发现，需裁决）**：§9-4 规定「同 id 但不是我们的形态 →
   拒覆盖」，而 `blockLooksOurs` 的比较基准是**本次要写的 baseUrl**（含端口）。于是网关从 `:8787` 换到 `:9000`
   之后，旧块 `…:8787/v1` 不再算我们的 → sync 直接报冲突拒写。可 UI 与 §6.5 恰恰把「网关换了端口」列为
   同步能修的事。**两头都有道理，不能都要**：放松成「同主机不同端口也算我们的」就能修端口，但也会把用户
   手动指向另一实例的条目抢过来。倾向：只在 sync 路径额外把**账本里记着的 `link.baseUrl`** 也认作我们的形态
   （账本证明那确实是我们写的那一份才放松），plan/apply 保持严格。当前行为已由 `AI-62a` 钉住（严格、拒覆盖），
   改法属裁决后开工。zcode/omp/dsh 三家同时受影响，不是 dsh 专属。
   **2026-09-15 已裁决并落地：采纳「认账本基址」**。`blockLooksOurs` 多收一个 `extraBases`，调用方在有账本时
   传 `[link.baseUrl]`，且 **plan / apply / sync 三处都传**（DR-CB：预览与提交必须同一把尺，否则会出现
   「预览说冲突、点同步却成功」）。没有账本（新接入、撤销之后）就一个字不放松，用户手写的同 id 条目照旧不抢。
   钉 `AI-70`（换端口 sync 修得好）/`AI-70b`（现值指向第三家仍拒），反证过：撤掉 sync 的 `oursBases` 只有
   `AI-70` 倒。附带修掉冲突文案里那个 `baseURL=?`——用户看到「被占用」第一反应就是「那它现在指着谁」，
   而旧文案只认 zcode 的 `options.baseURL`，YAML 系一律印问号（现由 `blockBaseOf()` 统一三处拼法，钉 AI-62a）。
