// 把 SEA 二进制按 Tauri sidecar 命名规范（name-<target-triple>）放进 src-tauri/binaries
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { arch, platform } from 'node:os';
const isWin = platform() === 'win32';
const triple = platform() === 'darwin' ? (arch() === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin') : isWin ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
const src = `dist/own-api-${arch() === 'arm64' ? 'arm64' : 'x64'}${isWin ? '.exe' : ''}`;
const dst = `src-tauri/binaries/own-api-${triple}${isWin ? '.exe' : ''}`;
if (!existsSync(src)) { console.error('先跑 npm run build:sea'); process.exit(1); }
mkdirSync('src-tauri/binaries', { recursive: true });
copyFileSync(src, dst);
if (!isWin) chmodSync(dst, 0o755);
console.log('sidecar 就位:', dst);
