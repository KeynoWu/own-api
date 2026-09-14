// 配置组导出（docs/config-bundle-design.md v2.1）。导入逻辑见文件后半（CB-2/3 落地）。
import { store, normalizeBaseUrl, toStrList, sanitizeExtraHeaders } from './store.ts';

export const BUNDLE_KIND = 'own-api-config-bundle';
export const BUNDLE_VERSION = 1;

/** 导出恒全量、恒不含密钥；渠道名原样导出（重名由导入端 §4.2-R 判冲突，导出端只提示）。 */
export function buildBundle() {
  const routes = store.db.routes;
  const byId = new Map(routes.map((r) => [r.id, r] as const));
  const channels = store.db.channels.map((c) => ({
    name: c.name,
    baseUrl: c.baseUrl,
    protocol: c.protocol,
    authStyle: c.authStyle ?? 'bearer',
    ...(c.extraHeaders && Object.keys(c.extraHeaders).length ? { extraHeaders: c.extraHeaders } : {}),
    ...(c.testModel ? { testModel: c.testModel } : {}),
    ...(c.modelList && c.modelList.length ? { modelList: c.modelList } : {}),
    enabled: c.enabled !== false,
    timeoutMs: c.timeoutMs ?? null,
    ...(c.note ? { note: c.note } : {}),
  }));
  const singles: any[] = [];
  const autos: any[] = [];
  for (const r of routes) {
    if (r.type === 'single') {
      const ch = store.db.channels.find((c) => c.id === r.channelId);
      singles.push({
        publicName: r.publicName,
        channelName: ch ? ch.name : '',
        upstreamModel: r.upstreamModel,
        ...(r.protocol ? { protocol: r.protocol } : {}),
        enabled: r.enabled !== false,
        ...(r.contextWindow !== undefined ? { contextWindow: r.contextWindow } : {}),
        ...(r.maxOutputTokens !== undefined ? { maxOutputTokens: r.maxOutputTokens } : {}),
        ...(r.supportsStreaming !== undefined ? { supportsStreaming: r.supportsStreaming } : {}),
        ...(r.supportsTools !== undefined ? { supportsTools: r.supportsTools } : {}),
        ...(r.priceInput !== undefined ? { priceInput: r.priceInput } : {}),
        ...(r.priceOutput !== undefined ? { priceOutput: r.priceOutput } : {}),
        ...(r.priceCacheRead !== undefined ? { priceCacheRead: r.priceCacheRead } : {}),
        ...(r.priceCacheWrite !== undefined ? { priceCacheWrite: r.priceCacheWrite } : {}),
        ...(r.tags && r.tags.length ? { tags: r.tags } : {}),
        ...(r.note ? { note: r.note } : {}),
      });
    } else {
      autos.push({
        publicName: r.publicName,
        enabled: r.enabled !== false,
        stickyTtlMs: r.stickyTtlMs ?? 300000,
        ...(r.note ? { note: r.note } : {}),
        // 引用锚=候选 publicName（DR-CB-A）；本机悬空候选导出端静默剔除（导出保持自洽可导入）
        candidates: (r.candidates || []).map((cd) => ({ publicName: byId.get(cd.routeId)?.publicName || '', weight: cd.weight })).filter((cd) => cd.publicName !== ''),
      });
    }
  }
  return { kind: BUNDLE_KIND, version: BUNDLE_VERSION, exportedAt: new Date().toISOString(), channels, routes: { singles, autos } };
}

// ================= 导入：校验 + 计划（dryRun 与提交共用同一构建器，预览≡落盘） =================

const CHAN_FIELDS = new Set(['name', 'baseUrl', 'protocol', 'authStyle', 'extraHeaders', 'testModel', 'modelList', 'enabled', 'timeoutMs', 'note']);
const SINGLE_FIELDS = new Set(['publicName', 'channelName', 'upstreamModel', 'protocol', 'enabled', 'contextWindow', 'maxOutputTokens', 'supportsStreaming', 'supportsTools', 'priceInput', 'priceOutput', 'priceCacheRead', 'priceCacheWrite', 'tags', 'note']);
const AUTO_FIELDS = new Set(['publicName', 'enabled', 'stickyTtlMs', 'note', 'candidates']);
const KEYISH = new Set(['keys', 'api_key', 'apiKey']);

