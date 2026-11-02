/**
 * ai.ts —— OpenAI 兼容的 AI 调用封装
 *
 * 职责：
 * - 管理 AI 配置（接口地址、模型名、API Key、是否自动执行工具、是否发送文字内容），
 *   配置只保存在 localStorage，绝不进入工程文件 / 快照 / MCP 数据；
 * - 封装 Chat Completions 请求（普通对话与带 tools 的对话），兼容非流式响应格式；
 * - 解析模型返回的 content 与 tool_calls，供上层执行工具后回填结果；
 * - 探测服务是否支持 function calling，不支持时退化为纯文字建议；
 * - 提供系统提示词与「当前作品结构」上下文构建。
 *
 * 关键概念：
 * - 协议为 OpenAI Chat Completions（POST {baseUrl}/chat/completions）；
 * - tool_calls 的 arguments 是 JSON 字符串，需由调用方解析后交给 aiTools.executeAiTool；
 * - 所有请求都支持 AbortSignal，便于用户取消正在进行的生成；
 * - 错误统一抛出 Error，message 尽量包含服务端返回的 error.message。
 *
 * 安全约定：API Key 仅通过 Authorization 头发送，不做日志输出，也不写入任何导出数据。
 */

import type { Deck } from '../types';
import { buildWorkspaceSnapshot } from './snapshot';

/** AI 服务配置；保存在 localStorage，不随作品导出。 */
export interface AiConfig {
  /** 接口基础地址，例如 https://api.openai.com/v1。 */
  baseUrl: string;
  /** 模型名称，例如 gpt-4o-mini。 */
  model: string;
  /** API Key；为空时不发送 Authorization 头（适用于本地代理）。 */
  apiKey: string;
  /** 自动执行模型返回的工具调用，直接把创意落到画布 */
  autoApply: boolean;
  /** 随请求发送画板文字内容 */
  includeText: boolean;
}

/** 模型返回的一次工具调用（arguments 仍是未解析的 JSON 字符串）。 */
export interface AiToolCall {
  /** 调用 id，回填工具结果时需要原样带回 tool_call_id。 */
  id: string;
  /** 工具名，对应 AI_TOOLS 中的 function.name。 */
  name: string;
  /** 参数字符串（JSON），需 JSON.parse 后再使用。 */
  arguments: string;
}

/**
 * 对话消息，按角色区分：
 * - system / user：纯文本；
 * - assistant：可带 tool_calls（模型请求执行工具）；
 * - tool：工具执行结果，必须用 tool_call_id 关联到具体调用。
 */
export type AiChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: AiToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

/** OpenAI function calling 的工具定义结构。 */
export interface AiToolDef {
  /** 固定为 function。 */
  type: 'function';
  function: {
    /** 工具名，执行时按此匹配。 */
    name: string;
    /** 给模型看的用途说明。 */
    description: string;
    /** JSON Schema 参数定义。 */
    parameters: Record<string, unknown>;
  };
}

/** 一次模型响应的解析结果：文本内容 + 工具调用列表（可能同时为空）。 */
export interface AiChatResult {
  /** 模型输出的文本（已 trim）；没有时为空字符串。 */
  content: string;
  /** 模型请求执行的工具调用；没有时为空数组。 */
  toolCalls: AiToolCall[];
}

/** localStorage 中保存 AI 配置的 key。 */
const CONFIG_KEY = '3d-slide:ai-config';

/** 默认 AI 配置：OpenAI 官方地址 + gpt-4o-mini，不发送文字内容，自动执行工具。 */
export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  autoApply: true,
  includeText: false,
};

/** 配置只保存在浏览器本地，绝不进入工程文件、快照或 MCP 数据 */
/**
 * 读取本地 AI 配置。
 *
 * @returns 完整配置；未保存过、JSON 损坏或字段类型异常时，对应字段回退默认值
 *
 * 逐字段校验而非整体信任，避免旧版本配置缺字段导致运行时出现 undefined。
 */
export function loadAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_AI_CONFIG };
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : DEFAULT_AI_CONFIG.baseUrl,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_AI_CONFIG.model,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      autoApply: typeof parsed.autoApply === 'boolean' ? parsed.autoApply : DEFAULT_AI_CONFIG.autoApply,
      includeText: typeof parsed.includeText === 'boolean' ? parsed.includeText : DEFAULT_AI_CONFIG.includeText,
    };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}

/**
 * 保存 AI 配置到 localStorage。
 *
 * @param config 完整配置
 * @throws localStorage 写入失败（配额满 / 隐私模式）时抛出，由设置面板提示
 */
