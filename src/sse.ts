/**
 * SSE 流式转发与跨协议流转换。
 * 原则：
 *  - 单条链路：一律用 pipeThrough / 可取消的读取链，绝不用 tee —— tee 会让"客户端已断开"
 *    无法传导到上游，上游继续生成继续计费。
 *  - 同协议零改写透传（旁路在同一路里解析 usage）；跨协议才重新编码事件。
 *  - 分帧兼容 \n\n 与 \r\n\r\n（SSE 规范允许两种）。
 */
import type { Protocol } from './types.ts';
import {
  finishToStopReason,
  mergeUsage,
  stopReasonToFinish,
  usageFromAnthropic,
  usageFromOpenai,
  type Usage,
} from './translate.ts';

export interface SSEEvent {
  event?: string;
  data: string;
}

export interface StreamMeta {
  publicName: string;
  usage: Usage;
  onFirstContent?: () => void;
}

const enc = new TextEncoder();

/**
 * 统一换行符：SSE 允许 CRLF / CR / LF。
 * 注意尾部孤立的 \r 必须留到下一块再定夺：若此刻就换成 \n，而下一块恰好以 \n 开头
 * （CRLF 行分隔符被 TCP 拆在 \r|\n 之间），就会在多行帧中间拼出一个假的 \n\n 帧边界。
 */
function normalizeNewlines(s: string) {
  if (s.endsWith('\r')) return normalizeNewlines(s.slice(0, -1)) + '\r';
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 从缓冲区里切出完整帧；返回剩余未完成的尾巴 */
function drainFrames(buf: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let idx: number;
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    frames.push(buf.slice(0, idx));
    buf = buf.slice(idx + 2);
  }
  return { frames, rest: buf };
}

function parseFrame(raw: string): SSEEvent | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return undefined;
  return { event, data: dataLines.join('\n') };
}

/** 按 SSE 空行分帧（兼容 CRLF）。for-await 提前 break 时会 cancel 上游 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = normalizeNewlines(buf + dec.decode(value, { stream: true }));
      const { frames, rest } = drainFrames(buf);
      buf = rest;
      for (const f of frames) {
        const ev = parseFrame(f);
        if (ev) yield ev;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

type Emit = (chunk: string | Uint8Array) => void;

/** 从上游读取并逐帧回调，返回可被取消的转换流 */
/**
 * 逐帧转换外壳：单条 pipeThrough 链路，下游取消会传导回上游。
 * onFirst 在每个上游分块到达时最多触发一次（用于 TTFT）。
 */
function frameTransform(
  src: ReadableStream<Uint8Array>,
  onFrame: (ev: SSEEvent, emit: Emit) => void,
  onEnd?: (emit: Emit) => void,
  onFirst?: () => void,
): ReadableStream<Uint8Array> {
  let buf = '';
  const dec = new TextDecoder();
  let first = true;
  const stream = src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (first) {
          first = false;
          onFirst?.();
        }
        buf = normalizeNewlines(buf + dec.decode(chunk, { stream: true }));
        const { frames, rest } = drainFrames(buf);
        buf = rest;
        const emit: Emit = (c) => controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
        for (const f of frames) {
          const ev = parseFrame(f);
          if (ev) onFrame(ev, emit);
        }
      },
      flush(controller) {
        const emit: Emit = (c) => controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
        const tail = normalizeNewlines(buf).trim();
        buf = '';
        const ev = tail ? parseFrame(tail) : undefined;
        if (ev) onFrame(ev, emit);
        onEnd?.(emit);
      },
    }),
  );
  return stream;
}

