// SEA 单文件产物：esbuild 打全量 JS → Node SEA 配置生成 blob → postject 注入 node 副本
// 用法：node scripts/build-sea.mjs（各平台各自构建——SEA 不能交叉编译，CI 矩阵跑同一脚本）
import { build } from 'esbuild';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { platform, arch } from 'node:os';
import { inject as postject } from 'postject';

const isWin = platform() === 'win32';
// 交叉出 Intel Mac 产物（不交叉编译——SEA 构建全程无需运行 x64）：
//   SEA_HOST_BIN=<x64 node 路径> SEA_ARCH=x64 node scripts/build-sea.mjs
// CI 的 x64 mac job 用 setup-node architecture:x64（Rosetta 执行），默认路径即可
const hostBin = process.env.SEA_HOST_BIN || process.execPath;
const targetArch = process.env.SEA_ARCH || (arch() === 'arm64' ? 'arm64' : 'x64');
const outName = `own-api-${targetArch}${isWin ? '.exe' : ''}`;
const out = `dist/${outName}`;
mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/sea-bundle.cjs',
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('① 打包完成 dist/sea-bundle.cjs');

writeFileSync('dist/sea-config.json', JSON.stringify({ main: 'dist/sea-bundle.cjs', output: 'dist/sea-prep.blob', disableExperimentalSEAWarning: true }, null, 2));
execSync(`"${process.execPath}" --experimental-sea-config dist/sea-config.json`, { stdio: 'inherit' });
console.log('② SEA blob 完成');

if (existsSync(out)) rmSync(out);
copyFileSync(hostBin, out);
chmodSync(out, 0o755);
if (platform() === 'darwin') execSync(`codesign --remove-signature "${out}"`);
// fuse 值随 node 构建而异（写死会翻车）：从注入宿主（hostBin）二进制里读
const fuseMatch = readFileSync(hostBin).toString('latin1').match(/NODE_SEA_FUSE_[0-9a-f]{32}/);
if (!fuseMatch) throw new Error(`${hostBin} 里找不到 SEA fuse（可能构建时禁用了 SEA）`);
await postject(out, 'NODE_SEA_BLOB', readFileSync('dist/sea-prep.blob'), {
  sentinelFuse: fuseMatch[0],
  machoSegmentName: platform() === 'darwin' ? 'NODE_SEA' : undefined,
});
if (platform() === 'darwin') execSync(`codesign --sign - "${out}"`); // arm64 必须有签名（adhoc）才能跑
console.log(`✅ ${out}`);
