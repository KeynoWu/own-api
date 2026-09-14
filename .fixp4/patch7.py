# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
def rep(h, of, nf, label, pre='  '):
    o = rd('.fixp4/' + of).rstrip(chr(10)); n = rd('.fixp4/' + nf).rstrip(chr(10))
    if pre != '  ':
        o = chr(10).join((pre + l) if l.strip() else l for l in o.split(chr(10)))
        n = chr(10).join((pre + l) if l.strip() else l for l in n.split(chr(10)))
    c = h.count(o)
    assert c == 1, '%s count %d' % (label, c)
    return h.replace(o, n)
h = rd('src-tauri/src/lib.rs')
# static（顶格）
OLD = 'pub struct Sidecar(pub Mutex<Option<CommandChild>>);'
assert h.count(OLD) == 1
h = h.replace(OLD, rd('.fixp4/static.txt').rstrip(chr(10)))
# graceful_shutdown（顶格）
h = rep(h, 'gs_old.txt', 'gs_new.txt', 'gs', pre='')
# 退出调用点（20 空格缩进片段已含在文件内？——片段按 20 空格写好，pre='  '×?）
o = rd('.fixp4/call_old.txt').rstrip(chr(10)); n = rd('.fixp4/call_new.txt').rstrip(chr(10))
assert h.count(o) == 1, 'call count %d' % h.count(o)
h = h.replace(o, n)
# wait_ready 头部（4 空格=fn 体，片段按 4 写好）
h = rep(h, 'wr_old.txt', 'wr_new.txt', 'wr', pre='')
# wait_ready 尾部（12 空格片段）
o = rd('.fixp4/wrend_old.txt').rstrip(chr(10)); n = rd('.fixp4/wrend_new.txt').rstrip(chr(10))
assert h.count(o) == 1, 'wrend count %d' % h.count(o)
h = h.replace(o, n)
# sidecar stderr（8 空格片段）
o = rd('.fixp4/spawn_old.txt').rstrip(chr(10)); n = rd('.fixp4/spawn_new.txt').rstrip(chr(10))
assert h.count(o) == 1, 'spawn count %d' % h.count(o)
h = h.replace(o, n)
wr('src-tauri/src/lib.rs', h)
print('lib.rs ok')
# ghost 9s -> 15s
h = rd('test/hardening.ts')
OLD = 'while (Date.now() - ghostStarted < 9000) {'
assert h.count(OLD) == 1
h = h.replace(OLD, 'while (Date.now() - ghostStarted < 15_000) { // P4：tsx 冷启+2s 轮询在重载 CI 上过 9s 窗口，放宽到 15s')
# RST 固定 sleep 改轮询
OLD = '  await new Promise((r2) => setTimeout(r2, 1500));' + chr(10) + "  const rstLog: any = await admin('/api/logs?limit=1');"
assert h.count(OLD) == 1, 'rst anchor'
h = h.replace(OLD, '  let rstLog: any = null; // P4：固定 1.5s 赌注改轮询——499 一落账就走' + chr(10) + '  for (let i = 0; i < 20; i++) {' + chr(10) + '    await new Promise((r2) => setTimeout(r2, 200));' + chr(10) + "    rstLog = await admin('/api/logs?limit=1');" + chr(10) + '    if (rstLog.body?.[0]?.status === 499) break;' + chr(10) + '  }')
wr('test/hardening.ts', h)
print('hardening p4 ok')
