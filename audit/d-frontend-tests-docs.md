# 审查 D：前端 XSS/正确性 + 测试与 CI 质量 + 文档漂移

- 仓库：`/Users/wuminxuan/Desktop/test/llm-manager`（own-api v0.1.16，HEAD `2f6b1df`）
- 范围：`web/index.html`(+ `src/web-html.gen.ts`)、`test/e2e.ts`、`test/hardening.ts`、`.github/workflows/*`、`scripts/*.mjs`、`docs/*.md`
- 方法：全文只读 + `/tmp` 下独立复现脚本（**未修改** `src/`、`web/`、`test/`、`docs/`、workflows；**未**运行 `npm test/test:all/test:hard`，未占用 18787/18099；未触碰真实用户目录）
- 复现脚本：`/tmp/xssproof/step1-usage.mjs`、`/tmp/xssproof/step2-e2e.mjs`（独立端口 18971/18972 + 临时数据目录）、`/tmp/xssproof/step3-window.mjs`

**结论分布**：26 条问题 —— P1×1、P2×8、P3×17；另有 1 条「设计取舍（非缺陷）」正向登记。
其中「已证实缺陷」22 条、「疑似」3 条、「设计取舍/一致性」1 条。

---

## 一、XSS / 注入

### D-01｜P1｜**已证实缺陷**：上游非数字 usage 字段 → 存储型 XSS（污染 `tip.innerHTML`）

**结论**：`usageFromOpenai` / `usageFromAnthropic` 对上游 `usage.*` **不做数值归一**；流式路径（`mergeUsage`）有 `typeof number` 闸，非流式路径（`applyUsage`）没有。畸形的第三方上游（本项目一等公民场景，见 SECURITY.md「对来路不明的转售渠道保持警惕」）返回字符串 usage 时，字符串会原样落库、原样经 `/api/logs` 吐出、在前端 `addAgg` 里被字符串拼接，最终经 `num()` 原样拼进 `tip.innerHTML`。CSP 的 `script-src 'self' 'unsafe-inline'` 不拦内联事件处理器，因此 `<img src=x onerror=…>` 会真执行。

**证据（file:line）**
- `src/translate.ts:460-468` `usageFromOpenai`：`promptTokens: u.prompt_tokens || 0`（无 `Number.isFinite` 归一）；`src/translate.ts:475-485` `usageFromAnthropic` 同。
- 对照 `src/translate.ts:489-493` `mergeUsage`：`if (typeof v === 'number' && v > 0)` —— **流式有闸**。
- `src/gateway.ts:1229` `Object.assign(u, emptyUsage(), …usageFromOpenai(json.usage))` —— 非流式无闸。
- `src/gateway.ts:1219-1225` `usagePatch()` 直接搬进 `RequestLog`；`src/admin.ts:517-525` `/logs` 原样 `c.json(...)`。
- `web/index.html:351` `b.pout += l.completionTokens || 0`（`0 + 字符串` = 字符串）；`web/index.html:165` `num()` 对字符串原样 `String(n || 0)`；`web/index.html:419-422` 把 `num(...)` 结果拼进 `tip.innerHTML`；`web/index.html:6` CSP 含 `'unsafe-inline'`。

**实测输出**（`npx tsx /tmp/xssproof/step1-usage.mjs` + `step2-e2e.mjs`）
```
[非流式] usageFromOpenai 返回: {"promptTokens":10,"completionTokens":"<img src=x onerror=\"globalThis.__pwned=1\">","cacheReadTokens":"9"}
[流式]   mergeUsage 后 completionTokens: 0 类型 number      ← 被 typeof number 闸拦下
[网关响应] status = 200
[落库日志] completionTokens = "<img src=x onerror=\"globalThis.__pwned=1\">"   ← 真网关 + 真 db.json
[前端聚合] b.pout = "0<img src=x onerror=\"globalThis.__pwned=1\">" 类型 string
[前端 num()] num(b.pout) = "0<img src=x onerror=\"globalThis.__pwned=1\">"
[tooltip] 赋给 innerHTML 的串 = <div>输出<span>0<img src=x onerror="globalThis.__pwned=1"></span></div>
[tooltip] 含可执行标签 = true | 含事件处理器 = true
[CSP] script-src 含 'unsafe-inline'（inline 事件处理器不被拦）=  true
```
（`cache_read_tokens` 同类字符串会走 `b.cr`/`b.cw` 进同一条 path。）

**影响**：本机管理台内的存储型 XSS。触发需管理员把使用统计页的图表悬停一次——而图表在畸形 usage 下必然画成 `NaN,NaN`，用户为排查反而更可能去悬停，触发路径现实存在。可读写管理令牌（`localStorage.lm_token`）、调用全部本机管理 API、经「接入 Agent」写本机配置文件。

**复现方式**
```bash
# 1) 纯解析层
npx tsx /tmp/xssproof/step1-usage.mjs
# 2) 端到端（独立端口 + /tmp 数据目录；含 mock 恶意上游）
npx tsx /tmp/xssproof/step2-e2e.mjs
# 手写等价复现：POST /v1/chat/completions，上游 usage 返回
#   {"usage":{"prompt_tokens":10,"completion_tokens":"<img src=x onerror=alert(1)>"}}
# 然后 GET /api/logs 观察 completionTokens 为字符串
```

**修复建议**
1. 根因收口在服务端：在 `usageFromOpenai`/`usageFromAnthropic` 出口把四个计数字段做 `Number.isFinite(v) && v > 0 ? v : 0`（与 `mergeUsage` 同规），或让 `applyUsage` 也走 `mergeUsage`。这样同时消灭落库污染与 `/api/stats` 的字符串求和。
2. 展示层去污：`web/index.html:419-422` 的 `tip.innerHTML` 改为 `el()` 构造（`.textContent`），把 `innerHTML` 从「数据拼接」降级为「仅静态骨架」。
3. 加污点回归钉（见测试缺口 T-2）。

---

### D-02｜P2｜**已证实缺陷**：同源字符串让概览图表与明细渲染崩（`toFixed` 抛 TypeError）

**结论**：与 D-01 同一根因的另一面。非数字 token 计数进入聚合后，`money()`（`.toFixed(4)`）与图表成本序列（`v.toFixed(4)`）会对字符串直接抛 `TypeError: v.toFixed is not a function`，`svgChart` 与概览渲染中断；`niceMax(Math.max(...))` 得到 `NaN`，折线与圆点坐标变成 `NaN,NaN`。

