# 审查 B：安全、权限与文件写入边界

- **对象**：own-api v0.1.16，HEAD `2f6b1df`（工作目录 `/Users/wuminxuan/Desktop/test/llm-manager`）
- **范围**：`src/admin.ts`、`src/app.ts`、`src/config-bundle.ts`、`src/agent-import.ts`、`src/bootstrap.ts`、`src/ratelimit.ts`、`src/usage.ts`、`src/upstream.ts`、`src/sse.ts`、`src/store.ts`（写入/权限部分）、`web/index.html`、`src-tauri/src/lib.rs`（只读）
- **方法**：只读源码 + 在 `/tmp/audit-b` 下起隔离实例（端口 18901/18905，`OWN_API_DATA_DIR`/`OWN_API_AGENT_HOME` 全指向 `/tmp`）做黑盒实证；**未修改 `src/`、`test/`、`web/`、`docs/`；未运行 `test:all`/`test`/`test:hard`；未读写任何真实用户配置**
- **实证环境**（可复现）：
  ```bash
  mkdir -p /tmp/audit-b/{data,home}
  env -i PATH="$PATH" HOME=/tmp/audit-b/home OWN_API_DATA_DIR=/tmp/audit-b/data \
    OWN_API_AGENT_HOME=/tmp/audit-b/home OWN_API_PORT=18901 OWN_API_HOST=127.0.0.1 \
    ./node_modules/.bin/tsx src/index.ts
  # 辅助：/tmp/audit-b/mock.mjs（18902 恒 302 → 18903 记录收到的一切头）、echo.mjs（18904 回显 key）
  ```
  非回环分支的模拟手段：带 `x-forwarded-for: 8.8.8.8`（`isLocalish` 见到 XFF 即判非本机，`admin.ts:32-36`），已实测与管理端 "远程客户端" 走同一分支。

## 结论摘要

| 编号 | 严重度 | 结论 | 一句话 |
|---|---|---|---|
| SEC-B-01 | **P1** | 已证实缺陷 | `GET /api/snippet` 在非回环下仍把 vkey 明文塞进 `curl/openaiSdk/claudeCode/codexCli` 四个字段 |
| SEC-B-02 | **P1** | 已证实缺陷 | `reqBase()` 取请求 `Host` 头作为写进 agent 配置的 baseUrl，可被固化成任意外域 + 明文 vkey |
| SEC-B-03 | P2 | 已证实缺陷 | `POST /api/channels/:id/test` 跟随 3xx 并把上游 key 转发给重定向目标（代理主链明确拒绝 3xx） |
| SEC-B-04 | P2 | 已证实缺陷 | `.own-api.tmp` / `.own-api-bak` 同级路径未做 symlink 检查 → 任意文件覆盖 + chmod，且回执报成功 |
| SEC-B-05 | P2 | 已证实缺陷 | `blockLooksOurs` 用 `startsWith` 判归属，前缀碰撞的他人条目被当成"我们的"覆盖/删除 |
| SEC-B-06 | P2 | 设计取舍 | 向 0644 的用户配置文件写入 vkey 明文（有代码注释声明为有意） |
| SEC-B-07 | P3 | 已证实缺陷 | `/v1/messages/count_tokens` 不做 `allowedForKey`/模型存在性校验 |
| SEC-B-08 | P3 | 已证实缺陷 | 审计日志 `clientIp` 取自可伪造的 `x-forwarded-for` |
| SEC-B-09 | P3 | 已证实缺陷 | 全局 `onError` 把内部异常 message 原样回给客户端 |
| SEC-B-10 | P3 | 设计取舍 | channel baseUrl 可指向内网/元数据地址（本机代理的正当用法），无 DNS-rebinding 防护 |
| SEC-B-11 | P3 | 疑似/设计取舍 | SSE 订阅票据 10 分钟内可重放、不绑定来源 IP |
| SEC-B-12 | P3 | 设计取舍 | 鉴权失败桶满后**持正确令牌也被 429**（本机进程可锁死管理面） |
| SEC-B-13 | P3 | 设计取舍 | 启动横幅把 admin token 与默认 vkey 打到 stdout |
| SEC-B-14 | P3 | 设计取舍 | 每日 token 限额对"当天首发"无条件放行，单发可远超限额 |
| SEC-B-15 | P3 | 设计取舍 | SSE 超 8MB 帧原文冲刷、跳过 key 掩码 |
| SEC-B-16 | P3 | 设计取舍 | 控制台保留旧式 `#token=` 长期令牌入口 |
| SEC-B-17 | P3 | 设计取舍 | 块型 `.own-api-bak` 单代覆盖；同文件多写入点会把它改成"我们写过之后"的状态 |
| SEC-B-18 | P3 | 设计取舍 | 未鉴权 `GET /healthz` 泄露渠道/模型/vkey 计数 |