export function saveAiConfig(config: AiConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

/**
 * 清除本地 AI 配置（恢复默认值）。
 * localStorage 不可用时静默忽略。
 */
export function clearAiConfig() {
  try {
    localStorage.removeItem(CONFIG_KEY);
  } catch {
    // ignore
  }
}

/**
 * 拼出完整的 Chat Completions 接口地址。
 *
 * @param baseUrl 用户填写的地址，可带或不带末尾斜杠
 * @returns 完整 URL；若用户已填写到 /chat/completions 则原样使用
 * @throws 地址为空时抛出「请填写 API 基础地址」
 */
function endpointOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('请填写 API 基础地址');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/**
 * 兼容两种 content 格式：纯字符串，或多段内容数组（每段可能有 text 字段）。
 *
 * @param content 服务端返回的 message.content
 * @returns 拼接并 trim 后的文本；无法识别时返回空字符串
 */
function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
      .trim();
  }
  return '';
}

/**
 * 把服务端返回的 tool_calls 规范化为内部结构。
 *
 * @param raw message.tool_calls 原始数组
 * @returns 过滤掉无名调用后的结果；arguments 统一成字符串（对象则 JSON.stringify）
 *
 * id 缺失时用 `call_${index}` 兜底，保证回填结果时仍有可用的关联键。
 * 部分服务把 arguments 直接返回为对象，这里不会因此丢弃该调用。
 */
function normalizeToolCalls(raw: unknown): AiToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: AiToolCall[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const record = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof record.function?.name === 'string' ? record.function.name : '';
    if (!name) return;
    const args = record.function?.arguments;
    calls.push({
      id: typeof record.id === 'string' && record.id ? record.id : `call_${index}`,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    });
  });
  return calls;
}

/**
 * 发起一次非流式 Chat Completions 请求。
 *
 * @param config      AI 配置
 * @param messages    对话消息
 * @param tools       工具定义；null 表示本次不启用工具
 * @param signal      取消信号
 * @param toolChoice  工具选择策略，默认 'auto'；探测能力时传强制指定某个工具
 * @returns 解析后的 content 与 toolCalls
 * @throws 模型名为空、网络错误、HTTP 非 2xx（含服务端 error.message）时抛出
 *
 * 实现要点：
 * - 先读取 response.text() 再自行 JSON.parse，兼容网关返回空 body 或非 JSON 的错误页；
 * - API Key 为空时不发送 Authorization 头，方便用户接本地代理；
 * - 固定 temperature 0.3、stream false，保证结果稳定且便于一次性解析。
 */
async function postChat(
  config: AiConfig,
  messages: AiChatMessage[],
  tools: AiToolDef[] | null,
  signal?: AbortSignal,
  toolChoice?: unknown,
): Promise<AiChatResult> {
  if (!config.model.trim()) throw new Error('请填写模型名称');
  const response = await fetch(endpointOf(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
    },
    body: JSON.stringify({
      model: config.model.trim(),
      messages,
      temperature: 0.3,
      stream: false,
      ...(tools && tools.length > 0 ? { tools, tool_choice: toolChoice ?? 'auto' } : {}),
    }),
    signal,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && payload !== null
        ? ((payload as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
    throw new Error(`模型请求失败：${message}`);
  }
  const message =
    payload && typeof payload === 'object'
      ? (payload as { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] }).choices?.[0]?.message
      : null;
  return {
    content: normalizeContent(message?.content),
    toolCalls: normalizeToolCalls(message?.tool_calls),
  };
}

/**
 * OpenAI 兼容的 Chat Completions 调用
 *
 * @param config    AI 配置
 * @param messages  对话消息
 * @param signal    取消信号
 * @returns 模型文本
 * @throws 请求失败或模型返回空内容时抛出
 *
 * 适用于不需要工具调用的纯文本场景（例如让模型解释某个操作）。
 */
export async function chatCompletion(
  config: AiConfig,
  messages: AiChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await postChat(config, messages, null, signal);
  if (result.content) return result.content;
  throw new Error('模型返回了空结果，请检查模型名称或接口地址');
}

/**
 * 带工具调用的对话：模型可以返回多个 function call，由调用方执行后回填结果
 *
 * @param config    AI 配置
 * @param messages  对话消息（通常最后一条是用户需求）
 * @param tools     可用工具列表
 * @param signal    取消信号
 * @returns content 与 toolCalls（至少有一项非空）
 * @throws 两次请求都失败或仍返回空结果时抛出
 *
 * 兼容性降级：若错误信息命中 tool / function / unsupported 之类关键词，说明服务端
 * 不支持 function calling，此时自动退回不带工具的普通对话，至少还能给出文字建议。
 */
export async function chatCompletionWithTools(
  config: AiConfig,
  messages: AiChatMessage[],
  tools: AiToolDef[],
  signal?: AbortSignal,
): Promise<AiChatResult> {
  try {
    const result = await postChat(config, messages, tools, signal);
    if (result.content || result.toolCalls.length > 0) return result;
    throw new Error('模型返回了空结果，请检查模型名称或接口地址');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/tool|function|unsupported|not support/i.test(message)) {
      // 兼容不支持工具调用的服务：退回普通对话，仍能给出方案建议
      const fallback = await postChat(config, messages, null, signal);
      return { content: fallback.content, toolCalls: [] };
    }
    throw error;
  }
}