**证据**：`web/index.html:166`（`money`）、`web/index.html:382`（成本序列 `fmt`）、`web/index.html:353/357-362`（`niceMax`/`tokMax`）、`web/index.html:540/558`（`money(l.costUsd)`）。

**影响**：单条脏日志即可让「使用统计」页持续白屏/半渲染，属可用性缺陷；在 D-01 未修前与 XSS 同源。

**复现方式**：接 D-01 的 mock 上游打一次请求，然后打开控制台（或直接把 `/api/logs` 的第 0 条喂给概览聚合），观察 `money`/`toFixed` 抛错。

**修复建议**：同 D-01 第 1 条（服务端归一）为根治；前端 `num`/`money` 增加 `Number.isFinite` 兜底 `0`，并对 `b.pout/cr/cw/cost` 在 `addAgg` 里用 `Number(l.x) || 0` 显式转换。

---

### D-03｜P3｜**疑似**：`href` 直接取 GitHub API 返回值，无 scheme/主机白名单

**结论**：`releaseUrl`/`downloadUrl` 逐字来自 GitHub API 的 `html_url`/`browser_download_url`，前端直接赋给 `el('a', {href: …})`。若 `api.github.com` 的响应被污染（仓库被接管、企业代理/中间盒、DNS+证书层被攻破），`javascript:` 形式的 `href` 可点击执行。

**证据**：`src/admin.ts:606-607`（`rel.html_url` / `asset.browser_download_url` 未校验）、`web/index.html:766-767`（直接 `href: r.downloadUrl || r.releaseUrl`）。当前 CSP `default-src 'self'` 对 `javascript:` 导航的拦截受 `script-src 'unsafe-inline'` 影响，不可依赖。

**影响**：需要 GitHub 侧或传输层被攻破，现实概率低；但这是唯一一处「远端字符串 → URL 属性」的通道，纵深防御缺失。

**复现方式**：静态可证（读上述两处即可）；动态验证需伪造 GitHub 响应，本轮未做 → 标「疑似」。

**修复建议**：服务端只透出通过 `new URL(x)` 且 `protocol === 'https:'` 且 `hostname === 'github.com' || endsWith('.github.com') || === 'objects.githubusercontent.com'` 的值，否则置 `null`；前端对 `href` 再做一次 `try { new URL } catch` 兜底。

---

### D-04｜P3｜**设计取舍/残余风险**：全页仍有两处 `innerHTML` 数据拼接，且无钉把守

**结论**：`el()` 的 `html` 键确实已摘除（无任何 `el(..., {html: …})` 调用，全页 grep 为 0），这条审计动作**已落实**。但页面仍保留两处字符串拼 `innerHTML`：`web/index.html:397`（`wrap.innerHTML = s.join('')`，SVG 图表）与 `web/index.html:419`（`tip.innerHTML`）。经核对，`397` 的插值全部经 `Math.round`/日期派生，当前**不是**污点路径；`419` 是（见 D-01）。风险点在于「只剩两处、其中一处已可注入」这种局面没有被任何钉守住——hardening 的 DOM 桩把 `innerHTML` 实现为**空操作**（`test/hardening.ts:1038`），所以桩测试根本看不见这类缺陷。

**证据**：`web/index.html:114`（注释）、`web/index.html:397`、`web/index.html:419`、`test/hardening.ts:1038`。

**影响**：后续任一新增的数字字段变成字符串（例：上游 usage 变更、`/api/rollups` 字段类型漂移）都会重新打开注入面。

**修复建议**：把 `innerHTML` 列入禁用清单（除 `= ''` 清场外），用一条源码钉断言 `web/index.html` 中 `innerHTML` 只出现在 `= ''` 形式；同时按 D-01 第 2 条重写 `tip`.

**正向结论（无问题，已核实）**：全页无 `insertAdjacentHTML` / `document.write` / `eval` / `new Function`；`el()` 的属性**名**在全部调用点均为字面量（无法做属性名注入）；上游错误串、模型名、渠道名、key 名全部经 `setAttribute` 或 `createTextNode` 落地，安全。

---

## 二、前端正确性

### D-05｜P2｜**已证实缺陷**：KPI／明细窗口与图表桶不同锚，`L6` 注释只在「今天」档成立

**结论**：`from`（KPI、请求日志明细、模型筛选的窗口下界）与 `startT`（图表首桶）用了两套对齐算法，导致 `[from, startT)` 区间内的日志**计入 KPI／明细，却在图表里一个桶都没有**。24h 档差最多 1 小时、7 天与 30 天档各差**整整一个自然日**。`web/index.html:447` 的注释「L6：KPI 与图表桶同锚」与实现不符。

**证据**：`web/index.html:444-447`（`from`：`hours<=48` 时对齐到小时、否则对齐到日零点）、`web/index.html:498-505`（`startT = align(now - (hours*3600e3 - step))`；`hourly = hours==='day' || hours<=48`）。

**实测输出**（`node /tmp/xssproof/step3-window.mjs`，锚定 `now = 2026-10-19 17:18`）
```
档位 day  | from=2026/10/19 00:00:00 (KPI 覆盖 17.30h)  | 图表首桶=2026/10/19 00:00:00 桶数=18 → 同锚
档位 24   | from=2026/10/18 17:00:00 (KPI 覆盖 24.30h)  | 图表首桶=2026/10/18 18:00:00 桶数=24 → 差 1.00h
档位 168  | from=2026/10/12 00:00:00 (KPI 覆盖 185.30h) | 图表首桶=2026/10/13 00:00:00 桶数=7  → 差 24.00h
档位 720  | from=2026/9/19 00:00:00  (KPI 覆盖 737.30h) | 图表首桶=2026/9/20 00:00:00 桶数=30 → 差 24.00h
```

**影响**：同屏两个数字互相矛盾。「近 7 天」实际展示 8 个自然日的消耗；用户拿 KPI 对账图表趋势必然对不上，属统计口径正确性缺陷（直接影响 DR-17「让近 7 天/近 30 天档变成真实数字」的目标）。

**复现方式**：`node /tmp/xssproof/step3-window.mjs`（纯算术复刻，无网络）。

**修复建议**：单一来源——先算 `startT`，令 `from = startT`（并让 `logs` 的过滤、明细表、`fbar` 文案、图表共用它）；或反之让 `startT = align(from)` 并让桶数 = `hours + 1`。改完补 T-1 钉。

---

### D-06｜P2｜**已证实缺陷**：日账本伪日志未按档位过滤，与图表口径分裂

