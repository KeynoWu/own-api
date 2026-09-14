# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
h = rd('src/config-bundle.ts')
assert 'buildImportPlan' not in h
frag = rd('.fixsi/cb2_core.txt')
h = h.replace("from './store.js'", "from './store.ts'") if "'./store.js'" in h else h
h = h.replace('store.routeNameTaken(name, null)', 'store.routeNameTaken(name)')
assert "'./store.ts'" in rd('src/config-bundle.ts') or "'./store.js'" not in h
wr('src/config-bundle.ts', h.rstrip(chr(10)) + chr(10) + frag)
h = rd('src/store.ts')
h = h.replace('function toStrList(', 'export function toStrList(')
h = h.replace('function sanitizeExtraHeaders(', 'export function sanitizeExtraHeaders(')
wr('src/store.ts', h)
h = rd('src/config-bundle.ts')
imp_old = "import { store } from './store.ts';"
assert h.count(imp_old) == 1, 'cb imp anchor' 
h = h.replace(imp_old, "import { store, normalizeBaseUrl, toStrList, sanitizeExtraHeaders } from './store.ts';")
wr('src/config-bundle.ts', h)
h = rd('src/admin.ts')
a = "  app.get('/config/export', (c) => c.json(buildBundle()));"
assert h.count(a) == 1
h = h.replace(a, a + chr(10) + rd('.fixsi/admin_cb2.txt').rstrip(chr(10)))
iold = "import { buildBundle } from './config-bundle.ts';"
assert h.count(iold) == 1
h = h.replace(iold, "import { buildBundle, buildImportPlan, applyPlan } from './config-bundle.ts';")
wr('src/admin.ts', h)
h = rd('test/e2e.ts')
anchor = '// ============ 18. 速度空窗（clearLogs 放最末，不伤任何 log 依赖断言） ============'
assert h.count(anchor) == 1
h = h.replace(anchor, rd('.fixsi/e2e_cb2.txt') + anchor)
wr('test/e2e.ts', h)
print('cb2 applied')
