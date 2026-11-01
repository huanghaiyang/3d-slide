import type { Deck } from '../types';
import { buildWorkspaceSnapshot } from './snapshot';

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const CONFIG_KEY = '3d-slide:ai-config';

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
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

/** OpenAI 兼容的 Chat Completions 调用 */
export async function chatCompletion(
  config: AiConfig,
  messages: AiMessage[],
  signal?: AbortSignal,
): Promise<string> {
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
  const content =
    payload && typeof payload === 'object'
      ? (payload as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content
      : null;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
    if (joined.trim()) return joined.trim();
  }
  throw new Error('模型返回了空结果，请检查模型名称或接口地址');
}

export const AI_SYSTEM_PROMPT = [
  '你是 3d-slide 的创作助手。3d-slide 是一个把文字、图片、视频、音频、SVG、3D 模型放进同一个三维空间，并用视点取景做演示的本地优先工具。',
  '下面会附上当前作品的结构快照（已脱敏：不含资源文件内容、不含任何 API Key 或令牌）。',
  '请基于这份结构给出可执行的创作建议、视点编排、空间布局或对象参数调整方案。',
  '规则：不要请求或输出密钥、令牌、密码等敏感信息；不要编造快照中不存在的内容；回答使用简体中文，简洁、分点。',
].join('\n');

/** 发送给模型的作品上下文：结构 + 可选文本内容，全部经过脱敏 */
export function buildDeckContext(deck: Deck, includeText: boolean): string {
  const snapshot = buildWorkspaceSnapshot([deck], [], [], { includeText });
  const data = snapshot.decks[0];
  return `当前作品结构（JSON）：\n${JSON.stringify(data, null, 2)}`;
}