无 P0。**注**：P1 两条的触发前提都是"持有 admin token 的非回环调用方"（例如 `HOST=0.0.0.0` 下从局域网访问控制台，或令牌经其它途径外泄）；本机直达（无 XFF）时二者均不触发。之所以仍定 P1：它们各自绕过了项目明确写下的安全控制（A-M 掩码战役的 `reveal` 同源闸、§9-1「URL 永不来自请求」），且 SEC-B-02 会把明文 vkey 持久化到攻击者指定端点。

---

## 详细发现

### SEC-B-01（P1，已证实缺陷）`/api/snippet` 的明文 vkey 只掩了一个字段

**证据**：`src/admin.ts:887-901`
- `:894` 对 `key` 字段做了闸：`isLocalish(c) ? vk.key : '（明文 key 请在本机直连的管理台查看复制）'`
- `:896` `curl`、`:897` `openaiSdk`、`:898` `claudeCode`、`:899` `codexCli` 四个字段**无条件**内插 `${vk.key}`
- 对照闸门：`/channels?reveal=1`（`admin.ts:200`）、`/vkeys?reveal=1`（`admin.ts:482`）都要求 `isLocalish`

**攻击/触发路径**：拿得到 admin token 的非回环客户端（LAN 控制台 / 令牌外泄 / 反向代理后）`GET /api/snippet`，四个剪切板模板里直接带明文 vkey → 可冒用该 key 打 `/v1/*`（消耗额度、以该 key 身份出网）。

**实证**：
```
$ curl -s $B/api/snippet -H "x-admin-token: $T" -H "x-forwarded-for: 8.8.8.8"
{"baseUrl":"http://127.0.0.1:18901","key":"（明文 key 请在本机直连的管理台查看复制）",...
 "curl":"... -H \"Authorization: Bearer sk-lm-Inv2JJmWjegHAMcYcVAudWcQ\" ..." }   ← 明文仍在
$ curl -s ... -H "x-forwarded-for: 8.8.8.8" | grep -c sk-lm-Inv2JJmWjegHAMcYcVAudWcQ
1
```

**影响**：A-M 掩码控制被 `snippet` 单点绕过；vkey 明文落到 LAN 客户端/浏览器/日志。

**修复建议**：`snippet` 全字段统一用 `reveal` 布尔（`const reveal = isLocalish(c)`），非 reveal 时 4 个模板里的 key 一律替换成占位符（并同步 `curl` 里的 `-H`）。

---

### SEC-B-02（P1，已证实缺陷）写进 agent 配置的 baseUrl 来自请求 `Host` 头

**证据**：`src/admin.ts:675-677`
```ts
/** 写进对方文件里的网关基址：请求体里没有 URL 字段可传，只能由本机监听地址派生（探针同源同理） */
const reqBase = (c:any) => `${new URL(c.req.url).protocol}//${c.req.header('host') || `127.0.0.1:${...}`}`...
```
`:677` 把 `c.req.header('host')` 当基址。该基址经 `agentCtx`（`admin.ts:721`）→ `planLink`/`applyLink`（`agent-import.ts:1010,1099`）→ 写进 `~/.zcode/...`、`~/.omp/...`、`~/.claude/settings.json`、`~/.dsh/settings.yaml`，并落进账本 `link.baseUrl`（`agent-import.ts:1183`）。

**攻击/触发路径**：持 admin token 且 socket 回环（`agentWriteGate`，`admin.ts:673`）的调用方，请求头带 `Host: evil.example` → `POST /api/agents/apply {confirm:true}` → 四个 agent 的配置里 `baseURL` 变成 `http://evil.example` **且同文件写下明文 vkey**；此后该 agent 每次请求都把 vkey 与 prompt 发到攻击者主机。DNS-rebinding 页面天然满足"socket 回环 + Host=攻击者域"（但仍需 admin token，见摘要注）。

**实证**：
```
$ curl -s -X POST $B/api/agents/plan -H "x-admin-token: $T" -H "Host: evil.example" \
    -d '{"agentId":"zcode","vkeyId":"...","model":"m1"}'
{"baseUrl":"http://evil.example","steps":[{"after":{"options":{"apiKey":"sk-lm-***dWcQ",
 "baseURL":"http://evil.example"}}}]}
$ curl -s -X POST $B/api/agents/apply ... -H "Host: evil.example" -d '{...,"confirm":true}'
{"status":"success",...}
$ cat /tmp/audit-b/home/.zcode/v2/config.json
{"provider":{"own-api":{ ... "options":{"apiKey":"sk-lm-Inv2JJmWjegHAMcYcVAudWcQ",
 "baseURL":"http://evil.example"} ...}}}
```
对照：同端点 `POST /api/agents/:id/probe` 用的是 `selfBase()`（`admin.ts:844`，`index.ts:24` 注入），带 `Host: evil.example` 时 L1 仍返回 200 且命中本机 —— 说明基址本可以不走请求头。

