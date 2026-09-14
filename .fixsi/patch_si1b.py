# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
h = rd('test/e2e.ts')
anchor = "// ================================================================\nconsole.log("
assert h.count(anchor) == 1
h = h.replace(anchor, rd('.fixsi/e2e_empty.txt') + anchor)
wr('test/e2e.ts', h)
print('empty pin ok')
