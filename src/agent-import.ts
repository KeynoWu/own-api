/**
 * Agent 一键接入（docs/agent-import-design.md）—— 适配器契约 + 三个写入原语中的 JSON 一支。
 *
 * 本模块是全项目**唯一**被允许写「数据目录以外文件」的地方，因此它的边界条件是硬要求而非风格：
 *  - 路径恒由「代码内常量 + agentHome()」派生，**请求体里没有路径入参**（§9-1）：
 *    路径穿越在此不是「被过滤掉」，是协议层不可表示。
 *  - merge-only：只操作适配器声明的托管路径，未知字段一个不碰（§9-3）。解析失败**拒写**不猜。
 *  - 不跟随符号链接；写前 .bak；临时文件 + fsync + rename 原子替换；保持原文件 mode 与结尾换行。
 *  - 漂移指纹只覆盖 writtenKeys（我方声明的字段子集）——目标 agent 是活写入者，
 *    实测 zcode 启动即给我们写的块补 reasoning、改 modalities（§4.3），整块 hash 每次启动必误报。
 *
 * 依赖纪律（DR-AI-F）：YAML 适配器落地时（PR2）才引入 `yaml`，现已引入（omp 用）。
 * 该让步的**实测代价**（不是估计，是在真实 `~/.omp/agent/*.yml` 上量出来的）：
 *  - `models.yml` 往返 **0 行差异**；`config.yml` 唯一重排是空 flow 序列折叠（`imageOrder:` + `[]` → `imageOrder: []`）。
 *  - **`lineWidth` 必须置 0**：yaml 默认 80 列会把用户无关的长带空格标量折成多行——静默改写用户内容，
 *    正是当初怕的那种破坏。序列化一律带 `lineWidth: 0`（钉 AI-30）。
 *  - 注释（文件级与行尾）、锚点/别名、块标量在 `setIn` 后全部保住（钉 AI-30/31）。
 *  - `yaml` 拒绝对**别名节点**做 `setIn`（抛异常而非静默穿越污染锚点）——所以我们前置检查并给出拒写理由，
 *    且整个写块包在 try/catch 里：库抛异常绝不能把管理端打成 500。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isAlias, isMap, parseDocument, type Document } from 'yaml';
import { maskKey } from './store.ts';

// ---------------------------------------------------------------- 根目录（测试唯一注入点）

/**
 * 适配器根目录一律经此派生，**任何函数都不许直接调 homedir()**——
 * 这是「测试全在临时 HOME 沙箱跑、真实 `~` 零污染」（钉 AI-0）得以成立的前提。
 */
export function agentHome() {
  return process.env.OWN_API_AGENT_HOME || homedir();
}

// ---------------------------------------------------------------- 类型

/** 一个写入点：一个文件 + 文件内一条托管路径 */
export interface TargetSpec {
  /** 相对 agentHome() 的路径段（常量，永不来自请求） */
  rel: string[];
  format: 'json' | 'yaml';
  /** 托管路径：在该文件内定位「我们那一块」 */
  path: string[];
  /** 指纹域：我方负责声明的字段（相对托管块）。块内其它字段增改一律不算漂移（§6.5） */
  writtenKeys: string[][];
  /** 撤销时是否删除托管块 */
  removable?: boolean;
  /**
   * **按键合并写入点**（值型）：我们拥有 `path` 这个映射下由 `roles` 声明的那几个键
   * （omp 的 `modelRoles.default` 等），不是自己命名空间下的整块。三条语义与块型不同：
   *  1. 写入是**逐键合并**，绝不整块替换——替换会把用户其它角色一起抹掉；
   *  2. 现值不是我们的**不算冲突**——「把角色指到本网关」本就是本功能的目的；
   *  3. 撤销是**逐键还原写前的值**（没记到 prev 的键才删），删掉整个映射会把对方其它角色弄没。
   * 指纹域不写死在代码里，而是取账本里的 `roles` 键集（见 keysOfTarget）——角色清单本身就是域声明。
   */
  merge?: boolean;
  /**
   * **合并型写入点里与角色无关、但恒归我们的键**（值取自 `adapter.build()` 的同名顶层键）。
   * omp 没有（角色清单本身就是域）；Claude Code 有——`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`
   * 不属于任何角色槽，却必须归我们管（要同步、要撤销、要进漂移域）。
   */
  staticKeys?: string[];
  /**
   * **块型**写入点从 `build()` 里取哪些键（缺省取整个 built）。
   * 一个适配器可能同时有三种写入点（dsh：provider 块 + 凭据库 refs + 默认模型指针），而 `build()` 只能
   * 返回一个扁平对象——块型若整包吞掉 built，就会把凭据与模型指针当成 provider 的字段写进配置文件。
   */
  blockKeys?: string[];
  /**
   * 本写入点是否**承接角色槽**（同一适配器里只能有一个，由 planLink 校验）。
   * 不显式声明就会出事：Claude 的顶层 `model` 写入点曾把 `default`/`haiku` 当根键写进 settings.json，
   * 在用户文件根上留下两个垃圾键。角色值只属于那个真正装角色的映射。
   */
  roleTarget?: boolean;
  /** 角色槽 → 该映射下的键名。缺省用槽名本身（omp 就是 `modelRoles.default`）；Claude 是全大写环境变量名 */
  roleKey?: (slot: string) => string;
  /** 这个写入点真要改动时，随 plan.warnings 提示一句人话（Claude 顶层 `model` 改的是用户的默认模型） */
  warn?: string;
}

/** 该写入点当前的指纹域：块型用声明的 writtenKeys；合并型用「恒归我们的键 + 它承接的角色键」 */
export function keysOfTarget(t: TargetSpec, roles?: Record<string, string>): string[][] {
  if (!t.merge) return t.writtenKeys;
  const keys: string[][] = (t.staticKeys ?? []).map((k) => [k]);
  if (t.roleTarget) for (const slot of Object.keys(roles ?? {}).sort()) keys.push([t.roleKey?.(slot) ?? slot]);
  return keys;
}

/**
 * 合并型写入点真正要落的键值：静态键从 build() 的同名顶层键取，角色键走 roleValue。
 * omp 传进来等价于旧写法（无静态键、roleKey 恒等），故既有行为逐字节不变。
 */
export function mergeValuesOf(t: TargetSpec, adapter: Adapter, ctx: { apiKey: string; baseUrl: string; model: string; protocol: 'openai' | 'anthropic'; roles?: Record<string, string> }, built: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of t.staticKeys ?? []) if (built?.[k] !== undefined) out[k] = built[k];
  if (t.roleTarget) for (const [slot, m] of Object.entries(ctx.roles ?? {})) out[t.roleKey?.(slot) ?? slot] = adapter.roleValue?.(slot, m) ?? m;
  return out;
}

/** 块型写入点的块值：缺省整个 built；built 被多个写入点共用时用 blockKeys 切分 */
function blockValueOf(t: TargetSpec, built: Record<string, any>): Record<string, unknown> {
  if (!t.blockKeys) return built;
  const out: Record<string, unknown> = {};
  for (const k of t.blockKeys) if (built?.[k] !== undefined) out[k] = built[k];
  return out;
}

/** 逐写入点指纹的键：同文件多写入点时带上托管路径（与聚合指纹同一键法，单写入点文件不变） */
function fileFpKey(files: string[], file: string, t: TargetSpec): string {
  return files.filter((f) => f === file).length > 1 ? `${file}#${t.path.join('.')}` : file;
}

export interface BuildCtx {
  /** 对外 key 明文——只进目标文件，禁止进 diff/回执/日志（§9-5②） */
  apiKey: string;
  /** 网关基址，形如 http://127.0.0.1:8787（不带尾斜杠） */
  baseUrl: string;
  /** 主模型的有效对外协议：决定 kind/baseURL 拼法与探针端点 */
  protocol: 'openai' | 'anthropic';
  /** 本次接入选定的主模型名（Claude Code 的顶层 `model` 这类「非 catalog」字段要用） */
  model: string;
  /** catalog 投影源：与 GET /v1/models 同一次取值（G1 选择器一致性） */
  models: { id: string; context_length?: number; max_output_tokens?: number }[];
}