**结论**：`/api/rollups` 无 `from`/`to` 参数，返回**全部**历史账本行；前端把全部行无条件并进 `aggLogs`。因此切到「今天」「近 24 小时」时，**任意历史日**的账本行仍会进 KPI（真实消耗/请求数/成本/缓存）、Provider 统计、模型统计；而图表因为 `buckets.get(align(ts))` 查不到桶而把它们丢掉。结果是同一屏「KPI 含 30 天账本 + 图表只画 24 小时」。

**证据**：`src/admin.ts:529-532`（`app.get('/rollups')` 无窗口参数）、`web/index.html:454-463`（`rollLogs` 全量 → `aggLogs = [...logs, ...rollLogs]`，`logs` 已按 `from` 过滤、`rollLogs` 没有）、`web/index.html:504`（`const b = buckets.get(align(l.ts)); if (b) addAgg(b, l);` —— 窗口外账本行静默丢弃）。

**影响**：与 D-05 叠加后，概览页存在三套口径（明细窗／KPI 窗／图表桶）。对「今天」档影响最大：账本是**永久**累积的（`MAX_ROLLUPS=6000` 行、按天裁），装过一段时间后 KPI 会长期高于图表。

**复现方式**：`node /tmp/xssproof/step3-window.mjs` 末段（算术论证）；动态复现需两个自然日的账本行，本轮未跑（不污染 Lead 端口）。

**修复建议**：二选一——①（推荐）`GET /api/rollups` 支持 `from`/`to` 或 `days` 参数，前端按档位请求；②前端在并入前按 `l.ts >= from` 过滤（注意 D-05 修完后再统一 `from`）。

---

### D-07｜P2｜**已证实缺陷**：`latN` 是死字段，平均延迟口径与设计文档不符

**结论**：设计文档明确定义 `latSumMs / latN` 为「平均延迟**原料**（和与样本数）……合并时才能精确加权」，但 `latN` **只写不读**：全仓（除 `types.ts` 声明与 `store.ts` 的写入/迁移）没有任何消费点。前端平均延迟用 `latSum / b.requests` 计算，而 `requests` 包含没有延迟样本的请求（`store.ts:946` 只在 `latencyMs > 0` 时才累 `latN`），所以账本行的平均延迟被系统性拉低；同表混排原始行（分母 = 请求数）与账本行（正确分母 = `latN`）时口径不一致。

**证据**：`docs/usage-rollup-design.md:36`（口径表）、`src/types.ts:278-279`、`src/store.ts:345`、`src/store.ts:946`、`src/store.ts:958`（写入侧）；`web/index.html:461`（`latencyMs: r.latSumMs || 0`）、`web/index.html:559`（`b.latSum / b.requests`，**未用 `latN`**）。
```
$ grep -rn "latN" src/ web/ test/ | grep -v web-html.gen
src/types.ts:279  latN: number;
src/store.ts:345, 939, 946, 958        ← 全部是写入/迁移，零读取
```

**影响**：Provider／模型统计的「平均延迟」列在跨越日志保留窗的长档下偏低；`latN` 字段长期占据 db.json 体积而无消费方。属口径缺陷 + 死字段。

**修复建议**：账本伪日志额外带 `_latN`，`groupAgg` 用 `latSum / (rawLatN + rollupLatN)`；或按文档精神让 `latN` 参与分母。若决定不实现，则应删掉 `latN` 并同步改文档（二选一，不能两边都留着）。

---

### D-08｜P3｜**已证实缺陷**：模型筛选下拉缺「只存在于账本」的模型，而它们会出现在统计表里

**结论**：`modelNames` 只从 `allLogs`（原始窗）派生，账本行的 `model` 不参与构建下拉项；但统计表（Provider/模型）用的是含账本的 `aggLogs`。因此长档下模型列会出现一个下拉里选不到的模型名。

**证据**：`web/index.html:450`（`modelNames` 仅来自 `allLogs`）、`web/index.html:451`（筛选）、`web/index.html:463`（`aggLogs` 含 `rollLogs`）、`web/index.html:550`（统计表键来自 `aggLogs`）。

**影响**：无法针对账本独有模型下钻；用户体验到「表里有、筛不了」。

**修复建议**：`modelNames` 并入 `rollLogs.map(r => r.requestedModel)` 后再去重排序。

---

### D-09｜P3｜**已证实缺陷**：`form()` 每次打开都往 `#dlg` 叠一个永不移除的 `close` 监听

**结论**：`form()` 每次调用都 `dlg.addEventListener('close', handler)`，从不 `removeEventListener`，整个会话内累积。功能语义正确（靠 `dlg.__form === myForm` 判归属），但属于无界监听器泄漏；长会话频繁开关表单会线性累积。

**证据**：`web/index.html:266`（无 `{once: true}`、无成对移除；对比 `web/index.html:151` 的 toast 搬运用了 `{ once: true }`）。

**影响**：轻微内存/回调开销增长，非功能性。P3。

**修复建议**：改为在 `submit`/`close` 后 `{ once: true }` 一次性注册，或每次 `form()` 前移除上一轮的监听（保存引用）。

---

### D-10｜P3｜**疑似**：概览页对 `/api/overview` 响应无形状校验，字段一改即白屏

**结论**：`o.channels.length`、`for (const c of o.channels)`、`r.candidates.length`、`allRoutes.routes` 等全部直接解构，无类型/形状守卫；而同一后端对不同端点用不同形状（`/api/overview` 的 `channels` 是数组，`/healthz` 的 `channels` 是数字，见 `web/index.html:1537`）。任一字段改名/改型，`go()` 的 catch 只会在「整页」粒度上兜底成一张错误卡。

**证据**：`web/index.html:468`、`568`、`581`、`922`、`1537`。

**影响**：接口与前端漂移时表现为白屏/半残；无编译期或运行时契约。归「疑似」（当前字段是对齐的，属健壮性缺口而非现存 bug）。

**修复建议**：为 `/api/*` 关键响应补一层轻量 `Array.isArray`/默认值归一；或在 e2e 里加「前端消费的字段集 ⊆ 服务端响应键集」的契约钉。

---

### D-11｜—｜**设计取舍（非缺陷，正向登记）**：视图代际（`myGen`）与孤儿定时器处理正确

