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
  deck: Deck;
  onClose: () => void;
}

interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
}

interface PendingState {
  calls: AiToolCall[];
  messages: AiChatMessage[];
}

interface ChatSession {
  entries: ChatEntry[];
  messages: AiChatMessage[];
}

const SUGGESTIONS = [
  '做一页深色科技封面：标题居中、副标题在下方，再放一张资源库里的图片',
  '把当前画布整理成 3 个运镜视点，从全景推进到主体特写',
  '用 3D 文字做标题，并加一些简单的几何装饰',
];

const MAX_ROUNDS = 6;
const MAX_ENTRIES = 80;
const MAX_MESSAGES = 24;
const SESSION_PREFIX = '3d-slide:ai-chat:';

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ai-${Math.random().toString(36).slice(2)}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AbortError')
  );
}

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

/** 去掉末尾没有工具响应的 assistant(tool_calls)，并从最近的 user 消息处截断历史 */
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

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !settingsOpen && !resetOpen) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, settingsOpen, resetOpen]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [entries, busy, pending, progress]);

  useEffect(() => {
    saveSession(deck.id, { entries, messages: messagesRef.current });
  }, [deck.id, entries, messagesVersion]);

  useEffect(() => {
    if (!settingsOpen && !resetOpen) textareaRef.current?.focus();
  }, [settingsOpen, resetOpen]);

  const commitMessages = (next: AiChatMessage[]) => {
    messagesRef.current = trimMessages(next);
    setMessagesVersion((value) => value + 1);
  };

  const pushEntry = (role: ChatEntry['role'], text: string) => {
    setEntries((prev) => {
      const next = [...prev, { id: uid(), role, text }];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  };

  const systemMessage = (): AiChatMessage => ({
    role: 'system',
    content: `${AI_SYSTEM_PROMPT}\n\n${buildDeckContext(deck, config.includeText)}`,
  });

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

  /** 跑一轮模型对话；返回可继续使用的消息历史 */
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

  const discardPending = () => {
    if (!pending) return;
    setPending(null);
    // 历史里已由 commitMessages 去掉孤立的 assistant(tool_calls)，不会污染下一轮请求
    pushEntry('tool', '已放弃待执行操作');
    textareaRef.current?.focus();
  };

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

  const toggleAutoApply = () => {
    const next = { ...config, autoApply: !config.autoApply };
    setConfig(next);
    saveAiConfig(next);
    toast(next.autoApply ? '已开启自动执行，助手会直接改动画布' : '已切换为确认后执行', 'info');
  };

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