**影响**：持久化的凭据+流量劫持（vkey 明文落到攻击者指定端点）；违反 `admin.ts:675` 与 `agent-import.ts` 文件头的"零外部入参"承诺。

**修复建议**：`reqBase` 改用 `selfBase()`（已在 `index.ts:24` 注入）；若确实需要 Host，则用白名单校验（必须命中本进程监听 host/port）后再用，否则回退 `selfBase()`。

---

### SEC-B-03（P2，已证实缺陷）连通性测试跟随 3xx 并把上游 key 转发给重定向目标

**证据**：
- 主代理链**明确拒绝** 3xx：`src/upstream.ts:134-147`（`redirect:'manual'` + 3xx → 502）
- 但 `POST /api/channels/:id/test` 的两处 fetch **没设** `redirect`：`src/admin.ts:284`（GET models）与 `:304`（最小对话），默认 `follow`
- 转发头含上游 key：`admin.ts:277-283`（anthropic → `x-api-key`；openai → `Authorization`）

**攻击/触发路径**：渠道上游（本项目核心场景就是第三方"中转"）返回 `302 Location: http://169.254.169.254/...` 或任意内网地址 → 控制台点"连通测试" → 网关替它去请求内网，并把 `x-api-key`（自定义头，undici 跨源重定向**不**剥离）带给目标。

**实证**（`mock.mjs` 18902 恒 302 → 18903 记录收到的头）：
```
$ curl -s -X POST $B/api/channels/ch_2dbe2d18d5c4/test -H "x-admin-token: $T"
{"...","results":[{"key":"SUPERS***7890","ok":true,"status":200,"models":["canary-model"]}]}
$ cat /tmp/audit-b/canary.log
{"port":18903,"method":"GET","url":"/canary/v1/models","headers":{
 "x-api-key":"SUPERSECRETKEY1234567890", ...}}      ← key 明文到达重定向目标
```
对照（同渠道走主链）：`POST /v1/chat/completions` → 502 `上游重定向被拒（302 → ...）：网关不跟随 3xx`。

**影响**：SSRF（打内网/元数据/本机其它服务）+ 凭据外送到重定向目标；与主链策略不一致。

**修复建议**：两处 fetch 加 `redirect:'manual'`，遇 3xx 直接算 `ok:false` 并回报"上游重定向被拒"；顺带对 `baseUrl` 增加私网/元数据网段告警（见 SEC-B-10）。

---

### SEC-B-04（P2，已证实缺陷）`.own-api.tmp` / `.own-api-bak` 未防 symlink → 任意文件覆盖

**证据**：`src/agent-import.ts:314-353`
- 备份：`:318-319` `backup = `${file}.own-api-bak`; copyFileSync(file, backup)` —— 同级可预测名，未 `lstat`
- 临时文件：`:330-343` `openSync(`${file}.own-api.tmp`,'w',mode)` → `renameSync(tmp, file)` —— 未 `O_NOFOLLOW`/未先 `lstat`
- 唯一的 symlink 防护 `statGate`（`:219-233`）只检查**最终目标**文件，不检查这两个前缀路径的兄弟文件
- 失败后**不自动回滚**（`:312` DR-AI-E 明示），`applyLink` 回读失败只报 `ok:false`（`:1160-1167`）

**攻击/触发路径**：本机同用户在 `<agent 配置文件>.own-api.tmp`（或 `.own-api-bak`）位置预置符号链接 → 用户点"一键接入/同步/撤销" → `openSync`/`copyFileSync`/`chmodSync` 跟随链接，把任意可写文件覆盖 + 改权限。这直接冲掉"本模块是全项目唯一被允许写数据目录之外文件"的边界。

