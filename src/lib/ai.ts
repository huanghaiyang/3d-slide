import type { Deck } from '../types';
import { buildWorkspaceSnapshot } from './snapshot';

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 自动执行模型返回的工具调用，直接把创意落到画布 */
  autoApply: boolean;
  /** 随请求发送画板文字内容 */
  includeText: boolean;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type AiChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: AiToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface AiToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AiChatResult {
  content: string;
  toolCalls: AiToolCall[];
}

const CONFIG_KEY = '3d-slide:ai-config';

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  autoApply: true,
  includeText: false,
};

/** 配置只保存在浏览器本地，绝不进入工程文件、快照或 MCP 数据 */
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

export function saveAiConfig(config: AiConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function clearAiConfig() {
  try {
    localStorage.removeItem(CONFIG_KEY);
  } catch {
    // ignore
  }
}

function endpointOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('请填写 API 基础地址');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

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

async function postChat(
  config: AiConfig,
  messages: AiChatMessage[],
  tools: AiToolDef[] | null,
  signal?: AbortSignal,
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
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
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

/** OpenAI 兼容的 Chat Completions 调用 */
export async function chatCompletion(
  config: AiConfig,
  messages: AiChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await postChat(config, messages, null, signal);
  if (result.content) return result.content;
  throw new Error('模型返回了空结果，请检查模型名称或接口地址');
}

/** 带工具调用的对话：模型可以返回多个 function call，由调用方执行后回填结果 */
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

export const AI_SYSTEM_PROMPT = [
  '你是 3d-slide 的创作助手。3d-slide 是一个把文字、图片、视频、音频、SVG、3D 模型、Lottie 放进同一个三维空间，并用视点取景做演示的本地优先工具。',
  '你可以直接修改画布：通过工具调用添加文字/形状/资源、调整对象、删除对象、修改作品设置与创建视点。用户提出创作需求时，先规划画面构图，然后实际调用工具落地，而不是只给文字建议。',
  '位置参数：anchor 表示对象在画面中的位置（center / top / bottom / left / right / top-left / top-right / bottom-left / bottom-right / left-third / right-third）；dx、dy 是相对画面宽高的百分比偏移（dx 正数向右，dy 正数向下）。不需要计算世界坐标。',
  '建议流程：需要素材时先调用 list_assets；一次可以连续调用多个工具；添加完成后可调用 get_deck_state 检查结果；最后用简体中文用一两句话说明改了什么、怎样预览。',
  '约束：不要请求或输出密钥、令牌、密码；不要编造画布中不存在的资源；文本保持简洁；对象总数不超过 200；不要重复添加同一内容。',
].join('\n');

/** 发送给模型的作品上下文：结构 + 可选文本内容，全部经过脱敏 */
export function buildDeckContext(deck: Deck, includeText: boolean): string {
  const snapshot = buildWorkspaceSnapshot([deck], [], [], { includeText });
  const data = snapshot.decks[0];
  return `当前作品结构（JSON）：\n${JSON.stringify(data, null, 2)}`;
}
