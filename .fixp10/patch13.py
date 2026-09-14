# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
def rep(h, name, label, expect=1):
    o = rd('.fixp10/' + name + '_old.txt'); n = rd('.fixp10/' + name + '_new.txt')
    c = h.count(o)
    assert c == expect, '%s count %d' % (label, c)
    return h.replace(o, n)
h = rd('web/index.html')
for nm, lab in [('copy','copy'),('submit','submit'),('append','append'),('hash','hash'),('hdl','hdl'),('ovw','ovw'),('ovt','ovt'),('mdw','mdw'),('mdt','mdt'),('ban','ban'),('p5a','p5a'),('p5b','p5b'),('set','set'),('sse','sse')]:
    h = rep(h, nm, lab)
wr('web/index.html', h)
h = rd('src/store.ts')
h = rep(h, 'st', 'store-null-list')
wr('src/store.ts', h)
h = rd('src/admin.ts')
h = rep(h, 'sn', 'snippet')
wr('src/admin.ts', h)
print('p9 applied')