**实证（tmp 变体）**：
```
$ ln -sf /tmp/audit-b/pwned-target /tmp/audit-b/home/.omp/agent/models.yml.own-api.tmp
$ curl -s -X POST $B/api/agents/apply ... -d '{"agentId":"omp",...,"confirm":true}'
{"status":"failed", steps:[{"file":".../models.yml","ok":false,
  "reason":"回读失败（目标是符号链接...）；备份在 undefined，未自动回滚"}]}
$ head -c 80 /tmp/audit-b/pwned-target
providers:                ← 原内容 "ORIGINAL-IMPORTANT-DATA" 已被覆盖（mode 0644→0600）
$ readlink /tmp/audit-b/home/.omp/agent/models.yml
/tmp/audit-b/pwned-target  ← 目标配置本身变成指向被劫文件的符号链接
```
**实证（bak 变体，且回执报 success）**：
```
$ ln -sf /tmp/audit-b/bak-victim /tmp/audit-b/home/.claude/settings.json.own-api-bak
$ curl -s -X POST $B/api/agents/apply ... -d '{"agentId":"claude-code",...,"confirm":true}'
{"status":"success", steps:[{"ok":true,"backup":".../settings.json.own-api-bak"}]}
$ stat -f '%Sp' /tmp/audit-b/bak-victim ; head -c 60 /tmp/audit-b/bak-victim
-rw-------                      ← 原 0644 被改
{ "env": { "KEEP": "me", "ANTHROPIC_AUTH_TOKEN": "sk-lm-Inv2JJmWjegHAMcYcVAudWcQ" ...  ← 明文 vkey 写进被劫文件
```

**影响**：任意文件覆盖/权限修改（同用户权限域内），并静默丢失数据；"拒写符号链接"这条控制被完全旁路。

**修复建议**：写前对 `tmp`/`backup` 两个路径先 `lstat`：存在即拒（或存在则用 `O_NOFOLLOW|O_EXCL` 打开，失败即拒）；`copyFileSync` 换成 `openSync(bak,'wx',0o600)` + 流式拷贝；`renameSync` 前再 `lstat(tmp)` 确认仍是普通文件。

---

### SEC-B-05（P2，已证实缺陷）归属判据用 `startsWith`，前缀碰撞条目被当成"我们的"

**证据**：`src/agent-import.ts:973-983`
```ts
const got = u.replace(/\/+$/, '');
return [baseUrl, ...extraBases].some((b) => got.startsWith(b.replace(/\/+$/, '')));
```
只做字符串前缀比较，没有 origin 边界（未要求 `got === b` 或 `got.startsWith(b + '/')`）。`planLink` 用它决定"不覆盖"（`:1034-1037`），`revokeLink` 用它决定"可删"（`:1295`）。

**实证**：
```
providers.own-api.baseUrl = http://127.0.0.1:18901.attacker.example/v1   （用户的、不是我们的条目）
$ POST /api/agents/plan {agentId:omp, model:m1}
{"errors":[],"steps":[{"state":"update","before":"http://127.0.0.1:18901.attacker.example/v1",
                              "after":"http://127.0.0.1:18901"}]}      ← 被判为"我们的"，直接覆盖
对照 baseUrl=http://other-gateway.example/v1 → errors:["...已被别的条目占用...拒绝覆盖"]
```

**影响**：越过"不覆盖非我方条目"（§9-4）与撤销归属判据；被覆盖条目的原 apiKey/模型清单随块型替换消失。触发需同 provider id + baseUrl 前缀碰撞，概率低但机制不成立。

**修复建议**：改为 origin 级比较：`new URL(got).origin === new URL(b).origin`（或至少 `got === b || got.startsWith(b + '/')`）；`extraBases` 同规。

---

### SEC-B-06（P2，设计取舍）vkey 明文写进 0644 的用户配置文件

**证据**：`src/agent-import.ts:317-343` —— 已存在文件写入时保持原 mode（`:339` `chmodSync(tmp, state.exists ? state.mode : 0o600)`）；备份才强制 0600（`:320-326`，注释明说"源文件宽是用户自己的选择，我们不替他收紧"）。Claude Code 的 `ANTHROPIC_AUTH_TOKEN` 就落在 `~/.claude/settings.json`（`:699-711`）。

**实证**：`/tmp/audit-b/home/.claude/settings.json` 预置 0644 → apply 后仍 `-rw-r--r--`，内含 `"ANTHROPIC_AUTH_TOKEN": "sk-lm-..."`；备份为 0600。

**判断**：文件头与注释都把它记为有意取舍（"我们不替他收紧"），故不判缺陷；但同机多用户/共享 HOME 场景下等价于向他人公开 vkey。**建议**：对"我方写入的密钥键所在文件"给出 UI 警告并在用户未显式反对时收紧到 0600（或至少提示）。

---

### SEC-B-07（P3，已证实缺陷）`count_tokens` 不做模型 ACL/存在性校验

**证据**：`src/app.ts:45-90` —— 只做 vkey 校验 + RPM + body 限额，没有 `store.findModelByName` / `allowedForKey`（对比主链 `gateway.ts:784-787`）。

