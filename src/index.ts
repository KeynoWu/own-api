import { serve } from '@hono/node-server';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { store, getDataDir } from './store.ts';
import { gcRpmWindows } from './usage.ts';
import { envAny, openBrowser } from './bootstrap.ts';

const PORT = Number(envAny(['OWN_API_PORT', 'PORT']) || 8787);
const HOST = envAny(['OWN_API_HOST', 'HOST']) || '127.0.0.1';
const app = createApp();

// 端口避让：桌面双击场景"下一个端口"远比"启动失败"友好；8 次后认输
let attempt = 0;
let server = listen(PORT);

function listen(port: number) {
  const srv = serve({ fetch: app.fetch, port, hostname: HOST }, (info) => {
    const s = store.getSettings();
    const vk = store.listVKeys()[0];
    const shownHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
    const base = `http://${shownHost}:${info.port}`;
    console.log(`\n  own-api 已启动`);
    console.log(`  ├─ 管理台    ${base}/`);
    console.log(`  ├─ 统一代理  ${base}/v1   (OpenAI 与 Anthropic 双协议)`);
    console.log(`  ├─ 管理令牌  ${s.adminToken}`);
    console.log(`  ├─ 默认 Key  ${vk ? vk.key : '(未创建)'}`);
    if (port !== PORT) console.log(`  ├─ 端口避让  ${PORT} 被占用，已改用 ${info.port}`);
    if (envAny(['OWN_API_ADMIN_TOKEN', 'LLM_ADMIN_TOKEN'])) console.log(`  (管理令牌来自环境变量)`);
    console.log('');
    // 会话交接文件：桌面壳（Tauri/托盘）从这里拿端口与令牌再开浏览器；含 token 必须 0600
    try {
      mkdirSync(getDataDir(), { recursive: true, mode: 0o700 });
      const f = join(getDataDir(), 'last-session.json');
      writeFileSync(f, JSON.stringify({ base, port: info.port, token: s.adminToken, startedAt: new Date().toISOString() }));
      try {
        chmodSync(f, 0o600);
      } catch {
        /* win 无 posix 位 */
      }
    } catch (err) {
      console.error('  (last-session.json 写入失败，桌面壳将无法自动获取令牌：' + String((err as any)?.message || err) + ')');
    }
    if (envAny(['OWN_API_OPEN_BROWSER']) === '1') openBrowser(`${base}/#token=${encodeURIComponent(s.adminToken)}`);
  });
  srv.on('error', (err: any) => {
    if (err?.code === 'EADDRINUSE' && attempt < 8) {
      attempt++;
      console.log(`  端口 ${port} 被占用，尝试 ${port + 1}…`);
      server = listen(port + 1);
    } else {
      console.error(`  own-api 启动失败：${err?.code || err}（请检查端口占用或设 OWN_API_PORT 指定端口）`);
      process.exit(1);
    }
  });
  return srv;
}

// 唯一的退出路径：停表 -> 落盘 -> 关连接 -> 退出（信号 / 父进程看护共用）
const gc = setInterval(gcRpmWindows, 60_000);
gc.unref();

let closing = false;
function shutdown(reason: string) {
  if (closing) return;
  closing = true;
  console.log(`\n  ${reason}，正在落盘并退出…`);
  clearInterval(gc);
  store.flushSync();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => shutdown(`收到 ${sig}`));
}

// 桌面看护：OWN_API_PPID 由桌面壳传入；壳没了（含崩溃/强杀）服务绝不孤儿驻留。
// 2s 轮询存在性；PID 复用在个人单机语境按可忽略处理
const ppid = Number(envAny(['OWN_API_PPID']) || 0);
if (ppid > 0) {
  const guard = setInterval(() => {
    try {
      process.kill(ppid, 0);
    } catch {
      shutdown('桌面壳已退出');
    }
  }, 2000);
  guard.unref();
}
