# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
def rep(h, of, nf, label):
    o = rd('.fixp3/' + of).rstrip(chr(10)); n = rd('.fixp3/' + nf).rstrip(chr(10))
    c = h.count(o)
    assert c == 1, '%s anchor count %d' % (label, c)
    return h.replace(o, n)
h = rd('src/gateway.ts')
h = rep(h, 'wd_old.txt', 'wd_new.txt', 'wd')
h = rep(h, 'sniff_old.txt', 'sniff_new.txt', 'sniff')
h = rep(h, 'p413_old.txt', 'p413_new.txt', '413')
h = rep(h, 'pmodel_old.txt', 'pmodel_new.txt', 'model')
h = rep(h, 'tracksig_old.txt', 'tracksig_new.txt', 'tracksig')
h = rep(h, 'trkenq_old.txt', 'trkenq_new.txt', 'trkenq')
OLD = 'c.body(track(out, trackFinished, errorFrame), 200, {'
assert h.count(OLD) == 1
h = h.replace(OLD, 'c.body(track(out, trackFinished, errorFrame, armWd), 200, {')
wr('src/gateway.ts', h)
print('gateway p3 ok')
h = rd('src/upstream.ts')
h = rep(h, 'upold.txt', 'upnew.txt', 'up-nonok')
sm = 'export async function callUpstream(opts: {'
assert h.count(sm) == 1
h = h.replace(sm, rd('.fixp3/uphelper.txt') + sm)
wr('src/upstream.ts', h)
print('upstream p3 ok')
h = rd('src/store.ts')
h = rep(h, 'scrub_old.txt', 'scrub_new.txt', 'scrub')
wr('src/store.ts', h)
h = rd('src/sse.ts')
h = rep(h, 'ufin_old.txt', 'ufin_new.txt', 'ufinish')
wr('src/sse.ts', h)
h = rd('src/translate.ts')
h = rep(h, 'trdel_old.txt', 'trdel_new.txt', 'trdel')
wr('src/translate.ts', h)
print('store/sse/translate p3 ok')
# hardening 钉插到 scrubSecret 测试块之前
h = rd('test/hardening.ts')
sm = chr(10) + '{' + chr(10) + "  const { anthropicToOpenaiRequest } = await import('../src/translate.ts');"
assert h.count(sm) == 1
h = h.replace(sm, chr(10) + rd('.fixp3/pins.txt') + '//' + chr(10) + sm.lstrip(chr(10)))
wr('test/hardening.ts', h)
print('pins ok')