**实证**：把 vkey 的 `allowedModels` 改成 `["m1"]` 后：
```
$ POST /v1/messages/count_tokens {"model":"echo1",...}          → {"input_tokens":5}   （被 ACL 拒绝的模型）
$ POST /v1/messages/count_tokens {"model":"totally-made-up",...} → {"input_tokens":2}   （不存在的模型）
$ POST /v1/chat/completions     {"model":"echo1",...}            → 404 model_not_found  （主链对照）
```
**影响**：ACL 一致性缺口（可探测"某模型是否存在于网关配置"的弱信号 + 计费估算差异），无实际数据外泄。
**修复建议**：`count_tokens` 复用 `resolveRoute` + `allowedForKey` 的校验（或至少校验模型存在且 key 可见）。

---

### SEC-B-08（P3，已证实缺陷）审计日志 `clientIp` 采信 `x-forwarded-for`

**证据**：`src/gateway.ts:1209`
```ts
clientIp: (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '').slice(0, 64) || undefined,
```
（限速与回环判定用的是不可伪造的 socket IP：`ratelimit.ts:16-28`、`admin.ts:32-36`；仅**日志字段**被污染。）

**实证**：`POST /v1/chat/completions -H "x-forwarded-for: 6.6.6.6, 7.7.7.7"` → `GET /api/logs` 该条 `clientIp: "6.6.6.6"`。
**影响**：审计/取证记录可被请求方任意伪造。
**修复建议**：日志同时记 socket IP（`clientIp(c)`）为 `sourceIp`，XFF 单列 `xff` 并标注不可信。

---

### SEC-B-09（P3，已证实缺陷）全局 onError 回显内部异常 message

**证据**：`src/app.ts:16-19` → `internal error: ${String(err?.message || err)}`。
**影响**：500 时把文件路径/内部实现细节回给客户端（含未鉴权路径）；与 "scrub 后回显" 的其它出口口径不一致。
**实证**：代码级；未能构造到 500 的输入（标"待核实"，见未覆盖清单）。
**修复建议**：对外统一 `internal error`，细节只进 `console.error`。

---

### SEC-B-10（P3，设计取舍）channel baseUrl 可指内网/元数据地址，无 DNS-rebinding 防护

**证据**：`store.ts:992-1006` 只校验 `http:`/`https:`；`buildUrl`（`upstream.ts:9-22`）原样拼接。`file://`/`gopher://`/`javascript:` 均被拒（实证见下），但 `http://169.254.169.254/...` 可入库。

**实证**：
```
config/import {"baseUrl":"file:///etc/passwd"}      → conflicts: ["baseUrl 无效：仅支持 http:// 或 https://"]
POST /api/channels {"baseUrl":"gopher://127.0.0.1"}  → 同拒
config/import {"baseUrl":"http://169.254.169.254/latest/meta-data"} → created:1（接受）
```
**判断**：本机代理需要指向 `http://127.0.0.1:11434`（ollama）等本地上游，黑名单会误伤，故属设计取舍；重定向已被主链拒绝（SEC-B-03 是例外）。**建议**：创建渠道时对 `169.254.0.0/16`、`metadata.google.internal` 给显式警告；对 `extraHeaders` 里的 Host/Authorization 覆盖给提示。

---

### SEC-B-11（P3，疑似/设计取舍）SSE 订阅票据可重放、不绑定来源

**证据**：`src/admin.ts:125-126`（TTL 10min）、`:152-158`（mint，需 admin token）、`:141-146`（只对 `path === '/logs/stream'` 放行 query 票据）。票据不记录 IP、不在使用后失效（非一次性）。
**实证**：mint 后 `curl "$B/api/logs/stream?ticket=$TK"` 成功；同一票据换端点 `?ticket=` 到 `/api/settings` 被 401（路径白名单有效）；伪造票据 401。
**影响**：票据 URL 若被代理日志/截图/Referer 外带，10 分钟内任何人可读实时日志；但日志本身不含 prompt/响应正文与 key（见 SEC-B-16 的日志字段核对）。
**修复建议**：票据绑定 `clientIp`，单次消费或缩短 TTL（重连走 mint）。

---

### SEC-B-12（P3，设计取舍）鉴权失败桶会把正确令牌一起 429

**证据**：`src/admin.ts:136-139` —— `failurePeek` 在 `safeEq` **之前**判定，且 `ratelimit.ts:1-11` 明示"成功不计数也不清零"。
**实证**：连续 21 次坏令牌后，即使带正确 token 也收到 `429 too many failed auth attempts`（`/api/logs/stream` 等实测）。
**判断**：注释记录了"失败才计数"的取舍（防洗白），但副作用是本机任意进程可用 21 次/min 的坏请求把控制台锁在 60s 窗口外（自 DoS）。**建议**：命中 429 前先验令牌，正确令牌放行且不计入桶（"失败计数不被成功清零"与"正确令牌不被误伤"可同时成立）。

---

### SEC-B-13（P3，设计取舍）启动横幅打印 admin token 与默认 vkey