export interface Adapter {
  id: string;
  label: string;
  /** 写进对方文件的命名空间；撤销与漂移的锚点 */
  providerId: string;
  /** 配置存在性判据（相对 home 的候选路径，任一存在即「可写」）。不做全盘扫描（§6.1） */
  configCandidates: string[][];
  /** 二进制存在性判据：PATH 命令名 + 既定安装位置，有限枚举 */
  binary: { cmds: string[]; apps: string[] };
  targets: TargetSpec[];
  /** 探针打哪个协议端点 = 该 agent 实际使用的协议 */
  probe: 'openai' | 'anthropic';
  /**
   * 配置文件里是否**存在我方投影的模型清单**。Claude Code 只写单个模型名（env/顶层 model），
   * 没有清单可投影——不关掉的话「模型清单待同步」会对它永真（拿环境变量名去比 catalog）。
   */
  catalogInFile?: boolean;
  /** 「怎么在 agent 侧确认真的生效」——探针只能证明网关侧（DR-AI-G） */
  verify: string;
  /** 生成托管块 */
  build(ctx: BuildCtx): Record<string, any>;
  /**
   * 该 agent 的**角色槽**（omp 的 modelRoles、将来 Claude Code 的 haiku/sonnet/opus）。
   * 声明在这里而不接受任意名字，是「零路径入参」纪律的延伸：槽名会变成目标文件里的路径段，
   * 放开就等于把路径注入重新开回来。管理端只接受本表里的 slot，其余静默丢弃。
   */
  roleSlots?: { slot: string; label: string }[];
  /** 角色槽要写进去的标量长什么样（omp: `own-api/<model>`） */
  roleValue?(slot: string, model: string): string;
  /** 由本次请求的角色选择派生的额外交付点（角色槽没有默认形态，故不进静态 targets） */
  extra?(ctx: { home: string; roles?: Record<string, string> }): TargetSpec[];
  /**
   * 新接入时**默认就该勾上**的槽（用户仍可取消）。Claude Code 的 `haiku` 属于这类：
   * 不填时它拿自己的默认小模型名发给网关 → 「未登记模型」404，而这看起来像网关坏了。
   */
  requiredSlots?: string[];
  /** 计划阶段的角色相关提示（不写死在 UI 里：什么算坑只有适配器知道） */
  warnings?(ctx: { model: string; roles?: Record<string, string> }): string[];
  /**
   * 计划阶段的**环境级否决**（返回错误文案，非空即拒绝写入）。用于「配置文件不在我们能写的位置」这类
   * 前提：dsh 的 home 可被 `DSH_HOME` 挪走，凭据库也可能尚未生成——往错位置写比不写糟得多。
   */
  preflight?(ctx: { home: string }): string[];
  /**
   * 撤销时判断「这个键的现值还算不算我们的」。**缺省判据是值以 `providerId/` 打头**（omp 的角色值形态），
   * 写裸模型名的 agent（Claude Code）必须自带判据——否则要么误删用户改过的值，要么永远删不掉。
   * `ctx.apiKey` 在 key 已被删除时拿不到：那种情况返回 `'unknown'`（认不出也不敢删），账本会留着说清楚。
   */
  ownsKey?(key: string, current: unknown, link: import('./types.ts').AgentLink, ctx: { apiKey?: string; baseUrl: string }): boolean | 'unknown';
}

/** 只承认适配器自己声明过的角色槽：槽名会变成目标文件里的路径段，放开=把路径注入重新开回来 */
export function filterRoles(adapter: Adapter, roles?: Record<string, string>): Record<string, string> {
  const allowed = new Set((adapter.roleSlots || []).map((r) => r.slot));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(roles || {})) if (allowed.has(k) && typeof v === 'string' && v) out[k] = v;
  return out;
}

/** 本次要动的全部交付点：静态块 + 角色派生。所有引擎函数都走这里，不许各自拼 */
export function targetsOf(adapter: Adapter, ctx: { home: string; roles?: Record<string, string> }): TargetSpec[] {
  return [...adapter.targets, ...(adapter.extra?.({ home: ctx.home, roles: filterRoles(adapter, ctx.roles) }) ?? [])];
}

// ---------------------------------------------------------------- 文件状态与原子写（JSON / YAML 双后端）

export interface FileState {
  raw: string;
  /**
   * 解析后的 JS 镜像。**所有读路径**（plan 比对、指纹、diff、漂移、UI 预览）一律只看它，
   * 于是 YAML 与 JSON 在这些环节完全同构；`doc` 只在写的那一下登场。
   */
  data: any;
  /** YAML 才有：保注释/锚点/块标量的 Document。写走 setIn/deleteIn，绝不整文件重排 */
  doc?: Document;
  format: 'json' | 'yaml';
  /** 原文件是否以换行结尾（zcode 实测不带，保持不了就会每次写都产生噪音，钉 AI-20） */
  eol: boolean;
  /** 原文件缩进（首行缩进探测；探测不到用 2） */
  indent: string;
  /** 原文件 mode（新建文件用 0o600） */
  mode: number;
  exists: boolean;
}

export type ReadResult = { ok: true; state: FileState } | { ok: false; reason: string };

const EMPTY_STATE = (format: 'json' | 'yaml'): FileState => ({ raw: '', data: undefined, doc: undefined, format, eol: false, indent: '  ', mode: 0o600, exists: false });

/** 共用闸门：symlink / 非普通文件 / 读失败一律拒（钉 AI-4/AI-11） */
function statGate(file: string): { ok: true; mode: number; raw?: string } | { ok: false; reason: string } {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return { ok: true, mode: 0o600 }; // 不存在 → 交给上层按「新建」处理
  }
  if (st.isSymbolicLink()) return { ok: false, reason: '目标是符号链接，拒绝跟随写入（避免经链接写到数据目录之外的任意文件）' };
  if (!st.isFile()) return { ok: false, reason: '目标不是普通文件，拒写' };
  try {
    return { ok: true, mode: st.mode & 0o777, raw: readFileSync(file, 'utf8') };
  } catch (err) {
    return { ok: false, reason: `读取失败：${(err as Error).message}` };
  }
}

/** 读 + 解析。任何不能安全 round-trip 的形态一律拒（含 JSONC 注释、tab 缩进、symlink）——钉 AI-4/AI-8 */
export function readJsonFile(file: string): ReadResult {
  const g = statGate(file);
  if (!g.ok) return g;
  if (g.raw === undefined) return { ok: true, state: EMPTY_STATE('json') };
  const raw = g.raw;
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'JSON 解析失败（可能含注释或非 JSON 内容）——拒绝覆盖，请人工处理' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: '顶层不是 JSON 对象，无法安全定位托管路径' };
  const ind = raw.match(/\n([ \t]+)/);
  if (ind && ind[1].includes('\t')) return { ok: false, reason: '文件用 tab 缩进，无法保证无损写回，拒写' };
  return {
    ok: true,
    state: { raw, data, format: 'json', eol: raw.endsWith('\n'), indent: ind && ind[1] ? ind[1] : '  ', mode: g.mode, exists: true },
  };
}

/**
 * YAML 读：解析失败/顶层非映射一律拒。注意**不套用 JSON 那条 tab 规则**——
 * YAML 的 tab 只在缩进位非法，块标量内的 tab 合法，交给解析器判比我数正则准。
 */
export function readYamlFile(file: string): ReadResult {
  const g = statGate(file);
  if (!g.ok) return g;
  if (g.raw === undefined) return { ok: true, state: EMPTY_STATE('yaml') };
  const raw = g.raw;
  let doc: Document;
  try {
    doc = parseDocument(raw, { prettyErrors: true });
  } catch (err) {
    return { ok: false, reason: `YAML 解析失败（${(err as Error).message}）——拒绝覆盖，请人工处理` };
  }
  if (doc.errors.length) return { ok: false, reason: `YAML 解析失败（${doc.errors[0].message}）——拒绝覆盖，请人工处理` };
  if (doc.contents && !isMap(doc.contents)) return { ok: false, reason: '顶层不是 YAML 映射，无法安全定位托管路径，拒写' };
  let data: any;
  try {
    data = doc.toJS();
  } catch (err) {
    return { ok: false, reason: `YAML 取值失败（${(err as Error).message}），拒写` };
  }
  const ind = raw.match(/\n([ ]+)/);
  return {
    ok: true,
    state: { raw, data, doc, format: 'yaml', eol: raw.endsWith('\n'), indent: ind && ind[1] ? ind[1] : '  ', mode: g.mode, exists: true },
  };
}

/** 按写入点声明的格式读。引擎各处只认这一个入口 */
export function readConfigFile(format: 'json' | 'yaml', file: string): ReadResult {
  return format === 'yaml' ? readYamlFile(file) : readJsonFile(file);
}

/** 托管路径是否可安全落到 Document 上：沿途出现别名即拒。
 *  `yaml` 自己会对着别名 setIn 抛异常（不静默污染锚点，这是好事），但抛异常=管理端 500，
 *  所以先在这里变成一句人话的拒写理由。 */
