# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
# mock 场景
h = rd('src/mock-upstream.ts')
sm = "  if (body.model === 'mock-dirty-stream') {"
assert h.count(sm) == 1
h = h.replace(sm, rd('.fixp6/mock_huge.txt').rstrip(chr(10)) + chr(10) + sm)
wr('src/mock-upstream.ts', h)
print('mock ok')
# e2e 巨帧块 + 爆破注释
h = rd('test/e2e.ts')
OLD = 'check(' + chr(39) + 'baseUrl 数字补丁被丢弃、原值保全（GET 不再被毒成 500）' + chr(39)
s = h.index(OLD)
e = h.index(chr(10) + '}', s) + 2
h = h[:e] + rd('.fixp6/e2e_huge.txt').rstrip(chr(10)) + chr(10) + h[e:]
OLD = rd('.fixp6/brute_old.txt').rstrip(chr(10))
assert h.count(OLD) == 1, 'brute anchor %d' % h.count(OLD)
h = h.replace(OLD, rd('.fixp6/brute_new.txt').rstrip(chr(10)))
wr('test/e2e.ts', h)
print('e2e ok')
# hardening 聚合钉
h = rd('test/hardening.ts')
sm = chr(10) + '{' + chr(10) + "  const t: any = await import('../src/translate.ts');"
assert h.count(sm) == 1, 'agg anchor'
h = h.replace(sm, chr(10) + rd('.fixp6/hard_agg.txt').rstrip(chr(10)) + sm)
wr('test/hardening.ts', h)
print('hardening ok')