**证据**：`src/index.ts:25-32`（`管理令牌 ${s.adminToken}`、`默认 Key ${vk.key}`）。`last-session.json` 已是 0600（`:34-42`），但 stdout 会被桌面壳/CI/终端 scrollback 收集。
**建议**：终端只打印掩码 + 首次启动引导；令牌仅经 `last-session.json` 传递。

---

### SEC-B-14（P3，设计取舍）每日 token 限额对"当天首发"无条件放行

**证据**：`src/usage.ts:91-105` —— `settled===0 && inFlight===0` 时无条件 `ok:true`（注释：防限额小于单发预占时永久锁死）。`estTokens` 由客户端 `max_tokens` 决定（`gateway.ts:792-795`）。
**影响**：每 key 每天可有一发明显超出 `dailyTokenLimit`（客户端可用超大 `max_tokens` 抬升预占与真实花费），属限额软边界。
**建议**：放行时把预占钳到 `dailyTokenLimit`，并在响应里带 `x-lm-warning`。

---

### SEC-B-15（P3，设计取舍）SSE 超 8MB 帧跳过 key 掩码

**证据**：`src/sse.ts:34`（`MAX_FRAME_BUF = 8MB`）、`:222-226` 超限原文 `controller.enqueue(enc.encode(buf))`，注释自承"超大帧放弃 scrub"。
**影响**：恶意上游把回显的池内 key 塞进 >8MB 未闭合帧即可绕过掩码链（对客户端可见）。已有内存/重扫上界，属有记录的取舍。**建议**：超限分支只冲刷到最后一个安全边界，或对含 `error` 的超帧截断后再发。

---

### SEC-B-16（P3，设计取舍）控制台保留旧式 `#token=` 长期令牌入口

**证据**：`web/index.html:122-124`（`#token=` 仍写 `localStorage.lm_token`）、`:100/1520-1522`（手动粘贴令牌）；新路径为 `#handoff=`（`:125-129`，60s 一次性票，`admin.ts:57-63`）。Tauri 侧首选 handoff、失败回退 `#token=`（`src-tauri/src/lib.rs:144-151`）。
**影响**：回退路径会把长期令牌放进浏览器历史（`history.replaceState` 只能清当前条的 hash）；旧桌面壳/书签场景残留。
**建议**：v1.x 后移除 `#token=` 分支，或仅允许 `http://127.0.0.1` 下使用。

---

### SEC-B-17（P3，设计取舍）块型备份单代、且被同文件多写入点覆盖

**证据**：`src/agent-import.ts:318-319`（同名 bak 每次覆盖）、`:1107-1171`（Claude Code 的 `env` 与顶层 `model` 是**两个**写入点、同一文件，各自走一次 `atomicWriteText`）。
**实证**：`{"env":{"KEEP":"me"}}` 经 apply（两个写入点）后，`.own-api-bak` 的内容是**第一个写入点之后**的状态（已含我方 key），而非 apply 前的原文 —— 即"写前备份"在该形态下不成立。
**影响**：块型无账本前值（`prev` 只服务 merge 型，`:1126-1138`）；重复 apply 后用户最早内容无法从 bak 还原。
**建议**：bak 名带序号/时间戳或按"文件+写入点"分别备份；或在计划里提示"本文件多写入点，备份仅代表最后一次写前状态"。

---

### SEC-B-18（P3，设计取舍）未鉴权 `/healthz` 泄露计数

**证据**：`src/app.ts:93-100` 返回 `channels/models/vkeys` 数量；对照 `/api/healthz`（`admin.ts:88`）只回 `{ok:true}`。
**影响**：未鉴权可探测"这台机器上是否跑着 own-api 及规模"（配合 `Host` 探测可辅助定位）。
**建议**：与 `/api/healthz` 对齐，只回 `{ok:true}`。

---

## 鉴权矩阵表（v0.1.16 / HEAD 2f6b1df）

图例：`admin` = 需 `x-admin-token`（或 `/logs/stream` 的 query `ticket`）；`vkey` = 需 `Authorization: Bearer` 或 `x-api-key`；`loopback` = 以 socket 对端判定的本机直连（XFF/Forwarded 存在即不算，`admin.ts:32-36`）；`ticket` = 一次性/短期票据。

### 顶层（`src/app.ts`）

| 方法 | 路径 | 鉴权 | 依据行号 |
|---|---|---|---|
| POST | `/v1/chat/completions` | vkey（+RPM+日额） | `app.ts:39-41` → `gateway.ts:682-697` |
| POST | `/v1/completions` | vkey | 同上（`ENTRYPOINTS` `gateway.ts:48`） |
| POST | `/v1/messages` | vkey | 同上（`gateway.ts:49`） |
| POST | `/v1/embeddings` | vkey | 同上（`gateway.ts:50`） |
| POST | `/v1/messages/count_tokens` | vkey + RPM（**无 ACL/存在性校验** 见 SEC-B-07） | `app.ts:45-61` |
| GET | `/v1/models` | vkey + RPM | `app.ts:42` → `gateway.ts:1303-1317` |
| GET | `/healthz` | **无**（回计数，SEC-B-18） | `app.ts:93-100` |
| GET | `/` `/favicon.ico` | 无（静态页/204） | `app.ts:105-110` |

