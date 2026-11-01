import { useMemo, useRef, useState } from 'react';
import type { Deck } from '../types';
import {
  AI_SYSTEM_PROMPT,
  buildDeckContext,
  chatCompletion,
  clearAiConfig,
  DEFAULT_AI_CONFIG,
  loadAiConfig,
  saveAiConfig,
  type AiConfig,
  type AiMessage,
} from '../lib/ai';
import { buildWorkspaceSnapshot } from '../lib/snapshot';
import { getDeck, listAssetMetas, listDecks, listFolders } from '../lib/storage';
import { downloadBlob, filenameFor } from '../lib/exportVideo';
import { toast } from '../store/uiStore';
import { FieldBlock, Modal } from './ui';
import { Icon } from './Icon';

const MCP_CONFIG = `{
  "mcpServers": {
    "3d-slide": {
      "command": "node",
      "args": ["mcp/server.mjs"],
      "env": { "SLIDE_SNAPSHOT": "workspace-snapshot.json" }
    }
  }
}`;

interface AiPanelProps {
  deck: Deck;
  onClose: () => void;
}

export function AiPanel({ deck, onClose }: AiPanelProps) {
  const [config, setConfig] = useState<AiConfig>(() => loadAiConfig());
  const [includeText, setIncludeText] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<AiMessage[]>([]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const context = useMemo(() => buildDeckContext(deck, includeText), [deck, includeText]);

  const persist = () => {
    if (!config.baseUrl.trim() || !config.model.trim()) {
      toast('请填写接口地址与模型名称', 'error');
      return;
    }
    saveAiConfig(config);
    toast('AI 配置已保存在本机浏览器', 'success');
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    if (!config.model.trim()) {
      toast('请先填写模型配置', 'error');
      return;
    }
    setBusy(true);
    setError('');
    setReply('');
    const controller = new AbortController();
    abortRef.current = controller;
    const userMessage: AiMessage = { role: 'user', content: text };
    const messages: AiMessage[] = [
      { role: 'system', content: `${AI_SYSTEM_PROMPT}\n\n${context}` },
      ...history,
      userMessage,
    ];
    try {
      const answer = await chatCompletion(config, messages, controller.signal);
      setReply(answer);
      setHistory((items) => [...items, userMessage, { role: 'assistant', content: answer }]);
      setPrompt('');
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : '模型请求失败');
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const exportSnapshot = async () => {
    try {
      const summaries = await listDecks();
      const decks = (await Promise.all(summaries.map((item) => getDeck(item.id)))).filter(
        (item): item is Deck => Boolean(item),
      );
      const [assets, folders] = await Promise.all([listAssetMetas(), listFolders()]);
      const snapshot = buildWorkspaceSnapshot(decks, assets, folders, { includeText });
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const filename = filenameFor('workspace', 'json');
      downloadBlob(blob, filename);
      toast(`已导出脱敏快照 · ${filename}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '快照导出失败', 'error');
    }
  };

  const copyMcp = async () => {
    try {
      await navigator.clipboard.writeText(MCP_CONFIG);
      toast('MCP 配置已复制', 'success');
    } catch {
      toast('无法写入剪贴板，请手动复制', 'error');
    }
  };

  return (
    <Modal
      title="AI 助手与集成"
      eyebrow="AI · MCP"
      width={660}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void send()}>
            <Icon name="spark" size={15} />
            {busy ? '思考中…' : '发送'}
          </button>
        </>
      }
    >
      <section className="ai-section">
        <h4>大模型接口（OpenAI 兼容）</h4>
        <div className="ai-config-grid">
          <label className="ai-field">
            <span className="field-label">接口地址</span>
            <input
              className="ai-input"
              value={config.baseUrl}
              spellCheck={false}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => setConfig({ ...config, baseUrl: event.target.value })}
            />
          </label>
          <label className="ai-field">
            <span className="field-label">模型</span>
            <input
              className="ai-input"
              value={config.model}
              spellCheck={false}
              placeholder="gpt-4o-mini"
              onChange={(event) => setConfig({ ...config, model: event.target.value })}
            />
          </label>
          <label className="ai-field ai-field-wide">
            <span className="field-label">API Key</span>
            <input
              className="ai-input"
              type="password"
              value={config.apiKey}
              spellCheck={false}
              autoComplete="off"
              placeholder="sk-…（仅保存在本机浏览器）"
              onChange={(event) => setConfig({ ...config, apiKey: event.target.value })}
            />
          </label>
        </div>
        <div className="ai-inline">
          <button className="btn btn-ghost btn-sm" onClick={persist}>
            保存配置
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              clearAiConfig();
              setConfig({ ...DEFAULT_AI_CONFIG });
              toast('已清除本机 AI 配置', 'info');
            }}
          >
            清除
          </button>
          <span className="ai-note">密钥不会写入工程、快照或 MCP 数据</span>
        </div>
      </section>

      <section className="ai-section">
        <div className="ai-chat-head">
          <h4>对话</h4>
          <label className="ai-toggle">
            <input
              type="checkbox"
              checked={includeText}
              onChange={(event) => setIncludeText(event.target.checked)}
            />
            随请求发送画板文字
          </label>
        </div>
        {history.length > 0 && (
          <div className="ai-history">
            {history.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`ai-bubble is-${message.role}`}>
                {message.content}
              </div>
            ))}
          </div>
        )}
        <FieldBlock
          label="告诉 AI 你想做什么"
          hint="请求会附带当前作品的结构快照；默认隐藏画板文字内容。"
        >
          <textarea
            className="ai-textarea"
            value={prompt}
            rows={3}
            maxLength={4000}
            placeholder="例如：帮我设计一条从俯视全景进入标题、再环绕到模型特写的视点路径。"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </FieldBlock>
        {error && <p className="ai-error">{error}</p>}
        {reply && !error && <div className="ai-reply">{reply}</div>}
      </section>

      <section className="ai-section">
        <h4>把工作区暴露给 MCP</h4>
        <p className="ai-note">
          快照只包含作品结构、资源元数据与脱敏后的字段，不包含资源文件内容、缩略图或任何密钥。
          MCP 服务以只读方式提供 list_decks、get_deck、list_assets、search_objects 等工具。
        </p>
        <div className="ai-inline">
          <button className="btn btn-light btn-sm" onClick={() => void exportSnapshot()}>
            <Icon name="download" size={14} />
            导出脱敏快照
          </button>
          <button className="btn btn-light btn-sm" onClick={() => void copyMcp()}>
            <Icon name="check" size={14} />
            复制 MCP 配置
          </button>
        </div>
        <pre className="ai-code">{MCP_CONFIG}</pre>
        <p className="ai-note">
          将快照保存到项目内后运行 <code>npm run mcp</code>，再把上面的配置加入 MCP 客户端即可。
        </p>
      </section>
    </Modal>
  );
}
