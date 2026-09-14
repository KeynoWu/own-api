# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
def rep(h, name, label):
    o = rd('.fixp9/' + name + '_old.txt'); n = rd('.fixp9/' + name + '_new.txt')
    assert h.count(o) == 1, '%s count %d' % (label, h.count(o))
    return h.replace(o, n)
h = rd('src/store.ts')
for nm in ('lock', 'chan', 'field', 'persist', 'catch', 'sets', 'ml'):
    h = rep(h, nm, nm)
wr('src/store.ts', h)
h = rd('src/admin.ts')
h = rep(h, 'keys', 'keys')
wr('src/admin.ts', h)
h = rd('test/hardening.ts')
anchor = rd('.fixp9/anchor2.txt')
assert h.count(anchor) == 1, 'anchor %d' % h.count(anchor)
h = h.replace(anchor, rd('.fixp9/v3pin.txt').rstrip(chr(10)) + chr(10) + anchor)
wr('test/hardening.ts', h)
print('p8 applied')