### 管理面（`src/admin.ts`，挂载于 `/api`，`app.ts:102`）

| 方法 | 路径 | 鉴权 | 依据行号 |
|---|---|---|---|
| POST | `/api/shutdown` | admin + loopback（自校验，豁免中间件；失败进 adm 桶） | `admin.ts:73-87` |
| GET | `/api/healthz` | **无**（只回 `{ok:true}`） | `admin.ts:88` |
| POST | `/api/auth/handoff` | `ticket`（60s 一次性）+ loopback；票据猜测计数 | `admin.ts:91-105` |
| POST | `/api/auth/handoff/ticket` | admin + loopback | `admin.ts:109-121` |
| OPTIONS | `/api/*` | **无**（直接 `next()`，交由全局 CORS 处理） | `admin.ts:128` |
| POST | `/api/logs/stream/ticket` | admin（中间件保护） | `admin.ts:152-158`（中间件 `:127-149`） |
| GET | `/api/overview` | admin | `admin.ts:172` |
| GET | `/api/channels` | admin；`reveal=1` 另需 loopback | `admin.ts:198-201` |
| POST | `/api/channels` | admin；回执明文 key 另需 loopback | `admin.ts:204-218` |
| PATCH | `/api/channels/:id` | admin（+loopback 才回明文） | `admin.ts:221-229` |
| DELETE | `/api/channels/:id` | admin | `admin.ts:232-236` |
| POST | `/api/channels/:id/keys` | admin | `admin.ts:238-248` |
| PATCH | `/api/channels/:id/keys/:keyId` | admin | `admin.ts:250-257` |
| DELETE | `/api/channels/:id/keys/:keyId` | admin | `admin.ts:259-262` |
| POST | `/api/channels/:id/test` | admin（**跟随 3xx**，SEC-B-03） | `admin.ts:265-331` |
| POST | `/api/channels/:id/import-models` | admin | `admin.ts:334-365` |
| GET | `/api/routes` | admin | `admin.ts:393` |
| POST | `/api/routes` | admin | `admin.ts:404` |
| PATCH | `/api/routes/:id` | admin | `admin.ts:433` |
| DELETE | `/api/routes/:id/sticky` | admin | `admin.ts:452` |
| DELETE | `/api/routes/:id` | admin | `admin.ts:459` |
| POST | `/api/routes/:id/vision/reset` | admin | `admin.ts:935` |
| GET | `/api/vkeys` | admin；`reveal=1` 另需 loopback | `admin.ts:481-491` |
| POST/PATCH/DELETE | `/api/vkeys` `/api/vkeys/:id` | admin | `admin.ts:493-514` |
| GET | `/api/logs` | admin | `admin.ts:517` |
| GET | `/api/rollups` | admin | `admin.ts:529` |
| GET | `/api/logs/stream` | admin **或** query `ticket`（仅此路径） | `admin.ts:535` + `:141-146` |
| DELETE | `/api/logs` | admin | `admin.ts:569` |
| GET | `/api/stats`、`/api/stats/speed` | admin | `admin.ts:580-582` |
| GET | `/api/version` | admin | `admin.ts:584` |
| GET | `/api/version/check` | admin（出网到 `api.github.com` 固定 URL） | `admin.ts:585-614` |
| GET | `/api/config/export` | admin（导出不含任何密钥，实测） | `admin.ts:615` → `config-bundle.ts:8-57` |
| POST | `/api/config/import` | admin（自建体积闸；`baseUrl` 仅 http/https） | `admin.ts:616-650` |
| GET | `/api/settings` | admin（**不回显** `adminToken`，只回 `adminTokenSet`） | `admin.ts:655-659` |
| PATCH | `/api/settings` | admin（白名单 + 区间钳制） | `admin.ts:660-665` → `store.ts:75-166` |
| GET | `/api/agents` | admin（**无 loopback 闸**，回本机配置文件路径/漂移） | `admin.ts:725-743` |
| POST | `/api/agents/plan` | admin + loopback | `admin.ts:745-752` |
| POST | `/api/agents/apply` | admin + loopback + `confirm:true` | `admin.ts:754-765` |
| POST | `/api/agents/:id/sync` | admin + loopback + `confirm:true`（ctx 全由账本重建） | `admin.ts:770-802` |
| DELETE | `/api/agents/:id` | admin + loopback（`?force=1` 才清残留账本） | `admin.ts:804-825` |
| POST | `/api/agents/:id/probe` | admin + loopback；L2 另需 `confirm:true`；URL 恒取 `selfBase()` | `admin.ts:832-884`（`:844`） |
| GET | `/api/snippet` | admin（**非回环仍泄 vkey**，SEC-B-01） | `admin.ts:887-901` |
| GET | `/api/auto-health` | admin | `admin.ts:904` |
| POST | `/api/auto-health/reset` | admin | `admin.ts:927` |
| POST | `/api/auto-health/saturation/clear` | admin | `admin.ts:941` |
| * | 其它 `/api/*` | admin（`notFound` 在中间件之后注册） | `admin.ts:947` |