/**
 * 检测服务是否支持 function/tool calling：自动化创作的地基
 *
 * @param config AI 配置
 * @param tools  已注册的工具列表
 * @param signal 取消信号
 * @returns ok 表示服务确实返回了 tool_calls；message 为可读结论或失败原因
 *
 * 实现方式：优先选择 get_deck_state（只读、无副作用），通过 tool_choice 强制模型调用它；
 * 只要有 toolCalls 即视为支持。任何异常都转成 ok=false，不向调用方抛出。
 */
export async function probeToolSupport(
  config: AiConfig,
  tools: AiToolDef[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  const target = tools.find((tool) => tool.function.name === 'get_deck_state') ?? tools[0];
  if (!target) return { ok: false, message: '没有可用的工具定义' };
  try {
    const result = await postChat(
      config,
      [{ role: 'user', content: '请调用 get_deck_state 工具读取当前作品结构，不要输出其他内容。' }],
      tools,
      signal,
      { type: 'function', function: { name: target.function.name } },
    );
    if (result.toolCalls.length > 0) {
      return { ok: true, message: `工具调用可用（${result.toolCalls.map((call) => call.name).join('、')}）` };
    }
    return { ok: false, message: '模型没有返回工具调用，可能不支持 function calling，将退化为文字建议' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '工具能力检测失败' };
  }
}

/**
 * 创作助手的系统提示词。
 *
 * 内容要点：说明产品形态（3D 空间 + 视点取景）、授权模型直接改画布、
 * 约定 anchor / dx / dy 的位置语义、给出推荐流程（先查资源、连续调用、最后检查）、
 * 并列出安全与规模约束（不输出密钥、不编造资源、对象数上限 200）。
 *
 * 以数组 join('\n') 的形式书写，便于逐条维护。
 */
export const AI_SYSTEM_PROMPT = [
  '你是 3d-slide 的创作助手。3d-slide 是一个把文字、图片、视频、音频、SVG、3D 模型、Lottie 放进同一个三维空间，并用视点取景做演示的本地优先工具。',
  '你可以直接修改画布：通过工具调用添加文字/形状/资源、调整对象、删除对象、修改作品设置与创建视点。用户提出创作需求时，先规划画面构图，然后实际调用工具落地，而不是只给文字建议。',
  '位置参数：anchor 表示对象在画面中的位置（center / top / bottom / left / right / top-left / top-right / bottom-left / bottom-right / left-third / right-third）；dx、dy 是相对画面宽高的百分比偏移（dx 正数向右，dy 正数向下）。不需要计算世界坐标。',
  '建议流程：需要素材时先调用 list_assets；一次可以连续调用多个工具；添加完成后可调用 get_deck_state 检查结果；最后用简体中文用一两句话说明改了什么、怎样预览。',
  '约束：不要请求或输出密钥、令牌、密码；不要编造画布中不存在的资源；文本保持简洁；对象总数不超过 200；不要重复添加同一内容。',
].join('\n');

/**
 * 发送给模型的作品上下文：结构 + 可选文本内容，全部经过脱敏
 *
 * @param deck        当前作品
 * @param includeText 是否包含画板文字内容
 * @returns 带说明前缀的 JSON 字符串（2 空格缩进便于模型阅读）
 *
 * 复用 buildWorkspaceSnapshot 的白名单投影与脱敏逻辑：资源 src、缩略图、
 * 密钥字段都不会进入上下文；只传一个作品，因此直接取 decks[0]。
 */
export function buildDeckContext(deck: Deck, includeText: boolean): string {
  const snapshot = buildWorkspaceSnapshot([deck], [], [], { includeText });
  const data = snapshot.decks[0];
  return `当前作品结构（JSON）：\n${JSON.stringify(data, null, 2)}`;
}