**结论**：核对了任务点名的竞态面，**未发现缺陷**，登记为正向结论：
- `go()` 进入即 `clearInterval(timer)`（`web/index.html:280`），代际 `viewGen` 自增（`:279`）。
- `views.overview` 与 `views.models` 在 `await` 之后、挂定时器之前都校验 `myGen === viewGen`（`:434` + `:647`、`:838` + `:966`），过期响应直接 return，不会留下孤儿 interval。
- 失败分支也重挂定时器，同样受代际保护（`:305-311`）。
- 视图切换时 EventSource 正确关闭（`:281`；`logs` 内 `:1380`），SSE 首帧按 `seq` 去重（`:1383-1392`），票据过期最多重连 2 次（`:1399-1403`）。
- `hashchange` 与 `go()` 设置 `location.hash` 不构成回环（`curView` 在 `hashchange` 任务执行前已更新，`:283-284`、`:317`）。
- 输入焦点守卫对 `SELECT`/checkbox 的豁免有明确论证（`:294-298`）。

---

## 三、测试与 CI 质量

### D-12｜P2｜**已证实缺陷**：「空钉」——只断言 `web/index.html` 源码字符串在场，不断言行为

**结论**：hardening 里至少 **9 条**钉的判定式是纯源码 `includes()`（无任何 DOM/行为断言），另有 DR-14/16/17 三条「UI 钉」同样如此。最要命的是 `test/hardening.ts:1110-1111`：它把「DR-17 账本合并在场」钉成 `html4.includes('l._n || 1')` 这**一个字面量**，所以 D-05/D-06 两个窗口缺陷完全穿透——钉全绿而口径是错的。同理 `:1104` 钉的是 `groupAgg((l) => l.publicName || l.requestedModel)` 这个字符串。

**证据**：`test/hardening.ts:940`、`1096`、`1100-1102`、`1103-1104`、`1106-1107`、`1110-1111`、`1262`、`1276`、`1303`、`1329`、`1332`、`1333`、`1335`。

**影响**：这类钉只能防「有人删掉了消费端」这种最粗的回归；对「消费端逻辑写错」（阈值、窗口、权重、分母）零覆盖，且会给审查者「已被钉死」的假信心。

**修复建议**：把 `:1100-1111` 三条源码钉升级为行为钉——先在 hardening 已有的假 DOM 桩上真跑 `groupAgg`/`addAgg`（喂一组含账本行的数据），断言聚合数值；纯源码钉保留为辅助。

---

### D-13｜P2｜**已证实缺陷**：`.every()` 空数组永真（弱钉），且有一条显式跳过钉计入钉数

**结论**：多处钉的判定式以 `.every()` 收尾，数组为空即**恒真**：
- `test/e2e.ts:422`「续跳全 chain」——`lgDesc?.chainAttempts?.slice(1).every(...)`，若这次没发生续跳（数组长度 1），判定恒真，钉名承诺的语义完全没被检验。
- `test/e2e.ts:2106`「只在路由登记了窗口才写数字」——`models.every(...)`，`models` 为空数组时恒真。
- `test/e2e.ts:2254` R17-4 `roll1.every(...)`——依赖 `:2253` 的 R17-3 先通过；而 `check()` 失败不中断，R17-3 一旦红，R17-4 反而空真通过，**故障被掩盖**。
- 另有 `test/e2e.ts:190`、`426`、`1341`、`1488`、`hardening.ts:320` 同类形态（这几个当前由前置长度断言兜着，属次生风险）。
- `test/hardening.ts:584` 是显式 `check('…win 无模式位语义，跳过', true, 'win32')`——条件恒真，计入 220 条「钉」但不检验任何东西。

**证据**：上列 file:line。

**修复建议**：所有 `.every()` 前先断言 `length > 0`（或把长度并入判定式），例：`lgDesc.chainAttempts.length >= 2 && chainAttempts.slice(1).every(...)`；跳过场景改为不调用 `check`（或另计 `skip` 计数，不混入 pass）。

---

### D-14｜P2｜**已证实缺陷**：整份测试是串行单文件脚本，钉之间共享可变状态，无法单独运行定位

**结论**：两个测试文件都是无框架的顺序脚本，`check()` 只累计失败。钉之间通过 `VKEY`、`store` 单例、settings、`logRetention`、渠道/路由存量互相影响；`test/e2e.ts:1142-1151` 直接假设前面章节已建好渠道与 key（`chs[0].keys[0]`），`test/e2e.ts:2258` 注释自认「前面章节可能已触发过裁剪/清日志/换 key——不假设白纸」。后果：①任一钉红了无法单独重跑定位；②钉的通过与否依赖执行顺序，重构章节顺序会静默改变覆盖；③`test/e2e.ts` 里 `section('15. 修复战役回归断言')` 出现在 `section('16. …')` **之后**（`:1109` vs `:1140`），且 `1..9` 后直接跳 `14`（`:286`），章节编号已与现实脱节。

**证据**：`test/e2e.ts:1109`、`1140`、`1142-1151`、`2258`；`test/hardening.ts` 全篇顺序脚本。

**修复建议**：把「共享前置」显式化为 `setup()`，每个 section 声明依赖；章节编号重排并加「本 section 依赖的既有状态」注释；长期可考虑把纯函数域（`auto.ts`、`usage.ts`、`translate.ts`）拆出可单跑的单测文件。

---

### D-15｜P3｜**疑似**：真实 HOME mtime 哨兵在 dsh 进程内运行，存在假红风险

**结论**：`AI-0b` 会读取**真实** `~/.zcode/v2/config.json`、`~/.omp/agent/{models,config}.yml`、`~/.claude/settings.json`、`~/.dsh/{settings.yaml,.credentials.yaml}` 的 mtime 并在章节末尾比对。这是刻意的只读哨兵（`SECURITY.md` 有说明，所有写入都在 `OWN_API_AGENT_HOME` 沙盒内，本轮已核实沙盒注入生效：`test/e2e.ts:1611`）。但注释自己点出「dsh 就是跑着测试的这个进程」——若 dsh 在本轮测试期间重写自己的 settings/credentials（会话生命周期事件、watcher 热发布），哨兵会**假红**，且假红原因与 own-api 无关。

**证据**：`test/e2e.ts:1633-1641`（取真实基线）、`test/e2e.ts:2205-2210`（比对）。

**影响**：偶发 flake，且难以自证；在有真实 dsh 会话的开发机上概率非零。标「疑似」（本轮未观测到实际假红）。

