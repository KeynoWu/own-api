/**
 * OpenAI Chat Completions <-> Anthropic Messages 双向协议转换。
 * 覆盖三条路径：请求体、非流式响应体、SSE 流（含 usage 提取）。
 */
import type { Protocol } from './types.ts';

// ---------------------------------------------------------------- 工具

function isTextContent(c: any): c is string {
  return typeof c === 'string';
}

function safeJsonParse(s: any): any {
  if (s == null) return {};
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function splitDataUrl(url: string) {
  const m = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(url);
  if (!m) return undefined;
  return { mediaType: m[1], data: m[2] };
}

export function stopReasonToFinish(r: string | null | undefined): string | null {
  switch (r) {
    case 'end_turn':
      return 'stop';
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case 'pause_turn':
      return null;
    default:
      return r ?? null;
  }
}

export function finishToStopReason(r: string | null | undefined): string | null {
  switch (r) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    case null:
    case undefined:
      return null;
    default:
      return 'end_turn';
  }
}

// ---------------------------------------------------------------- 请求：OpenAI -> Anthropic

export function openaiToAnthropicRequest(body: any, opts: { upstreamModel: string; defaultMaxTokens?: number }): any {
  const system: any[] = [];
  const messages: any[] = [];

  for (const msg of body.messages || []) {
    const role = msg.role;
    if (role === 'system' || role === 'developer') {
      const text = isTextContent(msg.content)
        ? msg.content
        : (msg.content || []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
      if (text) system.push({ type: 'text', text });
      continue;
    }

    if (role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: isTextContent(msg.content) ? msg.content : JSON.stringify(msg.content),
          },
        ],
      });
      continue;
    }

    if (role === 'user') {
      messages.push({ role: 'user', content: openaiContentToAnthropic(msg.content) });
      continue;
    }

    // assistant（可能带 tool_calls）
    const blocks: any[] = [];
    const text = isTextContent(msg.content)
      ? msg.content
      : (msg.content || []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
    if (text) blocks.push({ type: 'text', text });
    for (const tc of msg.tool_calls || []) {
      blocks.push({
        type: 'tool_use',
        id: tc.id || `toolu_${Math.random().toString(36).slice(2, 12)}`,
        name: tc.function?.name,
        input: safeJsonParse(tc.function?.arguments),
      });
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '' });
    messages.push({ role: 'assistant', content: blocks });
  }

  // 丢掉没有配对 tool_use 的 tool_result（客户端重放/截断历史时很常见，
  // 原样发出会让 Anthropic 报 "unexpected tool_use_id"）
  const knownToolIds = new Set<string>();
  for (const m of messages) {
    for (const b of m.content || []) if (b.type === 'tool_use' && b.id) knownToolIds.add(b.id);
  }
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    const kept = m.content.filter((b: any) => b.type !== 'tool_result' || knownToolIds.has(b.tool_use_id));
    m.content = kept.length ? kept : [{ type: 'text', text: '' }];
  }

  // Anthropic 要求相邻同角色需合并
  const merged = mergeAdjacent(messages.filter((m) => (m.content || []).length));
  if (!merged.length) merged.push({ role: 'user', content: [{ type: 'text', text: ' ' }] });

  applyResponseFormatFallback(body, system);

  const out: any = {
    model: opts.upstreamModel,
    messages: merged,
    max_tokens: Number(body.max_tokens) || Number(body.max_completion_tokens) || opts.defaultMaxTokens || 8192,
  };
  if (system.length) out.system = system.length === 1 ? system[0].text : system;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream) out.stream = true;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t: any) => t?.function?.name)
      .map((t: any) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      }));
  }
  const tc = body.tool_choice;
  if (tc && out.tools) {
    if (tc === 'auto') out.tool_choice = { type: 'auto' };
    else if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc === 'none') delete out.tool_choice;
    else if (typeof tc === 'object' && tc.function?.name) out.tool_choice = { type: 'tool', name: tc.function.name };
  }

  // 扩展思考 / 缓存等字段透传（存在才带）
  for (const k of ['metadata', 'top_k']) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

/**
 * 跨协议时被丢弃的参数收集成告警，随响应头回给客户端。
 * 静默降级（比如 JSON 模式变成自由文本）比报错更难排查。
 */
