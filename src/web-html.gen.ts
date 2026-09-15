// 生成文件：由 scripts/gen-web-html.mjs 产出，勿手改（源头是 web/index.html）
export const WEB_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'" />
<title>own-api · 模型管理与统一代理</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --panel-2: #1c2230; --line: #262d3a;
    --fg: #e6edf3; --dim: #8b98a9; --dimmer: #5d6b7c;
    --accent: #4c8dff; --ok: #3fb950; --warn: #d29922; --err: #f85149;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft Yahei", system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 22px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 20; }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .3px; }
  header .sub { color: var(--dim); font-size: 12px; }
  nav { display: flex; gap: 4px; margin-left: auto; flex-wrap: wrap; }
  nav button { background: none; border: 1px solid transparent; color: var(--dim); padding: 6px 12px; border-radius: 7px; cursor: pointer; font-size: 13px; }
  nav button:hover { color: var(--fg); background: var(--panel-2); }
  nav button.on { color: var(--fg); background: var(--panel-2); border-color: var(--line); }
  main { padding: 20px 22px 60px; max-width: 1400px; margin: 0 auto; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: var(--dim); margin: 26px 0 10px; }
  h2:first-child { margin-top: 0; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .grid { display: grid; gap: 12px; }
  .cards { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .card .k { color: var(--dim); font-size: 12px; }
  .card .v { font-size: 22px; font-weight: 600; font-family: var(--mono); margin-top: 4px; }
  .card .v small { font-size: 12px; color: var(--dim); font-weight: 400; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--dimmer); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { padding: 9px 10px; border-bottom: 1px solid rgba(38,45,58,.6); vertical-align: middle; }
  tr:hover td { background: rgba(76,141,255,.05); }
  .mono { font-family: var(--mono); font-size: 12px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--line); background: var(--panel-2); color: var(--dim); }
  .pill.ok { color: var(--ok); border-color: rgba(63,185,80,.4); }
  .pill.err { color: var(--err); border-color: rgba(248,81,73,.4); }
  .pill.warn { color: var(--warn); border-color: rgba(210,153,34,.4); }
  .pill.oai { color: #79c0ff; } .pill.ant { color: #ffa657; }
  button.btn, input, select, textarea { font-family: inherit; font-size: 13px; }
  .btn { background: var(--panel-2); color: var(--fg); border: 1px solid var(--line); padding: 6px 12px; border-radius: 7px; cursor: pointer; }
  .btn:hover { border-color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.sm { padding: 3px 8px; font-size: 12px; }
  .btn.danger:hover { border-color: var(--err); color: var(--err); }
  input, select, textarea { background: #0b0f14; color: var(--fg); border: 1px solid var(--line); border-radius: 7px; padding: 7px 10px; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); }
  textarea { width: 100%; min-height: 78px; font-family: var(--mono); font-size: 12px; resize: vertical; }
  label { display: block; font-size: 12px; color: var(--dim); margin: 10px 0 4px; }
  .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0 14px; }
  .form .full { grid-column: 1 / -1; }
  .muted { color: var(--dim); }
  .err-text { color: var(--err); font-size: 12px; }
  .bar { height: 6px; border-radius: 4px; background: var(--panel-2); overflow: hidden; display: flex; min-width: 90px; }
  .bar i { display: block; height: 100%; background: var(--ok); }
  .bar i.e { background: var(--err); }
  pre.code { background: #0b0f14; border: 1px solid var(--line); border-radius: 9px; padding: 12px 14px; overflow: auto; font-family: var(--mono); font-size: 12px; margin: 0; white-space: pre-wrap; word-break: break-all; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
  dialog { background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; padding: 20px 22px; width: min(720px, 92vw); }
  dialog::backdrop { background: rgba(0,0,0,.6); }
  dialog h3 { margin: 0 0 6px; font-size: 15px; }
  #toast { position: fixed; right: 18px; bottom: 18px; display: flex; gap: 8px; flex-direction: column; z-index: 50; }
  #toast div { background: var(--panel-2); border: 1px solid var(--line); border-left: 3px solid var(--accent); padding: 10px 14px; border-radius: 8px; font-size: 13px; max-width: 420px; }
  #toast div.err { border-left-color: var(--err); }
  /* 软刷新：数据真变化时一次性柔和淡入（内容不变不触发；reduced-motion 由 prefers-reduced-motion 兜底） */
  #app.soft { animation: appSoft .5s ease; }
  @keyframes appSoft { from { opacity: .55; } to { opacity: 1; } }
  #gate { max-width: 420px; margin: 12vh auto; }
  .split { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; align-items: start; }
  @media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
  details summary { cursor: pointer; color: var(--dim); font-size: 12px; }
  .log-line { font-family: var(--mono); font-size: 11.5px; padding: 5px 8px; border-bottom: 1px solid rgba(38,45,58,.5); display: flex; gap: 10px; }
  .log-line:hover { background: rgba(76,141,255,.06); }
  .log-line .c { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>
<header>
  <h1>own-api</h1>
  <span class="sub" id="hdr-sub">统一模型代理网关</span>
  <nav id="nav" hidden>
    <button data-v="overview">使用统计</button>
    <button data-v="models">模型路由</button>
    <button data-v="channels">渠道与号池</button>
    <button data-v="vkeys">对外 Key</button>
    <button data-v="connect">接入方式</button>
    <button data-v="logs">请求日志</button>
    <button data-v="settings">设置</button>
  </nav>
</header>
<main id="main">
  <div id="gate">
    <div class="card">
      <div class="k">管理令牌</div>
      <p class="muted" style="margin:8px 0 14px">启动日志里的 <span class="mono">管理令牌</span>，填入后进入管理台。</p>
      <div class="row"><input id="token" type="password" placeholder="admin-..." style="flex:1" /><button class="btn primary" id="go">进入</button></div>
    </div>
  </div>
  <div id="app" hidden></div>
</main>
<div id="toast"></div>
<dialog id="dlg"></dialog>

<script>
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    // html 键已摘除（安全审计）：全页零使用的 innerHTML 原语，不留误用入口
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
// 管理令牌只从本地存储取：不走 URL，避免令牌进地址栏 / 浏览历史 / 任何访问日志
{ const h = new URLSearchParams(location.hash.slice(1)); const t = h.get('token'); const vw = h.get('view') || '';
  if (vw) localStorage.setItem('lm_view', vw); // 托盘「检查更新」深链：换票/清 hash 会抹掉视图，意图暂存，boot 一次性消费
  if (t) { localStorage.setItem('lm_token', t); history.replaceState(null, '', location.pathname); }
  const hd = h.get('handoff'); // 60s 一次性交接票据：换回真令牌后立刻清 hash，长期令牌不再进历史/日志
  if (hd) { history.replaceState(null, '', location.pathname);
    fetch('/api/auth/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: hd }) })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.token) { localStorage.setItem('lm_token', j.token); location.reload(); } }).catch(() => {});
  } } // 双击启动带 #handoff=（旧版 #token= 仍兼容）
let TOKEN = localStorage.getItem('lm_token') || '';
const api = async (path, opt = {}) => {
  const res = await fetch(path, { ...opt, headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN, ...(opt.headers || {}) } });
    if (res.status === 401) { const err = new Error('管理令牌无效，请重新输入'); err.status = 401; throw err; }
  const txt = await res.text();
  let body; try { body = txt ? JSON.parse(txt) : {}; } catch { body = { raw: txt }; }
  if (!res.ok) throw new Error(body?.error?.message || body?.error || \`HTTP \${res.status}\`);
  return body;
};
const toast = (msg, bad) => {
  const n = el('div', { class: bad ? 'err' : '' }, String(msg));
  $('#toast').append(n);
  setTimeout(() => n.remove(), bad ? 6000 : 2600);
};
// F4：http 非安全上下文无 navigator.clipboard（同步炸毁创建流）；掩码串被静默复制=用户拿假 key 配 agent
const copy = (t) => {
  if (!t) { toast('没有可复制的内容', true); return; }
  if (String(t).includes('*')) { toast('这是掩码串——明文 key 仅限本机直连获取', true); return; }
  const fb = () => window.prompt('请手动复制（Ctrl+C）：', t);
  try { navigator.clipboard ? navigator.clipboard.writeText(t).then(() => toast('已复制'), fb) : fb(); } catch { fb(); }
};
const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0));
const money = (n) => '$' + (Number(n) || 0).toFixed(4);
const ago = (t) => {
  if (!t) return '-';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + 's 前';
  if (s < 3600) return Math.floor(s / 60) + 'm 前';
  if (s < 86400) return Math.floor(s / 3600) + 'h 前';
  return Math.floor(s / 86400) + 'd 前';
};
const clock = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
const proto = (p) => el('span', { class: 'pill ' + (p === 'anthropic' ? 'ant' : 'oai') }, p === 'anthropic' ? 'Anthropic' : 'OpenAI');

// ---------------- 弹窗表单 ----------------
let formSeq = 0;
function form(title, fields, onSubmit) {
  const dlg = $('#dlg');
  const inputs = {};
  const body = el('div');
  for (const f of fields) {
    body.append(el('label', {}, f.label));
    let node;
    if (f.type === 'select') {
      node = el('select', {}, ...(f.options || []).map((o) => el('option', { value: o.value, ...(f.value === o.value ? { selected: '' } : {}) }, o.label)));
    } else if (f.type === 'textarea') {
      node = el('textarea', { placeholder: f.ph || '' }, f.value || '');
    } else if (f.type === 'cands') {
      node = el('div');
      const opts = f.options || [];
      const rows = [];
      const syncDup = () => {
        const used = new Set(rows.map((r) => r.sel.value).filter(Boolean));
        for (const r of rows)
          for (const op of r.sel.options)
            if (op.value) op.disabled = used.has(op.value) && op.value !== r.sel.value;
      };
      const addRow = (val, w) => {
        const sel = el('select', { style: 'flex:1;min-width:0' }, el('option', { value: '', disabled: '' }, '选择模型路由…'),
          ...opts.map((o) => el('option', { value: o.value }, o.label)));
        if (val && opts.some((o) => o.value === val)) sel.value = val;
        const wt = el('input', { type: 'number', value: w ?? 1, min: '0', step: 'any', style: 'width:64px', title: '权重（相对占比，0=禁用）' });
        const row = el('div', { class: 'row', style: 'margin:3px 0;gap:6px' }, sel, wt, el('button', { class: 'btn sm', title: '移除', onclick: () => { row.remove(); rows.splice(rows.indexOf(r), 1); syncDup(); } }, '✕'));
        const r = { sel, wt };
        sel.addEventListener('change', syncDup);
        rows.push(r);
        node.insertBefore(row, addBtn);
        syncDup();
      };
      const addBtn = el('button', { class: 'btn sm', onclick: () => addRow() }, '+ 添加候选');
      node.append(addBtn);
      for (const c of (f.value || [])) addRow(c.routeId || c.name, c.weight);
      if (!rows.length && opts.length) addRow();
      node.__get = () => rows.map((r) => ({ routeId: r.sel.value, weight: Number(r.wt.value === '' ? 1 : r.wt.value) }));
      if (!opts.length) { node.prepend(el('div', { class: 'muted', style: 'font-size:12px' }, '还没有模型路由——先到「模型」页登记后再来')); addBtn.disabled = true; }
    } else if (f.type === 'check') {
      node = el('input', { type: 'checkbox', ...(f.value ? { checked: '' } : {}) });
    } else {
      node = el('input', { type: f.type || 'text', value: f.value ?? '', placeholder: f.ph || '', step: f.step });
    }
    node.style.width = '100%';
    inputs[f.name] = node;
    body.append(el('div', { class: f.full ? 'full' : '' }, node));
    if (f.hint) body.append(el('div', { class: 'muted', style: 'font-size:11px;margin-top:3px' }, f.hint));
  }
  // 联动下拉：依赖字段（如上游渠道）变化时，重填本字段的 options
  for (const f of fields) {
    if (f.type === 'select' && f.depends && f.optionsFor && inputs[f.depends]) {
      const target = inputs[f.depends];
      const populate = () => {
        const opts = f.optionsFor(String(target.value)) || [];
        const cur = inputs[f.name];
        cur.innerHTML = '';
        for (const o of opts) {
          const attr = { value: o.disabled ? '' : o.value };
          if (o.disabled) attr.disabled = '';
          cur.append(el('option', attr, o.label));
        }
        if (f.value && opts.some((o) => String(o.value) === String(f.value))) cur.value = String(f.value);
        else { const first = opts.find((o) => !o.disabled); if (first) cur.value = first.value; }
      };
      target.addEventListener('change', populate);
      populate();
    }
  }

  const myForm = ++formSeq; // 表单叠开（类型选择→具体表单）时的本实例标识
  let formClosed = false; // 链式弹窗：预览在途取消则不再放孤儿确认幕
  const saveBtn = el('button', { class: 'btn primary', onclick: () => submit() }, '保存');
  let submitting = false; // F2：双击保存=双发 POST（渠道会真建两条），在途一律吞掉
  const submit = async () => {
    if (submitting) return;
    submitting = true;
    saveBtn.disabled = true;
    const vals = {};
    for (const f of fields) vals[f.name] = f.type === 'cands' ? inputs[f.name].__get() : inputs[f.name].type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value;
    try { await onSubmit(vals, { cancelled: () => formClosed || dlg.__form !== myForm }); if (dlg.__form === myForm) dlg.close(); }
    catch (e) { toast(e.message, true); saveBtn.disabled = false; submitting = false; }
  };
  if (dlg.open) dlg.close(); // 叠开先退旧场再入幕
  dlg.__form = myForm;
  dlg.addEventListener('close', () => { if (dlg.__form === myForm) formClosed = true; });
  dlg.innerHTML = '';
  dlg.append(el('h3', {}, title), body, el('div', { class: 'row', style: 'margin-top:18px;justify-content:flex-end' },
    el('button', { class: 'btn', onclick: () => dlg.close() }, '取消'),
    saveBtn));
  dlg.showModal(); // M1（修订）：先 close 化解旧 InvalidStateError；上一版「已开则跳过」反而把刚打开的新表单关掉
}

// ---------------- 路由 ----------------
const views = {};
let timer = null;
let viewGen = 0;
function go(v, opts = {}) {
  const gen = ++viewGen; // M4：视图代际守卫——慢视图的过期响应不得覆盖新视图
  clearInterval(timer);
  if (v !== 'logs' && es) { es.close(); es = null; }
  const sameView = v === curView && !opts.force; // 同视图软刷新：不清场、不闪 loading，数据备好再一次性替换
  location.hash = v;
  curView = v;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  if (!sameView) { $('#app').innerHTML = ''; $('#app').append(views.loading()); }
  const keepScroll = sameView ? window.scrollY : 0;
  Promise.resolve((views[v] || views.overview)()) // L1：未知 hash 回落概览，不再白屏炸掉
    .then((node) => {
      if (gen !== viewGen) return;
      const app = $('#app');
      const cur = app.firstElementChild;
      if (sameView && cur && cur.outerHTML === node.outerHTML) return; // 数据没变：零 DOM 扰动直接跳过
      const ae = document.activeElement; // 用户正在输入：本轮不替换（不抢焦点，下轮自愈）
      // 只豁免文本录入（TEXTAREA / 文本类 INPUT）。SELECT 与 checkbox 是离散控件：change 即"决定已完成"，
      // 而此刻焦点恰好就在该控件上——若一并守卫，筛选切换的刷新会被吞掉，且控件保持聚焦期间每轮 tick 持续被吞，
      // 表现为"切换模型/时间无效"。替换后新控件按 state 重建 selected，无感。
      if (sameView && ae && app.contains(ae) && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && !/^(checkbox|radio|button|submit)$/.test(ae.type || '')))) return;
      app.replaceChildren(node);
      if (sameView) {
        window.scrollTo(0, keepScroll); // 替换是同步的，滚回原位防高度微差抖动
        app.classList.remove('soft'); void app.offsetWidth; app.classList.add('soft');
      }
    })
    .catch((e) => {
      if (gen !== viewGen) return;
      if (sameView) { toast('刷新失败：' + e.message + '（已保留当前画面）', true); } // 软刷新失败不清场——陈旧好过空白
      else { $('#app').innerHTML = ''; $('#app').append(el('div', { class: 'card err-text' }, e.message)); }
      // M4：失败分支同样重挂刷新计时——瞬时抖动不该让挂机页失去自愈
      if (v === 'overview' && ovSt.refresh > 0) timer = setInterval(() => go('overview'), ovSt.refresh * 1000);
    });
}
// F8：行内启停/删除按钮此前无 catch——失败静默像成功。一张全局网兜住所有未处理拒绝（也兜未来的）
addEventListener('unhandledrejection', (e) => { toast('请求失败：' + ((e.reason && e.reason.message) || String(e.reason)), true); e.preventDefault(); });
// F10：Back/Forward 此前只改地址栏不换视图（无 hashchange 监听）
let curView = 'overview';
addEventListener('hashchange', () => { const v = location.hash.slice(1) || 'overview'; if (v !== curView) go(v); });

views.loading = () => el('div', { class: 'muted' }, '加载中…');

const card = (k, v, sub) => el('div', { class: 'card' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v, sub ? el('small', {}, ' ' + sub) : null));

// ---------------- 概览 ----------------
// ---------------- 使用统计（首页） ----------------
const ovSt = { hours: 'day', model: '', fstat: '', tab: 'logs', refresh: 30 }; // hours: 'day'=自然日（本地零点起）；数字=滚动小时窗
{
  const newAgg = () => ({ requests: 0, errors: 0, pin: 0, pout: 0, cr: 0, cw: 0, cost: 0 });
  const addAgg = (b, l) => {
    b.requests++; if (!l.ok) b.errors++;
    const cr = l.cacheReadTokens || 0, cw = l.cacheWriteTokens || 0;
    b.pin += Math.max(0, (l.promptTokens || 0) - cr - cw);
    b.pout += l.completionTokens || 0; b.cr += cr; b.cw += cw; b.cost += l.costUsd || 0;
  };
  const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); return Math.ceil(v / p * 2) / 2 * p; };
  const svgChart = (buckets, hourly) => {
    const W = 1060, H = 280, PL = 52, PR = 52, PT = 14, PB = 40;
    const iw = W - PL - PR, ih = H - PT - PB;
    const tokMax = niceMax(Math.max(1, ...buckets.map((b) => Math.max(b.pin, b.pout, b.cr, b.cw))));
    const costMax = niceMax(Math.max(...buckets.map((b) => b.cost), 0.0001));
    const n = Math.max(1, buckets.length - 1);
    const X = (i) => PL + (i * iw) / n;
    const YL = (v) => PT + (1 - v / tokMax) * ih;
    const YR = (v) => PT + (1 - v / costMax) * ih;
    const fmtL = (v) => (v >= 1000 ? Math.round(v / 100) / 10 + 'k' : String(Math.round(v)));
    const fmtR = (v) => '$' + (v >= 1 ? v.toFixed(v >= 10 ? 0 : 1) : v.toFixed(2));
    const s = [];
    s.push('<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" xmlns="http://www.w3.org/2000/svg">');
    for (let g = 0; g <= 4; g++) {
      const y = PT + (g * ih) / 4;
      s.push('<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y + '" stroke="#23262e"/>');
      s.push('<text x="' + (PL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="#6b7280">' + fmtL((tokMax * (4 - g)) / 4) + '</text>');
      s.push('<text x="' + (W - PR + 6) + '" y="' + (y + 3) + '" font-size="10" fill="#6b7280">' + fmtR((costMax * (4 - g)) / 4) + '</text>');
    }
    const every = Math.max(1, Math.ceil(buckets.length / 9));
    buckets.forEach((b, i) => {
      if (i % every === 0 || i === buckets.length - 1) {
        const d = new Date(b.t);
        const lb = hourly ? (d.getMonth() + 1 + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':00') : (d.getMonth() + 1 + '/' + d.getDate());
        s.push('<text x="' + X(i) + '" y="' + (H - PB + 16) + '" text-anchor="middle" font-size="9.5" fill="#6b7280">' + lb + '</text>');
      }
    });
    const series = [
      { name: '成本', color: '#ef4444', y: YR, get: (b) => b.cost, fmt: (v) => '$' + v.toFixed(4) },
      { name: '缓存创建', color: '#f59e0b', y: YL, get: (b) => b.cw, fmt: num },
      { name: '缓存命中', color: '#8b5cf6', y: YL, get: (b) => b.cr, fmt: num },
      { name: '输入', color: '#3b82f6', y: YL, get: (b) => b.pin, fmt: num },
      { name: '输出', color: '#22c55e', y: YL, get: (b) => b.pout, fmt: num },
    ];
    for (const se of series) {
      const pts = buckets.map((b, i) => X(i).toFixed(1) + ',' + se.y(se.get(b)).toFixed(1)).join(' ');
      s.push('<polyline points="' + pts + '" fill="none" stroke="' + se.color + '" stroke-width="1.6"/>');
      buckets.forEach((b, i) => s.push('<circle cx="' + X(i).toFixed(1) + '" cy="' + se.y(se.get(b)).toFixed(1) + '" r="2.2" fill="' + se.color + '"/>'));
    }
    s.push('</svg>');
    const legend = el('div', { class: 'row', style: 'justify-content:center;gap:14px;margin-top:2px' },
      ...series.map((se) => el('span', { class: 'row', style: 'gap:5px;font-size:12px;color:' + se.color }, el('i', { style: 'width:8px;height:8px;border-radius:50%;background:' + se.color + ';display:inline-block' }), se.name)));
    const wrap = el('div', { style: 'position:relative' });
    wrap.innerHTML = s.join('');
    // —— 悬停：十字准线 + 系列高亮点 + 浮层数据卡（原生 title 已移除，避免双 tooltip）——
    const NS = 'http://www.w3.org/2000/svg';
    const svg = wrap.querySelector('svg');
    const mkNs = (t, at) => { const n = document.createElementNS(NS, t); for (const k in at) n.setAttribute(k, at[k]); return n; };
    const guide = mkNs('line', { y1: PT, y2: H - PB, stroke: '#4a5160', 'stroke-width': 1, 'stroke-dasharray': '3 3' });
    const dots = series.map((se) => mkNs('circle', { r: 4.2, fill: se.color, stroke: '#0d0f13', 'stroke-width': 1.5 }));
    const hit = mkNs('rect', { x: PL, y: PT, width: iw, height: ih, fill: 'transparent' });
    for (const n of [guide, ...dots, hit]) { n.style.opacity = '0'; n.style.transition = 'opacity .15s'; svg.append(n); }
    const tip = el('div', { style: 'position:absolute;pointer-events:none;background:var(--panel-2,#161922);border:1px solid var(--line,#262b35);border-radius:8px;padding:7px 10px;font-size:12px;line-height:1.8;opacity:0;transition:opacity .15s;z-index:5;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.35)' });
    wrap.append(tip);
    hit.addEventListener('mouseleave', () => { for (const n of [guide, ...dots, tip]) n.style.opacity = '0'; });
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const vx = ((e.clientX - r.left) * W) / r.width;
      const i = Math.max(0, Math.min(buckets.length - 1, Math.round(((vx - PL) / iw) * n)));
      const b = buckets[i];
      guide.setAttribute('x1', X(i)); guide.setAttribute('x2', X(i));
      dots.forEach((c, si) => { c.setAttribute('cx', X(i)); c.setAttribute('cy', series[si].y(series[si].get(b))); });
      const d = new Date(b.t);
      const tl = (d.getMonth() + 1) + '/' + d.getDate() + (hourly ? ' ' + String(d.getHours()).padStart(2, '0') + ':00' : '');
      const rows = [['请求数', num(b.requests) + (b.errors ? '（失败 ' + b.errors + '）' : '')]].concat(series.map((se) => [se.name, se.fmt(se.get(b))]));
      tip.innerHTML = '<div style="color:var(--dimmer,#8b93a3);font-size:11px;margin-bottom:2px">' + tl + '</div>' +
        rows.map(([k, v], ri) => '<div' + (ri === 0 ? ' style="font-weight:600"' : '') + '>' +
          (ri === 0 ? '' : '<i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + series[ri - 1].color + ';margin-right:6px"></i>') +
          k + '<span style="float:right;margin-left:14px;font-family:ui-monospace,SFMono-Regular,monospace">' + v + '</span></div>').join('');
      for (const n of [guide, ...dots, tip]) n.style.opacity = '1';
      const px = (X(i) * r.width) / W, py = e.clientY - r.top;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let lx = px + 14; if (lx + tw > r.width - 4) lx = px - tw - 14;
      tip.style.left = Math.max(2, lx) + 'px';
      tip.style.top = Math.max(2, Math.min(py - th / 2, r.height - th - 2)) + 'px';
    });
    const out = el('div', {}, wrap, legend);
    return out;
  };
  views.overview = async () => {
    const myGen = viewGen; // F1：本视图代际——await 之后若已被切走，禁止挂 timer（孤儿 interval 会把用户反复拽回来）
    // 号池健康页才顺带取 auto-health/routes（饱和观测 R8）——其他页不加请求
    const [o, allLogs, ah, allRoutes] = await Promise.all([api('/api/overview'), api('/api/logs?limit=5000'),
      ovSt.tab === 'pool' ? api('/api/auto-health').catch(() => null) : Promise.resolve(null),
      ovSt.tab === 'pool' ? api('/api/routes').catch(() => null) : Promise.resolve(null)]);
    const box = el('div');
    if (updateState && updateState.updateAvailable && !updateState.error) box.append(el('div', { class: 'card', style: 'padding:8px 12px;margin-bottom:10px;font-size:12px' },
      '检测到新版本 v' + updateState.latest + '（当前 v' + updateState.current + '）——',
      el('a', { href: '#settings', style: 'color:var(--accent)' }, '到「设置」安装')));
    const from = (() => {
      if (ovSt.hours === 'day') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); } // 「今天」=本地自然日，不混昨天
      const d = new Date(Date.now() - ovSt.hours * 3600e3); if (ovSt.hours <= 48) d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0); return d.getTime();
    })(); // L6：KPI 与图表桶同锚
    let logs = allLogs.filter((l) => l.ts >= from);
    const modelNames = [...new Set(allLogs.map((l) => l.requestedModel).filter(Boolean))].sort();
    if (ovSt.model) logs = logs.filter((l) => l.requestedModel === ovSt.model);
    const sel = (opts, cur, on) => { const s = el('select', { style: 'width:auto', onchange: (e) => on(e.target.value) }); for (const [v, t] of opts) s.append(el('option', { value: v, ...(v === cur ? { selected: '' } : {}) }, t)); return s; };
    box.append(el('div', { class: 'toolbar', style: 'justify-content:space-between' },
      el('div', {},
        el('h2', { style: 'margin:0' }, '使用统计'),
        el('div', { class: 'muted', style: 'font-size:12px;margin-top:3px' }, '查看 AI 模型的使用情况和成本统计 · 渠道 ' + o.channels.length + ' · 路由 ' + (o.models + o.autoRoutes) + ' · 对外 Key ' + o.vkeys + ' · 日志 ' + o.logs + ' 条')),
      el('div', { class: 'row', style: 'gap:8px' },
        sel([['', '全部模型'], ...modelNames.map((m) => [m, m])], ovSt.model, (v) => { ovSt.model = v; go('overview'); }),
        sel([['30', '30s'], ['60', '60s'], ['300', '5min'], ['0', '关闭']], String(ovSt.refresh), (v) => { ovSt.refresh = Number(v); go('overview'); }),
        sel([['day', '今天'], ['24', '近 24 小时'], ['168', '近 7 天'], ['720', '近 30 天']], String(ovSt.hours), (v) => { ovSt.hours = v === 'day' ? 'day' : Number(v); go('overview'); }),
      )));
    // F6：前端只取 5000 条——retention>5000 时旧条件恒假，恰是最该告警的场景永不响；两种截断分开说
    if (allLogs.length >= Math.min(5000, o.logRetention || 5000)) {
      box.append(el('div', { class: 'card muted', style: 'margin-top:8px;font-size:12px' }, o.logRetention && o.logRetention <= 5000
        ? '日志仅保留最近 ' + o.logRetention + ' 条且已达上限——更早的请求记录已被丢弃，本窗口统计可能不完整'
        : '本页统计仅取最近 5000 条日志——更早记录未纳入（当前保留上限 ' + (o.logRetention || '未设') + ' 条）'));
    }
    const tot = newAgg(); logs.forEach((l) => addAgg(tot, l));
    const realTok = tot.pin + tot.pout + tot.cr + tot.cw;
    const hitRate = tot.pin + tot.cr + tot.cw > 0 ? Math.round((tot.cr / (tot.pin + tot.cr + tot.cw)) * 1000) / 10 : 0;
    const hero = el('div', { class: 'card', style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-top:12px' },
      el('div', {}, el('div', { class: 'k' }, '真实消耗 Tokens'),
        el('div', { style: 'font-size:30px;font-weight:700' }, num(realTok), el('small', { class: 'muted' }, ' ≈ ' + money(tot.cost)))),
      el('div', { class: 'row', style: 'gap:0' },
        el('div', { style: 'padding:0 18px;border-left:1px solid var(--line)' }, el('div', { class: 'k' }, '总请求数'), el('div', { style: 'font-size:18px;font-weight:600' }, num(tot.requests), tot.errors ? el('small', { class: 'err-text' }, ' · 失败 ' + tot.errors) : null)),
        el('div', { style: 'padding:0 4px 0 18px;border-left:1px solid var(--line)' }, el('div', { class: 'k' }, '总成本'), el('div', { style: 'font-size:18px;font-weight:600' }, money(tot.cost)))));
    box.append(hero);
    const sub = (k, v, extra) => el('div', { class: 'card' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v, extra ? el('small', {}, ' ' + extra) : null));
    box.append(el('div', { class: 'grid cards', style: 'grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:10px' },
      sub('新增输入', num(tot.pin)),
      sub('Output', num(tot.pout)),
      sub('缓存创建', num(tot.cw)),
      sub('缓存命中', num(tot.cr)),
      el('div', { class: 'card' }, el('div', { class: 'row', style: 'justify-content:space-between' }, el('span', { class: 'k' }, '缓存命中率'), el('b', { style: hitRate >= 30 ? 'color:var(--ok)' : '' }, hitRate + '%')),
        el('div', { class: 'bar', style: 'margin-top:8px' }, el('i', { style: 'width:' + Math.min(100, hitRate) + '%' })))));
    const hourly = ovSt.hours === 'day' || ovSt.hours <= 48;
    const step = hourly ? 3600e3 : 86400e3;
    const align = (t) => { const d = new Date(t); if (hourly) d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0); return d.getTime(); };
    const buckets = new Map();
    const startT = ovSt.hours === 'day' ? align(from) : align(Date.now() - (ovSt.hours * 3600e3 - step));
    for (let t = startT; t <= Date.now(); t += step) buckets.set(t, Object.assign({ t }, newAgg()));
    for (const l of logs) { const b = buckets.get(align(l.ts)); if (b) addAgg(b, l); }
    const bArr = [...buckets.values()];
    const chartCard = el('div', { class: 'card', style: 'margin-top:12px' },
      el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' }, el('h2', { style: 'margin:0' }, '使用趋势'),
        el('span', { class: 'muted' }, hourly ? '按小时' : '按天')),
      svgChart(bArr, hourly));
    box.append(chartCard);
    const TABS = [['logs', '请求日志'], ['provider', 'Provider 统计'], ['model', '模型统计'], ['speed', '速度排行'], ['pool', '号池健康']];
    box.append(el('div', { class: 'row', style: 'gap:6px;margin:16px 0 10px' },
      ...TABS.map(([k, t]) => el('button', { class: 'btn sm' + (ovSt.tab === k ? ' primary' : ''), onclick: () => { ovSt.tab = k; go('overview'); } }, t))));
    const groupAgg = (keyFn) => {
      const m = new Map();
      for (const l of logs) {
        const k = keyFn(l) || '-';
        if (!m.has(k)) m.set(k, Object.assign({ key: k, latSum: 0 }, newAgg()));
        const b = m.get(k); addAgg(b, l); b.latSum += l.latencyMs || 0;
      }
      return [...m.values()].sort((a, b) => b.requests - a.requests);
    };
    if (ovSt.tab === 'logs') {
      const fbar = el('div', { class: 'card', style: 'padding:10px 12px;margin-bottom:10px' },
        el('div', { class: 'row', style: 'gap:8px' },
          sel([['', '全部'], ['ok', '仅成功'], ['err', '仅失败']], ovSt.fstat, (v) => { ovSt.fstat = v; go('overview'); }),
          el('span', { class: 'muted' }, (ovSt.hours === 'day' ? '今天' : ovSt.hours === 24 ? '近 24 小时' : ovSt.hours === 168 ? '近 7 天' : '近 30 天') + (ovSt.model ? ' · ' + ovSt.model : ''))));
      box.append(fbar);
      let rows = logs;
      if (ovSt.fstat === 'ok') rows = rows.filter((l) => l.ok);
      if (ovSt.fstat === 'err') rows = rows.filter((l) => !l.ok);
      const t = el('table');
      t.append(el('tr', {}, el('th', {}, '时间'), el('th', {}, '供应商'), el('th', {}, '计费模型'), el('th', {}, '输入'), el('th', {}, '输出'), el('th', {}, '总成本'), el('th', {}, '用时/首字'), el('th', {}, '状态'), el('th', {}, '来源')));
      for (const l of rows.slice(0, 200)) {
        t.append(el('tr', { title: (l.retries || []).join('\\n') || l.error || '' },
          el('td', { class: 'mono muted' }, new Date(l.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })),
          el('td', { class: 'muted' }, l.channelName || '-'),
          el('td', { class: 'mono' }, (l.requestedModel || '-') + (l.routedTo && l.routedTo !== l.requestedModel ? ' → ' + l.routedTo : '')),
          el('td', { class: 'mono' }, num(l.promptTokens)), el('td', { class: 'mono' }, num(l.completionTokens)),
          el('td', { class: 'mono' }, money(l.costUsd)),
          el('td', { class: 'mono muted' }, l.latencyMs + 'ms' + (l.ttftMs ? ' / ' + l.ttftMs + 'ms' : '')),
          el('td', {}, el('span', { class: 'pill ' + (l.ok ? 'ok' : 'err') }, String(l.status))),
          el('td', { class: 'muted' }, l.wire === 'anthropic' ? 'Anthropic' : l.wire ? 'OpenAI' : '-')));
      }
      if (!rows.length) t.append(el('tr', {}, el('td', { class: 'muted' }, '暂无数据')));
      box.append(t);
      if (rows.length > 200) box.append(el('div', { class: 'muted', style: 'margin-top:6px' }, '共 ' + rows.length + ' 条，仅显示最近 200 条'));
    } else if (ovSt.tab === 'provider' || ovSt.tab === 'model') {
      const g = ovSt.tab === 'provider' ? groupAgg((l) => l.channelName) : groupAgg((l) => l.requestedModel);
      const t = el('table');
      t.append(el('tr', {}, el('th', {}, ovSt.tab === 'provider' ? 'Provider（渠道）' : '模型'), el('th', {}, '请求'), el('th', {}, '失败'), el('th', {}, '输入'), el('th', {}, '输出'), el('th', {}, '缓存读/写'), el('th', {}, '成本'), el('th', {}, '平均延迟')));
      for (const b of g) {
        t.append(el('tr', {}, el('td', { class: 'mono' }, b.key), el('td', {}, b.requests),
          el('td', { class: b.errors ? 'err-text' : '' }, b.errors),
          el('td', { class: 'mono' }, num(b.pin)), el('td', { class: 'mono' }, num(b.pout)),
          el('td', { class: 'mono muted' }, num(b.cr) + ' / ' + num(b.cw)),
          el('td', { class: 'mono' }, money(b.cost)),
          el('td', { class: 'mono muted' }, (b.requests ? Math.round(b.latSum / b.requests) : 0) + 'ms')));
      }
      if (!g.length) t.append(el('tr', {}, el('td', { class: 'muted' }, '暂无数据')));
      box.append(t);
    } else if (ovSt.tab === 'speed') {
      box.append(renderSpeedTab(await speedFetch()));
    } else if (ovSt.tab === 'pool') {
      const t = el('table');
      t.append(el('tr', {}, el('th', {}, '渠道'), el('th', {}, '协议'), el('th', {}, '号池可用'), el('th', {}, '状态'), el('th', {}, '')));
      for (const c of o.channels) {
        const pct = c.keys ? Math.round((c.available / c.keys) * 100) : 0;
        t.append(el('tr', {}, el('td', {}, c.name), el('td', {}, proto(c.protocol)),
          el('td', {}, el('div', { class: 'row' }, el('div', { class: 'bar' }, el('i', { style: 'width:' + pct + '%', class: pct === 0 ? 'e' : '' })), el('span', { class: 'muted' }, c.available + '/' + c.keys))),
          el('td', {}, c.cooldown ? el('span', { class: 'pill warn' }, c.cooldown + ' 冷却中') : c.available ? el('span', { class: 'pill ok' }, '正常') : el('span', { class: 'pill err-text' }, '不可用')),
          el('td', {}, el('button', { class: 'btn sm', onclick: () => go('channels') }, '管理'))));
      }
      if (!o.channels.length) t.append(el('tr', {}, el('td', { class: 'muted' }, '还没有渠道，先去「渠道与号池」添加一个上游。')));
      box.append(t);
      // 信号观测（R8/P1+P2 F4.1）：饱和候选（回退退避中）+ 慢候选（速度因子偏软）；剩余秒数倒计、一键清
      const sat = (ah && ah.saturation) || [];
      const slowRows = ((ah && ah.windows) || []).filter((w) => w.ttftSlow || (w.speedFactor != null && w.speedFactor < 0.8));
      if (sat.length || slowRows.length) {
        const rname = new Map(((allRoutes && allRoutes.routes) || allRoutes || []).map((r) => [r.id, r.publicName || r.name || r.id]));
        box.append(el('div', { class: 'card', style: 'padding:10px 12px;margin-top:12px' },
          el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' },
            el('h2', { style: 'margin:0' }, '自动路由信号'),
            el('button', { class: 'btn sm', onclick: async () => { await api('/api/auto-health/saturation/clear', { method: 'POST' }); toast('已清除全部饱和态'); go('overview'); } }, '清除饱和')),
          el('table', {},
            sat.map((sn) => el('tr', {},
              el('td', {}, rname.get(sn.routeId) || sn.routeId),
              el('td', {}, el('span', { class: 'pill warn' }, '饱和')),
              el('td', { class: 'muted' }, \`剩余 ~\${sn.leftSec}s（第 \${sn.n} 档退避）\`))),
            slowRows.map((w) => el('tr', {},
              el('td', {}, rname.get(w.routeId) || w.routeId),
              el('td', {}, el('span', { class: 'pill' + (w.ttftSlow ? ' warn' : '') }, w.ttftSlow ? 'TTFT 慢降级' : '慢 ×' + (Math.round(w.speedFactor * 100) / 100)),
                w.speedFactor != null ? el('span', { class: 'muted', style: 'margin-left:6px' }, '因子 ' + (Math.round(w.speedFactor * 100) / 100)) : null),
              el('td', { class: 'muted' }, (w.ttftP50 != null ? \`TTFT p50 \${Math.round(w.ttftP50)}ms · \` : '') + (w.tokP50 != null ? \`吞吐 p50 \${Math.round(w.tokP50)} tok/s\` : '观测样本不足')))))));
      }
    }
    // ---------- auto 验收对比（G21，P2.1 缓交②）：以部署时刻为界的前后窗三指标对比 ----------
    const acc = el('div', { class: 'card', style: 'margin-top:12px' });
    acc.append(el('h3', { style: 'margin:0 0 6px' }, 'auto 验收对比'));
    acc.append(el('div', { class: 'muted', style: 'font-size:12px' },
      '以「分界时刻」（如 v2.3 部署完成的时间点）为界，对比前后各 7 天的三项验收指标。门槛：跨候选失败率与全链失败率相对降幅 ≥30% 且绝对差 ≥1 个百分点，p95 首字延迟不劣化。'));
    const accAt = el('input', { type: 'datetime-local', style: 'width:auto' });
    const accBtn = el('button', { class: 'btn sm', style: 'margin-left:8px' }, '对比');
    const accOut = el('div', { style: 'font-size:12.5px;margin-top:10px' });
    const accErr = el('div', { class: 'muted', style: 'font-size:11px;margin-top:6px' });
    accBtn.addEventListener('click', async () => {
      if (!accAt.value) { accOut.innerHTML = ''; accErr.textContent = '先选择分界时刻'; return; }
      const mid = new Date(accAt.value).getTime();
      if (!Number.isFinite(mid)) { accErr.textContent = '分界时刻无效'; return; }
      accBtn.disabled = true; accBtn.textContent = '计算中…'; accErr.textContent = '';
      try {
        const WEEK = 7 * 86400e3, now = Date.now();
        const base = await api('/api/stats?from=' + Math.max(0, mid - WEEK) + '&to=' + mid);
        const curr = await api('/api/stats?from=' + mid + '&to=' + Math.max(mid + 1000, now));
        const A = base.autoAcceptance || {}, B = curr.autoAcceptance || {};
        const pctFmt = (v) => v == null ? '—' : (v * 100).toFixed(2) + '%';
        const msFmt = (v) => v == null ? '—' : Math.round(v) + 'ms';
        const drop = (a, b) => (a != null && b != null && a > 0) ? (a - b) / a : null; // 相对降幅
        const pp = (a, b) => (a != null && b != null) ? (a - b) * 100 : null;          // 绝对差（百分点）
        const okRate = (a, b) => { const d = drop(a, b), w = pp(a, b); return (d != null && w != null && d >= 0.3 && w >= 1); };
        const rowLine = (name, a, b, ok) => el('tr', {},
          el('td', {}, name),
          el('td', { class: 'mono' }, a), el('td', { class: 'mono' }, b),
          el('td', {}, ok === null ? el('span', { class: 'muted' }, '样本不足') : el('span', { class: 'pill' + (ok ? '' : ' warn') }, ok ? '达标' : '未达标')));
        const tbl = el('table', { style: 'width:100%;margin-top:8px;font-size:12.5px' },
          el('thead', {}, el('tr', {}, el('td', { class: 'muted' }, '指标'), el('td', { class: 'muted' }, '基线周（分界前 7 天）'), el('td', { class: 'muted' }, '当前周（分界后至今）'), el('td', { class: 'muted' }, 'G21 门槛'))),
          el('tbody', {},
            rowLine('跨候选失败率（成功请求中换过候选的占比）', pctFmt(A.crossCandidateFailRate), pctFmt(B.crossCandidateFailRate), (A.autoRequests || 0) >= 100 && (B.autoRequests || 0) >= 100 ? okRate(A.crossCandidateFailRate, B.crossCandidateFailRate) : null),
            rowLine('全链失败率（候选耗尽终态 5xx 占比）', pctFmt(A.chainExhaustedRate), pctFmt(B.chainExhaustedRate), (A.autoRequests || 0) >= 100 && (B.autoRequests || 0) >= 100 ? okRate(A.chainExhaustedRate, B.chainExhaustedRate) : null),
            rowLine('p95 首字延迟（成功流式，越低越好）', msFmt(A.p95TtftStreamMs), msFmt(B.p95TtftStreamMs), (A.autoRequests || 0) >= 100 && (B.autoRequests || 0) >= 100 && A.p95TtftStreamMs != null && B.p95TtftStreamMs != null ? (B.p95TtftStreamMs <= A.p95TtftStreamMs) : null)));
        accOut.innerHTML = '';
        accOut.append(el('div', { class: 'muted', style: 'font-size:11px;margin-bottom:4px' },
          'auto 域请求数：基线 ' + (A.autoRequests || 0) + ' · 当前 ' + (B.autoRequests || 0)));
        accOut.append(tbl);
        if ((A.autoRequests || 0) < 100 || (B.autoRequests || 0) < 100) accErr.textContent = 'G21：周样本 <100 本周作废顺延（当前基线 ' + (A.autoRequests || 0) + ' / 当前 ' + (B.autoRequests || 0) + '）——门槛判定仅作参考';
      } catch (e) { accErr.textContent = '对比失败：' + e.message; }
      accBtn.disabled = false; accBtn.textContent = '对比';
    });
    acc.append(el('div', { class: 'row', style: 'gap:8px;align-items:center;margin-top:8px' }, accAt, accBtn));
    acc.append(accOut, accErr);
    api('/api/settings').then((st) => {
      if ((st.logRetention || 0) < 200000) acc.append(el('div', { class: 'card muted', style: 'margin-top:8px;font-size:11.5px' },
        'G21①：当前日志保留 ' + (st.logRetention || 0) + ' 条——验收基线周前请在「设置」把它提到 ≥200000，否则后半周样本会被静默裁掉，对比失真。'));
    }).catch(() => {});
    box.append(acc);
    if (ovSt.refresh > 0 && myGen === viewGen) { clearInterval(timer); timer = setInterval(() => go('overview'), ovSt.refresh * 1000); } // F1
    return box;
  };
}


// ---------------- 配置组导出/导入（config-bundle v2.1） ----------------
/** 出包前疑似密钥启发式（DR-CB-K）：只做标黄提示不阻断；自由文本藏 key 是真实模式。 */
function scanBundleForSecrets(b) {
  const re = /(sk|xoxb|sk-ant)[-_A-Za-z0-9]{16,}|[A-Za-z0-9_-]{40,}|\\b[0-9a-fA-F]{32}\\b|eyJ[A-Za-z0-9_-]{20,}/;
  const out = [];
  const walk = (v, path) => {
    if (typeof v === 'string') { if (re.test(v)) out.push(path); }
    else if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i], path + '[' + i + ']'); }
    else if (v && typeof v === 'object') { for (const k in v) { if (k === 'exportedAt') continue; walk(v[k], path + '.' + k); } }
  };
  walk(b, '$');
  return out;
}
async function exportConfig() {
  const b = await api('/api/config/export');
  const hits = scanBundleForSecrets(b);
  const seen = {}; let dup = false;
  for (const c of b.channels || []) { if (seen[c.name]) dup = true; seen[c.name] = 1; }
  if (hits.length || dup) {
    const msg = '导出前检查：' + (hits.length ? String.fromCharCode(10) + '疑似密钥文本（bundle 不该带，请人工复核）：' + hits.slice(0, 8).join('、') + (hits.length > 8 ? '…共 ' + hits.length + ' 处' : '') : '') + (dup ? String.fromCharCode(10) + '存在同名渠道，导入方将整条判冲突。' : '');
    if (!confirm(msg + String.fromCharCode(10) + String.fromCharCode(10) + '仍要导出？')) return;
  }
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }));
  a.download = 'own-api-config-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('已导出（不含渠道密钥；extraHeaders 请转发前人工检查）');
}
// ---- 配置组导入：两步链式弹窗（预览≡提交由服务端同一计划构建器保证） ----
const cbKeyDraft = {};
function cbReceiptText(rc) {
  const ch = rc.channels; const rt = rc.routes;
  const lines = [];
  const realMerge = (rt.candidatesMerged || []).some((c) => (c.changes || []).some((s) => s.indexOf('候选不变') !== 0));
  if (!ch.created && !rt.created && !realMerge && !ch.conflicts.length && !rt.conflicts.length) {
    lines.push('没有新变更：' + (ch.merged + rt.skipped) + ' 项一致、0 项冲突');
  } else {
    lines.push('渠道：新建 ' + ch.created + ' / 合并 ' + ch.merged + (ch.keysAdded ? ' / 密钥写入 ' + ch.keysAdded : ''));
    lines.push('路由：新建 ' + rt.created + ' / 跳过 ' + rt.skipped + ((rt.candidatesMerged || []).length ? ' / auto 合并 ' + rt.candidatesMerged.length : ''));
  }
  for (const x of ch.conflicts) lines.push('⚠ 渠道 ' + x.name + '：' + x.reason);
  for (const x of rt.conflicts) lines.push('⚠ 路由 ' + x.publicName + '：' + x.reason);
  for (const cm of (rt.candidatesMerged || [])) lines.push('↻ ' + cm.publicName + '：' + cm.changes.join('，'));
  for (const w of rt.warnings) lines.push('· ' + (w.publicName ? w.publicName + '：' : '') + w.reason);
  if (rc.pendingKeyChannels && rc.pendingKeyChannels.length) lines.push('待填密钥渠道：' + rc.pendingKeyChannels.join('、'));
  return lines.join('\\n');
}
function cbPendingFields(rc) {
  const names = rc.pendingKeyChannels || [];
  // 单一收口点：新预览即裁剪——不在本次 pending 集合的草稿一并移除（§4.1「粘贴框连同内容移除」）
  for (const n of Object.keys(cbKeyDraft)) if (!names.includes(n)) delete cbKeyDraft[n];
  return names.map((n) => ({ name: 'ck:' + n, label: '密钥（一行一个）：' + n, type: 'textarea', value: cbKeyDraft[n] || '', hint: '留空可跳过；之后也能在渠道页「+ 导入 key」补', full: true }));
}
async function importConfig() {
  form('导入配置组（粘贴）', [
    { name: 'bundle', label: 'Bundle JSON（公司内部渠道获取；不含任何密钥）', type: 'textarea', full: true, hint: '先预览再确认；导入全程零外呼，不连接 bundle 里的任何地址' },
  ], async (v0, ctx) => {
    let bundle;
    try { bundle = JSON.parse(v0.bundle); } catch { throw new Error('bundle 不是合法 JSON'); }
    let rc;
    try { rc = await api('/api/config/import', { method: 'POST', body: JSON.stringify({ bundle, dryRun: true }) }); }
    catch (e) { throw new Error('预览失败：' + e.message); }
    if (ctx && ctx.cancelled && ctx.cancelled()) return; // 预览在途用户已取消：不放孤儿确认幕
    const pf = cbPendingFields(rc);
    const fields = [{ name: '_rc', label: '预览（仅展示，提交以当前 bundle 重新计算）', type: 'textarea', value: cbReceiptText(rc), full: true }].concat(pf);
    // keys 只取本次对话框的 ck: 字段实际值——cbKeyDraft 仅作预填，绝不整仓回灌（防跨 bundle 串写）
    form('确认导入（新建 ' + (rc.channels.created + rc.routes.created) + ' 项）', fields, async (v) => {
      const keys = {};
      for (const f of pf) {
        const val = (v[f.name] || '').trim();
        const nm = f.name.slice(3);
        if (val) { cbKeyDraft[nm] = val; keys[nm] = val.split('\\n').map((s) => s.trim()).filter(Boolean); }
        else delete cbKeyDraft[nm];
      }
      // 提交在 onSubmit 内 await：失败抛出 → form 不关幕、内容保留可直接重试
      const rc2 = await api('/api/config/import', { method: 'POST', body: JSON.stringify({ bundle, keys }) });
      for (const f of pf) delete cbKeyDraft[f.name.slice(3)];
      toast('导入完成：新建 ' + (rc2.channels.created + rc2.routes.created) + ' / 合并 ' + rc2.channels.merged + ' / 冲突 ' + (rc2.channels.conflicts.length + rc2.routes.conflicts.length));
      if (rc2.pendingKeyChannels && rc2.pendingKeyChannels.length) cbFillPendingKeys(rc2.pendingKeyChannels);
      else go('channels');
    });
  });
}
async function cbFillPendingKeys(names) {
  let chans;
  try { chans = await api('/api/channels'); } catch { go('channels'); return; }
  const idOf = {};
  for (const c of chans) idOf[c.name] = c.id;
  const fields = names.filter((n) => idOf[n]).map((n) => ({ name: 'ck:' + n, label: '密钥（一行一个）：' + n, type: 'textarea', full: true, hint: '导入成功但该渠道还没有密钥——现在填，或取消后到渠道页「+ 导入 key」补' }));
  if (!fields.length) { go('channels'); return; }
  form('仍有待填密钥（' + names.length + ' 个渠道）', fields, async (v) => {
    for (const f of fields) {
      const arr = (v[f.name] || '').split('\\n').map((s) => s.trim()).filter(Boolean);
      if (arr.length) await api('/api/channels/' + idOf[f.name.slice(3)] + '/keys', { method: 'POST', body: JSON.stringify({ keys: arr }) });
    }
    toast('密钥已写入');
    go('channels');
  });
}
// ---------------- 检查更新（update-check v1）：手动触发，绝不自动联网（README「不联网上报」承诺） ----------------
let updateState = null; // 最近一次手动检查结果（含 latest/downloadUrl），概览页据此挂提示条
async function checkUpdate(btn, out) {
  btn.disabled = true; out.textContent = '检查中…（联网查询 GitHub Releases，最多 5s）';
  try {
    const r = await api('/api/version/check');
    updateState = r;
    out.innerHTML = '';
    if (r.error) out.append(el('span', { class: 'muted' }, r.error));
    else if (r.updateAvailable) out.append(
      el('div', { style: 'color:var(--ok);font-weight:600;margin-bottom:6px' }, '有新版本 v' + r.latest + '（当前 v' + r.current + '）'),
      el('div', { class: 'row', style: 'gap:8px' },
        el('a', { class: 'btn primary sm', href: r.downloadUrl || r.releaseUrl, target: '_blank', rel: 'noreferrer' }, '下载安装包'),
        el('a', { class: 'btn sm', href: r.releaseUrl, target: '_blank', rel: 'noreferrer' }, '查看发布说明')));
    else out.append(el('span', {}, '已是最新版本（v' + r.current + '）✓'));
  } catch (e) { out.textContent = '检查失败：' + e.message; }
  btn.disabled = false;
}
// ---------------- 速度排行（speed-insights v1.1） ----------------
// renderSpeedTab 是纯展示层：只消费后端预计算数值，严禁在这里重算任何百分位（DR-SI-9），
// DOM 桩钉会抽源断言本函数体不含 .sort( 与 Math.floor。
async function speedFetch() {
  const hours = ovSt.spHours === undefined ? 24 : ovSt.spHours;
  const rep = await api('/api/stats/speed?hours=' + hours);
  const chOf = {}; const autoNames = {}; let routesFailed = false;
  try { for (const r of await api('/api/routes')) { if (r.type === 'single') chOf[r.publicName] = r.channelName; else autoNames[r.publicName] = 1; } } catch { routesFailed = true; }
  return { rep, chOf, autoNames, routesFailed };
}
function renderSpeedTab(pack) {
  const rep = pack.rep;
  const hours = rep.window.hours;
  const frag = el('div');
  frag.append(el('div', { class: 'card', style: 'padding:9px 12px;margin-bottom:10px;font-size:12px' },
    el('b', {}, '本页只做观测，不影响 auto 路由；'), '要躲开慢模型请到模型路由调整候选权重。'));
  if (pack.routesFailed) frag.append(el('div', { class: 'muted', style: 'font-size:11px;margin:-4px 0 8px' }, '渠道归属映射加载失败——徽章暂省略，数值不受影响。'));
  frag.append(el('div', { class: 'row', style: 'gap:8px;align-items:center;margin-bottom:8px' },
    el('span', { class: 'muted', style: 'font-size:12px' }, '样本取自最近 ' + rep.logsInWindow + ' 条日志（logRetention=' + rep.retention + '），时间范围：'),
    el('select', { style: 'width:auto', onchange: (e) => { ovSt.spHours = Number(e.target.value); go('overview'); } },
      ...[[24, '24h'], [168, '7 天'], [0, '全部']].map((o) => el('option', { value: String(o[0]), ...(String(hours) === String(o[0]) ? { selected: '' } : {}) }, o[1])))));
  if (hours > 0 && rep.oldestTs && rep.window.to - rep.oldestTs < hours * 3600000) {
    const coverH = Math.max(1, Math.round((rep.window.to - rep.oldestTs) / 3600000));
    frag.append(el('div', { class: 'card', style: 'padding:8px 12px;margin-bottom:10px;font-size:12px;color:#b45309' },
      '所选范围已超出日志保留（实际覆盖约 ' + coverH + 'h）——如需更长窗口请到设置调大日志保留条数（上限 200000）'));
  }
  if (!rep.streamRows.length && !rep.latencyRows.length && !rep.unattributed) {
    frag.append(el('div', { class: 'card muted' }, '窗口内还没有请求记录——先到「接入方式」复制接入配置，跑几个请求后再回来看排行'));
    return frag;
  }
  const rate = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '-');
  const cell = (txt, cls, st) => el('td', { class: 'mono' + (cls ? ' ' + cls : ''), style: st || '' }, txt);
  const hl = (v, base) => (base && v > base * 2 ? 'color:#dc2626;font-weight:600' : base && v > base * 1.5 ? 'color:#b45309' : '');
  const nameTd = (r) => el('td', {}, r.key, ' ',
    pack.autoNames[r.key] ? el('span', { class: 'pill' }, 'auto') : (pack.chOf[r.key] ? el('span', { class: 'pill muted' }, pack.chOf[r.key]) : el('span', { class: 'muted' }, '-')));
  const t1 = el('table');
  t1.append(el('tr', {}, el('th', {}, '模型'), el('th', {}, '样本(流式)'), el('th', {}, 'TTFT P50'), el('th', {}, 'TTFT P95'), el('th', {}, '上游错误率'), el('th', {}, '中断率'), el('th', {}, 'failover'), el('th', {}, '最后请求')));
  for (const r of rep.streamRows) {
    t1.append(el('tr', { class: r.streamN < 5 ? 'muted' : '' }, nameTd(r), el('td', {}, String(r.streamN) + (r.streamN < 5 ? '（样本少）' : '')),
      cell(r.ttftP50Ms + 'ms', '', hl(r.ttftP50Ms, rep.benchmark.streamP50Ms)), cell(r.ttftP95Ms + 'ms'),
      cell(rate(r.errors, r.requests)), cell(rate(r.cancels, r.requests)), cell((r.failoverRate * 100).toFixed(0) + '%'),
      el('td', { class: 'muted' }, ago(r.lastTs))));
  }
  if (!rep.streamRows.length) frag.append(el('div', { class: 'card muted' }, '窗口内没有流式请求，TTFT 列不可用'));
  else frag.append(t1);
  frag.append(el('div', { class: 'muted', style: 'margin:14px 0 8px;font-weight:600' }, '↓ 非流式（按总延迟 P50 升序）——无 TTFT，勿与上表比较'));
  const t2 = el('table');
  t2.append(el('tr', {}, el('th', {}, '模型'), el('th', {}, '样本(首跳)'), el('th', {}, '延迟 P50'), el('th', {}, '延迟 P95'), el('th', {}, '均值'), el('th', { title: '5xx/网络/超时，不含客户端取消' }, '上游错误率'), el('th', { title: '多为客户端超时或主动取消，非上游故障' }, '中断率'), el('th', {}, 'failover'), el('th', {}, '最后请求')));
  for (const r of rep.latencyRows) {
    t2.append(el('tr', { class: r.firstAttemptN < 5 ? 'muted' : '' }, nameTd(r), el('td', {}, String(r.firstAttemptN) + (r.firstAttemptN && r.firstAttemptN < 5 ? '（样本少）' : '')),
      r.latP50Ms !== undefined ? cell(r.latP50Ms + 'ms', '', hl(r.latP50Ms, rep.benchmark.latP50Ms)) : cell('-'),
      cell(r.latP95Ms !== undefined ? r.latP95Ms + 'ms' : '-'), cell(r.avgLatencyMs !== undefined ? r.avgLatencyMs + 'ms' : '-'),
      cell(rate(r.errors, r.requests)), cell(rate(r.cancels, r.requests)), cell((r.failoverRate * 100).toFixed(0) + '%'),
      el('td', { class: 'muted' }, ago(r.lastTs))));
  }
  if (rep.unattributed) {
    const ua = rep.unattributed;
    t2.append(el('tr', { class: 'muted' }, el('td', {}, '-（未归因：限流/未命中等）'), el('td', {}, String(ua.requests)), el('td', {}, '-'), el('td', {}, '-'), el('td', {}, '-'),
      cell(rate(ua.errors, ua.requests)), cell(rate(ua.cancels, ua.requests)), el('td', {}, '-'), el('td', { class: 'muted' }, ago(ua.lastTs))));
  }
  frag.append(t2);
  return frag;
}

// ---------------- 模型路由（v3 单表：新增时选类型，single/auto 同页管理） ----------------
views.models = async () => {
  const myGen = viewGen; // F1：同 overview——过期代际不得留下 15s 孤儿定时器
  const [routes, channels, rt] = await Promise.all([api('/api/routes'), api('/api/channels'), api('/api/auto-health')]);
  const models = routes.filter((r) => r.type === 'single');
  const box = el('div');
  const hPill = (h) => el('span', { class: 'pill ' + (h >= 0.9 ? 'ok' : h >= 0.4 ? '' : 'err-text') }, '健康 ' + (Math.round(h * 100) / 100).toFixed(2));
  const typePill = (t) => t === 'auto' ? el('span', { class: 'pill', style: 'margin-left:6px' }, '自动路由') : el('span', { class: 'pill', style: 'margin-left:6px;opacity:.6' }, '单模型');

  const addModel = () => form('新增模型路由', [
    { name: 'publicName', label: '对外模型名（agent 请求里传的 model）', ph: 'gpt-4o / claude-sonnet-4' },
    { name: 'channelId', label: '上游渠道', type: 'select', options: channels.map((c) => ({ value: c.id, label: c.name + ' (' + c.protocol + ')' })) },
    { name: 'upstreamModel', label: '上游真实模型名（从所选渠道模型列表选）', type: 'select', depends: 'channelId', optionsFor: (cid) => { const l = (channels.find((c) => c.id === cid)?.modelList || []).filter(Boolean); return l.length ? l.map((mm) => ({ value: mm, label: mm })) : [{ value: '', label: '该渠道未配置模型列表，请先在渠道里填', disabled: true }]; } },
    { name: 'protocol', label: '协议（默认跟随渠道）', type: 'select', options: [{ value: '', label: '跟随渠道' }, { value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }] },
    { name: 'priceInput', label: '输入 $/百万 token', type: 'number', step: '0.01' },
    { name: 'priceOutput', label: '输出 $/百万 token', type: 'number', step: '0.01' },
    { name: 'maxOutputTokens', label: 'max_tokens 默认值', type: 'number' },
    { name: 'contextWindow', label: '上下文窗口', type: 'number' },
  ], (v) => api('/api/routes', { method: 'POST', body: JSON.stringify({
      type: 'single',
      publicName: v.publicName, channelId: v.channelId, upstreamModel: v.upstreamModel, protocol: v.protocol || null, // F5：「跟随渠道」=null 清除，undefined 会被 JSON 丢键变 no-op
      priceInput: v.priceInput ? Number(v.priceInput) : undefined, priceOutput: v.priceOutput ? Number(v.priceOutput) : undefined,
      maxOutputTokens: v.maxOutputTokens ? Number(v.maxOutputTokens) : undefined, contextWindow: v.contextWindow ? Number(v.contextWindow) : undefined,
    }) }).then(() => { toast('已创建'); go('models'); }));

  const editModel = (m) => form('编辑 ' + m.publicName, [
    { name: 'publicName', label: '对外模型名', value: m.publicName },
    { name: 'upstreamModel', label: '上游真实模型名', type: 'select', value: m.upstreamModel, depends: 'channelId', optionsFor: (cid) => { const ch = channels.find((c) => c.id === cid); const l = (ch?.modelList || []).filter(Boolean); const opts = l.map((mm) => ({ value: mm, label: mm })); if (!l.includes(m.upstreamModel)) opts.push({ value: m.upstreamModel, label: m.upstreamModel + '（不在列表，保留原值）' }); return opts.length ? opts : [{ value: '', label: '该渠道未配置模型列表', disabled: true }]; } },
    { name: 'channelId', label: '渠道', type: 'select', value: m.channelId, options: channels.map((c) => ({ value: c.id, label: c.name })) },
    { name: 'protocol', label: '协议', type: 'select', value: m.protocol || '', options: [{ value: '', label: '跟随渠道' }, { value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }] },
    { name: 'priceInput', label: '输入 $/M', type: 'number', step: '0.01', value: m.priceInput ?? '' },
    { name: 'priceOutput', label: '输出 $/M', type: 'number', step: '0.01', value: m.priceOutput ?? '' },
    { name: 'maxOutputTokens', label: 'max_tokens 默认', type: 'number', value: m.maxOutputTokens ?? '' },
    { name: 'supportsVision', label: '视觉（多模态）', type: 'select', value: m.supportsVision === true ? 'true' : m.supportsVision === false ? 'false' : '',
      options: [{ value: '', label: '未知（unknown）——带图放行并降权，学习闭环兜底' }, { value: 'true', label: '支持视觉' }, { value: 'false', label: '不支持视觉' }],
      hint: '手动标注后学习闭环不再覆盖（F6.3）；改回「未知」同样锁定为手动值。' },
  ], (v) => api('/api/routes/' + m.id, { method: 'PATCH', body: JSON.stringify({
      publicName: v.publicName, upstreamModel: v.upstreamModel, channelId: v.channelId, protocol: v.protocol || null, // F5
      priceInput: v.priceInput === '' ? null : Number(v.priceInput), priceOutput: v.priceOutput === '' ? null : Number(v.priceOutput),
      maxOutputTokens: v.maxOutputTokens === '' ? null : Number(v.maxOutputTokens),
      supportsVision: v.supportsVision === '' ? null : v.supportsVision === 'true',
    }) }).then(() => { toast('已更新'); go('models'); }));

  const editAuto = (a) => form(a ? '编辑 ' + a.publicName : '新增自动路由', [
    { name: 'publicName', label: 'auto 对外名（agent 的 model 里填它）', value: a?.publicName, ph: 'model_auto', hint: '全局唯一：不得与任何模型外名 / tag / 其它 auto 重名' },
    { name: 'candidates', label: '候选模型（从单模型路由选，可多行）', type: 'cands', full: true, value: a?.candidates || [], hint: '权重=相对分配占比；0 = 禁用该候选。要加新候选？先在本页登记单模型路由。',
      options: models.map((m) => ({ value: m.id, label: m.publicName + '（' + m.channelName + (m.enabled ? '' : ' · 已停用') + '）' }))
        .concat((a?.candidates || []).filter((c) => c.routeId && !models.some((m) => m.id === c.routeId)).map((c) => ({ value: c.routeId, label: (c.name || c.routeId) + '（路由已删除·悬空）' }))) },
    { name: 'stickyTtlMs', label: '粘性 TTL（ms，0=关）', type: 'number', value: a?.stickyTtlMs ?? 300000, hint: '同一 key + auto 名命中后滑动续期；重启网关即清空' },
    { name: 'note', label: '备注', value: a?.note || '', full: true },
  ], (v) => {
    const candidates = v.candidates.filter((c) => c.routeId);
    if (v.candidates.some((c) => !c.routeId)) throw new Error('有候选还没选模型');
    if (new Set(candidates.map((c) => c.routeId)).size !== candidates.length) throw new Error('候选模型不能重复');
    if (candidates.some((c) => !Number.isFinite(c.weight) || c.weight < 0)) throw new Error('权重须为 ≥0 的数字');
    if (!candidates.length) throw new Error('至少填一个候选');
    const body = a ? { publicName: v.publicName, candidates, stickyTtlMs: v.stickyTtlMs === '' ? 300000 : Number(v.stickyTtlMs), note: v.note || '' }
      : { type: 'auto', publicName: v.publicName, candidates, stickyTtlMs: v.stickyTtlMs === '' ? 300000 : Number(v.stickyTtlMs), note: v.note || '' };
    return api(a ? '/api/routes/' + a.id : '/api/routes', { method: a ? 'PATCH' : 'POST', body: JSON.stringify(body) })
      .then((r) => { if (r && r.error) throw new Error(r.error); toast('已保存'); go('models'); });
  });

  const pickTypeAndAdd = () => form('新增路由', [
    { name: 'type', label: '选类型', type: 'select', options: [
      { value: 'single', label: '单模型路由——一个对外名固定对应一个上游模型' },
      { value: 'auto', label: '自动路由——一个对外名聚合一组候选，健康加权选路、失败自动换' },
    ] },
  ], (v) => { if (v.type === 'auto') editAuto(null); else addModel(); });

  box.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary', onclick: pickTypeAndAdd }, '+ 新增模型'),
    el('button', { class: 'btn sm', onclick: () => exportConfig() }, '导出全部配置'),
    el('button', { class: 'btn sm', onclick: () => importConfig() }, '导入配置'),
    el('span', { class: 'muted' }, '不含渠道密钥；extraHeaders 原样导出——内部资料。'),
  ));

  const t = el('table');
  t.append(el('tr', {}, el('th', {}, '对外名'), el('th', {}, '去向 / 候选（权重·健康）'), el('th', {}, '渠道 / 协议'), el('th', {}, '单价 in/out'), el('th', {}, '粘性'), el('th', {}, '状态'), el('th', {}, '')));
  for (const r of routes) {
    const dest = r.type === 'single'
      ? el('td', { class: 'mono muted' }, '→ ' + r.upstreamModel)
      : el('td', {}, ...(r.candidates.length ? r.candidates.map((c) => el('div', { style: 'margin:2px 0' },
          el('span', { class: 'mono' + (c.dangling ? ' err-text' : '') }, (c.name || c.routeId) + (c.dangling ? '（悬空）' : '')),
          el('span', { class: 'muted' }, ' ×' + c.weight + ' '),
          c.weight === 0 ? el('span', { class: 'pill' }, '禁用') : c.dangling ? null : hPill(c.health ?? 1),
          c.satLeftSec ? el('span', { class: 'pill warn', title: '饱和态：自动路由正在对该候选回退退避' }, '饱和 ' + c.satLeftSec + 's') : null,
          c.ttftSlow ? el('span', { class: 'pill warn', title: 'TTFT 慢降级：≥3× 自身基线，粘性已降级' }, 'TTFT 慢') : (!c.ttftSlow && c.speedFactor != null && c.speedFactor < 0.8 ? el('span', { class: 'pill', title: '速度因子：decode 吞吐相对基准偏慢，权重已软降' }, '慢 ×' + (Math.round(c.speedFactor * 100) / 100)) : null),
          c.routeEnabled === false ? el('span', { class: 'pill' }, '路由停用') : null,
          c.channelEnabled === false ? el('span', { class: 'pill err-text' }, '渠道停用') : null,
        )) : [el('span', { class: 'muted' }, '（无候选）')]));
    const visPill = (sv) => sv === true ? el('span', { class: 'pill ok', title: 'supportsVision=true（导入启发式或手动标注）' }, '视觉✓')
      : sv === false ? el('span', { class: 'pill warn', title: 'supportsVision=false（手动标注或学习闭环自动降级）' }, '视觉✗')
      : el('span', { class: 'pill', style: 'opacity:.6', title: 'unknown：无证据，带图请求放行并降权，学习闭环兜底' }, '视觉?');
    const chn = r.type === 'single'
      ? el('td', {}, r.channelName, el('div', { class: 'muted' }, proto(r.protocol || r.channelProtocol)), visPill(r.supportsVision))
      : el('td', { class: 'muted' }, '多候选');
    t.append(el('tr', {},
      el('td', { class: 'mono' }, r.publicName, typePill(r.type),
        r.type === 'single' && r.tags?.length ? el('span', { class: 'muted' }, ' · ' + r.tags.join(',')) : null,
        r.type === 'auto' && r.note ? el('div', { class: 'muted', style: 'font-size:11px' }, r.note) : null),
      dest, chn,
      el('td', { class: 'mono muted' }, r.type === 'single' ? (r.priceInput != null ? r.priceInput + ' / ' + r.priceOutput : '-') : '-'),
      el('td', { class: 'mono muted' }, r.type === 'auto' ? (r.stickyTtlMs ? Math.round(r.stickyTtlMs / 1000) + 's' : '关') : '-'),
      el('td', {}, r.enabled ? el('span', { class: 'pill ok' }, '启用') : el('span', { class: 'pill' }, '停用')),
      el('td', {}, el('div', { class: 'row' },
        el('button', { class: 'btn sm', onclick: () => api('/api/routes/' + r.id, { method: 'PATCH', body: JSON.stringify({ enabled: !r.enabled }) }).then(() => go('models')) }, r.enabled ? '停用' : '启用'),
        el('button', { class: 'btn sm', onclick: () => (r.type === 'auto' ? editAuto(r) : editModel(r)) }, '编辑'),
        r.type === 'auto' ? el('button', { class: 'btn sm', title: '清空该路由全部粘性绑定：改完权重/候选点一下，下一条请求立即按新配比重抽（不必等粘性 TTL 过期）', onclick: () => api('/api/routes/' + r.id + '/sticky', { method: 'DELETE' }).then((z) => toast(z?.cleared ? '已清除 ' + z.cleared + ' 条粘性绑定，新配比立即生效' : '当前没有粘性绑定')) }, '粘性立即生效') : null,
        el('button', { class: 'btn sm danger', onclick: () => confirm('删除路由 ' + r.publicName + '？') && api('/api/routes/' + r.id, { method: 'DELETE' }).then((z) => { if (z?.warning) toast(z.warning, true); go('models'); }) }, '删除'),
      ))));
  }
  if (!routes.length) t.append(el('tr', {}, el('td', { class: 'muted' }, '还没有路由：点「+ 新增模型」，可选单模型直连或自动路由（例：model_auto → [gpt-4o ×3, 本地 qwen ×1]）')));
  box.append(t);

  const rc = el('div', { class: 'card', style: 'margin-top:16px' });
  rc.append(el('h2', {}, '运行时'), el('div', { class: 'muted', style: 'margin-bottom:8px' }, '健康窗口 10 分钟（全流量含直连），粘性条目内存态：' + (rt.stickyEntries || 0) + ' 条'));
  const wt = el('table');
  wt.append(el('tr', {}, el('th', {}, '候选模型'), el('th', {}, '渠道'), el('th', {}, '10min 成功'), el('th', {}, '失败'), el('th', {}, '健康分')));
  for (const w of (rt.windows || [])) {
    wt.append(el('tr', {}, el('td', { class: 'mono' }, w.name || w.routeId), el('td', { class: 'muted' }, w.channel || '-'),
      el('td', { class: 'mono' }, w.ok), el('td', { class: 'mono' + (w.fail ? ' err-text' : '') }, w.fail), el('td', {}, hPill(w.health))));
  }
  if (!(rt.windows || []).length) wt.append(el('tr', {}, el('td', { class: 'muted' }, '窗口内暂无候选流量样本')));
  rc.append(wt);
  box.append(rc);
  if (myGen === viewGen) { clearInterval(timer); timer = setInterval(() => go('models'), 15000); } // F1
  return box;
};
// ---------------- 渠道与号池 ----------------
views.channels = async () => {
  const channels = await api('/api/channels');
  const box = el('div');
  const addChannel = () => form('新增上游渠道', [
    { name: 'name', label: '渠道名称', ph: '生产 Azure OpenAI / 某中转站' },
    { name: 'protocol', label: '上游协议', type: 'select', options: [{ value: 'openai', label: 'OpenAI 兼容' }, { value: 'anthropic', label: 'Anthropic 原生' }] },
    { name: 'baseUrl', label: 'Base URL', ph: 'https://api.openai.com/v1', full: true },
    { name: 'keys', label: '号池 Key（每行一个，可批量导入）', type: 'textarea', ph: 'sk-xxx\\nsk-yyy', full: true },
    { name: 'extraHeaders', label: '附加请求头（JSON，可选）', ph: '{"X-Token":"1"}', full: true },
    { name: 'modelList', label: '上游真实模型列表（每行一个，选填）', type: 'textarea', ph: 'GLM-5.3-Flash\\nQwen3.8-27B', full: true },
    { name: 'testModel', label: '测试模型名（选填，连通测试用）', ph: 'GLM-5.3-Flash', full: true },
  ], (v) => {
    let extraHeaders;
    if (v.extraHeaders?.trim()) { try { extraHeaders = JSON.parse(v.extraHeaders); } catch { throw new Error('附加请求头不是合法 JSON'); } }
    return api('/api/channels', { method: 'POST', body: JSON.stringify({
      name: v.name, protocol: v.protocol, baseUrl: v.baseUrl, extraHeaders,
      modelList: v.modelList.split('\\n').map((s) => s.trim()).filter(Boolean),
      testModel: v.testModel || undefined,
      keys: v.keys.split('\\n').map((s) => s.trim()).filter(Boolean).map((k) => ({ key: k })),
    }) }).then(() => { toast('已创建渠道'); go('channels'); });
  });

  box.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary', onclick: addChannel }, '+ 新增渠道'),
    el('button', { class: 'btn sm', onclick: () => exportConfig() }, '导出全部配置'),
    el('button', { class: 'btn sm', onclick: () => importConfig() }, '导入配置'),
    el('span', { class: 'muted' }, '不含渠道密钥；extraHeaders 原样导出——内部资料。'),
  ));

  for (const c of channels) {
    const keys = el('table');
    keys.append(el('tr', {}, el('th', {}, 'Key'), el('th', {}, '状态'), el('th', {}, '权重'), el('th', {}, '请求/失败'), el('th', {}, '最近错误'), el('th', {}, '')));
    for (const k of c.keys) {
      const badge = k.status === 'active' ? el('span', { class: 'pill ok' }, '可用')
        : k.status === 'cooldown' ? el('span', { class: 'pill warn' }, \`冷却 \${Math.ceil((k.cooldownLeftMs || 0) / 1000)}s\`)
        : el('span', { class: 'pill' }, '已禁用');
      keys.append(el('tr', {},
        el('td', { class: 'mono' }, k.key, k.name && k.name !== k.key ? el('span', { class: 'muted' }, ' · ' + k.name) : null),
        el('td', {}, badge),
        el('td', { class: 'mono' }, k.weight),
        el('td', { class: 'mono' }, \`\${k.totalRequests}\`, el('span', { class: k.totalErrors ? 'err-text' : 'muted' }, \` / \${k.totalErrors}\`)),
        el('td', { class: 'mono muted', title: k.lastError || '' }, (k.lastError || '-').slice(0, 44)),
        el('td', {}, el('div', { class: 'row' },
          k.status !== 'active' ? el('button', { class: 'btn sm', onclick: () => api(\`/api/channels/\${c.id}/keys/\${k.id}\`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) }).then(() => go('channels')) }, '恢复') : '',
          k.status !== 'disabled' ? el('button', { class: 'btn sm', onclick: () => api(\`/api/channels/\${c.id}/keys/\${k.id}\`, { method: 'PATCH', body: JSON.stringify({ status: 'disabled' }) }).then(() => go('channels')) }, '禁用') : '',
          el('button', { class: 'btn sm danger', onclick: () => api(\`/api/channels/\${c.id}/keys/\${k.id}\`, { method: 'DELETE' }).then(() => go('channels')) }, '删除'),
        ))));
    }
    if (!c.keys.length) keys.append(el('tr', {}, el('td', { class: 'muted' }, '号池为空，添加 key 后该渠道才能服务请求')));

    const addKeys = () => form('向 ' + c.name + ' 导入 key', [
      { name: 'keys', label: '每行一个 key', type: 'textarea', full: true },
    ], (v) => api(\`/api/channels/\${c.id}/keys\`, { method: 'POST', body: JSON.stringify({ keys: v.keys.split('\\n').map((s) => s.trim()).filter(Boolean).map((k) => ({ key: k })) }) })
      .then(() => { toast('已导入'); go('channels'); }));

    const testAll = async (btn) => {
      btn.disabled = true; btn.textContent = '测试中…';
      try {
        const r = await api(\`/api/channels/\${c.id}/test\`, { method: 'POST' });
        const out = $('#test-' + c.id);
        out.innerHTML = '';
        for (const x of r.results) {
          out.append(el('div', { class: 'log-line' },
            el('span', { class: 'pill ' + (x.ok ? 'ok' : 'err') }, x.ok ? 'OK ' + x.status : String(x.status || 'ERR')),
            el('span', { class: 'mono' }, x.key),
            el('span', { class: 'mono muted' }, x.latencyMs + 'ms'),
            el('span', { class: 'c' }, x.error || (x.models.length ? \`可见模型：\${x.models.slice(0, 8).join(', ')}\` : ''))));
        }
        if (r.results[0]?.models?.length) {
          const models = r.results.find((x) => x.models?.length)?.models || [];
          out.append(el('div', { class: 'row', style: 'margin-top:8px' },
            el('button', { class: 'btn sm', onclick: () => api(\`/api/channels/\${c.id}/import-models\`, { method: 'POST', body: JSON.stringify({ models }) }).then((z) => { toast(\`已导入 \${z.created} 个模型路由\`); go('models'); }) }, \`把 \${models.length} 个模型导入路由表\`)));
        }
      } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = '测试连通'; }
    };

    box.append(el('div', { class: 'card', style: 'margin-bottom:16px' },
      el('div', { class: 'row' },
        el('strong', {}, c.name), proto(c.protocol),
        c.enabled ? el('span', { class: 'pill ok' }, '启用') : el('span', { class: 'pill' }, '停用'),
        el('span', { class: 'pill' }, \`可用 key \${c.availableKeys}/\${c.keys.length}\`),
        c.keys.length === 0 && c.enabled ? el('span', { class: 'pill warn', style: 'cursor:pointer', title: '点击导入密钥', onclick: () => addKeys() }, '待填密钥') : null,
        el('span', { class: 'mono muted', style: 'flex:1' }, c.urlPreview),
        el('button', { class: 'btn sm', onclick: (e) => testAll(e.target) }, '测试连通'),
        el('button', { class: 'btn sm', onclick: addKeys }, '+ 导入 key'),
        el('button', { class: 'btn sm', onclick: () => form('编辑渠道', [
          { name: 'name', label: '名称', value: c.name },
          { name: 'protocol', label: '协议', type: 'select', value: c.protocol, options: [{ value: 'openai', label: 'OpenAI 兼容' }, { value: 'anthropic', label: 'Anthropic 原生' }] },
          { name: 'baseUrl', label: 'Base URL', value: c.baseUrl, full: true },
          { name: 'modelList', label: '上游真实模型列表（每行一个）', type: 'textarea', value: (c.modelList || []).join('\\n'), full: true },
          { name: 'testModel', label: '测试模型名（选填，连通测试用）', value: c.testModel || '', full: true },
        ], (v) => api(\`/api/channels/\${c.id}\`, { method: 'PATCH', body: JSON.stringify({ ...v, modelList: v.modelList.split('\\n').map((s) => s.trim()).filter(Boolean) }) }).then(() => { toast('已更新'); go('channels'); })) }, '编辑'),
        el('button', { class: 'btn sm', onclick: () => api(\`/api/channels/\${c.id}\`, { method: 'PATCH', body: JSON.stringify({ enabled: !c.enabled }) }).then(() => go('channels')) }, c.enabled ? '停用' : '启用'),
        el('button', { class: 'btn sm danger', onclick: () => confirm(\`删除渠道 \${c.name}？其下模型路由会一并删除。\`) && api(\`/api/channels/\${c.id}\`, { method: 'DELETE' }).then(() => go('channels')) }, '删除'),
      ),
      el('div', { id: 'test-' + c.id, style: 'margin-top:10px' }),
      el('details', { style: 'margin-top:10px' }, el('summary', {}, \`号池明细（\${c.keys.length}）\`), keys),
    ));
  }
  if (!channels.length) box.append(el('div', { class: 'card muted' }, '还没有渠道。添加一个上游渠道开始使用。'));
  return box;
};

// ---------------- 对外 Key ----------------
views.vkeys = async () => {
  const [vkeys, models] = await Promise.all([api('/api/vkeys'), api('/api/routes?type=single')]);
  const box = el('div');
  box.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary', onclick: () => form('创建对外 Key', [
      { name: 'name', label: '名称（如 claude-code / codex / 团队 A）' },
      { name: 'allowed', label: '允许的模型（逗号分隔，留空 = 全部；按对外名匹配，auto 路由名同样可填）', full: true },
      { name: 'rpmLimit', label: 'RPM 上限（0 = 不限）', type: 'number' },
      { name: 'dailyTokenLimit', label: '每日 token 上限（0 = 不限）', type: 'number' },
    ], (v) => api('/api/vkeys', { method: 'POST', body: JSON.stringify({
      name: v.name, allowedModels: v.allowed ? v.allowed.split(/[,，\\s]+/).filter(Boolean) : [],
      rpmLimit: Number(v.rpmLimit) || 0, dailyTokenLimit: Number(v.dailyTokenLimit) || 0,
    }) }).then((vk) => { copy(vk.key); toast('已创建并复制完整 key（只显示这一次）'); go('vkeys'); })) }, '+ 新建 Key'),
    el('span', { class: 'muted' }, '这就是发给各个 agent 的统一 key。'),
  ));
  const t = el('table');
  t.append(el('tr', {}, el('th', {}, '名称'), el('th', {}, 'Key'), el('th', {}, '允许模型'), el('th', {}, '限额'), el('th', {}, '最近使用'), el('th', {}, '状态'), el('th', {}, '')));
  for (const k of vkeys) {
    t.append(el('tr', {},
      el('td', {}, k.name),
      el('td', { class: 'mono' }, k.key, ' ', el('button', { class: 'btn sm', onclick: () => api(\`/api/vkeys?reveal=1\`).then((all) => copy(all.find((x) => x.id === k.id)?.key || '')) }, '取完整值')),
      el('td', { class: 'mono muted' }, k.allowedModels?.length ? k.allowedModels.join(', ') : '全部'),
      el('td', { class: 'mono muted', title: \`今日已用 \${num(k.today?.tokens || 0)} token · \${k.today?.requests || 0} 次 · $\${k.today?.costUsd || 0}\` },
        [k.rpmLimit ? \`\${k.rpmLimit} rpm\` : '', k.dailyTokenLimit ? \`\${num(k.today?.tokens || 0)}/\${num(k.dailyTokenLimit)}/天\` : ''].filter(Boolean).join(' · ') || '不限'),
      el('td', { class: 'muted' }, ago(k.lastUsedAt)),
      el('td', {}, k.enabled ? el('span', { class: 'pill ok' }, '启用') : el('span', { class: 'pill' }, '停用')),
      el('td', {}, el('div', { class: 'row' },
        el('button', { class: 'btn sm', onclick: () => api(\`/api/vkeys/\${k.id}\`, { method: 'PATCH', body: JSON.stringify({ enabled: !k.enabled }) }).then(() => go('vkeys')) }, k.enabled ? '停用' : '启用'),
        el('button', { class: 'btn sm danger', onclick: () => confirm(\`删除 \${k.name}？使用该 key 的 agent 会立即失效。\`) && api(\`/api/vkeys/\${k.id}\`, { method: 'DELETE' }).then(() => go('vkeys')) }, '删除'),
      ))));
  }
  box.append(t);
  box.append(el('div', { class: 'muted', style: 'margin-top:10px;font-size:12px' }, \`可路由模型：\${models.map((m) => m.publicName).join(' / ') || '（还没有）'}\`));
  return box;
};

// ---------------- 接入方式 ----------------
views.connect = async () => {
  const s = await api('/api/snippet');
  const box = el('div');
  box.append(el('div', { class: 'card' },
    el('div', { class: 'k' }, '统一入口'),
    el('div', { class: 'row', style: 'margin-top:6px' },
      el('span', { class: 'mono' }, s.baseUrl + '/v1'), el('button', { class: 'btn sm', onclick: () => copy(s.baseUrl + '/v1') }, '复制 URL')),
    el('div', { class: 'row', style: 'margin-top:8px' },
      el('span', { class: 'mono' }, s.key), el('button', { class: 'btn sm', onclick: () => copy(s.key) }, '复制 Key')),
    el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' }, '同一入口同时提供 OpenAI 与 Anthropic 两套协议，agent 换 model 名即可切到不同真实上游。'),
    el('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' },
      '支持的端点：',
      el('span', { class: 'mono' }, '/v1/chat/completions、/v1/completions、/v1/messages、/v1/messages/count_tokens、/v1/embeddings、GET /v1/models'),
      '。注意：不支持 OpenAI Responses API（', el('span', { class: 'mono' }, '/v1/responses'),
      '）；需要该 API 的客户端（如新版 Codex CLI 默认端点）请改用 chat completions 或经 litellm 之类代理转换。'),
  ));
  const blocks = [
    ['curl（OpenAI 协议）', s.curl],
    ['OpenAI SDK', s.openaiSdk],
    ['Claude Code / Anthropic SDK', s.claudeCode],
    ['Codex CLI', s.codexCli],
  ];
  for (const [title, code] of blocks) {
    box.append(el('h2', {}, title), el('div', { class: 'row', style: 'justify-content:flex-end;margin-bottom:-6px' }, el('button', { class: 'btn sm', onclick: () => copy(code) }, '复制')), el('pre', { class: 'code' }, code));
  }
  box.append(el('h2', {}, '切换模型'),
    el('div', { class: 'card muted' }, 'agent 侧只改请求里的 model 字段：例如从 "gpt-4o" 改成 "claude-sonnet"，网关会自动换成对应渠道的真实 base_url 与真实 key，agent 配置无需任何变更。'));
  return box;
};

// ---------------- 日志 ----------------
let es = null;
views.logs = async () => {
  const box = el('div');
  const list = el('div', { class: 'card', style: 'padding:0;max-height:70vh;overflow:auto' });
  let onlyErr = false;
  const render = (l) =>
    el('div', { class: 'log-line', style: l.ok ? '' : 'background:rgba(248,81,73,.06)', title: (l.retries || []).join('\\n') || l.error || '' },
      el('span', { class: 'pill ' + (l.ok ? 'ok' : 'err') }, String(l.status)),
      el('span', { class: 'mono' }, clock(l.ts)),
      el('span', { class: 'mono' }, l.requestedModel || '-'),
      el('span', { class: 'mono muted' }, l.channelName || '-'),
      el('span', { class: 'mono muted' }, \`\${l.latencyMs}ms\` + (l.ttftMs ? \` · ttft \${l.ttftMs}ms\` : '') + (l.attempts > 1 ? \` · ×\${l.attempts}\` : '')),
      el('span', { class: 'mono muted' }, \`\${l.promptTokens}↑ \${l.completionTokens}↓\` + (l.cacheReadTokens ? \` · c\${l.cacheReadTokens}\` : '')),
      el('span', { class: 'mono muted' }, money(l.costUsd)),
      el('span', { class: 'c mono', style: l.ok ? 'color:var(--dimmer)' : 'color:var(--err)' },
        (l.error || (l.retries || []).join(' | ') || '').slice(0, 120)));
  const first = await api('/api/logs?limit=200');
  first.forEach((l) => list.append(render(l)));

  const reload = async () => {
    list.innerHTML = '';
    const logs = await api('/api/logs?limit=300' + (onlyErr ? '&errors=1' : ''));
    logs.forEach((l) => list.append(render(l)));
  };
  if (es) es.close();
  es = null;
  // M3：SSE 首帧快照与屏上已有条目按 seq 去重——竞态窗口内不再双份渲染
  const seenSeq = new Set(first.map((l) => l.seq));
  const onSseMsg = (m) => {
    sseTry = 0; // F9：收到推送就把重连额度回满——纯网络闪断不烧票据重发预算
    try {
      JSON.parse(m.data).forEach((l) => {
        if (l.seq != null && seenSeq.has(l.seq)) return;
        seenSeq.add(l.seq);
        if (!onlyErr || !l.ok) list.prepend(render(l));
      });
    } catch {}
  };
  let sseTry = 0;
  const connectSse = (ticket) => {
    if (es) { es.close(); es = null; }
    es = new EventSource('/api/logs/stream?ticket=' + encodeURIComponent(ticket));
    es.onmessage = onSseMsg;
    es.onerror = () => {
      // L5：票据过期后 EventSource 拿旧 URL 无限重连（401 死循环）——重发票据再接，至多两次
      if (sseTry++ >= 2 || !list.isConnected) { if (es) { es.close(); es = null; } return; }
      api('/api/logs/stream/ticket', { method: 'POST' }).then((t2) => { if (t2 && t2.ticket && list.isConnected) connectSse(t2.ticket); }).catch(() => {});
    };
  };
  const tk = await api('/api/logs/stream/ticket', { method: 'POST' }).catch(() => null);
  if (tk && tk.ticket) connectSse(tk.ticket);

  box.append(el('div', { class: 'toolbar' },
    el('label', { class: 'row', style: 'gap:6px' }, el('input', { type: 'checkbox', onchange: (e) => { onlyErr = e.target.checked; reload(); } }), el('span', { class: 'muted' }, '只看失败')),
    el('button', { class: 'btn sm', onclick: reload }, '刷新'),
    el('button', { class: 'btn sm danger', onclick: () => confirm('清空全部日志？') && api('/api/logs', { method: 'DELETE' }).then(reload) }, '清空'),
    el('span', { class: es ? 'pill ok' : 'pill warn' }, es ? '实时推送中' : '实时推送不可用（ticket 获取失败，可手动刷新）'),
    el('span', { class: 'muted' }, '×N 表示该请求在号池里试过 N 个 key'),
  ), list);
  return box;
};

// ---------------- 设置 ----------------
views.settings = async () => {
  const s = await api('/api/settings');
  const channels = await api('/api/channels');
  const box = el('div', { class: 'card', style: 'max-width:760px' });
  const f = (label, name, value, hint) => {
    box.append(el('label', {}, label));
    const node = el('input', { name, value: value ?? '', type: 'number' });
    box.append(node);
    if (hint) box.append(el('div', { class: 'muted', style: 'font-size:11px;margin:3px 0 6px' }, hint));
    return node;
  };
  box.append(el('h2', {}, '路由与容错'));
  box.append(el('label', {}, '未知模型兜底渠道'));
  const fb = el('select', { name: 'fallbackChannelId' },
    el('option', { value: '', ...(s.fallbackChannelId ? {} : { selected: '' }) }, '不兜底（返回 404）'),
    ...channels.map((c) => el('option', { value: c.id, ...(s.fallbackChannelId === c.id ? { selected: '' } : {}) }, c.name)));
  box.append(fb);
  box.append(el('div', { class: 'muted', style: 'font-size:11px;margin:3px 0 6px' }, '开启后，未登记路由的 model 会透传给该渠道（上游模型名原样传递）。'));
  const retry = f('单请求最多尝试 key 数', 'maxKeyRetries', s.maxKeyRetries, '号池故障切换的最大尝试次数');
  const timeout = f('上游首包超时（ms）', 'defaultUpstreamTimeoutMs', s.defaultUpstreamTimeoutMs, '多久没拿到响应头就判超时');
  const idle = f('上游响应体空闲超时（ms）', 'upstreamIdleTimeoutMs', s.upstreamIdleTimeoutMs, '流式响应连续这么久没有新数据就中断，防止上游 200 后卡死');
  const bodyLimit = f('请求体上限（字节）', 'maxBodyBytes', s.maxBodyBytes, \`当前约 \${(s.maxBodyBytes / 1048576).toFixed(0)} MB，超限返回 413\`);
  const autoChain = f('auto 候选链预算（秒）', 'autoMaxChainSeconds', s.autoMaxChainSeconds, '一次 auto 请求跨所有候选最多耗这么久（本地模型加载慢，默认 300s）');
  const th = f('进入冷却的连续失败阈值', 'errorThreshold', s.errorThreshold);
  const cdBase = f('冷却基数（ms）', 'cooldownBaseMs', s.cooldownBaseMs);
  const cdMax = f('冷却上限（ms）', 'cooldownMaxMs', s.cooldownMaxMs, '上游 Retry-After 再大也只会冷却到这么久');
  const ret = f('日志保留条数', 'logRetention', s.logRetention);
  box.append(el('h2', {}, '安全'));
  box.append(el('label', {}, '管理令牌'));
  const tok = el('input', { value: '', placeholder: s.adminTokenSet || s.adminToken ? '••••••••（已保存，出于安全不再回显；输入新值可替换）' : '尚未设置' });
  tok.style.width = '100%';
  box.append(tok, el('div', { class: 'muted', style: 'font-size:11px;margin:3px 0 6px' }, '至少 8 个字符；改动会写进 data/db.json（文件权限 0600），也可用 LLM_ADMIN_TOKEN 固定。'));
  const dbg = el('input', { type: 'checkbox', ...(s.debugHeaders ? { checked: '' } : {}) });
  box.append(el('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:6px' }, dbg, '返回 x-lm-channel / x-lm-key 等内部调试响应头'));
  box.append(el('div', { class: 'muted', style: 'font-size:11px;margin:3px 0 6px' }, '默认关闭：这些头会暴露渠道名与 key 尾号，排查故障时再打开。'));
  const save = async () => {
    const patch = {
      maxKeyRetries: Number(retry.value), defaultUpstreamTimeoutMs: Number(timeout.value), errorThreshold: Number(th.value),
      upstreamIdleTimeoutMs: Number(idle.value), maxBodyBytes: Number(bodyLimit.value),
      cooldownBaseMs: Number(cdBase.value), cooldownMaxMs: Number(cdMax.value), logRetention: Number(ret.value),
      autoMaxChainSeconds: Number(autoChain.value),
      debugHeaders: !!dbg.checked,
      fallbackChannelId: fb.value,
      // P2.1：auto 路由 v2 三组开关（服务端校验钳制：floor∈[0.1,1]、cap∈[1,10]、baseSec∈[5,600]、maxSec∈[30,86400]、floor≤cap）
      autoSaturation: { enabled: !!satEn.checked, baseSec: Number(satBase.value), maxSec: Number(satMax.value) },
      autoVision: { enabled: !!visEn.checked, heuristics: !!visHeur.checked },
      autoSpeedFactor: { enabled: !!spdEn.checked, floor: Number(spdFloor.value), cap: Number(spdCap.value) },
    };
    if (tok.value.trim()) patch.adminToken = tok.value.trim();
    try {
      const res = await api('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
      if (patch.adminToken && !(res && (res._rejected || res.rejected) && (res._rejected || res.rejected).length)) { // F3：换令牌后本会话凭据即刻跟上，否则下一个请求起全会话 401 变砖
        TOKEN = patch.adminToken; localStorage.setItem('lm_token', patch.adminToken);
      }
      const rejected = res?._rejected || res?.rejected || [];
      if (rejected.length) toast('部分设置未生效：' + rejected.join('；'), true);
      else toast('已保存');
    } catch (e) { toast(e.message, true); }
  };
  // ---------- auto 路由 v2（饱和/视觉/速度三组开关，P2.1 缓交③：回滚预案要有界面入口） ----------
  box.append(el('h2', { style: 'margin-top:22px' }, 'auto 路由'));
  const sw = (labelText, checked, hint) => {
    const cb = el('input', { type: 'checkbox', ...(checked ? { checked: '' } : {}) });
    box.append(el('label', { style: 'display:flex;gap:8px;align-items:center' }, cb, labelText));
    if (hint) box.append(el('div', { class: 'muted', style: 'font-size:11px;margin:3px 0 6px' }, hint));
    return cb;
  };
  const sv = (s2) => s2 || {};
  const sat = sv(s.autoSaturation), vis = sv(s.autoVision), spd = sv(s.autoSpeedFactor);
  const satEn = sw('饱和避让（渠道连续 429/超时 → 整段避让）', sat.enabled !== false, '同一渠道跨 key 连续触发时整段绕开，指数退避（baseSec 起、maxSec 封顶，24h 绝对帽）；剩余不足 5s 时仍给一次探测机会。关闭即回到逐 key 重试。');
  const satBase = f('　饱和退避基数（秒）', 'autoSatBaseSec', sat.baseSec ?? 60, '首档冷却时长；每次重触发翻倍（5~600）');
  const satMax = f('　饱和退避上限（秒）', 'autoSatMaxSec', sat.maxSec ?? 1800, '退避封顶（30~86400）；候选饱和期也可在路由页手动清除');
  const visEn = sw('视觉适配（带图请求的候选过滤与降权）', vis.enabled !== false, '关闭后整套视觉路由决策一起失效：不再软排除不支持图片的候选、不再对未知候选降权 0.25、学习闭环停写（R9 回滚开关）。');
  const visHeur = sw('　视觉家族启发式识别', vis.heuristics !== false, '导入模型时按已知多模态家族名自动预填 supportsVision 初值');
  const spdEn = sw('速度因子（按流式实测吞吐软降权）', spd.enabled !== false, '快候选加权、慢候选降权（不剔除）；EMA 平滑 + 1h 半衰期，样本 <3 视为冷启动恒 1。关闭后全部候选 factor 恒 1。');
  const spdFloor = f('　速度因子下限 floor', 'autoSpdFloor', spd.floor ?? 0.5, '慢候选最低权重系数（0.1~1，默认 0.5）');
  const spdCap = f('　速度因子上限 cap', 'autoSpdCap', spd.cap ?? 2.0, '快候选最高权重系数（1~10，默认 2.0）；floor 不得大于 cap');
  box.append(el('div', { class: 'muted', style: 'font-size:11px;margin:6px 0 0' }, '以上改动保存后即刻生效（设置热读），无需重启；也可用于逐项回滚。'));
  box.append(el('div', { class: 'row', style: 'margin-top:18px' },
    el('button', { class: 'btn primary', onclick: save }, '保存设置'),
  ));
  // 关于与更新（update-check v1）：当前版本 + 手动检查；绝不自动联网
  const about = el('div', { class: 'card', style: 'max-width:760px;margin-top:16px' });
  about.append(el('h2', {}, '关于与更新'));
  const verLabel = el('b', {}, '…');
  api('/api/version').then((v) => (verLabel.textContent = 'v' + v.version)).catch(() => (verLabel.textContent = '未知'));
  const chkBtn = el('button', { class: 'btn sm' }, '检查更新');
  const updOut = el('div', { style: 'font-size:12px;margin-top:8px' });
  chkBtn.addEventListener('click', () => checkUpdate(chkBtn, updOut));
  about.append(el('div', { class: 'row', style: 'gap:8px;align-items:center' },
    el('span', { class: 'muted', style: 'font-size:12px' }, '当前版本：'), verLabel, chkBtn),
    el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' },
      '仅在你点击「检查更新」时联网查询一次 GitHub Releases（10 分钟缓存）；本应用其余时间零外呼。'),
    updOut);
  const wrap = el('div');
  wrap.append(box, about);
  return wrap;
};

// ---------------- 启动 ----------------
$('#go').addEventListener('click', () => {
  TOKEN = $('#token').value.trim();
  api('/api/overview').then(() => {
    localStorage.setItem('lm_token', TOKEN);
    boot();
  }).catch((e) => toast(e.message, true));
});
$('#token').addEventListener('keydown', (e) => e.key === 'Enter' && $('#go').click());

function boot() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
  $('#nav').hidden = false;
  document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => go(b.dataset.v)));
  if (es) es.close(), (es = null);
  const wantV = localStorage.getItem('lm_view'); // 托盘深链目标视图：一次性消费（消费即删，不影响后续手点导航）
  if (wantV) localStorage.removeItem('lm_view');
  go(wantV || (location.hash || '#overview').slice(1), { force: true }); // 首载仍走清场+loading（此时画面本来就空）
  api('/healthz').then((h) => { $('#hdr-sub').textContent = \`\${h.channels} 渠道 · \${h.models} 模型 · \${h.vkeys} 对外 key\`; });
}

if (TOKEN) api('/api/overview').then(() => boot()).catch((e) => {
  // L2：只有 401 才清本地凭据——网络抖动/服务重启不再无故丢登录态
  if (e && e.status === 401) { localStorage.removeItem('lm_token'); TOKEN = ''; }
  else boot();
});
</script>
</body>
</html>
`;