**修复建议**：只对 `.claude`/`.zcode`/`.omp`（我们从不自动写、也不会有第三方写者）保留 mtime 哨兵；`.dsh` 两份改为「快照内容哈希不变」并允许 `DSH_HOME` 注入沙盒，或在检测到外部写入时降级为 `warning` 不判红。

---

### D-16｜P3｜**已证实缺陷**：端口全部硬编码，无探测/重试，测试无法并行或与其它任务同机

**结论**：`18787`/`18099` 写死在文件顶部，子进程额外用 `18810/18811/18812/18813/18654`。没有 `find-free-port` 或失败重试，也没有 env 覆盖口。结果：同机第二个实例直接 `EADDRINUSE`；CI 上也无法与其它 job 共享 runner；开发机上任何占用该端口的进程都会让测试假红。

**证据**：`test/e2e.ts:15`、`:21-22`；`test/hardening.ts:717/719/727/732/745/1401-1411/1563`。

**影响**：本轮审查本身就被迫回避这些端口（任务约束的直接来源）；也是测试基础设施的可用性缺陷。

**修复建议**：`const PORT = Number(process.env.TEST_PORT || 18787)`，起服务前用 `net.createServer().listen(0)` 探测；CI 里无冲突但仍可并行化。

**正向结论**：测试**不依赖真实外网**（`test/e2e.ts:696` 的 `https://example.com/a.png` 只是喂给 `count_tokens` 的输入串，应用不下载，`/api/version/check` 未被测试调用）；两个脚本的退出码正确（`test/e2e.ts:2286`、`test/hardening.ts:1634` 均为 `process.exit(failCount ? 1 : 0)`）；`test/e2e.ts:1137` 的 `WEB_HTML === web/index.html` 陈旧性守护与 `:1603` 的 `version.gen.ts ↔ package.json` 一致性守护，恰好补上了 CI 不跑 `gen:web` 的缺口（见 D-17）。

---

### D-17｜P2｜**已证实缺陷**：`ci.yml` 不跑 `npm run typecheck`，类型门只在发布时生效

**结论**：`ci.yml` 只跑 `npm ci` + `npm run test:all`；`typecheck` 仅出现在 `release.yml` 的质量门禁里。`tsx` 是**转译执行、不做类型检查**，所以一个纯类型错误可以一路合进 main 并通过 CI，直到有人推 `v*` tag 才暴露——而 release 的 `build` 是唯一质量门（`release.yml:52-57`），此时 tag 已推、发布流程已启动。

**证据**：`.github/workflows/ci.yml:18-19`（仅 `test:all`）；`.github/workflows/release.yml:54-57`（`gen:web` + `typecheck` + `test:all`）；`package.json` 有 `typecheck` 脚本但 CI 未用。

**修复建议**：`ci.yml` 加 `- run: npm run typecheck`（可再加 `- run: npm run gen:web && git diff --exit-code src/` 做生成物零漂移门，比 e2e 内的字符串比对更醒目）。

---

### D-18｜P3｜**已证实缺陷**：`ci.yml` 缺 `permissions`（非最小权限）与 `concurrency`

**结论**：`ci.yml` 没有 `permissions:` 块，`GITHUB_TOKEN` 取仓库默认权限（常见为 `contents: write`），而该 job 只需 `contents: read`；也没有 `concurrency:`，同一分支连续 push 会并行跑重复任务。对照 `pages.yml:9-16` 有 `permissions` + `concurrency`，`release.yml:12`、`:96` 有逐 job `permissions`。

**证据**：`.github/workflows/ci.yml`（全文无 `permissions`/`concurrency`）。

**修复建议**：加 `permissions: { contents: read }` 与 `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`。

---

### D-19｜P3｜**已证实缺陷**：Action pin 姿态不一致（同一仓库内混用 SHA 与浮动 tag）

**结论**：`release.yml` 全部 pin 到 40 位 SHA（供应链最佳实践），但 `ci.yml:13` 只 pin 了 `checkout`，`ci.yml:14` 的 `actions/setup-node@v4` 是浮动 tag；`pages.yml:24-26`、`:30` 四个 action **全部**浮动 tag。同一个受信任边界内两种标准，浮动 tag 可被上游强制推送劫持。

**证据**：`.github/workflows/ci.yml:13-14`、`.github/workflows/pages.yml:24-26`、`:30`、`.github/workflows/release.yml:30/40/43/46/50/85/103/111/144`。

**修复建议**：统一 pin 到 SHA（可加 Dependabot 的 `github-actions` 生态自动升级）。

---

### D-20｜P3｜**已证实缺陷**：版本一致性门只覆盖 `tag ↔ package.json`，`src-tauri/tauri.conf.json` 无前置门

**结论**：仓库里有**四处**独立维护的版本：`package.json`、`CHANGELOG.md`、`src/version.gen.ts`、`src-tauri/tauri.conf.json`。前置门只查 `tag ↔ package.json`（`release.yml:31-39`）；`version.gen.ts` 由 e2e 钉住（`test/e2e.ts:1603`）；`tauri.conf.json` 的 `version` **没有任何前置门**，而它决定 dmg/exe 的文件名（`productName: own-api`）。一旦不一致，会在 `release.yml:163-184` 的「发布后资产硬校验」才红——但那时 release 已 `draft:false` 公开（`:153`）。

**证据**：`.github/workflows/release.yml:31-39`、`:163-184`；`src-tauri/tauri.conf.json:3-4`；`scripts/prepare-desktop.mjs`（不写版本，已核实）、`scripts/build-sea.mjs`（不写版本）。

**修复建议**：`release.yml` 的版本一致性步骤补一行 `node -p "require('./src-tauri/tauri.conf.json').version"` 与 `package.json` 比对；更彻底的做法是让 `prepare-desktop.mjs` 从 `package.json` 回写 `tauri.conf.json`。

---

### D-21｜P3｜**已证实缺陷**：`sha256sums.txt` 带 `./` 前缀，且校验和自身无签名/证明

**结论**：`release.yml:129` 用 `cd artifacts && find . … | xargs sha256sum`，输出行形如 `<hash>  ./own-api_0.1.16_aarch64.dmg`。用户在其它目录执行 `sha256sum -c sha256sums.txt` 会因路径不存在而全部失败。校验和随 release 上传，但没有任何签名/attestation（`release.yml:144-151` 只传文件），下载者无法验证校验和本身未被替换。

**证据**：`.github/workflows/release.yml:127-129`、`:155-184`。

**修复建议**：`find … -printf '%f\n'` 或 `-exec basename {} \;` 去掉 `./`；如需可验证性，接 `actions/attest-build-provenance`（Sigstore）并公布公钥指纹。

