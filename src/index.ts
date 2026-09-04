import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { store } from './store.ts';
import { gcRpmWindows } from './usage.ts';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const app = createApp();

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const s = store.getSettings();
  const vk = store.listVKeys()[0];
  const base = `http://${info.address}:${info.port}`;
  console.log(`\n  llm-manager 已启动`);
  console.log(`  ├─ 管理台    ${base}/`);
  console.log(`  ├─ 统一代理  ${base}/v1   (OpenAI 与 Anthropic 双协议)`);
  console.log(`  ├─ 管理令牌  ${s.adminToken}`);
  console.log(`  └─ 默认 Key  ${vk ? vk.key : '(未创建)'}`);
  if (process.env.LLM_ADMIN_TOKEN) console.log(`  (管理令牌来自环境变量 LLM_ADMIN_TOKEN)`);
  console.log('');
});

// 唯一的信号处理入口：停表 -> 落盘 -> 关连接 -> 退出
const gc = setInterval(gcRpmWindows, 60_000);
gc.unref();

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log(`\n  收到 ${sig}，正在落盘并退出…`);
    clearInterval(gc);
    store.flushSync();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