**未鉴权可达集合（实证）**：`GET /api/healthz` → `200 {"ok":true}`；`POST /api/auth/handoff`（无/坏票 → 401）；`GET /healthz`（顶层）；`/`、`/favicon.ico`。其余全部 `/api/*` 实测 401，超过 20 次失败后 429（SEC-B-12）。**未发现漏网鉴权的 `/api/*` 或 `/v1/*`。**

## 未覆盖清单 / 待核实

1. **未构造到 500**：SEC-B-09 只做到代码级证据（全局 `onError` 分支未在隔离实例上触发），标"待核实"。
2. **`src-tauri` 运行时**：未构建/运行桌面壳，`lib.rs` 的手写 HTTP 请求（`:64-79`、`:88-95`）只做静态阅读；`read_session`/`last-session.json` 竞态未实测。
3. **Windows 平台**：所有 mode(0600/0644) 结论基于 macOS/POSIX；`chmodSync` 在 Windows 上被 catch 吞掉（`agent-import.ts:322-326`、`:338-342`），实际权限语义未验证。
4. **`translation/协议转换`路径的伪造面**（`translate.ts`）不在本审查范围：未审 anthropic↔openai 映射是否可被恶意 body 触发原型污染/资源耗尽。
5. **DNS-rebinding 全链**：只验证了 `Host`/`XFF` 语义与 `isLocalish` 的 socket 判定；未用真实浏览器做 rebinding 演练（admin token 仍是硬门槛，见 SEC-B-02 注）。
6. **`mock-upstream.ts` / `scripts/` / `site/`** 未审（非生产入口）。
7. **压测类问题**（`/api/logs?limit=NaN` 返回全量、`from/to` 无界扫描）只做静态判断，未做资源耗尽实测。
8. **上游"重定向到 file://"**：undici 不支持该跳转，未单独验证；SEC-B-03 只需 http(s) 目标即可利用。

## 已确认有效的正面机制（避免误改）

- `safeEq`（`admin.ts:65-67`）与 `findVKey`（`store.ts:816-824`）都是 SHA-256 后再 `timingSafeEqual`，长度不泄露。
- 管理中间件注册顺序正确：`/api/healthz` 等豁免区在中间件之前（实测 200），`/logs/stream/ticket` 在其后（实测 401）。
- query token 只对 `path === '/logs/stream'` 生效（`admin.ts:141-146`），换端点实测 401。
- 代理主链 `redirect:'manual'` + 3xx→502（`upstream.ts:134-147`），实测拒绝。
- `file://`/`gopher://`/`javascript://` baseUrl 全部被 `normalizeBaseUrl` 拒（`store.ts:992-1006`）。
- 上游错误回显 key 经 `scrubSecret`（原文/URL 编码/base64/base64url）掩码（`gateway.ts:377`、`:432`、`:189-192`）；实测客户端只看到 `Bearer UPSTRE***3456`，`/api/logs` 无明文。
- `/api/config/export` 实测不含上游 key；`/api/settings` 不回显 `adminToken`；`db.json`/`last-session.json`/`.lock` 实测 0600（`store.ts:384-411`、`index.ts:34-42`）。
- agent-import 零路径入参实证：`agentId` 传 `../../../../etc/passwd`、绝对路径均 400；`plan/apply/sync/revoke` 非回环 403；目标为符号链接时 plan/apply 均拒写且目标未被改动；DSH_HOME 与 `<home>/.dsh` 不一致时 preflight 拒绝写入。
- `probe` 基址用 `selfBase()`，带 `Host: evil.example` 仍命中本机（与 SEC-B-02 对照）。
- 控制台全部 `innerHTML` 赋值点（`web/index.html:236,267,286,308,397,419,608,632,761,1030,1187,1188,1271,1376`）经逐点核对：均为清空或**纯常量/数值**拼接，未发现把服务端字符串插入 HTML 的 XSS 汇聚点（上游错误文案走 `textContent`/`el()` 文本节点）。