export function collectDropWarnings(body: any, targetProtocol: Protocol): string[] {
  const w: string[] = [];
  if (targetProtocol === 'anthropic') {
    if (body.response_format?.type && body.response_format.type !== 'text') {
      w.push(`response_format=${body.response_format.type} 不被上游协议支持，已降级为 system 指令提示`);
    }
    if (Number(body.n) > 1) w.push(`n=${body.n} 不被上游协议支持，仅返回 1 个 choice`);
    if (body.logprobs || body.top_logprobs) w.push('logprobs 不被上游协议支持，已忽略');
    if (body.frequency_penalty || body.presence_penalty) w.push('frequency_penalty / presence_penalty 不被上游协议支持，已忽略');
  } else if (targetProtocol === 'openai') {
    if (JSON.stringify(body).includes('cache_control')) w.push('cache_control 断点无法映射到 OpenAI 协议，缓存计费会受影响');
    if (body.thinking) w.push('thinking（扩展思考）不被 OpenAI 协议支持，已忽略');
    if (body.top_k !== undefined) w.push('top_k 不被 OpenAI 协议支持，已忽略');
    if (body.metadata) w.push('metadata 不被 OpenAI 协议支持，已忽略');
    if (body.service_tier) w.push('service_tier 不被 OpenAI 协议支持，已忽略');
    if (body.tool_choice?.type === 'none') w.push('tool_choice=none 无法表达进 OpenAI 协议，已移除（模型可能仍产生工具调用）');
  }
  return w;
}

/** response_format 的语义降级：把约束并进 system */
function applyResponseFormatFallback(body: any, system: any[]) {
  const rf = body.response_format;
  if (!rf || !rf.type || rf.type === 'text') return;
  let hint = 'Respond with a single valid JSON object and nothing else.';
  if (rf.type === 'json_schema' && rf.json_schema?.schema) {
    hint = `Respond with a single valid JSON object matching this JSON Schema and nothing else: ${JSON.stringify(rf.json_schema.schema)}`;
  }
  system.push({ type: 'text', text: hint });
}

function openaiContentToAnthropic(content: any): any[] {
  if (isTextContent(content)) return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content ?? '') }];
  const blocks: any[] = [];
  for (const part of content) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const url = part.image_url?.url || '';
      const data = splitDataUrl(url);
      blocks.push({
        type: 'image',
        source: data
          ? { type: 'base64', media_type: data.mediaType, data: data.data }
          : { type: 'url', url },
      });
    } else if (part.type === 'input_audio') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: `audio/${part.input_audio?.format || 'mp3'}`, data: part.input_audio?.data },
      });
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

function mergeAdjacent(messages: any[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = [...(Array.isArray(prev.content) ? prev.content : []), ...(Array.isArray(m.content) ? m.content : [])];
    } else out.push({ ...m });
  }
  // Anthropic 要求首条为 user。OpenAI 允许用 assistant 轮做"预填充"，
  // 直接 shift 会静默丢内容——改为在最前面补一条占位 user，把预填充保住。
  if (out.length && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue from the last assistant message)' }] });
  }
  return out;
}

// ---------------------------------------------------------------- 请求：Anthropic -> OpenAI

export function anthropicToOpenaiRequest(body: any, opts: { upstreamModel: string; defaultMaxTokens?: number }): any {
  const messages: any[] = [];
  const sys = body.system;
  if (sys) {
    const text = Array.isArray(sys) ? sys.map((s: any) => (typeof s === 'string' ? s : s.text)).join('\n') : String(sys);
    if (text) messages.push({ role: 'system', content: text });
  }

  for (const msg of body.messages || []) {
    const role = msg.role;
    const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content ?? '') }];
    const texts: string[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];

    for (const p of parts) {
      if (!p || typeof p === 'string') {
        texts.push(p as string);
      } else if (p.type === 'text') texts.push(p.text);
      else if (p.type === 'image') {
        const src = p.source || {};
        const mediaType = src.media_type || 'application/octet-stream';
        const url = src.type === 'url' ? src.url : `data:${mediaType};base64,${src.data ?? ''}`;
        texts.push('');
        (msg as any).__images ||= [];
        (msg as any).__images.push({ type: 'image_url', image_url: { url } });
      } else if (p.type === 'tool_use') {
        toolCalls.push({
          id: p.id,
          type: 'function',
          function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
        });
      } else if (p.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: p.tool_use_id,
          content: Array.isArray(p.content)
            ? p.content.map((c: any) => c.text ?? '').join('')
            : String(p.content ?? ''),
        });
      }
    }

    for (const tr of toolResults) messages.push(tr);
    const content = texts.filter(Boolean).join('\n');
    if (role === 'assistant') {
      const m: any = { role: 'assistant', content: content || (toolCalls.length ? '' : '') };
      if (toolCalls.length) m.tool_calls = toolCalls;
      messages.push(m);
    } else if (toolCalls.length || content || (msg as any).__images) {
      messages.push({
        role: 'user',
        content: (msg as any).__images?.length ? [{ type: 'text', text: content }, ...(msg as any).__images] : content,
      });
    }
  }

  const out: any = {
    model: opts.upstreamModel,
    messages,
    max_tokens: Number(body.max_tokens) || opts.defaultMaxTokens || 8192,
  };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.stream) out.stream = true;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: any) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  const tc = body.tool_choice;
  if (tc) {
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  return out;
}