---

### D-22｜P3｜**已证实缺陷**：发布后校验是「事后闸」，且 Windows 侧无包内冒烟

**结论**：资产逐项比对（`release.yml:155-184`）在 `softprops/action-gh-release`（`:144`）**之后**执行；失败时 workflow 会红，但 `draft:false` 的 release 已经公开，只能人工清理。另外包内冒烟只有 macOS（`:62-76`，验 dmg 内侧车 401），Windows 的 nsis 产物没有任何「装完能不能起」的等价验证，仅有文件存在性（`:80-84`）。

**证据**：`.github/workflows/release.yml:62-76`（`if: runner.os == 'macOS'`）、`:77-84`、`:144-154`、`:155-184`。

**修复建议**：把上传改为两步——先 `draft: true` 上传、跑完资产校验再 `gh release edit --draft=false`；Windows 侧加一条「解包后运行 sidecar，等 401」的冒烟（或说明为何不可行）。

**正向结论（CI/发布）**：`tag ↔ package.json` 门到位（`release.yml:31-39`）；`fail_on_unmatched_files: true`（`:154`）+ 平铺后 `N -ge 3` 硬校验（`:116-126`）+ 空 glob 前置 `ls`（`:77-84`）确实堵住了 v0.1.7/v0.1.10 那类「零匹配静默发空 release」；build 矩阵三个 runner 各自跑 `test:all`，端口不互抢；`workflow_dispatch` 被显式防呆拒绝发布（`:98-100`）。

---

## 四、文档漂移

### D-23｜P3｜**已证实缺陷**：`agent-import-design.md` §13.2 的度量数字全部滞后

**结论**：文档写「计数：e2e **395**、hardening **214**；`gen:web` **101.3 KB**」。实测：`check(` 出现次数 **e2e 473 / hardening 223**，`web/index.html` 为 **104.3 KB**（106,792 字节；`gen:web` 打印的正是该值）。且同一文档 `:752` 又引用了「为什么 395 条全绿」。

**证据**：`docs/agent-import-design.md:741`、`:752`；实测命令
```bash
grep -o "check(" test/e2e.ts | wc -l          # 473
grep -o "check(" test/hardening.ts | wc -l    # 223
node -e "console.log(require('fs').readFileSync('web/index.html','utf8').length/1024)"  # 104.3
```

**修复建议**：改成「截至 v0.1.16」并附生成命令，或干脆不写绝对数字（写「见 `npm test` 输出」）。

---

### D-24｜P3｜**已证实缺陷**：`DR-CB-G` 的「version ≤ 已知集合」在代码里是「version === 常量」

**结论**：文档裁决为「version **只接受 ≤ 已知集合**，大于 → 400；同 version 内新增可选字段不升版」，即应兼容旧版 bundle。代码是 `if (ver !== BUNDLE_VERSION) return {errors:[…]}`——**只接受精确相等**，任何更旧的版本都落到「version 无效」。当前 `BUNDLE_VERSION = 1`，故「≤ 已知集合」与「=== 1」等价，**暂无实害**，属文档超前；一旦升到 v2 就会出现「旧 bundle 被拒」与文档承诺相反的行为。

**证据**：`docs/config-bundle-design.md:256`；`src/config-bundle.ts:5`（`BUNDLE_VERSION = 1`）、`:125-129`。

**修复建议**：实现 `ver` 为「已知版本集合」的一员（`KNOWN_VERSIONS.has(ver)`）并为每版留迁移钩子；或把文档改成「当前仅支持同版本」并写明升版策略。

---

### D-25｜P3｜**已证实缺陷**：`DR-AI-I` 仍标「待 §15-4 追认」，而实现与钉早已落地

**结论**：`DR-AI-I` 正文写「实现改为默认只勾 `default` 一个槽（2026-09-15，**见 §15-4 待裁决**）」，§13.2 又写「角色勾选默认只接管 `default`（改动 DR-AI-I，**待 §15-4 追认**）」。但该行为已经实现并被钉死：前端 `defaultRoles()` 只返回 `['default']`，hardening 有真点击钉断言 `roles === '["default"]'`。文档把一个已交付且已验证的行为长期留在「待裁决」，读者无法判断它是稳定契约还是临时状态。

**证据**：`docs/agent-import-design.md:672`、`:739`；`web/index.html:1172-1179`；`test/hardening.ts:1126`（「默认只接管 default 一个槽」）。

**修复建议**：把 §15-4 该条标为已决（附裁决日期）或从「待裁决」列表中移出。

---

### D-26｜P3｜**已证实缺陷**：`#token=` 通道与两处文字（代码注释 + SECURITY.md）口径冲突

**结论**：`web/index.html:121` 的注释声明「管理令牌只从本地存储取：不走 URL，避免令牌进地址栏/浏览历史/任何访问日志」；但两行之后的 `:124` 仍在消费 `#token=`（`localStorage.setItem('lm_token', t)`），并在 `:129` 注释里承认为「旧版兼容」。`SECURITY.md` 则写「令牌经 URL 注入仅走 **60 秒一次性票据**，不落地 URL」。三处口径不一致：长期令牌仍可经 URL hash 注入（虽然 `history.replaceState` 会清掉它、fragment 不进 HTTP 请求，风险有限）。

**证据**：`web/index.html:121`、`:124`、`:129`；`SECURITY.md`（「部署须知」第 4 条）。

**修复建议**：二选一并同步三处——①删掉 `#token=` 兼容分支（保留 `#handoff=`），把注释/SECURITY.md 变成真话；②保留兼容但在 SECURITY.md 明确写出「旧版 `#token=` 仍被接受，属过渡通道，将在 vX 移除」，并加一条钉断言其存在与清理行为。

---

### D-27｜P3｜**疑似**：多条 DR 裁决在代码里没有锚点，可追溯性断裂

**结论**：文档声称「理论上每一条裁决都该在代码里落实」。逐 ID 核对（`grep -roh "DR-…" src/ web/ test/ scripts/`）：

| 文档族 | 文档中出现的裁决 | 代码/测试里有锚点的 | 无任何锚点的 |
|---|---|---|---|
| `agent-import-design.md` | DR-AI-A…O（11 条） | D、E、F、G、H | A、B、C、I、J、K、L、M、N、O |
| `config-bundle-design.md` | DR-CB-A…L（12 条） | A、E、G、K、L（+裸 `DR-CB`） | B、C、D、F、H、I、J |
| `speed-insights-design.md` | DR-SI-1…10 | 3、5、7、8、9 | 1、2、4、6、10 |

