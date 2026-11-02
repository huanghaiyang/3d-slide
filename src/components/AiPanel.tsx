/**
 * AiPanel.tsx —— AI 创作助手侧边抽屉
 *
 * 组件职责：
 * - 提供一个自然语言对话入口，让模型读写当前画布：添加文字、形状、素材、视点，
 *   或调整已有对象；
 * - 维护「对话条目（entries）」与「模型消息历史（messages）」两套数据：
 *   前者用于界面展示（含工具执行结果与错误），后者用于下一轮请求的上下文；
 * - 把模型返回的 function call（工具调用）交给 lib/aiTools 执行，并把执行结果
 *   作为 tool 消息回填，支持最多 MAX_ROUNDS 轮「模型 -> 工具 -> 模型」循环；
 * - 支持「确认后执行」与「自动执行」两种模式，并提供撤销本轮改动的能力；
 * - 支持导入外部 JSON 创作方案（applyDeckPlan），以及刷新后恢复最近一次会话。
 *
 * 主要交互：
 * - Enter 发送、Shift+Enter 换行（输入法组词期间不误发）；
 * - 待执行操作需先「应用到画布」或「放弃」，期间禁止继续发送；
 * - 请求使用 AbortController 支持中途停止；
 * - 「撤销本轮」根据本轮开始时的历史栈长度连续 undo，回退本轮所有改动。
 *
 * 与其他模块的关系：
 * - 模型配置与请求封装在 lib/ai，工具定义与执行在 lib/aiTools；
 * - 所有画布改动都通过 lib/aiTools -> store/deckStore 完成；
 * - 设置弹窗复用 AiSettings，确认弹窗复用 ui 中的 ConfirmDialog。
 *
 * 说明：当前接口以 stream:false 请求，模型回复是整段返回后一次性展示，
 * 不做逐字流式追加；执行工具时通过 progress 文案实时提示正在进行的步骤。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Deck } from '../types';
import {
  AI_SYSTEM_PROMPT,
  buildDeckContext,
  chatCompletionWithTools,
  loadAiConfig,
  saveAiConfig,
  type AiChatMessage,
  type AiConfig,
  type AiToolCall,
} from '../lib/ai';
import { AI_TOOLS, applyDeckPlan, executeAiTool } from '../lib/aiTools';
import { useDeckStore } from '../store/deckStore';
import { toast } from '../store/uiStore';
import { Icon } from './Icon';
import { AiSettings } from './AiSettings';
import { ConfirmDialog } from './ui';

interface AiPanelProps {
  /** 当前作品；用于构造系统提示中的画板上下文，并在切换作品时区分会话缓存。 */
  deck: Deck;
  /** 关闭抽屉（Esc 或点击遮罩 / 关闭按钮触发）。 */
  onClose: () => void;
}

/**
 * 界面上的一条对话记录。
 * role 决定样式与图标：user 用户输入、assistant 模型回复、
 * tool 工具执行成功摘要、error 工具或请求失败信息。
 */
interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
}

/**
 * 等待用户确认执行的工具调用。
 * messages 保存「已包含 assistant(tool_calls)」的历史，确认后继续回填工具结果，
 * 保证对话历史结构符合 OpenAI 工具调用协议。
 */
interface PendingState {
  calls: AiToolCall[];
  messages: AiChatMessage[];
}

/** 会话缓存的完整内容：界面条目 + 模型消息历史。 */
interface ChatSession {
  entries: ChatEntry[];
  messages: AiChatMessage[];
}

// 空状态展示的示例提示词，点击后填入输入框，降低首次使用门槛
const SUGGESTIONS = [
  '做一页深色科技封面：标题居中、副标题在下方，再放一张资源库里的图片',
  '把当前画布整理成 3 个运镜视点，从全景推进到主体特写',
  '用 3D 文字做标题，并加一些简单的几何装饰',
];