// ---------------------------------------------------------------- 响应：Anthropic -> OpenAI（非流式）

export function anthropicToOpenaiResponse(raw: any, publicName: string): any {
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  const toolCalls = blocks
    .filter((b: any) => b.type === 'tool_use')
    .map((b: any, i: number) => ({
      id: b.id || `call_${i}`,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
  const thinking = blocks.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking).join('');

  const u = usageFromAnthropic(raw.usage) as Usage;
  return {
    id: raw.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: publicName,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || (toolCalls.length ? null : ''),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(thinking ? { reasoning_content: thinking } : {}),
        },
        finish_reason: stopReasonToFinish(raw.stop_reason) || 'stop',
      },
    ],
    usage: {
      prompt_tokens: u.promptTokens,
      completion_tokens: u.completionTokens,
      total_tokens: u.promptTokens + u.completionTokens,
      prompt_tokens_details: { cached_tokens: u.cacheReadTokens },
      cache_creation_input_tokens: u.cacheWriteTokens,
    },
  };
}

// ---------------------------------------------------------------- 响应：OpenAI -> Anthropic（非流式）

export function openaiToAnthropicResponse(raw: any, publicName: string): any {
  const choice = raw.choices?.[0] || {};
  const msg = choice.message || {};
  const content: any[] = [];
  if (msg.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content });
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function?.name,
      input: safeJsonParse(tc.function?.arguments),
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  // Anthropic 口径：input_tokens **不含**缓存部分（与文件底部 usageFromAnthropic 的归一互为逆运算）。
  // 直接把含缓存的 prompt_tokens 填进 input_tokens，Anthropic 客户端求和会双算缓存。
  const un = usageFromOpenai(raw.usage);
  const cacheRead = un.cacheReadTokens || 0;
  const cacheWrite = un.cacheWriteTokens || 0;
  return {
    id: (raw.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, 'msg_'),
    type: 'message',
    role: 'assistant',
    model: publicName,
    content,
    stop_reason: finishToStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (un.promptTokens || 0) - cacheRead - cacheWrite),
      output_tokens: un.completionTokens || 0,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
    },
  };
}

// ---------------------------------------------------------------- Usage 结构

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function usageFromOpenai(u: any): Partial<Usage> {
  if (!u) return {};
  return {
    promptTokens: u.prompt_tokens || 0,
    completionTokens: u.completion_tokens || 0,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens || u.cache_read_input_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || u.prompt_tokens_details?.cache_write_tokens || 0,
  };
}

/**
 * Anthropic 的 input_tokens **不含**缓存部分，OpenAI 的 prompt_tokens **含**缓存部分。
 * 统一成 OpenAI 口径（promptTokens = 含缓存的总输入），否则 computeCost 的减法
 * 会把 Anthropic 的缓存 token 重复扣掉，实测少算 43%。
 */
export function usageFromAnthropic(u: any): Partial<Usage> {
  if (!u) return {};
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  return {
    promptTokens: (u.input_tokens || 0) + cacheRead + cacheWrite,
    completionTokens: u.output_tokens || 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

export function mergeUsage(target: Usage, patch: Partial<Usage>) {
  // Anthropic 流式里 message_delta 的 input_tokens 是最终值，直接覆盖非零值
  for (const k of ['promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const v = patch[k];
    if (typeof v === 'number' && v > 0) target[k] = v;
  }
  return target;
}


// ---------------------------------------------------------------- Legacy /v1/completions

/**
 * legacy text-completions 请求 -> chat 请求。
 * 入口声明了就要能用：直接把 {prompt} 转给 /chat/completions 会被上游 400。
 */
export function legacyToChatRequest(body: any): any {
  const out: any = { ...body };
  delete out.prompt;
  delete out.suffix;
  delete out.best_of;
  delete out.echo;
  const prompt = body.prompt;
  const content = Array.isArray(prompt)
    ? prompt.map((p: any) => String(p ?? '')).join('\n')
    : typeof prompt === 'string'
      ? prompt
      : '';
  const messages = Array.isArray(body.messages) && body.messages.length ? body.messages : undefined;
  out.messages = messages || [{ role: 'user', content }];
  if (body.max_tokens !== undefined && out.max_completion_tokens === undefined) out.max_completion_tokens = body.max_tokens;
  return out;
}

/** chat 响应 -> legacy text_completion 响应 */
export function chatResponseToLegacy(json: any): any {
  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};
  return {
    id: json.id,
    object: 'text_completion',
    created: json.created,
    model: json.model,
    choices: [{ index: 0, text: typeof msg.content === 'string' ? msg.content : '', logprobs: null, finish_reason: choice.finish_reason || 'stop' }],
    usage: json.usage,
  };
}
