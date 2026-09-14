# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
h = rd('test/e2e.ts')
o = rd('.fixp8/e2e_old.txt'); n = rd('.fixp8/e2e_new.txt')
assert h.count(o) == 1, 'e2e %d' % h.count(o)
h = h.replace(o, n)
wr('test/e2e.ts', h)
h = rd('test/hardening.ts')
for nm in ('hard_ready', 'hard_blk'):
    oo = rd('.fixp8/' + nm + '_old.txt'); nn = rd('.fixp8/' + nm + '_new.txt')
    assert h.count(oo) == 1, nm + ' %d' % h.count(oo)
    h = h.replace(oo, nn)
wr('test/hardening.ts', h)
print('tests patched')