function sseEvent(event: string | undefined, data: any): string {
  return `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function openaiUsagePayload(u: Usage) {
  return {
    prompt_tokens: u.promptTokens,
    completion_tokens: u.completionTokens,
    total_tokens: u.promptTokens + u.completionTokens,
    prompt_tokens_details: { cached_tokens: u.cacheReadTokens },
    cache_creation_input_tokens: u.cacheWriteTokens,
  };
}

function scanUsage(json: any, protocol: Protocol, meta: StreamMeta) {
  if (protocol === 'openai') {
    if (json.usage) mergeUsage(meta.usage, usageFromOpenai(json.usage));
  } else if (json.type === 'message_start') {
    mergeUsage(meta.usage, usageFromAnthropic(json.message?.usage));
  } else if (json.type === 'message_delta') {
    mergeUsage(meta.usage, usageFromAnthropic(json.usage));
  }
}

let chunkSeq = 0;

/**
 * 同协议透传。默认逐字节原样转发（含上游自定义字段与注释行），只在同一路里旁扫 usage；
 * 别名与上游真名不同时才逐帧改写 model，避免对外泄漏上游真实模型名。
 */
export function passthroughStream(
  src: ReadableStream<Uint8Array>,
  protocol: Protocol,
  meta: StreamMeta,
  modelRewrite?: { to: string } | undefined,
): ReadableStream<Uint8Array> {
  if (!modelRewrite) {
    // 零改写：原始字节一个字节不动地转发，只在副本上旁扫 usage
    const sc = new UsageSc(protocol, meta);
    let firstByte = true;
    return src.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (firstByte) {
            firstByte = false;
            meta.onFirstContent?.();
          }
          sc.feed(chunk.slice());
          controller.enqueue(chunk);
        },
        flush() {
          sc.finish();
        },
      }),
    );
  }

  return frameTransform(
    src,
    (ev, emit) => {
      if (!ev.data) {
        return;
      }
      if (ev.data === '[DONE]') {
        emit(sseEvent(ev.event, ev.data));
        return;
      }
      let json: any;
      try {
        json = JSON.parse(ev.data);
      } catch {
        emit(sseEvent(ev.event, ev.data));
        return;
      }
      scanUsage(json, protocol, meta);
      if (json.model !== undefined) json.model = modelRewrite.to;
      if (protocol === 'anthropic' && json.type === 'message_start' && json.message) json.message.model = modelRewrite.to;
      emit(sseEvent(ev.event, json));
    },
    undefined,
    () => meta.onFirstContent?.(),
  );
}

/** 增量旁扫 usage 的行缓冲。每条流必须持有独立实例，不能共享 */
class UsageSc {
  private text = '';
  private dec = new TextDecoder(); // 实例级 decoder：跨块的多字节 UTF-8 序列才能续上，不能每块 new
  private protocol: Protocol;
  private meta: StreamMeta;
  constructor(protocol: Protocol, meta: StreamMeta) {
    this.protocol = protocol;
    this.meta = meta;
  }
  feed(chunk: Uint8Array) {
    this.text = normalizeNewlines(this.text + this.dec.decode(chunk, { stream: true }));
    const { frames, rest } = drainFrames(this.text);
    this.text = rest;
    for (const f of frames) this.scan(f);
  }
  finish() {
    const tail = this.text.trim();
    this.text = '';
    if (tail) this.scan(tail);
  }
  private scan(raw: string) {
    const ev = parseFrame(raw);
    if (!ev?.data || ev.data === '[DONE]') return;
    try {
      scanUsage(JSON.parse(ev.data), this.protocol, this.meta);
    } catch {
      /* 非 JSON 帧忽略 */
    }
  }
}

/** 上游忽略 stream 参数、直接回 JSON 时，把完整响应合成成 SSE，避免客户端拿到空响应 */
export function openaiJsonToSSE(json: any, publicName: string, usage: Usage): ReadableStream<Uint8Array> {
  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};
  const base = {
    id: String(json.id || `chatcmpl-${Date.now()}`).replace(/^msg_/, 'chatcmpl-'),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: publicName,
  };
  return new ReadableStream({
    start(c) {
      const push = (delta: any, finish: string | null, u?: any) => {
        const o: any = { ...base, choices: [{ index: 0, delta, finish_reason: finish }] };
        if (u) o.usage = u;
        c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      };
      push({ role: msg.role || 'assistant', content: msg.content || (msg.tool_calls ? '' : '') }, null);
      if (msg.reasoning_content) push({ reasoning_content: msg.reasoning_content }, null);
      (msg.tool_calls || []).forEach((tc: any, i: number) =>
        push({ tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: tc.function?.arguments || '' } }] }, null),
      );
      push({}, choice.finish_reason || 'stop', json.usage || openaiUsagePayload(usage));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

/** Anthropic 客户端要流式、上游只给 JSON 时，合成合法 Anthropic 事件序列 */
export function anthropicJsonToSSE(json: any, publicName: string, usage: Usage): ReadableStream<Uint8Array> {
  const blocks = Array.isArray(json.content) ? json.content : [];
  return new ReadableStream({
    start(c) {
      const push = (ev: string, o: any) => c.enqueue(enc.encode(sseEvent(ev, o)));
      push('message_start', {
        type: 'message_start',
        message: {
          id: json.id || `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model: publicName,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.promptTokens, output_tokens: 0 },
        },
      });
      blocks.forEach((b: any, i: number) => {
        if (b.type === 'text') {
          push('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
          if (b.text) push('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } });
        } else if (b.type === 'thinking') {
          push('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } });
          push('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: b.thinking || '' } });
        } else if (b.type === 'tool_use') {
          push('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
          push('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } });
        }
        push('content_block_stop', { type: 'content_block_stop', index: i });
      });
      push('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: json.stop_reason || 'end_turn', stop_sequence: null },
        usage: { output_tokens: usage.completionTokens, input_tokens: usage.promptTokens },
      });
      push('message_stop', { type: 'message_stop' });
      c.close();
    },
  });
}

/** Anthropic SSE -> OpenAI chat.completion.chunk SSE */
export function anthropicStreamToOpenai(src: ReadableStream<Uint8Array>, meta: StreamMeta): ReadableStream<Uint8Array> {
  const base = {
    id: `chatcmpl-lm-${Date.now().toString(36)}-${(chunkSeq++).toString(36)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: meta.publicName,
  };
  let sentRole = false;
  let sawText = false;
  const toolIndex = new Map<number, number>();
  let nextToolIndex = 0;

  return frameTransform(
    src,
    (ev, emit) => {
      if (!ev.data) return;
      let json: any;
      try {
        json = JSON.parse(ev.data);
      } catch {
        return;
      }
      const chunk = (delta: any, finish: string | null, usage?: any) => {
        const c: any = { ...base, choices: [{ index: 0, delta, finish_reason: finish }] };
        if (usage) c.usage = usage;
        emit(sseEvent(undefined, c));
      };
      const type = json.type || ev.event;
      if (type === 'message_start') {
        if (json.message?.id) base.id = String(json.message.id).replace(/^msg_/, 'chatcmpl-');
        mergeUsage(meta.usage, usageFromAnthropic(json.message?.usage));
      } else if (type === 'content_block_start') {
        const blk = json.content_block || {};
        if (blk.type === 'tool_use') {
          const oi = nextToolIndex++;
          toolIndex.set(json.index, oi);
          if (!sentRole) {
            sentRole = true;
            chunk({ role: 'assistant', content: '' }, null);
          }
          chunk({ tool_calls: [{ index: oi, id: blk.id, type: 'function', function: { name: blk.name, arguments: '' } }] }, null);
        }
      } else if (type === 'content_block_delta') {
        const d = json.delta || {};
        if ((d.type === 'text_delta' || d.type === 'thinking_delta') && !sentRole) {
          sentRole = true;
          chunk({ role: 'assistant', content: '' }, null);
        }
        if (d.type === 'text_delta') {
          if (!sawText) {
            sawText = true;
            meta.onFirstContent?.();
          }
          chunk({ content: d.text }, null);
        } else if (d.type === 'thinking_delta') {
          chunk({ reasoning_content: d.thinking }, null);
        } else if (d.type === 'input_json_delta') {
          chunk({ tool_calls: [{ index: toolIndex.get(json.index) ?? 0, function: { arguments: d.partial_json } }] }, null);
        }
      } else if (type === 'message_delta') {
        mergeUsage(meta.usage, usageFromAnthropic(json.usage));
        const finish = stopReasonToFinish(json.delta?.stop_reason);
        if (finish) chunk({}, finish, openaiUsagePayload(meta.usage));
      } else if (type === 'error') {
        emit(sseEvent(undefined, { error: json.error ?? { message: 'upstream stream error' } }));
      }
    },
    (emit) => emit('data: [DONE]\n\n'),
    () => meta.onFirstContent?.(),
  );
}

/**
 * OpenAI chat chunk 流 -> legacy text_completion chunk 流。
 * 既然声明了 /v1/completions 入口，就得给出老 SDK 真能解析的结构：
 * 它们读的是 choices[].text，不是 delta.content。
 */
export function chatStreamToLegacy(src: ReadableStream<Uint8Array>, publicName: string): ReadableStream<Uint8Array> {
  return frameTransform(
    src,
    (ev, emit) => {
      if (!ev.data) return;
      if (ev.data === '[DONE]') {
        emit(sseEvent(undefined, ev.data));
        return;
      }
      let json: any;
      try {
        json = JSON.parse(ev.data);
      } catch {
        emit(sseEvent(ev.event, ev.data));
        return;
      }
      if (json.error) {
        emit(sseEvent(undefined, json));
        return;
      }
      const choice = json.choices?.[0] || {};
      const delta = choice.delta || {};
      const text = typeof delta.content === 'string' ? delta.content : '';
      const args = (delta.tool_calls || []).map((tc: any) => tc.function?.arguments || '').join('');
      emit(
        sseEvent(undefined, {
          id: json.id,
          object: 'text_completion',
          created: json.created ?? Math.floor(Date.now() / 1000),
          model: publicName,
          choices: [{ index: 0, text: text || args, logprobs: null, finish_reason: choice.finish_reason || null }],
          ...(json.usage ? { usage: json.usage } : {}),
        }),
      );
    },
    undefined,
    undefined,
  );
}

/** OpenAI SSE -> Anthropic messages 事件流 */
export function openaiStreamToAnthropic(src: ReadableStream<Uint8Array>, meta: StreamMeta): ReadableStream<Uint8Array> {
  const msgId = `msg_${Date.now().toString(36)}${(chunkSeq++).toString(36)}`;
  let blockCount = 0;
  let thinkingIndex = -1;
  let textIndex = -1;
  const toolBlocks = new Map<number, number>();
  let stopReason: string | null = null;
  let firstText = true;
  let started = false;

  const openBlock = (emit: Emit, blk: any) => {
    const idx = blockCount++;
    emit(sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: blk }));
    return idx;
  };

  return frameTransform(
    src,
    (ev, emit) => {
      if (!started) {
        started = true;
        emit(
          sseEvent('message_start', {
            type: 'message_start',
            message: {
              id: msgId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: meta.publicName,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: meta.usage.promptTokens, output_tokens: 0 },
            },
          }),
        );
      }
      if (!ev.data || ev.data === '[DONE]') return;
      let json: any;
      try {
        json = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (json.error) {
        emit(sseEvent('error', { type: 'error', error: json.error }));
        return;
      }
      if (json.usage) mergeUsage(meta.usage, usageFromOpenai(json.usage));
      const choice = json.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};

      if (delta.reasoning_content) {
        if (thinkingIndex < 0) thinkingIndex = openBlock(emit, { type: 'thinking', thinking: '' });
        emit(
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: thinkingIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          }),
        );
      }
      if (typeof delta.content === 'string' && delta.content.length) {
        if (firstText) {
          firstText = false;
          meta.onFirstContent?.();
        }
        if (textIndex < 0) textIndex = openBlock(emit, { type: 'text', text: '' });
        emit(
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text_delta', text: delta.content },
          }),
        );
      }
      for (const tc of delta.tool_calls || []) {
        const oi = tc.index ?? 0;
        let idx = toolBlocks.get(oi);
        if (idx === undefined) {
          idx = openBlock(emit, { type: 'tool_use', id: tc.id || `toolu_${oi}`, name: tc.function?.name || '', input: {} });
          toolBlocks.set(oi, idx);
        }
        if (tc.function?.arguments) {
          emit(
            sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: idx,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            }),
          );
        }
      }
      if (choice.finish_reason) stopReason = finishToStopReason(choice.finish_reason);
    },
    (emit) => {
      if (!started) {
        emit(
          sseEvent('message_start', {
            type: 'message_start',
            message: { id: msgId, type: 'message', role: 'assistant', content: [], model: meta.publicName, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
          }),
        );
      }
      for (let i = 0; i < blockCount; i++) {
        emit(sseEvent('content_block_stop', { type: 'content_block_stop', index: i }));
      }
      emit(
        sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
          usage: { input_tokens: meta.usage.promptTokens, output_tokens: meta.usage.completionTokens },
        }),
      );
      emit(sseEvent('message_stop', { type: 'message_stop' }));
    },
    undefined,
  );
}
