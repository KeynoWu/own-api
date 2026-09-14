// 配置组导出（docs/config-bundle-design.md v2.1）。导入逻辑见文件后半（CB-2/3 落地）。
import { store } from './store.ts';

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