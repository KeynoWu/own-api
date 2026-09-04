/**
 * 桌面发行地基：环境前缀、数据目录、浏览器拉起。
 * 纯函数无副作用（store 在 import 期就调 resolveDataDir，这里绝不能藏 IO）。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 带前缀的环境变量读取：新 OWN_API_* 优先，兼容历史 LLM_*（升级期两套都认） */
export function envAny(names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/**
 * 数据目录解析：显式 env > 开发兼容（工作目录 ./data 已有库就继续用，
 * 源码开发者升级无感）> 默认 ~/.own-api（桌面发行形态，绝不落在 cwd——
 * 同事把源码放网盘/共享目录也不会两人共账）。
 */
export function resolveDataDir(cwd: string = process.cwd()): string {
  const explicit = envAny(['OWN_API_DATA_DIR', 'LLM_DATA_DIR']);
  if (explicit) return explicit;
  if (existsSync(join(cwd, 'data', 'db.json'))) return join(cwd, 'data');
  return join(homedir(), '.own-api');
}

/** 拉起系统默认浏览器；失败静默——它绝不能把服务本身带崩 */
export function openBrowser(url: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 无桌面环境（服务器/CI）正常路径 */
  }
}