// 单次请求内「模型 -> 工具 -> 模型」的最大轮数，防止工具调用陷入死循环
const MAX_ROUNDS = 6;
// 界面最多保留的对话条目数，超出时丢弃最旧的部分
const MAX_ENTRIES = 80;
// 发送给模型的历史消息上限，避免上下文无限增长导致费用与截断问题
const MAX_MESSAGES = 24;
// sessionStorage 中按作品 id 隔离的会话缓存前缀
const SESSION_PREFIX = '3d-slide:ai-chat:';

/** 生成对话条目 id；优先使用 crypto.randomUUID，旧环境退化为随机字符串。 */
function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ai-${Math.random().toString(36).slice(2)}`;
}

/**
 * 判断异常是否来自主动中止（AbortController.abort）。
 * 中止属于用户正常取消，不应作为错误条目展示。
 * 同时兼容 DOMException 与普通对象的 name 字段（不同浏览器的实现差异）。
 */
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AbortError')
  );
}

/**
 * 生成工具调用的一行摘要，用于待执行列表与进度提示。
 * 参数是 JSON 字符串，解析失败时只显示工具名；解析成功则取最常见的
 * 文本 / 形状 / 资源 / 名称字段，截断到 24 个字符。
 */
function summarizeCall(call: AiToolCall): string {
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    const detail =
      args.text ?? args.shape ?? args.asset ?? args.name ?? args.title ?? '';
    return detail ? `${call.name} · ${String(detail).slice(0, 24)}` : call.name;
  } catch {
    return call.name;
  }
}

/**
 * 规范化消息历史，保证其可被下一轮请求安全使用。
 *
 * 两步处理：
 * 1. 若最后一条是带有 tool_calls 但没有对应 tool 响应的 assistant 消息，直接丢弃；
 *    否则 OpenAI 兼容接口会因「工具调用缺少结果」而拒绝整段历史。
 * 2. 历史超过 MAX_MESSAGES 时，从最近的 user 消息处开始截断，
 *    避免把问答切在工具调用中间。
 */
function trimMessages(messages: AiChatMessage[]): AiChatMessage[] {
  let list = messages;
  const last = list[list.length - 1];
  if (last && last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
    list = list.slice(0, -1);
  }
  if (list.length <= MAX_MESSAGES) return list;
  let start = list.length - MAX_MESSAGES;
  while (start < list.length && list[start].role !== 'user') start += 1;
  return start < list.length ? list.slice(start) : list.slice(list.length - MAX_MESSAGES);
}

/**
 * 从 sessionStorage 读取指定作品的会话。
 * 解析后的数据会做结构与角色白名单校验，避免脏数据导致渲染异常；
 * 条目与消息都会按上限裁剪，读取失败时返回空会话。
 */
function loadSession(deckId: string): ChatSession {
  const empty: ChatSession = { entries: [], messages: [] };
  try {
    const raw = sessionStorage.getItem(`${SESSION_PREFIX}${deckId}`);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<ChatSession>;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter(
          (entry): entry is ChatEntry =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            typeof (entry as ChatEntry).id === 'string' &&
            ['user', 'assistant', 'tool', 'error'].includes((entry as ChatEntry).role) &&
            typeof (entry as ChatEntry).text === 'string',
        )
      : [];
    const messages = Array.isArray(parsed.messages)
      ? trimMessages(parsed.messages as AiChatMessage[])
      : [];
    return { entries: entries.slice(-MAX_ENTRIES), messages };
  } catch {
    return empty;
  }
}

/**
 * 把会话写入 sessionStorage。
 * 空会话会删除缓存；写入失败（隐私模式、配额不足）时静默忽略，
 * 因为会话恢复只是辅助能力，不应影响当前对话。
 */
function saveSession(deckId: string, session: ChatSession) {
  try {
    const key = `${SESSION_PREFIX}${deckId}`;
    if (session.entries.length === 0 && session.messages.length === 0) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, JSON.stringify(session));
  } catch {
    // 会话恢复只是辅助能力，写入失败时继续当前对话
  }
}

/**
 * AI 助手抽屉主组件。
 *
 * @param deck 当前作品
 * @param onClose 关闭抽屉
 *
 * 状态要点：
 * - config 模型配置（含 autoApply 是否自动执行、includeText 是否发送文字正文）；
 * - entries 界面展示的对话条目，messagesRef 保存模型上下文（不需要触发渲染，故用 ref）；
 * - pending 待确认的工具调用；roundStartPast 记录本轮开始时的历史栈长度，用于撤销本轮。
 */
export function AiPanel({ deck, onClose }: AiPanelProps) {
  const [config, setConfig] = useState<AiConfig>(() => loadAiConfig());
  const [initialSession] = useState<ChatSession>(() => loadSession(deck.id));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [entries, setEntries] = useState<ChatEntry[]>(initialSession.entries);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingState | null>(null);
  const [roundStartPast, setRoundStartPast] = useState<number | null>(null);
  const [messagesVersion, setMessagesVersion] = useState(0);
  const messagesRef = useRef<AiChatMessage[]>(initialSession.messages);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pastLength = useDeckStore((state) => state.past.length);

  // Esc 关闭抽屉；设置弹窗或确认弹窗打开时让它们优先处理 Esc
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !settingsOpen && !resetOpen) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, settingsOpen, resetOpen]);

  // 新条目、执行中提示或待确认操作出现时，把对话区域滚动到底部
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [entries, busy, pending, progress]);

  // 条目或消息历史变化时持久化会话；messagesVersion 用于感知 ref 内历史的更新
  useEffect(() => {
    saveSession(deck.id, { entries, messages: messagesRef.current });
  }, [deck.id, entries, messagesVersion]);

  // 关闭设置 / 确认弹窗后把焦点还给输入框，方便继续对话
  useEffect(() => {
    if (!settingsOpen && !resetOpen) textareaRef.current?.focus();
  }, [settingsOpen, resetOpen]);

  /**
   * 提交模型消息历史。
   * 历史本身放在 ref 中（避免高频重渲染），只递增 messagesVersion 通知持久化 effect。
   */
  const commitMessages = (next: AiChatMessage[]) => {
    messagesRef.current = trimMessages(next);
    setMessagesVersion((value) => value + 1);
  };

  /** 追加一条界面条目；超过 MAX_ENTRIES 时丢弃最旧的记录。 */
  const pushEntry = (role: ChatEntry['role'], text: string) => {
    setEntries((prev) => {
      const next = [...prev, { id: uid(), role, text }];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  };

  /**
   * 构造系统消息：固定行为提示词 + 当前画板上下文。
   * includeText 为 false 时上下文只含结构信息，不发送文字正文。
   */
  const systemMessage = (): AiChatMessage => ({
    role: 'system',
    content: `${AI_SYSTEM_PROMPT}\n\n${buildDeckContext(deck, config.includeText)}`,
  });

  /**
   * 依次执行一批工具调用，并返回对应的 tool 结果消息。
   *
   * 每条工具消息必须携带 tool_call_id，才能与 assistant 的 tool_calls 对齐。
   * 参数 JSON 解析失败时仍会生成一条失败结果，而不是中断整批执行。
   * 工具返回值会被序列化；超过 12000 字符时截断，防止单条消息撑爆上下文。
   * 每执行一步都会更新 progress，让用户看到当前进度。
   */
  const executeCalls = async (calls: AiToolCall[]): Promise<AiChatMessage[]> => {
    const results: AiChatMessage[] = [];
    try {
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        if (abortRef.current?.signal.aborted) break;
        setProgress(`执行 ${index + 1}/${calls.length} · ${summarizeCall(call)}`);
        let args: unknown = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          const message = '工具参数不是有效 JSON';
          pushEntry('error', `${call.name} · ${message}`);
          results.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ ok: false, message }),
          });
          continue;
        }
        const outcome = await executeAiTool(call.name, args);
        pushEntry(outcome.ok ? 'tool' : 'error', `${call.name} · ${outcome.message}`);
        const payload = JSON.stringify({
          ok: outcome.ok,
          message: outcome.message,
          data: outcome.data ?? null,
        });
        results.push({
          role: 'tool',
          tool_call_id: call.id,
          content: payload.length > 12000 ? `${payload.slice(0, 12000)}…` : payload,
        });
      }
    } finally {
      setProgress(null);
    }
    return results;
  };

  /**
   * 跑一轮完整的模型对话（可能包含多次工具调用）。
   *
   * 流程：
   * 1. 携带 system + 历史消息请求模型；
   * 2. 有文字回复时立即加入界面条目；
   * 3. 没有工具调用则把 assistant 文字并入历史并结束；
   * 4. 有工具调用时，auto=false 则暂存为待确认并返回；auto=true 则执行工具、
   *    回填 tool 消息后继续下一轮，直到达到 MAX_ROUNDS 或不再产生工具调用。
   *
   * 注意：接口不是流式返回，模型回复整段到达后才展示；多轮工具结果则逐步追加。
   *
   * @param baseMessages 本轮开始时的消息历史
   * @param auto 是否自动执行工具（false 时交给用户确认）
   * @returns 可继续用于下一轮请求的消息历史
   */
  const runAssistant = async (
    baseMessages: AiChatMessage[],
    auto: boolean,
  ): Promise<AiChatMessage[]> => {
    const controller = new AbortController();
    abortRef.current = controller;
    let messages = baseMessages;
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const result = await chatCompletionWithTools(
          config,
          [systemMessage(), ...messages],
          AI_TOOLS,
          controller.signal,
        );
        if (result.content) pushEntry('assistant', result.content);
        if (result.toolCalls.length === 0) {
          // 纯文字回复也要进入历史，否则下一轮对话会丢失助手说过的内容
          return result.content
            ? [...messages, { role: 'assistant' as const, content: result.content }]
            : messages;
        }
        const assistant: AiChatMessage = {
          role: 'assistant',
          content: result.content,
          tool_calls: result.toolCalls,
        };
        messages = [...messages, assistant];
        if (!auto) {
          setPending({ calls: result.toolCalls, messages });
          pushEntry('tool', `已生成 ${result.toolCalls.length} 个待执行操作`);
          return messages;
        }
        const toolMessages = await executeCalls(result.toolCalls);
        messages = [...messages, ...toolMessages];
        if (controller.signal.aborted) break;
      }
      return messages;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  /**
   * 发送用户输入。
   *
   * 前置校验：非空、未在请求中、没有待确认操作、已配置模型。
   * 发送前记录当前撤销栈长度（roundStartPast），作为「撤销本轮」的起点。
   * 请求异常（除主动中止）会追加一条 error 条目，并在 finally 中提交历史、解除忙碌态。
   */
  const send = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    if (pending) {
      toast('请先应用或放弃待执行操作', 'info');
      return;
    }
    if (!config.model.trim()) {
      toast('请先在设置中配置模型', 'error');
      setSettingsOpen(true);
      return;
    }
    setPrompt('');
    setBusy(true);
    setRoundStartPast(useDeckStore.getState().past.length);
    pushEntry('user', text);
    const base: AiChatMessage[] = [...messagesRef.current, { role: 'user', content: text }];
    let nextMessages = base;
    try {
      nextMessages = await runAssistant(base, config.autoApply);
    } catch (error) {
      if (!isAbortError(error)) {
        const message = error instanceof Error ? error.message : '模型请求失败';
        pushEntry('error', message);
      }
    } finally {
      commitMessages(nextMessages);
      setBusy(false);
    }
  };

  /**
   * 应用待执行操作：先执行工具，再用执行结果继续对话，
   * 让模型根据真实结果决定下一步（例如修正失败操作或继续补充内容）。
   */
  const applyPending = async () => {
    if (!pending || busy) return;
    const state = pending;
    setPending(null);
    setBusy(true);
    let nextMessages = state.messages;
    try {
      const toolMessages = await executeCalls(state.calls);
      nextMessages = [...state.messages, ...toolMessages];
      nextMessages = await runAssistant(nextMessages, true);
    } catch (error) {
      if (!isAbortError(error)) {
        pushEntry('error', error instanceof Error ? error.message : '操作执行失败');
      }
    } finally {
      commitMessages(nextMessages);
      setBusy(false);
    }
  };

  /** 放弃待执行操作；历史裁剪会移除孤立的 assistant(tool_calls)，不会污染后续请求。 */
  const discardPending = () => {
    if (!pending) return;
    setPending(null);
    // 历史里已由 commitMessages 去掉孤立的 assistant(tool_calls)，不会污染下一轮请求
    pushEntry('tool', '已放弃待执行操作');
    textareaRef.current?.focus();
  };

  /** 开始新对话：清空界面条目、模型历史、待确认操作与撤销起点，并清除会话缓存。 */
  const resetConversation = () => {
    setEntries([]);
    messagesRef.current = [];
    setMessagesVersion((value) => value + 1);
    setPending(null);
    setProgress(null);
    setRoundStartPast(null);
    saveSession(deck.id, { entries: [], messages: [] });
    setResetOpen(false);
    toast('已开始新对话', 'success');
    textareaRef.current?.focus();
  };

  /** 切换「自动执行 / 确认后执行」，并立即写入本机配置。 */
  const toggleAutoApply = () => {
    const next = { ...config, autoApply: !config.autoApply };
    setConfig(next);
    saveAiConfig(next);
    toast(next.autoApply ? '已开启自动执行，助手会直接改动画布' : '已切换为确认后执行', 'info');
  };

  /**
   * 撤销本轮 AI 操作。
   * 连续调用 undo 直到历史栈长度回到本轮起点；guard 上限 60 次，
   * 防止异常情况下死循环。撤销后把起点更新为当前长度，避免再次点击重复撤销。
   */
  const undoRound = () => {
    if (roundStartPast === null) {
      toast('还没有可撤销的 AI 操作', 'info');
      return;
    }
    let guard = 0;
    while (useDeckStore.getState().past.length > roundStartPast && guard < 60) {
      useDeckStore.getState().undo();
      guard += 1;
    }
    setRoundStartPast(useDeckStore.getState().past.length);
    toast(guard > 0 ? `已撤销本轮 ${guard} 步改动` : '本轮没有可撤销的改动', guard > 0 ? 'success' : 'info');
  };

  /**
   * 导入外部创作方案（由 MCP 或手动保存的 JSON）。
   * 限制 2MB 以内并校验 JSON 结构，执行结果会写明成功步数与第一条失败原因；
   * 导入前同样记录撤销起点，便于一键回退。
   */
  const importPlan = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      toast('方案文件超过 2 MB', 'error');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast('方案文件不是有效的 JSON', 'error');
      return;
    }
    setRoundStartPast(useDeckStore.getState().past.length);
    try {
      const result = await applyDeckPlan(parsed);
      pushEntry(
        result.failed.length > 0 ? 'error' : 'tool',
        `导入方案 · 已执行 ${result.applied} 步${result.failed.length > 0 ? `，${result.failed.length} 步失败：${result.failed[0]}` : ''}`,
      );
      toast(`方案已导入 · ${result.applied} 步`, result.failed.length > 0 ? 'info' : 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '方案导入失败', 'error');
    }
  };

  const canUndo = roundStartPast !== null && pastLength > roundStartPast;

  return createPortal(
    <div className="ai-drawer-layer" role="presentation">
      <div className="ai-drawer-scrim" onMouseDown={onClose} />
      <aside
        className="ai-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="AI 创作助手"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ai-drawer-head">
          <div>
            <div className="ai-drawer-eyebrow">AI · CREATIVE</div>
            <h3>创作助手</h3>
          </div>
          <div className="ai-drawer-head-actions">
            <button
              className="icon-btn"
              title="新对话"
              aria-label="新对话"
              disabled={entries.length === 0 && !pending}
              onClick={() => setResetOpen(true)}
            >
              <Icon name="reset" size={17} />
            </button>
            <button
              className="icon-btn"
              title="AI 与 MCP 设置"
              aria-label="AI 与 MCP 设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="gear" size={17} />
            </button>
            <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
              <Icon name="close" size={17} />
            </button>
          </div>
        </header>

        <div className="ai-drawer-status">
          <button
            type="button"
            className={`ai-drawer-chip is-button ${config.model ? '' : 'is-warn'}`}
            title="打开 AI 设置"
            onClick={() => setSettingsOpen(true)}
          >
            {config.model || '未配置模型'}
          </button>
          <button
            type="button"
            className="ai-drawer-chip is-button"
            title="点击切换执行方式"
            onClick={toggleAutoApply}
          >
            {config.autoApply ? '自动执行' : '确认后执行'}
          </button>
          <span className="ai-drawer-spacer" />
          <button className="btn btn-ghost btn-sm" disabled={!canUndo} onClick={undoRound}>
            <Icon name="undo" size={13} />
            撤销本轮
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importPlan(file);
            }}
          />
          <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={13} />
            导入方案
          </button>
        </div>

        <div className="ai-drawer-body" ref={bodyRef}>
          {entries.length === 0 && (
            <div className="ai-drawer-empty">
              <div className="ai-drawer-empty-title">把想法直接说给画布</div>
              <p>
                助手会读取当前作品结构，并调用工具添加文字、素材、视点，或调整已有对象。
                改动会立即出现在画布上，可用「撤销本轮」回退。
              </p>
              <div className="ai-drawer-suggest">
                {SUGGESTIONS.map((item) => (
                  <button key={item} onClick={() => setPrompt(item)}>
                    {item}
                  </button>
                ))}
              </div>
            </div>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className={`ai-entry is-${entry.role}`}>
              {entry.role === 'tool' && <Icon name="check" size={12} />}
              {entry.role === 'error' && <Icon name="alert" size={12} />}
              <span>{entry.text}</span>
              {entry.role === 'error' && (
                <button
                  type="button"
                  className="ai-entry-link"
                  onClick={() => setSettingsOpen(true)}
                >
                  检查设置
                </button>
              )}
            </div>
          ))}
          {busy && (
            <div className="ai-entry is-tool">
              <Icon name="spark" size={12} />
              <span>{progress ?? '正在理解并执行…'}</span>
            </div>
          )}
          {pending && (
            <div className="ai-pending">
              <div className="ai-pending-head">待执行操作 · {pending.calls.length} 步</div>
              <ul>
                {pending.calls.map((call) => (
                  <li key={call.id}>{summarizeCall(call)}</li>
                ))}
              </ul>
              <div className="ai-inline">
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void applyPending()}>
                  应用到画布
                </button>
                <button className="btn btn-ghost btn-sm" onClick={discardPending}>
                  放弃
                </button>
              </div>
            </div>
          )}
        </div>

        <footer className="ai-drawer-foot">
          <textarea
            ref={textareaRef}
            className="ai-textarea"
            value={prompt}
            rows={3}
            maxLength={4000}
            placeholder="描述你想要的画面或改动，例如：做一页深色科技封面，标题居中，右下方放资源库里的 3D 模型，并创建 3 个运镜视点。"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="ai-drawer-foot-actions">
            <span className="ai-note">
              {pending
                ? '先应用或放弃待执行操作，再继续对话'
                : 'Enter 发送 · Shift+Enter 换行 · 密钥仅存本机'}
            </span>
            {busy ? (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  abortRef.current?.abort();
                  setBusy(false);
                }}
              >
                停止
              </button>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                disabled={!prompt.trim() || Boolean(pending)}
                onClick={() => void send()}
              >
                <Icon name="spark" size={14} />
                发送
              </button>
            )}
          </div>
        </footer>
      </aside>

      {settingsOpen && (
        <AiSettings
          config={config}
          onSave={(next) => setConfig(next)}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {resetOpen && (
        <ConfirmDialog
          title="开始新对话"
          message="将清空当前对话记录，画布上已有的改动不会回退。"
          confirmLabel="清空对话"
          onConfirm={resetConversation}
          onCancel={() => setResetOpen(false)}
        />
      )}
    </div>,
    document.body,
  );
}
