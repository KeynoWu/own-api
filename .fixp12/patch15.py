# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
h = rd('src/mock-upstream.ts')
sm = "  if (body.model === 'mock-hugeframe') {"
assert h.count(sm) == 1
h = h.replace(sm, rd('.fixp12/mock.txt').rstrip(chr(10)) + chr(10) + sm)
wr('src/mock-upstream.ts', h)
h = rd('test/e2e.ts')
anchor = rd('.fixp12/anchor.txt')
assert h.count(anchor) == 1, h.count(anchor)
h = h.replace(anchor, anchor + (anchor + rd('.fixp12/e2e.txt').rstrip(chr(10))))
wr('test/e2e.ts', h)
print('p10 pins ok')