export interface Conflict { name?: string; publicName?: string; reason: string }
export interface Receipt {
  dryRun: boolean;
  channels: { created: number; merged: number; keysAdded: number; keysAddedByChannel: Record<string, number>; conflicts: Conflict[] };
  routes: { created: number; skipped: number; conflicts: Conflict[]; warnings: { publicName?: string; reason: string }[]; candidatesMerged: { publicName: string; changes: string[] }[] };
  pendingKeyChannels: string[];
}
interface Plan {
  chanCreate: { src: any; keyList: string[] }[];
  chanMerge: { targetId: string; name: string; keyList: string[] }[];
  singles: { src: any; channelId?: string; newChanIdx?: number; srcIdx: number }[];
  autos: { src: any; mergeTargetId?: string; okCount: number; changes?: string[] }[];
  candRoutes: { publicName: string; localId?: string; newSingleIdx?: number }[];
  skippedSingles: number;
}

const normOpt = (v: any) => (v === null || v === undefined ? null : v);
const boolDef = (v: any, d: boolean) => (v === undefined || v === null ? d : !!v);
const setEq = (a: string[], b: string[]) => { const sa = new Set(a); const sb = new Set(b); return sa.size === sb.size && [...sa].every((x) => sb.has(x)); };
const hdrEq = (a?: Record<string, string>, b?: Record<string, string>) => {
  const f = (h?: Record<string, string>) => Object.entries(h || {}).sort((x, y) => x[0].localeCompare(y[0])).map((kv) => kv[0] + ':' + kv[1]).join('|');
  return f(a) === f(b);
};
const isNum0 = (v: any) => (v === null || v === undefined ? true : typeof v === 'number' && Number.isFinite(v) && v >= 0);


function chanEq(local: any, src: any) {
  return normalizeBaseUrl(src.baseUrl) === normalizeBaseUrl(local.baseUrl)
    && (src.protocol ?? 'openai') === (local.protocol === 'anthropic' ? 'anthropic' : 'openai')
    && (src.authStyle ?? 'bearer') === (local.authStyle ?? 'bearer')
    && hdrEq(sanitizeExtraHeaders(src.extraHeaders), local.extraHeaders)
    && setEq(toStrList(src.modelList) || [], local.modelList || [])
    && boolDef(src.enabled, true) === (local.enabled !== false)
    && normOpt(src.timeoutMs) === normOpt(local.timeoutMs)
    && (src.testModel ?? '') === (local.testModel ?? '')
    && (src.note ?? '') === (local.note ?? '');
}
function singleEq(local: any, src: any, channelId: string) {
  return local.channelId === channelId
    && local.upstreamModel === String(src.upstreamModel ?? '').trim() // 与 createModel 落库 trim 对齐
    && normOpt(src.protocol) === normOpt(local.protocol)
    && boolDef(src.enabled, true) === (local.enabled !== false)
    && (normOpt(src.contextWindow) ?? 128000) === (normOpt(local.contextWindow) ?? 128000) // 布尔/数值缺省按 create 默认展开后再比（§4.2）
    && normOpt(src.maxOutputTokens) === normOpt(local.maxOutputTokens)
    && boolDef(src.supportsStreaming, true) === boolDef(local.supportsStreaming, true)
    && boolDef(src.supportsTools, true) === boolDef(local.supportsTools, true)
    && normOpt(src.priceInput) === normOpt(local.priceInput)
    && normOpt(src.priceOutput) === normOpt(local.priceOutput)
    && normOpt(src.priceCacheRead) === normOpt(local.priceCacheRead)
    && normOpt(src.priceCacheWrite) === normOpt(local.priceCacheWrite)
    && setEq((src.tags || []).map(String), local.tags || [])
    && (src.note ?? '') === (local.note ?? '');
}

