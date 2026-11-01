import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Deck } from '../types';
import {
  AI_SYSTEM_PROMPT,
  buildDeckContext,
  chatCompletionWithTools,
  loadAiConfig,
  type AiChatMessage,
  type AiConfig,
  type AiToolCall,
} from '../lib/ai';
import { AI_TOOLS, applyDeckPlan, executeAiTool } from '../lib/aiTools';
import { useDeckStore } from '../store/deckStore';
import { toast } from '../store/uiStore';
import { Icon } from './Icon';
import { AiSettings } from './AiSettings';

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

const SUGGESTIONS = [
  '做一页深色科技封面：标题居中、副标题在下方，再放一张资源库里的图片',
  '把当前画布整理成 3 个运镜视点，从全景推进到主体特写',
  '用 3D 文字做标题，并加一些简单的几何装饰',
];

const MAX_ROUNDS = 6;

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

export function AiPanel({ deck, onClose }: AiPanelProps) {
  const [config, setConfig] = useState<AiConfig>(() => loadAiConfig());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingState | null>(null);
  const [roundStartPast, setRoundStartPast] = useState<number | null>(null);
  const messagesRef = useRef<AiChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pastLength = useDeckStore((state) => state.past.length);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !settingsOpen) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, settingsOpen]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [entries, busy, pending]);

  const pushEntry = (role: ChatEntry['role'], text: string) => {
    setEntries((prev) => [...prev, { id: uid(), role, text }]);
  };

  const systemMessage = (): AiChatMessage => ({
    role: 'system',
    content: `${AI_SYSTEM_PROMPT}\n\n${buildDeckContext(deck, config.includeText)}`,
  });

  const executeCalls = async (calls: AiToolCall[]): Promise<AiChatMessage[]> => {
    const results: AiChatMessage[] = [];
    for (const call of calls) {
      if (abortRef.current?.signal.aborted) break;
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
        if (result.toolCalls.length === 0) return messages;
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
    if (!config.model.trim()) {
      toast('请先在设置中配置模型', 'error');
      setSettingsOpen(true);
      return;
    }
    setPrompt('');
    setBusy(true);
    setPending(null);
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
      messagesRef.current = nextMessages;
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
      messagesRef.current = nextMessages;
      setBusy(false);
    }
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
          <span className={`ai-drawer-chip ${config.model ? '' : 'is-warn'}`}>
            {config.model || '未配置模型'}
          </span>
          <span className="ai-drawer-chip">{config.autoApply ? '自动执行' : '确认后执行'}</span>
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
            </div>
          ))}
          {busy && (
            <div className="ai-entry is-tool">
              <Icon name="spark" size={12} />
              <span>正在理解并执行…</span>
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
                <button className="btn btn-ghost btn-sm" onClick={() => setPending(null)}>
                  放弃
                </button>
              </div>
            </div>
          )}
        </div>

        <footer className="ai-drawer-foot">
          <textarea
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
            <span className="ai-note">Enter 发送 · Shift+Enter 换行 · 密钥仅存本机</span>
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
              <button className="btn btn-primary btn-sm" disabled={!prompt.trim()} onClick={() => void send()}>
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
    </div>,
    document.body,
  );
}
