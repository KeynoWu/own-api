# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
h = rd('src/usage.ts')
assert 'buildSpeedStats' not in h
wr('src/usage.ts', h.rstrip(chr(10)) + chr(10) + rd('.fixsi/speed_impl.txt'))
h = rd('src/admin.ts')
old = "  app.get('/stats', (c) => c.json(buildStats(Number(c.req.query('hours') || 24))));"
assert h.count(old) == 1
new = old + chr(10) + "  // 速度排行（speed-insights v1.1）：hours 归一钳制在 buildSpeedStats 内（DR-SI-8）"
new += chr(10) + "  app.get('/stats/speed', (c) => c.json(buildSpeedStats(Number(c.req.query('hours') ?? 24))));"
h = h.replace(old, new)
imp_old = "import { buildStats } from './usage.js';"
if h.count(imp_old) != 1:
    import re
    m = re.search(r"import \{[^}]*buildStats[^}]*\} from '[^']*';", h)
    assert m, 'import not found'
    imp_old = m.group(0)
imp_new = imp_old.replace('buildStats', 'buildSpeedStats, buildStats') if 'buildSpeedStats' not in imp_old else imp_old
h = h.replace(imp_old, imp_new)
wr('src/admin.ts', h)
h = rd('test/e2e.ts')
anchor = rd('.fixsi/anchor.txt')
assert h.count(anchor) == 1, h.count(anchor)
h = h.replace(anchor, rd('.fixsi/e2e_speed.txt') + anchor)
wr('test/e2e.ts', h)
print('si1 applied')