需要强调**这不等同于未落实**——抽查的几条其实都实现了（例：DR-CB-H「导入全程零外呼」已核实 `src/config-bundle.ts` 内无任何 fetch/HTTP 客户端；DR-CB-I「≥2 同名全链 conflict」已核实 `:203`；DR-SI-10「两表」已核实 `web/index.html:807-832`）。缺的是**代码→文档的回指锚**，导致审查者无法用 grep 回答「这条裁决落在哪一行」。

**证据**：上表；抽样验证见 §五 的逐条对照。

**修复建议**：给每条裁决在实现点补 `// DR-XX-Y：…` 注释（本项目已对 DR-14/16/17、DR-SI-3/8/9、DR-CB-K 这么做了，照此补齐即可），并在文档决策表加一列「代码锚点」。

---

## 五、测试缺口清单（建议补的钉，按优先级）

| 编号 | 缺口 | 建议钉（可执行断言） | 证据/理由 |
|---|---|---|---|
| **T-1** | **前端聚合口径零覆盖**：473+223 条钉里没有一条跑过 `addAgg` / `from` / `startT` / `buckets` / `svgChart`；只有源码串钉 | 把 `from`/`startT`/桶生成抽成纯函数导出，钉：①同一 `now` 下 `from === startT`（或桶覆盖恰等于档位）；②`Σ桶.requests === KPI.requests`；③「今天」档不并入历史账本行 | D-05、D-06；`test/hardening.ts:1110-1111` 只钉字面量 |
| **T-2** | **XSS 污点回归无钉** | ①服务端：mock 上游返回 `completion_tokens: "<img …>"` → 断言 `/api/logs` 的 `completionTokens` 为 `number` 且 `=== 0`；②页面：源码钉断言 `web/index.html` 无「`innerHTML` 赋值右侧含变量拼接」（仅允许 `= ''`） | D-01、D-02、D-04；hardening 的 DOM 桩把 `innerHTML` 做成空操作（`test/hardening.ts:1038`），天然看不见 |
| **T-3** | **`latN` 语义无钉（且字段是死的）** | 喂一组 `latencyMs` 含 0 与非 0 的日志 + 一组账本行，断言平均延迟分母为 `latN` 之和；顺带断言 `latN` 被读取（否则字段应删除） | D-07；`docs/usage-rollup-design.md:36` 与 `web/index.html:559` 冲突 |
| **T-4** | **`.every()` 空真守卫缺失** | 对 `chainAttempts.slice(1)`、`models`、`roll1` 等先断言 `length > 0`；把「跳过」计为 skip 而非 pass | D-13；`test/e2e.ts:422`、`:2106`、`:2254`、`test/hardening.ts:584` |
| **T-5** | **类型门缺失（CI 层）** | `ci.yml` 加 `npm run typecheck`；再加 `npm run gen:web && git diff --exit-code src/` 生成物零漂移门 | D-17；`tsx` 不检查类型，`typecheck` 只在 `release.yml:56` |
| **T-6** | **`src-tauri/tauri.conf.json` 版本无门** | `release.yml` 版本一致性步骤补该文件与 `package.json` 比对 | D-20；不一致时到「发布后校验」才红，而 release 已公开 |
| **T-7** | **固定端口 / 不可并行** | `TEST_PORT`/`TEST_MOCK_PORT` env 覆盖 + 端口探测 | D-16；本轮审查被迫回避 18787/18099 |
| **T-8** | **`#token=` 通道无钉、文档三处口径不一** | 要么删通道 + 钉断言「不消费 `#token=`」，要么钉断言「消费且 `replaceState` 清 hash」 | D-26 |
| **T-9** | **钉不可单跑、顺序敏感** | 显式 `setup()` 与 section 依赖声明；章节编号重排（现 `15` 在 `16` 之后、`1..9` 后直接 `14`） | D-14；`test/e2e.ts:1109`/`:1140`/`:2254` |
| **T-10** | **界面契约无钉** | 加「前端消费的字段集 ⊆ `/api/overview`、`/api/rollups` 响应键集」的契约钉 | D-10；`web/index.html:468/568/581` 全是裸解构 |

---

## 六、文档漂移表（逐文档）

