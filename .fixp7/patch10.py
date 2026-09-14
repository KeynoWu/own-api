# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
h = rd('test/hardening.ts')
anchor = rd('.fixp7/anchor.txt')
assert h.count(anchor) == 1, h.count(anchor)
blk = rd('.fixp7/pin_chain.txt').rstrip(chr(10))
h = h.replace(anchor, chr(10) + blk + anchor)
wr('test/hardening.ts', h)
print('pin inserted')