export function pathSafe(state: FileState, path: string[]): string | undefined {
  if (!state.doc?.contents) return undefined;
  let cur: any = state.doc.contents;
  for (const k of path) {
    if (isAlias(cur)) return `托管路径 ${path.join('.')} 途经一个 YAML 别名（*anchor），写进去会改到锚点指向的公共内容，拒写`;
    if (!isMap(cur)) break; // 再往下由 setIn 自动建层，不是穿越
    cur = cur.get(k, true);
    if (cur === undefined) break;
  }
  return isAlias(cur) ? `托管路径 ${path.join('.')} 落在一个 YAML 别名（*anchor）上，写进去会改到锚点指向的公共内容，拒写` : undefined;
}

/** YAML 序列化统一口径：禁折行（默认 80 列会静默改写用户无关长行） */
const yamlText = (doc: Document, eol: boolean) => doc.toString({ lineWidth: 0, minContentWidth: 0 }) + (eol ? '\n' : '');

/**
 * 原子写：备份 → tmp + fsync → rename → 恢复原 mode。
 * fsync 先于 rename 的理由与 store.ts#persist 相同（断电窗口里 rename 可能指向未落盘内容）。
 * 注意**不自动回滚**（DR-AI-E）：回滚会覆盖写后用户自己的手改，且回滚本身可能再失败。
 */
function atomicWriteText(file: string, state: FileState, text: string): { ok: true; backup?: string } | { ok: false; reason: string } {
  let backup: string | undefined;
  try {
    if (state.exists) {
      backup = `${file}.own-api-bak`;
      copyFileSync(file, backup); // 同日重复接入覆盖同一 bak 名，不产生垃圾堆积
      // 备份就是同一份明文的第二个副本：权限一律收紧到 0600，不跟着源文件的 0644 走。
      // 源文件宽是用户自己的选择，我们不替他收紧；我们的产物没有理由比源文件更松。
      try {
        chmodSync(backup, 0o600);
      } catch {
        /* 非 POSIX 平台（Windows）没有这个 mode 语义，跳过而不是谎报失败 */
      }
    } else {
      mkdirSync(dirname(file), { recursive: true }); // 目标目录还没建（omp 只有 config.yml 没有 models.yml 之类的新装态）
    }
    const tmp = `${file}.own-api.tmp`;
    const fd = openSync(tmp, 'w', state.mode || 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, state.exists ? state.mode : 0o600); // 已存在文件保持原 mode；新建一律 0600（§9-5①）
    } catch {
      /* win 无 posix 位 */
    }
    renameSync(tmp, file);
    return { ok: true, backup };
  } catch (err) {
    try {
      unlinkSync(`${file}.own-api.tmp`);
    } catch {
      /* ignore */
    }
    return { ok: false, reason: `写入失败：${(err as Error).message}` };
  }
}

export function atomicWriteJson(file: string, state: FileState, data: any): { ok: true; backup?: string } | { ok: false; reason: string } {
  return atomicWriteText(file, state, JSON.stringify(data, null, state.indent) + (state.eol ? '\n' : ''));
}

/** 把值写进托管路径并落盘。YAML 走 Document API（只动这一块的字节区，别处的注释/锚点原样留着） */
function writeBlock(t: TargetSpec, file: string, state: FileState, value: unknown): { ok: true; backup?: string } | { ok: false; reason: string } {
  const entries = Object.entries((value ?? {}) as Record<string, unknown>);
  if (state.format === 'yaml') {
    try {
      const bad = pathSafe(state, t.path);
      if (bad) return { ok: false, reason: bad };
      const doc = state.doc ?? parseDocument('');
      const put = (p: string[], v: unknown) => doc.setIn(p, doc.createNode(v, { aliasDuplicateObjects: false }));
      if (t.merge) for (const [k, v] of entries) put([...t.path, k], v); // 逐键合并，不整块替换
      else put(t.path, value);
      return atomicWriteText(file, state, yamlText(doc, state.eol));
    } catch (err) {
      return { ok: false, reason: `YAML 写入失败：${(err as Error).message}` }; // 库抛异常绝不冒成 500
    }
  }
  const root = state.data ?? {};
  if (t.merge) for (const [k, v] of entries) setPath(root, [...t.path, k], v);
  else setPath(root, t.path, value);
  return atomicWriteJson(file, state, root);
}

/**
 * 撤销落盘。块型：删掉整块。合并型：逐键处理——写前记到值的还原回去，没记到的（我们新建的）才删。
 * `slots` 是本次要交还的键集（合并型必传，取自账本 roles）。
 */
function dropBlock(t: TargetSpec, file: string, state: FileState, prev?: Record<string, unknown>, slots: string[] = []): { ok: true; backup?: string } | { ok: false; reason: string } {
  const keys = t.merge ? slots : [];
  if (state.format === 'yaml') {
    try {
      const bad = pathSafe(state, t.path);
      if (bad) return { ok: false, reason: bad };
      if (!state.doc) return { ok: true };
      if (t.merge) {
        for (const k of keys) {
          const v = prev?.[k];
          if (v === undefined) state.doc.deleteIn([...t.path, k]);
          else state.doc.setIn([...t.path, k], state.doc.createNode(v, { aliasDuplicateObjects: false }));
        }
      } else state.doc.deleteIn(t.path);
      return atomicWriteText(file, state, yamlText(state.doc, state.eol));
    } catch (err) {
      return { ok: false, reason: `YAML 撤销失败：${(err as Error).message}` };
    }
  }
  if (!state.data) return { ok: true };
  if (t.merge) {
    for (const k of keys) {
      const v = prev?.[k];
      if (v === undefined) deletePath(state.data, [...t.path, k]);
      else setPath(state.data, [...t.path, k], v);
    }
    return atomicWriteJson(file, state, state.data);
  }
  deletePath(state.data, t.path);
  return atomicWriteJson(file, state, state.data);
}

// ---------------------------------------------------------------- 路径读写与指纹

export function getPath(obj: any, path: string[]): any {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 写入托管路径：沿途缺失的对象/数组按需创建 */
export function setPath(root: any, path: string[], value: unknown): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = /^\d+$/.test(path[i + 1]) ? [] : {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

export function deletePath(root: any, path: string[]): boolean {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return false;
    cur = cur[path[i]];
  }
  if (cur == null || typeof cur !== 'object') return false;
  const last = path[path.length - 1];
  if (!(last in cur)) return false;
  delete cur[last];
  return true;
}

/** 稳定序列化：对象键排序后输出，指纹因此与键序无关（目标 agent 重排键不算改动） */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
}

/**
 * 指纹域提取：只取「我方声明负责的字段」，块内其它字段一律不进指纹。
 * writtenKeys 支持 `*` 通配（对 zcode 这类「对方会往我们块里补字段」的活写入者必需，§6.5）：
 *  - `['models','*','limit']` → 逐个模型只取 limit 子字段（对方补的 reasoning/modalities 不算漂移）
 *  - `['models','*']`（通配在末尾）→ 取**键集合本身**：对方增删我方 catalog 里的模型算漂移
 *    （那直接破坏 G1「选择器里的集合 ≡ 这把 key 能调的集合」，必须让人看见）
 * 通配按盘上现值的键展开，因此增删会改变指纹——这是刻意的。
 */
function domainOf(block: unknown, writtenKeys: string[][]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of writtenKeys) {
    const star = p.indexOf('*');
    if (star === -1) {
      out[canonical(p)] = getPath(block, p);
      continue;
    }
    const prefix = p.slice(0, star);
    const parent = getPath(block, prefix);
    const keys = parent && typeof parent === 'object' ? Object.keys(parent).sort() : [];
    if (star === p.length - 1) {
      out[canonical(prefix) + '#keys'] = keys;
      continue;
    }
    const rest = p.slice(star + 1);
    for (const k of keys) out[canonical([...prefix, k, ...rest])] = getPath((parent as any)?.[k], rest);
  }
  return out;
}

/** 漂移指纹 = 仅指纹域内的字段（§6.5）。这是我方「被改」判定的唯一定义域 */
export function fingerprintOf(block: unknown, writtenKeys: string[][]): string {
  return 'sha256:' + createHash('sha256').update(canonical(domainOf(block, writtenKeys))).digest('hex');
}

