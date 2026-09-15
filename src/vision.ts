// 视觉能力三态（AR-6，§4）：supportsVision true/false/'unknown'（undefined ≡ unknown，无证据≠支持）。
// 启发式初值（静态家族先验）+ 被动降级学习（G18 指纹门槛 / F6.2 60s 窗 / SEC-2）+ inputEst 图片 token（R7）。
// 本模块不依赖 store/gateway——被两者共用，禁止反向 import。
import { createHash } from 'node:crypto';

export type VisionSupport = true | false | 'unknown';

/** 已知多模态家族静态表（§4 先验）：只做初值不做裁决——网关静默丢图返回 200 的场景探测不出来，交给学习闭环 */
const VISION_FAMILIES: RegExp[] = [
  /gpt-4(\.\d+)?\b/, /gpt-4-turbo/, /gpt-4-vision/, /gpt-4o/, /chatgpt-4o/, /gpt-4\.1/,
  /\bo[1-9]\b/, /\bo[1-9]-/, /o[1-9]-mini/,
  /claude-3/, /claude-(sonnet|opus|haiku)/,
  /gemini/,
  /glm-4v/, /qvq/, /qwen[^,/]*-vl/,
  /llava/, /llama-3\.2[^,/]*vision/, /pixtral/, /internvl/, /molmo/, /minicpm-v/,
];

/** 启发式初值：命中已知家族 → true；其余 → undefined（≡unknown，交给学习闭环兜底） */
export function heuristicVision(...names: (string | undefined)[]): true | undefined {
  const s = names.filter((n): n is string => !!n).join(' ').toLowerCase();
  return VISION_FAMILIES.some((re) => re.test(s)) ? true : undefined;
}

/** vision 三态合法性（store 白名单用） */
export function isVisionSupport(v: unknown): v is VisionSupport {
  return v === true || v === false || v === 'unknown';
}

/**
 * 视觉不支持的保守白名单（G2 修正）：只匹配"能力声明"类文案——模型根本不收图，换支持视觉的候选有意义。
 * 单图处理失败类（could not process / invalid media type / image too large / unsupported format）显式不在列：
 * 那是这张图的问题，换候选同样会挂。白名单宁缺勿滥：未命中走 D 格短接，误放进来的代价是全链烧尽。
 */
export const VISION_UNSUPPORTED_RE = /images?\s*(?:are\s+)?not\s+supported|not\s+support(?:ing)?\s+(?:the\s+)?images?|(?:vision|multimodal|image\s+input)\s+(?:is\s+)?not\s+(?:supported|enabled)|text[- ]only\s+model|does\s+not\s+support\s+(?:the\s+)?vision/i;

/** 带图请求检测（AR-6/F2.1）：openai image_url / anthropic image 内容块 */
export function chatHasImages(chatBody: any): boolean {
  for (const m of chatBody?.messages || []) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) if (p?.type === 'image_url' || p?.type === 'image') return true;
  }
  return false;
}

/** data URL / anthropic base64 → 可解码字节；http(s) URL → null（R7：不为计费下载图片） */
function imageBytes(part: any): Buffer | null {
  const url: string | undefined =
    part?.type === 'image_url' ? part?.image_url?.url
      : part?.type === 'image' && part?.source?.data
        ? `data:${part?.source?.media_type || 'application/octet-stream'};base64,${part.source.data}`
        : undefined;
  if (!url || !url.startsWith('data:')) return null;
  const i = url.indexOf(';base64,');
  if (i < 0) return null;
  try {
    return Buffer.from(url.slice(i + 8), 'base64');
  } catch {
    return null;
  }
}

/** 图片尺寸嗅探：PNG(IHDR) / GIF(逻辑屏幕) / JPEG(SOF 扫描)。其它格式 → null 走常数 */
function sniffImageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
      }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) return null;
      off += 2 + len;
    }
  }
  return null;
}

/**
 * 单图 token 估算（R7 补坑）：data URL 解析出 w×h 精算 ≈(w×h)/750（OpenAI tile 语义的线性近似）；
 * http URL / 解析失败 → null（调用方用常数兜底）。不为计费去下载图片。
 */
export function imageDataTokens(part: any): number | null {
  const buf = imageBytes(part);
  if (!buf) return null;
  const dim = sniffImageSize(buf);
  if (!dim || !(dim.w > 0 && dim.h > 0)) return null;
  return Math.max(1, Math.ceil((dim.w * dim.h) / 750));
}

/** 图片内容指纹（G18）：data URL/base64 → SHA-256 截断；http URL 指纹 URL 本身（不下载）。防粘性+重试双击同一张坏图造成永久误标 */
export function imageFingerprints(chatBody: any): string[] {
  const out = new Set<string>();
  for (const m of chatBody?.messages || []) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) {
      if (p?.type !== 'image_url' && p?.type !== 'image') continue;
      const bytes = imageBytes(p);
      const src = bytes ? 'd:' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) : 'u:' + createHash('sha256').update(String(p?.image_url?.url || p?.source?.url || '')).digest('hex').slice(0, 16);
      out.add(src);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------- 被动降级学习状态（进程内存，R5 同健康/粘性生命周期）

const VISION_FP_WINDOW_MS = 60_000;        // F6.2/SEC-2：指纹只在 60s 滑动窗内有效
const VISION_LEARN_COOLDOWN_MS = 3_600_000; // 学习动作每候选 1h 冷却
export const VISION_UNKNOWN_BIAS = 0.25;   // §5：带图请求 unknown 候选的加权偏置（非排除——尽量不付"第一次失败"的学费）

const seenFps = new Map<string, Map<string, number>>(); // routeId → (fp → 首见 ts)
const learnedAt = new Map<string, number>();            // routeId → 上次学习触发 ts
let vnow: () => number = () => Date.now();
export function setVisionClockForTest(fn: () => number) {
  vnow = fn;
}

/**
 * 学习门槛判定 + 指纹记账。齐备（窗内 ≥2 不同指纹 + 未在学习冷却中）才允许置 false。
 * 同一张图反复 400（粘性+重试双击）只有 1 个指纹 → 永远差一口，杜绝 G18 误标。
 */
export function visionLearnReady(routeId: string, fps: string[]): boolean {
  if (!routeId || !fps.length) return false;
  const now = vnow();
  const last = learnedAt.get(routeId);
  if (last !== undefined && now - last < VISION_LEARN_COOLDOWN_MS) return false;
  const m = seenFps.get(routeId) || new Map<string, number>();
  for (const [fp, ts] of m) if (now - ts > VISION_FP_WINDOW_MS) m.delete(fp);
  for (const fp of fps) if (!m.has(fp)) m.set(fp, now);
  seenFps.set(routeId, m);
  return m.size >= 2;
}

export function markVisionLearned(routeId: string) {
  learnedAt.set(routeId, vnow());
}

/** 管理台「重置回 unknown」连带清学习记忆（否则 60s 内两次重置会被冷却卡住） */
export function clearVisionLearning(routeId?: string) {
  if (routeId) {
    seenFps.delete(routeId);
    learnedAt.delete(routeId);
  } else {
    seenFps.clear();
    learnedAt.clear();
  }
}
