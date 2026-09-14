# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
# e2e 内容小修
seg = rd('.fixsi/e2e_cb3.txt').replace("  const net = await import('node:net');" + chr(10), '')
wr('.fixsi/e2e_cb3.txt', seg)
h = rd('web/index.html')
if 'cbReceiptText' not in h:
    fa = '// ---------------- 速度排行（speed-insights v1.1） ----------------'
    assert h.count(fa) == 1
    h = h.replace(fa, rd('.fixsi/web_cb3.txt') + fa)
btn = "    el('button', { class: 'btn sm', onclick: () => exportConfig() }, '导出全部配置'),"
if h.count(btn) == 2:
    h = h.replace(btn, btn + chr(10) + "    el('button', { class: 'btn sm', onclick: () => importConfig() }, '导入配置'),")
else:
    assert '导入配置' in h
pill = "        el('span', { class: 'pill' }, \`可用 key \${c.availableKeys}/\${c.keys.length}\`),"
if h.count(pill) == 1:
    h = h.replace(pill, pill + chr(10) + "        c.keys.length === 0 && c.enabled ? el('span', { class: 'pill warn', style: 'cursor:pointer', title: '点击导入密钥', onclick: () => addKeys() }, '待填密钥') : null,")
else:
    assert '待填密钥' in h
wr('web/index.html', h)
h = rd('test/e2e.ts')
h = h.replace("import { mkdtempSync, rmSync } from 'node:fs';", "import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';")
if '21. 配置组提交导入' not in h:
    anchor = '// ============ 18. 速度空窗（clearLogs 放最末，不伤任何 log 依赖断言） ============'
    assert h.count(anchor) == 1
    h = h.replace(anchor, rd('.fixsi/e2e_cb3.txt') + anchor)
wr('test/e2e.ts', h)
h = rd('test/hardening.ts')
if 'cbReceiptText' not in h:
    pa = '// ---------- R3：v3 形状净化 + 退出锁清理（真 spawn） ----------'
    assert h.count(pa) == 1
    h = h.replace(pa, rd('.fixsi/dom_pin3.txt') + pa)
wr('test/hardening.ts', h)
print('cb3 applied')