/** 数组路径版（多 target 汇总成一个指纹，存进 link） */
/**
 * 聚合指纹：逐写入点各算一份再规范化合并。两处易踩的坑都在这里：
 *  1. **域必须与 plan/apply/drift 同一口径**（`keysOfTarget`）。曾经直接吃 `target.writtenKeys`，
 *     而合并型的 writtenKeys 是空数组——空域 `fingerprintOf` 塌成 `sha256("{}")` 常量，
 *     等于把 omp 的 modelRoles 整个排除在漂移之外（用户把 default 改成别家照样报「一致」）。
 *  2. **同一文件多个写入点**（Claude Code 的 `env` 与顶层 `model`）必须各占一个键，否则后者覆盖前者，
 *     漂移检测永远看不见被吃掉的那一半。单写入点文件的键保持裸 `rel` 不变——zcode 的既有账本里
 *     存的就是它，键法一改，升级即全员误报「被改」（同 AI-38 的约束）。
 */
export function fingerprintOfTargets(reads: { target: TargetSpec; block: unknown }[], roles?: Record<string, string>): string {
  const hits: Record<string, number> = {};
  for (const r of reads) {
    const rel = r.target.rel.join('/');
    hits[rel] = (hits[rel] || 0) + 1;
  }
  const map: Record<string, unknown> = {};
  for (const r of reads) {
    const rel = r.target.rel.join('/');
    map[hits[rel] > 1 ? `${rel}#${r.target.path.join('.')}` : rel] = fingerprintOf(r.block, keysOfTarget(r.target, roles));
  }
  return 'sha256:' + createHash('sha256').update(canonical(map)).digest('hex');
}

// ---------------------------------------------------------------- diff（仅托管块，给 UI 看）

/** 密钥类字段的值渲染成掩码：diff/回执任何位置都不得出现 vkey 明文（§9-5②） */
const SECRET_KEYS = /^(api[_-]?key|apikey|token|secret|authorization|password)$|_(token|secret|password|api[_-]?key|key)$/i;

export function maskBlock(v: any): any {
  if (Array.isArray(v)) return v.map(maskBlock);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = typeof val === 'string' && SECRET_KEYS.test(k) ? maskKey(val) : maskBlock(val);
    return out;
  }
  return v;
}

