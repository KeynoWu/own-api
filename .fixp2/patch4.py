# -*- coding: utf-8 -*-
import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, h): io.open(p, 'w', encoding='utf-8').write(h)
def cut(h, sm, em, new, frm=0):
    s = h.index(sm, frm)
    e = h.index(em, s) + len(em)
    return (h[:s] + new + h[e:]), s + len(new)
h = rd('src/store.ts')

# 1) 字段
OLD = '''  private logSeq = 0;'''
assert h.count(OLD) == 1
h = h.replace(OLD, OLD + chr(10) + '''  private pendingMigration = false;''')

# 2) 构造：迁移回写移出 load
OLD = '''  constructor() {
    this.db = this.load();'''
assert h.count(OLD) == 1
h = h.replace(OLD, OLD + chr(10) + '''    if (this.pendingMigration) {
      // 迁移回写移出 load（审查 P2）：写失败 ≠ 数据损坏——保留内存态并稍后重试，
      // 不再在解析 try/catch 里把健康数据误判成 corrupt 搬走''' + chr(10) + '''      this.pendingMigration = false;
      try {
        this.persist();
      } catch (err) {
        console.error('[store] v2→v3 迁移回写失败（内存态继续服务，稍后重试）', err);
        this.save();
      }
    }''')

# 3) load 主体+catch 整体重写
sm = '      const rawRoutes = arr<RouteEntry>(parsed.routes);'
em = '      return emptyDb();' + chr(10) + '    }' + chr(10) + '  }'
h = cut(h, sm, em, rd('.fixp2/p2_load.txt').rstrip(chr(10)))[0]

# 4) flushSync 先写后清脏
OLD = '''    if (this.dirty) {
      this.dirty = false;
      this.persist();
    }'''
assert h.count(OLD) == 1
h = h.replace(OLD, '''    if (this.dirty) {
      // 先落盘成功再清脏（审查 P2）：persist 异常时保留脏标记等防抖窗重试；旧顺序在 exit 钩子里丢最后一秒数据
      try {
        this.persist();
        this.dirty = false;
      } catch (err) {
        console.error('[store] flushSync 落盘失败（保留脏标记，下次机会重试）', err);
      }
    }''')

# 5) createChannel 空 key 拒收
OLD = '''      keys: (Array.isArray(input.keys) ? input.keys : []).map((k) => makeKey(k.key, k.name, k.weight)),'''
assert h.count(OLD) == 1
h = h.replace(OLD, '''      // 空串 key 会造出恒失败的 key 反复吃池（审查 P2）：入口拒收
      keys: (Array.isArray(input.keys) ? input.keys : [])
        .filter((k) => !!k && typeof k.key === 'string' && k.key.trim() !== '')
        .map((k) => makeKey(k.key, k.name, k.weight)),''')

# 6) createModel：新 tag 与其它路由名/tag 冲突
sm = '    const taken = this.routeNameTaken(input.publicName.trim());'
assert h.count(sm) == 1
h = h.replace(sm, '''    for (const t of Array.isArray(input.tags) ? input.tags : []) {
      const conflict = this.routeNameTaken(String(t));
      if (conflict) return { error: 'tag "' + t + '" ' + conflict };
    }''' + chr(10) + sm)

# 7) updateModel：tag/名冲突查全量（旧块只查 auto 名——tag 撞上其它 single 的名/tag 仍放行）
sm = "    if (typeof next.publicName === 'string' || next.tags !== undefined) {"
NEW = '''    if (typeof next.publicName === 'string' || next.tags !== undefined) {
      // 审查 P2：本次变更引入的每一个名字（新外名+全部 tag）都要过 routeNameTaken——
      // 旧检查只比对 auto 名，tag 撞上其它 single 的 publicName/tag 会静默双解析歧义
      const names = new Set<string>();
      if (typeof next.publicName === 'string') names.add(next.publicName.toLowerCase());
      if (next.tags !== undefined) for (const t of Array.isArray(next.tags) ? next.tags : []) if (typeof t === 'string' && t) names.add(t.toLowerCase());
      for (const n of names) if (this.routeNameTaken(n, id)) return 'conflict' as const;'''
h, _ = cut(h, sm, '    }' + chr(10) + '    Object.assign(m, next);', NEW + chr(10) + '    }' + chr(10) + '    Object.assign(m, next);')

# 8) acquireLock 原子化
sm = 'function acquireLock() {'
em = '  }' + chr(10) + '}' + chr(10) + 'acquireLock();'
h = cut(h, sm, em, rd('.fixp2/p2_lock.txt').rstrip(chr(10)) + chr(10) + 'acquireLock();')[0]

wr('src/store.ts', h)
print('store p2 ok')
