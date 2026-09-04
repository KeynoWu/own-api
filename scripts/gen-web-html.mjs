// 把 web/index.html 内嵌成 TS 模块（SEA 单文件产物没有磁盘上的 web/ 目录）
// 改过 web/index.html 记得 npm run gen:web——e2e §16 有陈旧性守护断言兜底
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('web/index.html', 'utf8');
const body = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const out = '// 生成文件：由 scripts/gen-web-html.mjs 产出，勿手改（源头是 web/index.html）' + String.fromCharCode(10) + 'export const WEB_HTML = `' + body + '`;' + String.fromCharCode(10);
writeFileSync('src/web-html.gen.ts', out);
console.log(`web-html.gen.ts 已生成（${(html.length / 1024).toFixed(1)} KB）`);
