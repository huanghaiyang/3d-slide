import { useState } from 'react';
import type { Deck } from '../types';
import {
  chatCompletion,
  clearAiConfig,
  DEFAULT_AI_CONFIG,
  probeToolSupport,
  saveAiConfig,
  type AiConfig,
} from '../lib/ai';
import { AI_TOOLS } from '../lib/aiTools';
import { buildWorkspaceSnapshot } from '../lib/snapshot';
import { getDeck, listAssetMetas, listDecks, listFolders } from '../lib/storage';
import { downloadBlob, filenameFor } from '../lib/exportVideo';
import { toast } from '../store/uiStore';
import { Modal } from './ui';
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

interface AiSettingsProps {
  config: AiConfig;
  onSave: (config: AiConfig) => void;
  onClose: () => void;
}

export function AiSettings({ config, onSave, onClose }: AiSettingsProps) {
  const [draft, setDraft] = useState<AiConfig>(config);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const updateDraft = (patch: Partial<AiConfig>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setProbe(null);
  };

  const save = () => {
    if (!draft.baseUrl.trim() || !draft.model.trim()) {
      toast('请填写接口地址与模型名称', 'error');
      return;
    }
    const next = {
      ...draft,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim(),
    };
    saveAiConfig(next);
    onSave(next);
    toast('AI 设置已保存在本机浏览器', 'success');
    onClose();
  };

  const test = async () => {
    if (testing) return;
    if (!draft.model.trim()) {
      toast('请先填写模型名称', 'error');
      return;
    }
    setTesting(true);
    setProbe(null);
    try {
      const answer = await chatCompletion(draft, [
        { role: 'user', content: '只回复四个字：连接成功' },
      ]);
      const support = await probeToolSupport(draft, AI_TOOLS);
      setProbe({
        tone: support.ok ? 'ok' : 'warn',
        text: `对话连接成功（${answer.slice(0, 24)}）· ${support.message}`,
      });
      toast(
        support.ok ? '连接成功 · 工具调用可用' : '连接成功 · 工具调用不可用',
        support.ok ? 'success' : 'info',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接失败';
      setProbe({ tone: 'error', text: message });
      toast(message, 'error');
    } finally {
      setTesting(false);
    }
  };

  const exportSnapshot = async () => {
    try {
      const summaries = await listDecks();
      const decks = (await Promise.all(summaries.map((item) => getDeck(item.id)))).filter(
        (item): item is Deck => Boolean(item),
      );
      const [assets, folders] = await Promise.all([listAssetMetas(), listFolders()]);
      const snapshot = buildWorkspaceSnapshot(decks, assets, folders, {
        includeText: draft.includeText,
      });
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const filename = filenameFor('workspace', 'json');
      downloadBlob(blob, filename);
      toast(`已导出脱敏快照 · ${filename}`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '快照导出失败', 'error');
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
      title="AI 与 MCP 设置"
      eyebrow="SETTINGS · INTEGRATION"
      width={640}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={save}>
            保存设置
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
              value={draft.baseUrl}
              spellCheck={false}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => updateDraft({ baseUrl: event.target.value })}
            />
          </label>
          <label className="ai-field">
            <span className="field-label">模型</span>
            <input
              className="ai-input"
              value={draft.model}
              spellCheck={false}
              placeholder="gpt-4o-mini"
              onChange={(event) => updateDraft({ model: event.target.value })}
            />
          </label>
          <label className="ai-field ai-field-wide">
            <span className="field-label">API Key</span>
            <input
              className="ai-input"
              type="password"
              value={draft.apiKey}
              spellCheck={false}
              autoComplete="off"
              placeholder="sk-…（仅保存在本机浏览器）"
              onChange={(event) => updateDraft({ apiKey: event.target.value })}
            />
          </label>
        </div>
        <div className="ai-inline">
          <button className="btn btn-light btn-sm" disabled={testing} onClick={() => void test()}>
            <Icon name="plug" size={14} />
            {testing ? '检测中…' : '测试连接与工具'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              clearAiConfig();
              const reset = { ...DEFAULT_AI_CONFIG };
              setDraft(reset);
              setProbe(null);
              onSave(reset);
              toast('已清除本机 AI 配置', 'info');
            }}
          >
            清除
          </button>
          <span className="ai-note">密钥不会写入工程、快照或 MCP 数据</span>
        </div>
        {probe && <p className={`ai-probe is-${probe.tone}`}>{probe.text}</p>}
      </section>

      <section className="ai-section">
        <h4>创作行为</h4>
        <label className="ai-toggle ai-toggle-row">
          <input
            type="checkbox"
            checked={draft.autoApply}
            onChange={(event) => updateDraft({ autoApply: event.target.checked })}
          />
          自动执行模型给出的操作
        </label>
        <p className="ai-note">
          开启后，助手会直接添加文字、素材、视点并调整对象，改动可以随时用「撤销本轮」回退；
          关闭后，助手只列出待执行操作，由你在对话抽屉里确认。
        </p>
        <label className="ai-toggle ai-toggle-row">
          <input
            type="checkbox"
            checked={draft.includeText}
            onChange={(event) => updateDraft({ includeText: event.target.checked })}
          />
          随请求发送画板文字内容
        </label>
        <p className="ai-note">默认只发送作品结构（位置、尺寸、类型），不发送文字正文与资源文件内容。</p>
      </section>

      <section className="ai-section">
        <h4>把工作区暴露给 MCP</h4>
        <p className="ai-note">
          快照只包含作品结构、资源元数据与脱敏后的字段，不包含资源文件内容、缩略图或任何密钥。
          除只读查询外，MCP 还能通过 write_plan 把创作方案写入 .mcp/plans/*.json，在应用内导入执行。
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
          运行 <code>npm run mcp</code> 后把上面的配置加入 MCP 客户端。方案文件格式为
          <code> 3d-slide/plan@1</code>。
        </p>
      </section>
    </Modal>
  );
}
