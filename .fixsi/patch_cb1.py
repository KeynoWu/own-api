# -*- coding: utf-8 -*-
import io, shutil
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
shutil.copy('.fixsi/cb_mod.ts.txt', 'src/config-bundle.ts')
h = rd('src/admin.ts')
a = rd('.fixsi/admin_old.txt'); n = rd('.fixsi/admin_new.txt')
assert h.count(a) == 1, 'admin anchor %d' % h.count(a)
h = h.replace(a, n)
imp = "import { buildSpeedStats, buildStats, quotaSnapshot } from './usage.ts';"
assert h.count(imp) == 1
h = h.replace(imp, imp + chr(10) + "import { buildBundle } from './config-bundle.ts';")
wr('src/admin.ts', h)
h = rd('web/index.html')
fa = rd('.fixsi/fn_anchor2.txt.txt')
assert h.count(fa) == 1
h = h.replace(fa, rd('.fixsi/web_fn.txt.txt') + fa)
for nm in ['tb1', 'tb2']:
    o = rd('.fixsi/%s_old.txt' % nm); x = rd('.fixsi/%s_new.txt' % nm)
    assert h.count(o) == 1, nm + ' %d' % h.count(o)
    h = h.replace(o, x)
wr('web/index.html', h)
h = rd('test/e2e.ts')
anchor = "// ================================================================\nconsole.log("
assert h.count(anchor) == 1
h = h.replace(anchor, rd('.fixsi/e2e_cb1.txt.txt') + rd('.fixsi/e2e_empty.txt') + anchor)
wr('test/e2e.ts', h)
h = rd('test/hardening.ts')
pa = "// ---------- R3：v3 形状净化 + 退出锁清理（真 spawn） ----------"
assert h.count(pa) == 1
h = h.replace(pa, rd('.fixsi/dom_pin2.txt.txt') + pa)
wr('test/hardening.ts', h)
print('cb1 applied')
