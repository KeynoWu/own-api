# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
def rep(h, name, label):
    o = rd('.fixp11/' + name + '_old.txt'); n = rd('.fixp11/' + name + '_new.txt')
    assert h.count(o) == 1, '%s count %d' % (label, h.count(o))
    return h.replace(o, n)
h = rd('src/sse.ts')
for nm in ('pt', 'sf', 'ft', 'us'):
    h = rep(h, nm, nm)
wr('src/sse.ts', h)
h = rd('src/gateway.ts')
h = rep(h, 'fin', 'finished')
wr('src/gateway.ts', h)
h = rd('src/upstream.ts')
h = rep(h, 'rc', 'readCapped')
wr('src/upstream.ts', h)
print('p10 applied')
