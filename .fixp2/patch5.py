# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
# store: legacy auto candidates 兜底
h = rd('src/store.ts')
OLD = '          ...(arr<any>(legacy.autoRoutes) ?? []).map((a) => ({ ...a, type: ' + chr(39) + 'auto' + chr(39) + ' as const })),'
NEW = '          ...(arr<any>(legacy.autoRoutes) ?? []).map((a) => ({ ...a, candidates: Array.isArray((a as any)?.candidates) ? (a as any).candidates : [], type: ' + chr(39) + 'auto' + chr(39) + ' as const })),'
assert h.count(OLD) == 1, 'auto guard anchor'
h = h.replace(OLD, NEW)
wr('src/store.ts', h)
# hardening: P2 脏迁移矩阵插到 v2mig 块之后
h = rd('test/hardening.ts')
sm = '  rmSync(migDir, { recursive: true, force: true });'
s = h.index(sm)
e = h.index(chr(10) + '}', s) + 2
h = h[:e] + chr(10) + rd('.fixp2/p2_test.txt') + h[e:]
wr('test/hardening.ts', h)
print('p2 patch5 ok')