/** 极简 LCS 行 diff：托管块体量小（几十行），够用且无需依赖 */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  for (let i = 0, j = 0; i < m || j < n; ) {
    if (i < m && j < n && a[i] === b[j]) {
      out.push('  ' + a[i]);
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push('+ ' + b[j++]);
    } else {
      out.push('- ' + a[i++]);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- 适配器

/** 协议 → zcode 的 kind/baseURL 拼法（实测枚举与惯例，§4.3；错一次就是首发 404） */
function zcodeKind(protocol: 'openai' | 'anthropic') {
  return protocol === 'anthropic' ? 'anthropic' : 'openai-compatible';
}
/**
 * 协议端点拼法。openai 系要带 `/v1`（zcode 与 omp 实测都是：真机 zcode 写 `/v1`、
 * omp 现有 5 个 provider 的 baseUrl 全部以 `/v1` 结尾）；anthropic 系不带（会拼成 /v1/v1 → 404，实测）。
 */
function apiBase(baseUrl: string, protocol: 'openai' | 'anthropic') {
  const b = baseUrl.replace(/\/+$/, '');
  return protocol === 'anthropic' ? b : `${b}/v1`;
}

const ZCODE: Adapter = {
  id: 'zcode',
  label: 'ZCode（智谱官方 agent）',
  providerId: 'own-api',
  configCandidates: [['.zcode/v2/config.json'], ['.zcode/cli/config.json']],
  binary: { cmds: ['zcode'], apps: ['/Applications/ZCode.app'] },
  probe: 'openai',
  verify: '在 ZCode 里选 own-api 的模型发一句话就算验完（不用重装或重登）。',
  // 实测（2026-09-15）：不投影 modalities/reasoning——zcode 启动会按自家模型目录覆盖它们（§4.3）
  build: ({ apiKey, baseUrl, protocol, models }) => ({
    name: 'own-api',
    kind: zcodeKind(protocol),
    enabled: true,
    source: 'custom',
    options: { apiKey, baseURL: apiBase(baseUrl, protocol) },
    models: Object.fromEntries(
      models.map((m, i) => [
        m.id,
        {
          ...(m.context_length ? { limit: { context: m.context_length, ...(m.max_output_tokens ? { output: m.max_output_tokens } : {}) } } : {}),
          zcode: { modified: false, priority: 200 + i },
        },
      ]),
    ),
  }),
  targets: [
    {
      rel: ['.zcode', 'v2', 'config.json'],
      format: 'json',
      path: ['provider', 'own-api'],
      writtenKeys: [['name'], ['kind'], ['enabled'], ['source'], ['options', 'baseURL'], ['options', 'apiKey'], ['models', '*'], ['models', '*', 'limit']],
      removable: true,
    },
  ],
};

/** omp 真机形态（2026-09-15 读 ~/.omp/agent/{models,config}.yml）：provider 块 + 角色槽 */
const OMP_PROVIDER = 'own-api';

const OMP: Adapter = {
  id: 'omp',
  label: 'oh-my-pi（omp）',
  providerId: OMP_PROVIDER,
  configCandidates: [['.omp/agent/models.yml'], ['.omp/agent/config.yml']],
  binary: { cmds: ['omp'], apps: [] },
  probe: 'openai',
  verify: '在 omp 里用 /model 选 own-api 的模型，或直接让已指向 own-api 的角色发一句话。',
  // 真机 5 个 provider 一律 api: openai-completions + baseUrl 带 /v1 + apiKey 内联（不是 env 引用）。
  // anthropic 分支的 api 名未实机核过（本机这条链路是 openai 协议），登记为 §14-V9。
  build: ({ apiKey, baseUrl, protocol, models }) => ({
    baseUrl: apiBase(baseUrl, protocol),
    api: protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    apiKey,
    // 真机每个模型都是 {id, name, contextWindow, maxTokens} 四项齐全——omp 按它算预算，
    // 缺字段可能直接算不出窗口。网关没报限制时兜一个保守下限（§14-V10：omp 是否强制要求未核）。
    models: models.map((m) => ({
      id: m.id,
      name: m.id,
      contextWindow: m.context_length || 128000,
      maxTokens: m.max_output_tokens || 8192,
    })),
  }),
  targets: [
    {
      rel: ['.omp', 'agent', 'models.yml'],
      format: 'yaml',
      path: ['providers', OMP_PROVIDER],
      // 逐字段声明，models 用下标通配：omp 若给我们补它自己的字段不算漂移，但它改我方 id/窗口算
      writtenKeys: [['baseUrl'], ['api'], ['apiKey'], ['models', '*', 'id'], ['models', '*', 'name'], ['models', '*', 'contextWindow'], ['models', '*', 'maxTokens']],
      removable: true,
    },
  ],
  // 角色槽取自真机 config.yml 的 modelRoles 键集（label 用人话，UI 直接渲染）
  roleSlots: [
    { slot: 'default', label: '默认（不打角色时用它）' },
    { slot: 'plan', label: '规划' },
    { slot: 'task', label: '任务' },
    { slot: 'smol', label: '小模型' },
    { slot: 'tiny', label: '微型' },
    { slot: 'slow', label: '慢档' },
    { slot: 'advisor', label: '顾问' },
    { slot: 'designer', label: '设计' },
    { slot: 'commit', label: '提交信息' },
  ],
  roleValue: (_slot, model) => `${OMP_PROVIDER}/${model}`,
  extra: ({ roles }) =>
    Object.keys(roles ?? {}).length
      ? [{ rel: ['.omp', 'agent', 'config.yml'], format: 'yaml', path: ['modelRoles'], merge: true, roleTarget: true, writtenKeys: [], removable: true }]
      : [],
};

/**
 * Claude Code —— `~/.claude/settings.json`。**〔未实机验证：本机已卸载，见 §14-V7〕**
 * 形态取自本机残留 settings.json（真实键集与真实邻居：同文件里有 24 个 enabledPlugins、statusLine 的
 * 转义 shell 命令等，故必须 merge-only）。与另两家根本不同：Claude Code 没有 provider 登记表，
 * 只吃一组环境变量 + 顶层默认模型名——**没有 `own-api/` 前缀可当归属判据**，所以 ownsKey 必须自带。
 */
const CLAUDE_FILE = ['.claude', 'settings.json'];
/** 角色槽 → 环境变量名（真机残留实测的键名，不是推测的命名风格） */
const CLAUDE_ENV: Record<string, string> = {
  default: 'ANTHROPIC_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
};
const CLAUDE_SLOT_OF = new Map(Object.entries(CLAUDE_ENV).map(([slot, key]) => [key, slot]));
/** 顶层 `model`：改的是用户的默认模型，只在接管了 default 槽时才跟着写 */
const CLAUDE_ROOT_TARGET: TargetSpec = {
  rel: CLAUDE_FILE,
  format: 'json',
  path: [],
  merge: true,
  staticKeys: ['model'],
  writtenKeys: [],
  removable: true,
  warn: '顶层 model 也会被改成所选主模型——这改变的是 Claude Code 的默认模型，不只是我们 env 里那条',
};

const CLAUDE: Adapter = {
  id: 'claude-code',
  label: 'Claude Code',
  providerId: 'own-api',
  configCandidates: [CLAUDE_FILE],
  binary: { cmds: ['claude'], apps: ['/Applications/Claude.app'] },
  probe: 'anthropic',
  // 文件里不存在模型清单可投影：catalogStale 这条判据对它没有意义（见 admin 的 catalogInFile）
  catalogInFile: false,
  verify: '新开一次 Claude Code 会话（不用重装/重登），会话里 /status 看 base_url 是否指向 own-api，/model 看清单',
  build: ({ apiKey, baseUrl, model }) => ({
    // anthropic 协议不追加 /v1：Claude Code 自己拼 /v1/messages（真机残留的 BASE_URL 也没有 /v1）
    ANTHROPIC_BASE_URL: apiBase(baseUrl, 'anthropic'),
    ANTHROPIC_AUTH_TOKEN: apiKey,
    model,
  }),
  targets: [
    {
      rel: CLAUDE_FILE,
      format: 'json',
      path: ['env'],
      merge: true,
      staticKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
      roleTarget: true, // 角色落在 env 这一层；顶层 `model` 那个写入点跟角色无关（否则角色名会变成根上的垃圾键）
      roleKey: (slot) => CLAUDE_ENV[slot] ?? slot,
      writtenKeys: [],
      removable: true,
    },
  ],
  extra: ({ roles }) => (roles?.default ? [CLAUDE_ROOT_TARGET] : []),
  roleSlots: [
    { slot: 'default', label: '主模型（ANTHROPIC_MODEL）' },
    { slot: 'haiku', label: '后台/压缩任务用的便宜档' },
    { slot: 'sonnet', label: 'Sonnet 档' },
    { slot: 'opus', label: 'Opus 档' },
  ],
  // haiku 不接管时 Claude Code 会把它自己那套默认小模型名发给网关 → 404「未登记模型」，
  // 现象看起来像网关坏了。故默认勾上（仍可取消），但不替用户猜「哪个模型便宜」（DR-AI-H）
  requiredSlots: ['default', 'haiku'],
  roleValue: (_slot, model) => model, // 裸模型名：Claude Code 没有 provider 命名空间
  warnings: ({ model, roles }) => {
    const out: string[] = [];
    if (roles?.haiku && roles.haiku === model) out.push(`haiku 槽指向 ${model}：后台与压缩任务都会走它，通常该指向更便宜的模型`);
    if (!roles?.haiku) out.push('未接管 haiku 槽：Claude Code 会用它自己的默认小模型名，那个名字多半没登记在 own-api 里（表现为 404 未登记模型）');
    return out;
  },
  ownsKey: (key, cur, link, ctx) => {
    const s = String(cur ?? '');
    if (key === 'ANTHROPIC_BASE_URL') return s.replace(/\/+$/, '') === apiBase(link.baseUrl, 'anthropic').replace(/\/+$/, '');
    // key 已删除时 ctx.apiKey 为空 → 报 unknown（不是 false）：这是「我查不了」而非「不是我们的」，账本得留着
    if (key === 'ANTHROPIC_AUTH_TOKEN') return ctx.apiKey ? s === ctx.apiKey : 'unknown';
    if (key === 'model') return s === link.model;
    const slot = CLAUDE_SLOT_OF.get(key);
    return !!slot && s === link.roles?.[slot];
  },
};

/**
 * DSH —— `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml`。
 * 规格取自**正在运行的 v0.1.5-rc.2 实现与其包内文档**（`@deepseek-ai/dsh-llm-pi-ai`、
 * `@deepseek-ai/dsh-settings-file`、`@deepseek-ai/dsh-credentials-local`），不是猜测：
 *  - provider 块在 `llm-pi-ai.providers.<id>` 下，`apiKeyEnv` 是「按请求解析的凭据引用」；
 *    profile **没有**内联 apiKey 字段（models 条目除 id 外全部可选）。
 *  - 凭据落在 dsh 自己的密码本 `.credentials.yaml` 的 `refs.<ENV名>`（同一文档另有 `records`，不是我们的）。
 *  - `apiKeyEnv` 优先于已存凭据记录；引用配了却解析不到值 → `MISSING_CREDENTIAL` 明确失败，不静默回落。
 *  - 两个文件都有 watcher（外部编辑热发布）：**写完不用重启 dsh**。
 */
const DSH_FILE = ['.dsh', 'settings.yaml'];
const DSH_CREDS = ['.dsh', '.credentials.yaml'];
/** 我们占用的凭据引用名。恒为常量：一个 agent 一条接入，不需要 per-link 起名 */
const DSH_REF = 'OWN_API_API_KEY';

const DSH: Adapter = {
  id: 'dsh',
  label: 'DSH',
  providerId: 'own-api',
  configCandidates: [DSH_FILE, ['.dsh', 'settings.yml'], ['.dsh', 'settings.json']],
  binary: { cmds: ['dsh'], apps: [] },
  probe: 'openai',
  verify: '不用重启：settings 与凭据都有 watcher（100ms 防抖）。新建一个 agent 看它从哪个模型开始，或看模型清单里有没有 own-api 那批',
  build: ({ apiKey, baseUrl, model, models }) => ({
    // provider 块
    displayName: 'own-api',
    api: 'openai-completions',
    baseURL: apiBase(baseUrl, 'openai'),
    apiKeyEnv: DSH_REF,
    // contextWindow/maxTokens 只在路由真的登记了才写：dsh 自己有 defaultContextWindow 兜底，
    // 我们不该拿 128k 这种编出来的数去冒充用户的真实窗口
    models: models.map((m) => ({
      id: m.id,
      name: m.id,
      ...(m.context_length ? { contextWindow: m.context_length } : {}),
      ...(m.max_output_tokens ? { maxTokens: m.max_output_tokens } : {}),
    })),
    // 凭据库 refs 里的我们那一格
    [DSH_REF]: apiKey,
    // agent-default-model 指针（provider + model 两段）
    provider: 'own-api',
    model,
  }),
  targets: [
    {
      rel: DSH_FILE,
      format: 'yaml',
      path: ['llm-pi-ai', 'providers', 'own-api'],
      blockKeys: ['displayName', 'api', 'baseURL', 'apiKeyEnv', 'models'],
      writtenKeys: [['displayName'], ['api'], ['baseURL'], ['apiKeyEnv'], ['models', '*', 'id'], ['models', '*', 'name'], ['models', '*', 'contextWindow'], ['models', '*', 'maxTokens']],
      removable: true,
    },
    {
      rel: DSH_CREDS,
      format: 'yaml',
      path: ['refs'],
      merge: true,
      staticKeys: [DSH_REF],
      writtenKeys: [],
      removable: true,
      // 明文 key 落进 dsh 自己的密码本（0600，多用户可读会被 dsh 拒绝加载），不躺进 settings.yaml
      warn: '这把 key 会写进 ~/.dsh/.credentials.yaml 的 refs（dsh 自己的凭据库，与 records 同文件）',
    },
  ],
  // 默认模型指针只在接管 default 时才动：那是用户每次新建 agent 的起点，不是我们的默认赠品
  extra: ({ roles }) =>
    roles && roles.default
      ? [
          {
            rel: DSH_FILE,
            format: 'yaml',
            path: ['agent-default-model'],
            merge: true,
            staticKeys: ['provider'],
            roleTarget: true,
            roleKey: () => 'model',
            writtenKeys: [],
            removable: true,
            warn: 'dsh 的默认模型会被改成 own-api——之后你在 dsh 里自己换过模型，这里就会显示「被改」，点同步按账本刷回',
          },
        ]
      : [],
  roleSlots: [{ slot: 'default', label: '默认模型（新建 agent 从它开始）' }],
  // 不接管时 dsh 仍按 profile 里的官方默认模型起步（那个名字在 own-api 里不存在），
  // 于是「接入成功但 agent 起不来」——和 Claude 的 haiku 同一种坑
  requiredSlots: ['default'],
  roleValue: (_slot, model) => model, // 指针的 provider 段恒为 own-api，model 段是裸模型名
  preflight: ({ home }) => {
    const out: string[] = [];
    const dshHome = process.env.DSH_HOME;
    // OWN_API_AGENT_HOME 是「把写根整体换掉」的测试旋钮：那时开发者机器上的 DSH_HOME 指的是他真那一份
    // 安装，与沙盒毫无关系（harness 自己就设着 DSH_HOME），此时比较没有意义
    if (dshHome && !process.env.OWN_API_AGENT_HOME && dshHome.replace(/\/+$/, '') !== join(home, '.dsh')) {
      out.push(`检测到 DSH_HOME=${dshHome}：本适配器只按默认 <home>/.dsh 定位 dsh 的配置，拒绝往别处写（unset 该变量，或把配置迁回默认位置）`);
    }
    if (!existsSync(join(home, ...DSH_CREDS))) {
      out.push(`~/.dsh/.credentials.yaml 不存在：那是 dsh 自己的凭据库（带 version 与 records 的文档），我们只往里加一格 refs，不替你发明它的格式——请先启动一次 dsh 让它建库`);
    }
    return out;
  },
  ownsKey: (key, cur, link, ctx) => {
    const s = String(cur ?? '');
    if (key === DSH_REF) return ctx.apiKey ? s === ctx.apiKey : 'unknown';
    if (key === 'provider') return s === link.providerId;
    if (key === 'model') return s === link.roles?.default;
    return false;
  },
};

export const ADAPTERS: Adapter[] = [ZCODE, CLAUDE, DSH, OMP];

export function getAdapter(id: unknown): Adapter | undefined {
  return typeof id === 'string' ? ADAPTERS.find((a) => a.id === id) : undefined;
}

export function targetFile(t: TargetSpec, home: string) {
  return join(home, ...t.rel);
}

// ---------------------------------------------------------------- detect

export interface TargetStatus {
  file: string;
  exists: boolean;
  parseOk: boolean;
  reason?: string;
  managedPresent: boolean;
}
export interface AgentStatus {
  id: string;
  label: string;
  /** 配置文件/数据目录在（可写的前提） */
  configPresent: boolean;
  /** 可执行体在既定位置存在；与 configPresent 分开判——卸载后配置常残留（§6.1） */
  binaryFound: boolean;
  targets: TargetStatus[];
  verify: string;
  /** 可选的角色槽（UI 据此渲染勾选项；不传的适配器没有这个角色概念） */
  roleSlots?: { slot: string; label: string }[];
  /** 其中默认该勾上的槽（Claude 的 haiku 不接管会让 agent 拿没登记的模型名打网关） */
  requiredSlots?: string[];
}

export function detectAgents(home: string): AgentStatus[] {
  const pathDirs = (process.env.PATH || '').split(':').filter(Boolean);
  return ADAPTERS.map((a) => {
    const targets: TargetStatus[] = a.targets.map((t) => {
      const file = targetFile(t, home);
      const r = readConfigFile(t.format, file);
      return {
        file,
        exists: existsSync(file),
        parseOk: r.ok,
        ...(r.ok ? {} : { reason: r.reason }),
        managedPresent: r.ok && getPath(r.state.data, t.path) !== undefined,
      };
    });
    return {
      id: a.id,
      label: a.label,
      configPresent: a.configCandidates.some((c) => existsSync(join(home, ...c))),
      binaryFound: a.binary.cmds.some((c) => pathDirs.some((d) => existsSync(join(d, c)))) || a.binary.apps.some((p) => existsSync(p)),
      targets,
      verify: a.verify,
      ...(a.roleSlots?.length ? { roleSlots: a.roleSlots } : {}),
      ...(a.requiredSlots?.length ? { requiredSlots: a.requiredSlots } : {}),
    };
  });
}

// ---------------------------------------------------------------- plan / apply

export interface PlanCtx {
  home: string;
  baseUrl: string;
  apiKey: string;
  vkeyId: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  /** 已按该 key ACL 过滤的可见模型集合（与 GET /v1/models 同源，G1） */
  models: { id: string; context_length?: number; max_output_tokens?: number }[];
  /** 角色槽 → 模型名（只有声明了 roleSlots 的适配器用得着；未声明的槽名在 targetsOf 里被丢弃） */
  roles?: Record<string, string>;
  /**
   * 该 agent 已有的账本（重复接入/同步时由调用方带上）。只用于一件事：本轮 noop 的写入点继承上一轮的
   * 写前值（见 applyLink 的 noop 分支），免得「同步一次」就把用户最早的原值从还原依据里抹掉。
   */
  prevLink?: import('./types.ts').AgentLink;
  /**
   * 除本次 `baseUrl` 外，还承认哪些基址是「我们写下去的」——同步/重接入时由调用方传账本里的
   * `link.baseUrl`。网关换过端口之后，旧块对本次要写的地址不再匹配，认账本才修得好（§15-5）；
   * 无账本时不传，§9-4 一个字都不放松。
   */
  oursBases?: string[];
}

export interface Step {
  file: string;
  state: 'create' | 'update' | 'noop';
  /** 托管块改写前后（密钥已掩码），供 UI 预览 */
  before: unknown;
  after: unknown;
  diff: string;
  /** 该步动的是文件里的哪条路径 + 是块还是角色槽（多写入点适配器要说得清改了哪一处） */
  path: string[];
  kind: 'block' | 'role';
}

export interface Plan {
  agentId: string;
  label: string;
  /** 结构性拒绝与撞名冲突：非空即不可 apply */
  errors: string[];
  /** 不阻断但必须让人看见的（agent 正在运行、配置残留、二进制缺失等） */
  warnings: string[];
  steps: Step[];
  fingerprint: string;
  baseUrl: string;
  verify: string;
}

/** 托管块里「指向哪家网关」那个字段：zcode 在 options.baseURL，omp/dsh 在块根上，三种拼法都得认 */
function blockBaseOf(block: any): string | undefined {
  for (const u of [block?.options?.baseURL, block?.baseURL, block?.baseUrl]) if (typeof u === 'string') return u;
  return undefined;
}

function blockLooksOurs(block: any, baseUrl: string, t?: TargetSpec, extraBases: string[] = []): boolean {
  if (t?.merge) return true; // 合并型写入点：现值不是我们的也算——「把角色指到本网关」正是本功能的目的（prev 记账供撤销还原）
  if (!block || typeof block !== 'object') return true; // 不存在 → 视为可创建
  const u = blockBaseOf(block);
  if (typeof u !== 'string') return false; // 同 id 但结构不是我们的形态：不覆盖（§9-4）
  const got = u.replace(/\/+$/, '');
  // 同主机端口才算我们写的（换 key/换模型都算 update）。extraBases 是账本里记着的旧基址：网关换过端口之后
  // 旧块长得确实不像本次要写的地址，但**账本是我们自己写的证据**——认它不算猜（§15-5）。
  // 没有账本（新接入、撤销之后）就一个字都不放松，用户手写的同 id 条目照旧不抢。
  return [baseUrl, ...extraBases].some((b) => got.startsWith(b.replace(/\/+$/, '')));
}

/** 托管块里登记的模型名清单：JSON 侧是 map（zcode），YAML 侧是数组（omp），两种形态都要认（catalog 新旧比对用） */
export function catalogIdsOf(block: any): string[] {
  const m = block?.models ?? block;
  if (Array.isArray(m)) return m.map((x: any) => String(x?.id ?? x?.name ?? '')).filter(Boolean);
  if (m && typeof m === 'object') return Object.keys(m);
  return [];
}

/** 读回主块供 UI 比对（按写入点声明的格式解析，YAML 也读得动） */
export function primaryBlock(adapter: Adapter, link: { targets: string[] }, home: string): unknown {
  const t = adapter.targets[0];
  if (!t) return undefined;
  const file = link.targets.find((f) => f === targetFile(t, home)) || targetFile(t, home);
  const r = readConfigFile(t.format, file);
  return r.ok ? getPath(r.state.data, t.path) : undefined;
}

/** 计划：服务端重算一切，零写入零外呼（§6.2） */
export function planLink(adapter: Adapter, ctx: PlanCtx): Plan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const steps: Step[] = [];
  const reads: { target: TargetSpec; block: unknown }[] = [];
  // 角色槽先过滤再往下传：下游（targetsOf / 指纹域 / after 值）一律只看过滤后的集合
  ctx = { ...ctx, roles: filterRoles(adapter, ctx.roles) };
  const built = adapter.build({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl, protocol: ctx.protocol, model: ctx.model, models: ctx.models });

  if (!ctx.models.length) errors.push('这把 key 目前没有任何可路由模型（先在「模型路由」登记，并确认它在此 key 的允许范围内）');

  // 角色必须有唯一归宿：声明了角色槽却传了角色值而无人承接 = 角色被静默丢弃；两个承接点 = 同一角色写两处、
  // 撤销只认一处。两种都是适配器作者的错，宁可当场拒绝也不落盘（这条守卫正是被 Claude 的垃圾根键逼出来的）
  const roleTargets = targetsOf(adapter, ctx).filter((t) => t.roleTarget);
  if (Object.keys(ctx.roles ?? {}).length && !roleTargets.length) errors.push('适配器配置错误：声明了角色但没有写入点承接（roleTarget），已拒绝写入');
  if (roleTargets.length > 1) errors.push(`适配器配置错误：${roleTargets.length} 个写入点都声称承接角色槽，已拒绝写入`);
  for (const e of adapter.preflight?.(ctx) ?? []) errors.push(e);

  for (const t of targetsOf(adapter, ctx)) {
    const file = targetFile(t, ctx.home);
    const r = readConfigFile(t.format, file);
    if (!r.ok) {
      errors.push(`${file}：${r.reason}`);
      continue;
    }
    const unsafe = t.format === 'yaml' ? pathSafe(r.state, t.path) : undefined;
    if (unsafe) {
      errors.push(`${file}：${unsafe}`);
      continue;
    }
    const before = getPath(r.state.data, t.path);
    if (!blockLooksOurs(before, ctx.baseUrl, t, ctx.oursBases)) {
      // 把现值印出来：用户看到「被占用」第一反应就是「那它现在指着谁？」，答不上来这条就只是挡路
      errors.push(`${file}：托管路径 ${t.path.join('.')} 已被别的条目占用（它写的是 ${blockBaseOf(before) ?? '没有 baseURL 字段'}，不是本网关 ${ctx.baseUrl}），拒绝覆盖——请换个名字，或先把那一条改掉`);
      continue;
    }
    const keys = keysOfTarget(t, ctx.roles);
    const after = t.merge ? mergeValuesOf(t, adapter, ctx, built) : blockValueOf(t, built);
    // 合并型写入点的「之前」只呈现我们claim的那几个键：把用户其它角色也拉进 diff 是噪音，
    // 而且会让人误以为我们要动它们
    const beforeView = t.merge ? Object.fromEntries(Object.entries((before ?? {}) as Record<string, unknown>).filter(([k]) => keys.some((p) => p[0] === k))) : before;
    reads.push({ target: t, block: after });
    const same = before !== undefined && fingerprintOf(before, keys) === fingerprintOf(after, keys);
    // 只在真要改动时说：一致的键不值得占用用户的眼球
    if (t.warn && before !== undefined && !same) warnings.push(t.warn);
    // 块型覆盖是「整块换掉」：盘上那块里我们不托管的键会一起消失。这在真机彩排里咬过一口——
    // 用户手写的 providers.own-api 带着 defaultInput 和 5 个模型（各自的 input/maxTokens），
    // 我们的投影没有它们。预览 diff 看得见，但一句话说明白更负责。
    if (!t.merge && before && typeof before === 'object' && !Array.isArray(before)) {
      const dropped = Object.keys(before).filter((k) => !(k in (after ?? {})));
      if (dropped.length) warnings.push(`${t.path.join('.') || '目标块'}里有我们不托管的字段：${dropped.join('、')}——整块覆盖后这些会消失（原文在 ${file}.own-api-bak 里）`);
    }
    steps.push({
      file,
      state: before === undefined ? 'create' : same ? 'noop' : 'update',
      before: maskBlock(beforeView),
      after: maskBlock(after),
      diff: lineDiff(JSON.stringify(maskBlock(beforeView ?? {}), null, 2), JSON.stringify(maskBlock(after), null, 2)),
      path: t.path,
      kind: t.merge ? 'role' : 'block',
    });
  }

  const st = detectAgents(ctx.home).find((a) => a.id === adapter.id);
  if (st && !st.binaryFound) warnings.push(`未检测到 ${adapter.label} 的可执行体：配置会写入成功，但该 agent 当前可能未安装在此机器上`);
  if (st && st.targets.some((t) => !t.parseOk)) warnings.push('有目标文件无法安全解析，本次已拒绝（见错误清单）');
  // 适配器侧的补充提示（如 Claude 的 haiku 槽指向主模型：能用但会拿贵的模型跑后台任务）
  for (const w of adapter.warnings?.(ctx) ?? []) warnings.push(w);
  return {
    agentId: adapter.id,
    label: adapter.label,
    errors,
    warnings,
    steps,
    fingerprint: fingerprintOfTargets(reads, ctx.roles),
    baseUrl: ctx.baseUrl,
    verify: adapter.verify,
  };
}

export interface ApplyResult {
  status: 'success' | 'partial' | 'failed';
  steps: { file: string; state: Step['state']; ok: boolean; backup?: string; reason?: string }[];
  plan: Plan;
  /** 交调用方落账（store.upsertAgentLink）；failed 时为 undefined */
  link?: import('./types.ts').AgentLink;
}

/** 应用：备份 → 原子写 → **回读校验**。回读不等只报失败不自动回滚（DR-AI-E） */
export function applyLink(adapter: Adapter, ctx: PlanCtx): ApplyResult {
  const plan = planLink(adapter, ctx); // 提交路径同样重算，绝不信任前端传来的计划
  const steps: ApplyResult['steps'] = [];
  if (plan.errors.length) return { status: 'failed', steps, plan };

  const now = Date.now();
  ctx = { ...ctx, roles: filterRoles(adapter, ctx.roles) };
  const built = adapter.build({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl, protocol: ctx.protocol, model: ctx.model, models: ctx.models });
  /** 逐写入点指纹（漂移定位用）；noop 也记——它表示「盘上现值与我方声明一致」，同样是指纹 */
  const byFile: Record<string, string> = {};
  /** 合并型写入点的写前值（`文件#路径` → {键: 原值}）：撤销时逐键还原，没记到的键才真删 */
  const prev: Record<string, Record<string, unknown>> = {};

  const targets = targetsOf(adapter, ctx);
  const files = targets.map((t) => targetFile(t, ctx.home));
  for (const t of targets) {
    const file = targetFile(t, ctx.home);
    const keys = keysOfTarget(t, ctx.roles);
    const value = t.merge ? mergeValuesOf(t, adapter, ctx, built) : blockValueOf(t, built);
    // 同一文件可以有多条托管路径（Claude Code 的 env 与顶层 model）：计划步必须按「文件+路径」配对，
    // 只按文件配会张冠李戴。写入本身是安全的——每个写入点都重新读盘再改，看得见前一个写入点的成果
    const step = plan.steps.find((s) => s.file === file && s.path.join('.') === t.path.join('.'));
    if (!step) {
      steps.push({ file, state: 'noop', ok: false, reason: '该写入点不在计划内' });
      continue;
    }
    if (step.state === 'noop') {
      byFile[fileFpKey(files, file, t)] = fingerprintOf(value, keys);
      // noop 也得留下「撤销时该放回什么」，否则撤销会把这一格掏空。dsh 的 agent-default-model 最容易踩：
      // 用户本来就指着 own-api/model_auto，第一轮 apply 就是 noop，什么都不记的话撤销只能删键，
      // 留下一个空映射——那是文件形状变化，不是还原。
      // 优先级：上一轮账本记的写前值 > 盘上现值。前者可能和眼下看到的不一样（凭据那格我们写过一次，
      // 之后轮轮 noop，但用户最早那把 key 只活在旧账本里）。
      // 注意：**真写过的写入点绝不继承**（AI-32：那次凭空造出来的键，撤销就该删掉而不是造回去）。
      if (t.merge) {
        const carry = ctx.prevLink?.prev?.[`${file}#${t.path.join('.')}`];
        if (carry) prev[`${file}#${t.path.join('.')}`] = carry;
        else {
          const nr = readConfigFile(t.format, file);
          if (nr.ok) {
            const cur0 = (getPath(nr.state.data, t.path) ?? {}) as Record<string, unknown>;
            const snap0: Record<string, unknown> = {};
            for (const p of keys) if (cur0[p[0]] !== undefined) snap0[p[0]] = cur0[p[0]];
            if (Object.keys(snap0).length) prev[`${file}#${t.path.join('.')}`] = snap0;
          }
        }
      }
      steps.push({ file, state: 'noop', ok: true });
      continue;
    }
    const r = readConfigFile(t.format, file);
    if (!r.ok) {
      steps.push({ file, state: step.state, ok: false, reason: r.reason });
      continue;
    }
    if (t.merge) {
      const cur = (getPath(r.state.data, t.path) ?? {}) as Record<string, unknown>;
      const snap: Record<string, unknown> = {};
      for (const p of keys) if (cur[p[0]] !== undefined) snap[p[0]] = cur[p[0]];
      if (Object.keys(snap).length) prev[`${file}#${t.path.join('.')}`] = snap;
    }
    const w = writeBlock(t, file, r.state, value);
    if (!w.ok) {
      steps.push({ file, state: step.state, ok: false, reason: w.reason });
      continue;
    }
    // 回读校验：重新解析并按指纹域比对（钉 AI-7 靠这一步才成立）
    const back = readConfigFile(t.format, file);
    if (!back.ok) {
      steps.push({ file, state: step.state, ok: false, backup: w.backup, reason: `回读失败（${back.reason}）；备份在 ${w.backup}，未自动回滚` });
      continue;
    }
    const got = getPath(back.state.data, t.path);
    if (fingerprintOf(got, keys) !== fingerprintOf(value, keys)) {
      steps.push({ file, state: step.state, ok: false, backup: w.backup, reason: `回读校验不等（写入后内容与我们提交的不一致，可能被并发写）；备份在 ${w.backup}，未自动回滚` });
      continue;
    }
    byFile[fileFpKey(files, file, t)] = fingerprintOf(value, keys);
    steps.push({ file, state: step.state, ok: true, backup: w.backup });
  }

  const failed = steps.filter((s) => !s.ok);
  const status: ApplyResult['status'] = failed.length ? 'failed' : 'success';
  const link = failed.length
    ? undefined
    : {
        agentId: adapter.id,
        vkeyId: ctx.vkeyId,
        model: ctx.model,
        ...(Object.keys(ctx.roles ?? {}).length ? { roles: ctx.roles } : {}),
        providerId: adapter.providerId,
        baseUrl: ctx.baseUrl,
        fingerprint: plan.fingerprint,
        byFile,
        ...(Object.keys(prev).length ? { prev } : {}),
        targets: targetsOf(adapter, ctx).map((t) => targetFile(t, ctx.home)),
        linkedAt: now,
        lastSyncAt: now,
      };
  return { status, steps, plan, link };
}

// ---------------------------------------------------------------- drift / revoke

export type DriftState = 'consistent' | 'modified' | 'missing' | 'unavailable';

export function driftOf(adapter: Adapter, link: import('./types.ts').AgentLink, home: string): { state: DriftState; detail?: string } {
  const targets = targetsOf(adapter, { home, roles: link.roles });
  const reads: { target: TargetSpec; block: unknown }[] = [];
  for (const t of targets) {
    const file = targetFile(t, home);
    const r = readConfigFile(t.format, file);
    if (!r.ok) return { state: 'unavailable', detail: `${file}：${r.reason}` };
    const keys = keysOfTarget(t, link.roles);
    const block = getPath(r.state.data, t.path);
    // 合并型的「凭空消失」= 我们声明的那些键全没了（映射本身可能还在，里面装着别人的角色）
    const gone = t.merge ? !keys.length || keys.every((p) => getPath(block, p) === undefined) : block === undefined;
    if (gone) return { state: 'missing', detail: `${file} 里已找不到 ${t.path.join('.')}${t.merge ? ` 的 ${keys.map((p) => p[0]).join('、')}` : ''}（被删或被整段覆盖）` };
    reads.push({ target: t, block });
  }
  const fp = fingerprintOfTargets(reads, link.roles);
  if (fp === link.fingerprint) return { state: 'consistent' };
  // 逐写入点定位（账本存了 byFile 才说得清是哪个文件；老账本没有就只报「整体不符」）
  const changed: string[] = [];
  const files = targets.map((t) => targetFile(t, home));
  for (const t of targets) {
    const file = targetFile(t, home);
    const r = readConfigFile(t.format, file);
    if (!r.ok) continue;
    const now = fingerprintOf(getPath(r.state.data, t.path), keysOfTarget(t, link.roles));
    if (link.byFile && link.byFile[fileFpKey(files, file, t)] !== now) changed.push(file);
  }
  return { state: 'modified', detail: changed.length ? `以下文件里我方声明的字段被改动：${changed.join('、')}` : '指纹与账本不符（该 agent 或已被其它工具整段覆盖）' };
}

/** 撤销：块型只删自己的块且须仍指向本网关；合并型逐键还原写前值，同样只对我们认得的键下手 */
export function revokeLink(
  adapter: Adapter,
  link: import('./types.ts').AgentLink,
  home: string,
  /** 撤销时需要知道「我们写的值」才能判断归属。key 已被删除时调用方给不出 apiKey，相关键一律按认不出处理（kept） */
  ctx: { apiKey?: string } = {},
): { results: { file: string; action: 'removed' | 'kept' | 'absent' | 'refused' | 'failed'; reason?: string }[] } {
  const results: { file: string; action: 'removed' | 'kept' | 'absent' | 'refused' | 'failed'; reason?: string }[] = [];
  /** 缺省归属判据：值以 `providerId/` 打头（omp 写的是 `own-api/<model>`）。裸值型 agent 用 ownsKey 自带判据 */
  const owns = (t: TargetSpec, k: string, cur: unknown) =>
    adapter.ownsKey
      ? adapter.ownsKey(k, cur, link, { apiKey: ctx.apiKey, baseUrl: link.baseUrl })
      : String(cur ?? '').split('/')[0] === link.providerId;
  for (const t of targetsOf(adapter, { home, roles: link.roles })) {
    const file = targetFile(t, home);
    if (!t.removable) {
      results.push({ file, action: 'kept', reason: '该适配器未声明可自动删除，请人工处理' });
      continue;
    }
    const r = readConfigFile(t.format, file);
    if (!r.ok) {
      results.push({ file, action: 'refused', reason: r.reason });
      continue;
    }
    if (!r.state.exists) {
      results.push({ file, action: 'absent' });
      continue;
    }
    const block = getPath(r.state.data, t.path);
    const prev = link.prev?.[`${file}#${t.path.join('.')}`] as Record<string, unknown> | undefined;
    if (t.merge) {
      const keys = keysOfTarget(t, link.roles).map((p) => p[0]);
      const cur = (block ?? {}) as Record<string, unknown>;
      // 三态而不是布尔：**「用户改走了」和「我没法确认」是两件事**。前者可以放心清账（残留的已经不是我们的），
      // 后者是关键残留（比如删不掉的 key），账本必须留着，否则 UI 上它就隐身了
      const ours: string[] = [];
      const unknown: string[] = [];
      for (const k of keys) {
        const v = owns(t, k, cur[k]);
        if (v === true) ours.push(k);
        else if (v === 'unknown') unknown.push(k);
      }
      const skipped = keys.filter((k) => !ours.includes(k) && !unknown.includes(k));
      if (!ours.length) {
        results.push({ file, action: 'kept', reason: `${keys.join('、')} 的现值都不是本次写入的值（可能被你自己改过），保留不动` });
        continue;
      }
      const w = dropBlock(t, file, r.state, prev, ours);
      if (!w.ok) {
        results.push({ file, action: 'failed', reason: w.reason });
        continue;
      }
      if (unknown.length) {
        results.push({ file, action: 'kept', reason: `已还原 ${ours.length} 个键，但 ${unknown.join('、')} 无法确认归属（key 明文已不可得），账本留着等你处理` });
        continue;
      }
      results.push({
        file,
        action: 'removed',
        reason: [w.backup ? `备份：${w.backup}` : '', skipped.length ? `${skipped.join('、')} 的现值不是本次写入的值，未动` : ''].filter(Boolean).join('；') || undefined,
      });
      continue;
    }
    if (block === undefined) {
      results.push({ file, action: 'absent' });
      continue;
    }
    if (!blockLooksOurs(block, link.baseUrl)) {
      results.push({ file, action: 'kept', reason: '该条目已不指向本网关（可能被你改写或重建），保留不动' });
      continue;
    }
    const w = dropBlock(t, file, r.state);
    results.push(w.ok ? { file, action: 'removed', reason: w.backup ? `备份：${w.backup}` : undefined } : { file, action: 'failed', reason: w.reason });
  }
  return { results };
}