/** 结构畸形 → errors[]（400 逐条零落盘）；字段级脏值 → conflict/warning。DR-CB-G：kind 精确匹配，version > 已知 → 升级指引。 */
export function buildImportPlan(bundle: any, keysRaw: any): { errors?: string[]; plan?: Plan; receipt?: Receipt } {
  const errors: string[] = [];
  const warnings: { publicName?: string; reason: string }[] = [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return { errors: ['bundle 需为对象'] };
  if (bundle.kind !== BUNDLE_KIND) return { errors: ['kind 必须为 ' + BUNDLE_KIND] };
  const ver = bundle.version;
  if (ver !== BUNDLE_VERSION) {
    return { errors: [typeof ver === 'number' && ver > BUNDLE_VERSION ? '该 bundle 由更新版本 own-api 导出（version=' + ver + '），请升级后重试' : 'version 无效'] };
  }
  const chans = bundle.channels ?? [];
  const singlesIn = bundle.routes?.singles ?? [];
  const autosIn = bundle.routes?.autos ?? [];
  if (!Array.isArray(chans) || !Array.isArray(singlesIn) || !Array.isArray(autosIn) || (bundle.routes !== undefined && (typeof bundle.routes !== 'object' || bundle.routes === null))) {
    return { errors: ['channels/routes.singles/routes.autos 需为数组'] };
  }
  if (!chans.length && !singlesIn.length && !autosIn.length) errors.push('空 bundle：channels 与 routes 均为空');
  if (chans.length + singlesIn.length + autosIn.length > 5000) return { errors: ['实体数量超过上限 5000（当前 ' + (chans.length + singlesIn.length + autosIn.length) + '），请拆分 bundle 后重试'] };
  const chanNames = new Set<string>();
  for (let i = 0; i < chans.length; i++) {
    const c = chans[i];
    if (!c || typeof c !== 'object') { errors.push('channels[' + i + '] 需为对象'); continue; }
    if (typeof c.name !== 'string' || !c.name.trim()) errors.push('channels[' + i + '].name 必填');
    else if (chanNames.has(c.name.trim())) errors.push('bundle 内渠道重名：' + c.name.trim() + '（引用锚不唯一）');
    else chanNames.add(c.name.trim());
    if (typeof c.baseUrl !== 'string' || !c.baseUrl.trim()) errors.push('channels[' + i + '].baseUrl 必填');
  }
  const routeNames = new Set<string>();
  for (let i = 0; i < singlesIn.length; i++) {
    const s = singlesIn[i];
    if (!s || typeof s !== 'object') { errors.push('routes.singles[' + i + '] 需为对象'); continue; }
    if (typeof s.publicName !== 'string' || !s.publicName.trim()) errors.push('routes.singles[' + i + '].publicName 必填');
    else if (routeNames.has(s.publicName.trim())) errors.push('bundle 内路由重名：' + s.publicName.trim());
    else routeNames.add(s.publicName.trim());
    if (typeof s.channelName !== 'string') errors.push('routes.singles[' + i + '].channelName 必填');
    if (typeof s.upstreamModel !== 'string' || !s.upstreamModel.trim()) errors.push('routes.singles[' + i + '].upstreamModel 必填');
  }
  for (let i = 0; i < autosIn.length; i++) {
    const a = autosIn[i];
    if (!a || typeof a !== 'object') { errors.push('routes.autos[' + i + '] 需为对象'); continue; }
    if (typeof a.publicName !== 'string' || !a.publicName.trim()) errors.push('routes.autos[' + i + '].publicName 必填');
    else if (routeNames.has(a.publicName.trim())) errors.push('bundle 内路由重名：' + a.publicName.trim());
    else routeNames.add(a.publicName.trim());
    if (a.candidates !== undefined && !Array.isArray(a.candidates)) errors.push('routes.autos[' + i + '].candidates 需为数组');
  }
  if (errors.length) return { errors };

  const keysIn: Record<string, string[]> = {};
  if (keysRaw && typeof keysRaw === 'object' && !Array.isArray(keysRaw)) {
    for (const [n, v] of Object.entries(keysRaw)) {
      const arr = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
      if (arr.length) keysIn[n.trim()] = [...new Set(arr)];
    }
  }
  if (Object.values(keysIn).reduce((s, a) => s + a.length, 0) > 1000) return { errors: ['keys 条目超过上限 1000，请分批导入'] };
  const plan: Plan = { chanCreate: [], chanMerge: [], singles: [], autos: [], candRoutes: [], skippedSingles: 0 };
  const chanConflicts: Conflict[] = [];
  const routeConflicts: Conflict[] = [];
  const keysAddedByChannel: Record<string, number> = {};
  let keysAdded = 0;
  const consumedKeyNames = new Set<string>();
  const ambiguousNames = new Set<string>();
  const pending = new Set<string>();
  const db = store.db;

  for (const src0 of chans) {
    const src = { ...src0 };
    const name = String(src.name).trim();
    for (const k of Object.keys(src)) {
      if (KEYISH.has(k)) warnings.push({ reason: '渠道 ' + name + ' 的密钥字段「' + k + '」已忽略：每人密钥不同，请经导入 keys 参数或渠道页填入' });
      else if (!CHAN_FIELDS.has(k)) warnings.push({ reason: '渠道 ' + name + ' 未知字段「' + k + '」已忽略' });
    }
    for (const k of [...KEYISH]) delete (src as any)[k];
    if (src.protocol !== undefined && src.protocol !== null && src.protocol !== 'openai' && src.protocol !== 'anthropic') { chanConflicts.push({ name, reason: 'protocol 无效' }); continue; }
    if (src.authStyle !== undefined && src.authStyle !== 'bearer' && src.authStyle !== 'x-api-key') { chanConflicts.push({ name, reason: 'authStyle 无效' }); continue; }
    if (src.timeoutMs !== undefined && src.timeoutMs !== null && !(typeof src.timeoutMs === 'number' && Number.isFinite(src.timeoutMs) && src.timeoutMs >= 1000 && src.timeoutMs <= 3_600_000)) { chanConflicts.push({ name, reason: 'timeoutMs 无效（1000..3600000 或 null）' }); continue; }
    if ((src.note !== undefined && typeof src.note !== 'string') || (src.testModel !== undefined && typeof src.testModel !== 'string')) { chanConflicts.push({ name, reason: 'note/testModel 需为字符串' }); continue; }
    if (src.extraHeaders !== undefined && src.extraHeaders !== null && (typeof src.extraHeaders !== 'object' || Array.isArray(src.extraHeaders))) { chanConflicts.push({ name, reason: 'extraHeaders 需为对象' }); continue; }
    try { normalizeBaseUrl(String(src.baseUrl)); } catch (e: any) { chanConflicts.push({ name, reason: 'baseUrl 无效：' + (e?.message || '仅支持 http/https') }); continue; } // 正确性审查 H1：createChannel 会抛→半截落盘，闸必须前移
    const matches = db.channels.filter((c) => c.name.trim() === name);
    const keyList = keysIn[name] || [];
    if (keyList.length) consumedKeyNames.add(name);
    if (matches.length >= 2) {
      chanConflicts.push({ name, reason: '本机存在 ' + matches.length + ' 个同名渠道，无法判定合并目标，请先改名' });
      ambiguousNames.add(name);
      if (keyList.length) warnings.push({ reason: '渠道 ' + name + ' 同名歧义，密钥未写入' });
      continue;
    }
    if (matches.length === 1) {
      const local = matches[0];
      if (!chanEq(local, src)) {
        chanConflicts.push({ name, reason: '已存在且配置不同（merge 不覆盖，请人工核对）' });
        if (keyList.length) warnings.push({ reason: '渠道 ' + name + ' 冲突，密钥未写入，冲突解决后请到渠道页填写' });
        continue;
      }
      const have = new Set((local.keys || []).map((k) => k.key));
      const net = keyList.filter((k) => !have.has(k)).length;
      if (net) { keysAddedByChannel[name] = net; keysAdded += net; }
      plan.chanMerge.push({ targetId: local.id, name, keyList });
      const usableNow = (local.keys || []).some((k: any) => k.status === 'active' || k.status === 'cooldown');
      if (!usableNow && keyList.length === 0) pending.add(name); // §5 判据：无 active 即待填（cooldown 瞬态不算；disabled 算——双评审裁决）
    } else {
      plan.chanCreate.push({ src, keyList });
      if (keyList.length) { keysAddedByChannel[name] = keyList.length; keysAdded += keyList.length; }
      if (keyList.length === 0) pending.add(name);
    }
  }
  for (const n of Object.keys(keysIn)) {
    if (!consumedKeyNames.has(n)) warnings.push({ reason: '渠道 ' + n + ' 不存在（或已冲突/歧义），密钥未写入' });
  }
  const chanConflictNames = new Set(chanConflicts.map((c) => c.name));
  const createdChanNames = new Set(plan.chanCreate.map((p) => String(p.src.name).trim()));

  const singleIdByName = new Map(db.routes.filter((r): r is any => r.type === 'single').map((r: any) => [r.publicName, r.id] as const));
  const autoNameSet = new Set(db.routes.filter((r) => r.type === 'auto').map((r: any) => r.publicName));

  const accTags = new Set<string>(); // 计划层 tag 闸：守 dryRun≡提交
  singlesIn.forEach((src: any, srcIdx: number) => {
    const name = String(src.publicName).trim();
    for (const k of Object.keys(src)) { if (KEYISH.has(k)) warnings.push({ publicName: name, reason: '密钥字段「' + k + '」已忽略：每人密钥不同，请经 keys 参数或渠道页填入' }); else if (!SINGLE_FIELDS.has(k)) warnings.push({ publicName: name, reason: '未知字段「' + k + '」已忽略' }); }
    if (src.protocol !== undefined && src.protocol !== null && src.protocol !== 'openai' && src.protocol !== 'anthropic') { routeConflicts.push({ publicName: name, reason: 'protocol 无效' }); return; }
    if (!(isNum0(src.contextWindow) && isNum0(src.maxOutputTokens) && isNum0(src.priceInput) && isNum0(src.priceOutput) && isNum0(src.priceCacheRead) && isNum0(src.priceCacheWrite))) { routeConflicts.push({ publicName: name, reason: '数值字段需为非负数或 null' }); return; }
    if (src.tags !== undefined && !(Array.isArray(src.tags) && src.tags.every((t: any) => typeof t === 'string'))) { routeConflicts.push({ publicName: name, reason: 'tags 需为字符串数组' }); return; }
    const cn = String(src.channelName ?? '').trim();
    const matches = db.channels.filter((c) => c.name.trim() === cn);
    if (matches.length >= 2 || ambiguousNames.has(cn)) { routeConflicts.push({ publicName: name, reason: '渠道 ' + cn + ' 同名歧义，无法归属' }); return; }
    let channelId: string | undefined; let newChanIdx: number | undefined;
    if (matches.length === 1) {
      channelId = matches[0].id;
      if (chanConflictNames.has(cn)) warnings.push({ publicName: name, reason: '引用了 conflict 渠道 ' + cn + '（本机配置不同），请人工核对' });
    } else if (createdChanNames.has(cn)) newChanIdx = plan.chanCreate.findIndex((p) => String(p.src.name).trim() === cn);
    else { routeConflicts.push({ publicName: name, reason: '渠道 ' + cn + ' 不存在' }); return; }
    const existing = db.routes.find((r): r is any => r.type === 'single' && r.publicName === name);
    if (existing) {
      if (channelId === undefined) { routeConflicts.push({ publicName: name, reason: '本机已存在同名单模型，但 bundle 将其挂到本包新建渠道' }); return; }
      if (singleEq(existing, src, channelId)) plan.skippedSingles++;
      else routeConflicts.push({ publicName: name, reason: '已存在且配置不同（不覆盖）' });
      return;
    }
    if (store.routeNameTaken(name)) { routeConflicts.push({ publicName: name, reason: '外名/tag 与既有路由冲突' }); return; }
    {
      const tg: string[] = (src.tags || []).map(String);
      let tagBad = '';
      for (const t of tg) { if (store.routeNameTaken(t) || accTags.has(t)) { tagBad = t; break; } }
      if (tagBad) { routeConflicts.push({ publicName: name, reason: 'tag「' + tagBad + '」与既有路由或本包内冲突' }); return; }
      for (const t of tg) accTags.add(t);
    }
    plan.singles.push({ src, channelId, newChanIdx, srcIdx });
  });
  const bundleSingleNames = new Set(singlesIn.map((s: any) => String(s.publicName).trim()));
  const conflictedSingles = new Set(routeConflicts.map((x) => String(x.publicName)).filter((n: string) => bundleSingleNames.has(n)));

  const candNameSet = new Set<string>();
  const bundleSingleIdx = new Map<string, number>();
  singlesIn.forEach((s: any, i: number) => bundleSingleIdx.set(String(s.publicName).trim(), i));

  for (const src of autosIn) {
    const name = String(src.publicName).trim();
    for (const k of Object.keys(src)) { if (KEYISH.has(k)) warnings.push({ publicName: name, reason: '密钥字段「' + k + '」已忽略：每人密钥不同，请经 keys 参数或渠道页填入' }); else if (!AUTO_FIELDS.has(k)) warnings.push({ publicName: name, reason: '未知字段「' + k + '」已忽略' }); }
    const cands = (Array.isArray(src.candidates) ? src.candidates : []) as any[];
    if (cands.length > 16) { routeConflicts.push({ publicName: name, reason: '候选数量超过上限 16（与路由存储同闸，不静默截断）' }); continue; }
    if (src.stickyTtlMs !== undefined && !(typeof src.stickyTtlMs === 'number' && Number.isFinite(src.stickyTtlMs) && src.stickyTtlMs >= 1000 && src.stickyTtlMs <= 86400000)) { routeConflicts.push({ publicName: name, reason: 'stickyTtlMs 无效（1000..86400000）' }); continue; }
    let weightBad = false;
    for (const cdw of cands) { const wv = cdw && cdw.weight; if (wv !== undefined && wv !== null && !(typeof wv === 'number' && Number.isFinite(wv) && wv >= 0 && wv <= 10000)) { weightBad = true; break; } }
    if (weightBad) { routeConflicts.push({ publicName: name, reason: '候选 weight 无效（0..10000）' }); continue; }
    let okCount = 0;
    for (const cd of cands) {
      const pn = cd && typeof cd.publicName === 'string' ? cd.publicName.trim() : '';
      if (!pn) continue;
      if (pn === name || autoNameSet.has(pn) || autosIn.some((a: any) => String(a.publicName).trim() === pn)) { warnings.push({ publicName: name, reason: '候选 ' + pn + ' 指向自动路由，已跳过（禁嵌套）' }); continue; }
      if (conflictedSingles.has(pn)) { warnings.push({ publicName: name, reason: '候选 ' + pn + ' 因配置冲突未导入，已跳过' }); continue; }
      if (singleIdByName.has(pn) || bundleSingleNames.has(pn)) {
        if (!candNameSet.has(pn)) {
          candNameSet.add(pn);
          plan.candRoutes.push(singleIdByName.has(pn) ? { publicName: pn, localId: singleIdByName.get(pn) } : { publicName: pn, newSingleIdx: bundleSingleIdx.get(pn) });
        }
        okCount++;
      } else warnings.push({ publicName: name, reason: '候选 ' + pn + ' 不存在，已跳过' });
    }
    const existing = db.routes.find((r): r is any => r.type === 'auto' && r.publicName === name);
    if (existing) {
      if (boolDef(src.enabled, true) !== (existing.enabled !== false) || (src.stickyTtlMs !== undefined && normOpt(src.stickyTtlMs) !== normOpt(existing.stickyTtlMs ?? 300000)) || ((src.note ?? '') !== (existing.note ?? ''))) {
        routeConflicts.push({ publicName: name, reason: '已存在且配置不同（不覆盖）' });
        continue;
      }
      if (!okCount) { warnings.push({ publicName: name, reason: '无可解析候选，auto 未合并' }); continue; }
      // §4.2 回执列合并后候选集：篡改 bundle 给既有 auto 塞候选/改权重，必须在两步审阅里可见
      const curBy = new Map<string, number>();
      for (const x of (existing.candidates || [])) curBy.set(x.routeId, typeof x.weight === 'number' ? x.weight : 1);
      const changes: string[] = []; const seenChg = new Set<string>();
      for (const cd of cands) {
        const pn2 = cd && typeof cd.publicName === 'string' ? cd.publicName.trim() : '';
        if (!pn2 || seenChg.has(pn2)) continue;
        if (!singleIdByName.has(pn2) && !bundleSingleNames.has(pn2)) continue;
        const w2 = typeof cd.weight === 'number' && Number.isFinite(cd.weight) ? Math.trunc(cd.weight) : 1;
        const lid = singleIdByName.get(pn2); // 本机同名 single（含包内同名已合并项）一律按本机 id 判权重改写
        seenChg.add(pn2);
        if (lid === undefined) changes.push('新增候选 ' + pn2 + '（w' + w2 + '）');
        else if (curBy.has(lid)) { const old = curBy.get(lid)!; if (old !== w2) changes.push('权重 ' + pn2 + '：' + old + '→' + w2); }
        else changes.push('新增候选 ' + pn2 + '（w' + w2 + '）');
      }
      if ((existing.candidates || []).length + changes.filter((s) => s.indexOf('新增候选') === 0).length > 16) { routeConflicts.push({ publicName: name, reason: '合并后候选并集超过上限 16（与存储同闸）' }); continue; }
      if (!changes.length) changes.push('候选不变（合并为空操作）');
      plan.autos.push({ src, mergeTargetId: existing.id, okCount, changes });
      continue;
    }
    if (store.routeNameTaken(name)) { routeConflicts.push({ publicName: name, reason: '外名/tag 与既有路由冲突' }); continue; }
    if (!okCount) { warnings.push({ publicName: name, reason: '候选全部无法解析，auto 未创建' }); continue; }
    plan.autos.push({ src, okCount });
  }

  const receipt: Receipt = {
    dryRun: false,
    channels: { created: plan.chanCreate.length, merged: plan.chanMerge.length, keysAdded, keysAddedByChannel, conflicts: chanConflicts },
    routes: { created: plan.singles.length + plan.autos.filter((a) => !a.mergeTargetId).length, skipped: plan.skippedSingles, conflicts: routeConflicts, warnings, candidatesMerged: plan.autos.filter((a) => a.mergeTargetId).map((a) => ({ publicName: String(a.src.publicName).trim(), changes: a.changes || [] })) },
    pendingKeyChannels: [...pending],
  };
  return { plan, receipt };
}

/** 落盘：与 buildImportPlan 共享同一计划，仅落盘一步分叉（预览≡提交）。返回与计划的偏差（干净 bundle 应为空）。 */
export function applyPlan(plan: Plan): Conflict[] {
  const errs: Conflict[] = [];
  const idByNewChan = new Map<number, string>();
  for (let i = 0; i < plan.chanCreate.length; i++) {
    const p = plan.chanCreate[i];
    const src = p.src;
    const ch = store.createChannel({
      name: String(src.name).trim(), baseUrl: src.baseUrl, protocol: src.protocol,
      authStyle: src.authStyle, extraHeaders: sanitizeExtraHeaders(src.extraHeaders),
      testModel: src.testModel, modelList: toStrList(src.modelList), enabled: boolDef(src.enabled, true),
      timeoutMs: src.timeoutMs ?? undefined, note: src.note,
    });
    if (p.keyList.length) store.addKeys(ch.id, p.keyList.map((k) => ({ key: k })));
    idByNewChan.set(i, ch.id);
  }
  for (const m of plan.chanMerge) {
    if (m.keyList.length) store.addKeys(m.targetId, m.keyList.map((k) => ({ key: k })));
  }
  const idByNewSingle = new Map<number, string>();
  for (const p of plan.singles) {
    const src = p.src;
    const channelId = p.channelId ?? (p.newChanIdx !== undefined ? idByNewChan.get(p.newChanIdx) : undefined);
    if (!channelId) { errs.push({ publicName: src.publicName, reason: '渠道归属在落盘时丢失' }); continue; }
    const { model, error } = store.createModel({
      type: 'single', publicName: String(src.publicName).trim(), channelId, upstreamModel: src.upstreamModel,
      protocol: src.protocol ?? undefined, enabled: boolDef(src.enabled, true),
      contextWindow: src.contextWindow ?? undefined, maxOutputTokens: src.maxOutputTokens ?? undefined,
      supportsStreaming: src.supportsStreaming, supportsTools: src.supportsTools,
      priceInput: src.priceInput ?? undefined, priceOutput: src.priceOutput ?? undefined,
      priceCacheRead: src.priceCacheRead ?? undefined, priceCacheWrite: src.priceCacheWrite ?? undefined,
      tags: src.tags, note: src.note,
    } as any);
    if (!model) errs.push({ publicName: src.publicName, reason: error || '创建失败' });
    else idByNewSingle.set(p.srcIdx, model.id);
  }
  for (const a of plan.autos) {
    const srcCands: any[] = Array.isArray(a.src.candidates) ? a.src.candidates : [];
    const cands: { routeId: string; weight: number }[] = [];
    const seen = new Map<string, number>();
    for (const cd of srcCands) {
      const pn = cd && typeof cd.publicName === 'string' ? cd.publicName.trim() : '';
      const idx = plan.candRoutes.findIndex((x) => x.publicName === pn);
      if (idx < 0) continue;
      const cr = plan.candRoutes[idx];
      const rid = cr.localId ?? (cr.newSingleIdx !== undefined ? idByNewSingle.get(cr.newSingleIdx) : undefined);
      if (!rid) continue;
      const w = typeof cd.weight === 'number' && Number.isFinite(cd.weight) ? Math.trunc(cd.weight) : 1;
      const dup = seen.get(rid);
      if (dup !== undefined) { cands[dup].weight = w; continue; }
      seen.set(rid, cands.length);
      cands.push({ routeId: rid, weight: w });
    }
    if (a.mergeTargetId) {
      const cur = store.getRoute(a.mergeTargetId) as any;
      if (!cur) { errs.push({ publicName: a.src.publicName, reason: '合并目标丢失' }); continue; }
      const merged = [...(cur.candidates || [])];
      for (const cd of cands) {
        const ex = merged.find((x: any) => x.routeId === cd.routeId);
        if (ex) ex.weight = cd.weight; // weight 冲突 bundle 胜（评审仲裁）
        else merged.push(cd);
      }
      const { auto, error } = store.updateAutoRoute(a.mergeTargetId, { candidates: merged } as any);
      if (!auto) errs.push({ publicName: a.src.publicName, reason: error || '合并候选失败' });
    } else {
      if (!cands.length) { errs.push({ publicName: a.src.publicName, reason: '无可解析候选（包内候选全部 conflict）' }); continue; }
      const { auto, error } = store.createAutoRoute({ type: 'auto', publicName: String(a.src.publicName).trim(), enabled: boolDef(a.src.enabled, true), stickyTtlMs: a.src.stickyTtlMs ?? 300000, note: a.src.note, candidates: cands });
      if (!auto) errs.push({ publicName: a.src.publicName, reason: error || '创建失败' });
    }
  }
  return errs;
}