| 文档 | 条目（file:line） | 文档主张 | 代码现状 | 判定 |
|---|---|---|---|---|
| `docs/usage-rollup-design.md` | `:36` | `latSumMs / latN` 是「平均延迟**原料**（和与样本数）……合并时才能精确加权」 | `latN` 只写不读（`src/store.ts:345/946/958`），前端用 `latSum / requests`（`web/index.html:559`） | **未落实**（D-07） |
| 同上 | `:66` | 账本「进聚合视图：KPI/趋势/Provider/模型统计」 | 进了，但**未按档位过滤**（`web/index.html:463`），与图表口径分裂 | **部分落实**（D-06） |
| 同上 | `:13` / `:68` | 「近 7 天/近 30 天档变成真实数字」；筛选「双匹配」 | 双匹配 ✓（`web/index.html:451`）；但窗口与图表不同锚（`from` vs `startT`） | **部分落实**（D-05） |
| 同上 | `:3` | 「守护断言：e2e §18（R17-1…R17-9）、hardening「UI 钉（DR-17）」」 | §18 的 9 条钉是行为钉 ✓；hardening「UI 钉（DR-17）」是**源码字面量钉** | **落实但强度不足**（D-12） |
| 同上 | `:47` / `:44` / `:58` / `:75-77` | 账本与原始窗不相交不双计；两条离场路径；`GET /api/rollups`；v4→v5 元素级清洗 | 全部落实：`src/store.ts:929-967`、`:913/919`、`src/admin.ts:529-532`、`src/store.ts:338-352`（`rollOK` 校验 `requests` 为 number） | **已落实** ✓ |
| `docs/config-bundle-design.md` | `:256` | `DR-CB-G`：version **只接受 ≤ 已知集合** | `src/config-bundle.ts:127` `ver !== BUNDLE_VERSION` → 只接受精确相等（当前 =1，等价；升版即反） | **文档超前**（D-24） |
| 同上 | `:167` | 未知字段白名单忽略 + 回执 warnings 列字段路径 | 落实：`src/config-bundle.ts:190/239/278`；e2e `:1394` 有钉 | **已落实** ✓ |
| 同上 | `:250-261` `DR-CB-A/B/E/H/I/J/K/L` | 按名引用 / bundle 恒不含密钥 / 待填密钥三处呈现 / 导入零外呼 / ≥2 同名全链 conflict / conflict 渠道 keys 不消费 / 导出启发式不阻断 / 全字段域比较 | 抽查全部落实：`buildBundle` 按名（`:56`）、无 HTTP 客户端（全文 grep 无 `fetch`）、`web/index.html:1051/702-707/685-701`、`:203/205`、`web/index.html:655-674` | **已落实** ✓ |
| `docs/speed-insights-design.md` | `:148-157` `DR-SI-1..10` | 后端端点 / 两表分列 / 与 `byRoutedTo` 逐字同键 / 不落库 / attempts>1 剔除 / 速度不进路由 / 499 拆列 / hours 归一钳制 / benchmark 后端单源 / 两表版式 | 全部核实落实：`src/admin.ts:582`、`web/index.html:807-832`、`src/usage.ts:239` 与 `:299` 表达式逐字相同、`src/usage.ts:293-294`（`Math.min(Math.max(Math.trunc(q),0),87600)` 与文档逐字一致）、`web/index.html:812/824`、`:1262-1276` 有「renderSpeedTab 不得自算百分位」抽源钉 | **已落实** ✓（代码锚仅 3/5/7/8/9，其余靠行为承载，见 D-27） |
| `docs/model-auto-design.md` | `:295-313` `C0-C18` | 粘性仅内存 / `weight=0` 硬过滤+逐出粘性 / 迟滞 0.4↔0.6 / 样本<3 不惩罚、全挂钳 0.1 / 粘性默认 300s / 悬空引用剔除+红标 / 429 判负续链 / 链预算 300s / 不进熔断探针 | 抽查落实：`src/auto.ts:12-14`、`:60-73`、`web/index.html:923/943`、`:1441`；C13「不进熔断/探针」与 `SECURITY.md` 一致 | **已落实** ✓（未逐条穷举，标「抽查通过」） |
| `docs/agent-import-design.md` | `:741` | 「计数：e2e **395**、hardening **214**；`gen:web` **101.3 KB**」 | 实测 `check(` = 473 / 223；`web/index.html` = 104.3 KB | **文档滞后**（D-23） |
| 同上 | `:672` / `:739` | `DR-AI-I` 改动「待 §15-4 追认」 | 实现 + 钉均已落地（`web/index.html:1172-1179`、`test/hardening.ts:1126`） | **状态未收口**（D-25） |
| 同上 | `:664-678` `DR-AI-A…O` | 11 条裁决 | 仅 D/E/F/G/H 在代码里有锚点 | **可追溯性断裂**（D-27，非未落实） |
| 同上 | `:664-678` 抽查 `DR-AI-B`（绝不自动同步） | 启动不写别人的配置 | 核实：写入只由前端显式点击触发（`web/index.html:1259-1265`），无启动期写路径 | **已落实** ✓ |
| `README.md` | `:39` | 一键接入支持 ZCode/omp/Claude Code/dsh；Claude Code **未实机验证** | 与 `SECURITY.md` 的 AI-0b 哨兵说明一致；`README.md:277` 目录树含 `src/agent-import.ts` | **一致** ✓（无漂移） |
| —（跨文件） | `web/index.html:121` / `:124` / `SECURITY.md` | 「令牌不走 URL」vs「仅走 60s 票据」 | `:124` 仍消费 `#token=`（长期令牌），`:129` 自认「旧版兼容」 | **三处口径冲突**（D-26） |

---

## 七、已核实为「设计取舍（非缺陷）」的项（避免误报）

1. **`DR-14` 的模型统计键与 `/api/stats.byRoutedTo` 不完全同键**：前端 `publicName || requestedModel`（`web/index.html:550`）vs 后端 `routedTo || (chainAttempts?.length ? requestedModel : publicName) || '-'`（`src/usage.ts:239`）。二者在「请求未及任何候选（如 404）」时分桶不同（前端归到请求名，后端归 `'-'`）。但 `DR-SI-3` 要求的是**速度页与 `byRoutedTo` 同键**，那条已逐字落实；统计页分桶属另一路径，且差异只出现在未归因请求上。判定：一致性瑕疵（P3 级），非缺陷。
2. **`applyUsage` 不做净输入减法**：`web/index.html:350` 与 `src/store.ts:942` 各自做 `max(0, prompt - cr - cw)`，服务端 `computeCost` 同口径，三处一致 ✓。
3. **`latSum / requests` 对原始日志是自洽的**：原始日志每条都参与计数，分母 `requests` 正确；问题只在混入账本行后（D-07）。
4. **`realTok = pin + pout + cr + cw`** 命名「真实消耗 Tokens」：口径是「全部计费 token（缓存不重复计）」，与 KPI 其余数字自洽 ✓。
5. **CSP 含 `'unsafe-inline'`**：单文件内联脚本架构下的必然选择（无构建期 nonce 注入点），且当前无 HTML 注入路径——但正因如此 D-01 才必须修（CSP 不是兜底）。
6. **macOS 仅 adhoc 签名（`signingIdentity "-"`）、无公证**：无 Apple Developer 账号下的取舍，`release.yml:2-3` 已写明；代价是 Gatekeeper 警告，属产品决策。
7. **测试读取真实 HOME 的 mtime**：刻意的只读哨兵，写入全在 `OWN_API_AGENT_HOME` 沙盒（`test/e2e.ts:1611` 已核实注入生效），并写进了 `SECURITY.md`。仅 `.dsh` 两份有假红风险（D-15）。

---

## 八、复现脚本清单

| 脚本 | 作用 | 端口/目录 |
|---|---|---|
| `/tmp/xssproof/step1-usage.mjs` | 证明非流式 usage 无类型闸、流式有闸 | 无网络 |
| `/tmp/xssproof/step2-e2e.mjs` | 端到端：mock 恶意上游 → 真网关 → 真 `db.json` → `/api/logs` → 前端 `num()`/`tip.innerHTML` 串 | 18971/18972，数据目录 `/tmp/xssproof/data`（用后自删） |
| `/tmp/xssproof/step3-window.mjs` | 算术复刻概览页 `from`/`startT`/桶，量化同锚偏差 | 无网络 |

三个脚本均**未**写入仓库、未占用 18787/18099、未触碰 `~/.own-api`、`~/.claude`、`~/.omp`、`~/.dsh`、`~/.zcode`。
