/**
 * TopBar.tsx —— 编辑器顶部工具栏
 *
 * 组件职责：
 * - 左侧：返回首页、可内联编辑的作品标题、保存状态指示；
 * - 右侧：资源库、撤销 / 重做、AI 助手、导出视频、导出工程与「演示」入口；
 * - 只读模式下隐藏所有编辑类按钮，并展示「另一窗口正在编辑」的锁定状态。
 *
 * 主要交互 / 副作用：
 * - 标题输入采用「本地草稿 + 失焦 / Enter 提交」的模式：输入过程中不影响全局状态，
 *   提交时自动 trim、空标题回滚、超过上限截断；
 * - 保存状态根据 store 的 saveStatus.state 映射为四种展示：只读、失败、保存中、待保存、已保存；
 * - 保存失败时点击状态按钮可打开错误详情弹窗（由 Editor 提供回调）。
 *
 * 与其他模块的关系：
 * - 组件本身不直接改 store，所有动作通过 props 回调交给 Editor；
 * - SaveStatus 类型与标题长度限制分别来自 types 与 lib/constants。
 */

import { useEffect, useRef, useState } from 'react';
import type { Deck, SaveStatus } from '../types';
import { LIMITS } from '../lib/constants';
import { formatClock } from '../lib/file';
import { Icon } from './Icon';

interface TopBarProps {
  /** 当前作品，用于读取标题与只读状态。 */
  deck: Deck;
  /** 是否只读（未取得编辑锁）。 */
  readonly: boolean;
  /** 当前保存状态机，决定右侧状态指示的展示。 */
  saveStatus: SaveStatus;
  /** 是否可撤销。 */
  canUndo: boolean;
  /** 是否可重做。 */
  canRedo: boolean;
  /** 返回首页。 */
  onBack: () => void;
  /** 提交新标题（已 trim 并截断）。 */
  onRename: (title: string) => void;
  /** 撤销。 */
  onUndo: () => void;
  /** 重做。 */
  onRedo: () => void;
  /** 进入演示流程。 */
  onPresent: () => void;
  /** 导出 .slide 工程文件。 */
  onExport: () => void;
  /** 打开视频导出对话框。 */
  onExportVideo: () => void;
  /** 打开 AI 助手。 */
  onOpenAi: () => void;
  /** 打开资源库。 */
  onOpenAssets: () => void;
  /** 查看保存失败的详细信息。 */
  onShowSaveError: () => void;
}

/**
 * 顶部工具栏主组件。
 *
 * @param props 见 TopBarProps
 */
export function TopBar({
  deck,
  readonly,
  saveStatus,
  canUndo,
  canRedo,
  onBack,
  onRename,
  onUndo,
  onRedo,
  onPresent,
  onExport,
  onExportVideo,
  onOpenAi,
  onOpenAssets,
  onShowSaveError,
}: TopBarProps) {
  // 标题编辑草稿；focused 标记输入框是否聚焦，聚焦期间不跟随外部标题变化，
  // 避免自动保存 / 撤销导致输入内容被覆盖
  const [draft, setDraft] = useState(deck.title);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(deck.title);
  }, [deck.title]);

  /**
   * 提交标题：
   * - 空标题（仅空白）直接回滚为当前标题，不做任何修改；
   * - 有变化时截断到标题字数上限后交给 onRename；
   * - 无变化则不触发回调，避免产生无意义的历史记录与保存。
   */
  const commit = () => {
    const title = draft.trim();
    if (!title) {
      setDraft(deck.title);
      return;
    }
    if (title !== deck.title) onRename(title.slice(0, LIMITS.titleChars));
  };

  // 保存状态的展示分支：error / saving 单独处理，dirty / saved 直接使用原值
  const state =
    saveStatus.state === 'error' ? 'error' : saveStatus.state === 'saving' ? 'saving' : saveStatus.state;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-btn topbar-back" onClick={onBack} aria-label="返回首页" title="返回首页">
          <Icon name="back" size={18} />
        </button>
        <div className="topbar-title">
          <input
            className="title-input"
            value={draft}
            maxLength={LIMITS.titleChars}
            aria-label="作品标题"
            disabled={readonly}
            onFocus={(event) => {
              focused.current = true;
              event.currentTarget.select();
            }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              focused.current = false;
              commit();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setDraft(deck.title);
                event.currentTarget.blur();
              }
            }}
          />
          {readonly ? (
            <span className="save-state is-readonly">
              <Icon name="lock" size={13} />
              只读 · 另一窗口正在编辑
            </span>
          ) : state === 'error' ? (
            <button className="save-state is-error" onClick={onShowSaveError} title="查看保存失败原因">
              <Icon name="alert" size={13} />
              保存失败 · 查看
            </button>
          ) : state === 'saving' ? (
            <span className="save-state is-saving">
              <span className="saving-dot" />
              保存中…
            </span>
          ) : state === 'dirty' ? (
            <span className="save-state is-dirty">
              <span className="saving-dot" />
              待保存
            </span>
          ) : (
            <span className="save-state is-saved">
              <Icon name="check" size={13} />
              已保存{saveStatus.at ? ` · ${formatClock(saveStatus.at)}` : ''}
            </span>
          )}
        </div>
      </div>

      <div className="topbar-right">
        {!readonly && (
          <>
            <button className="icon-btn" onClick={onOpenAssets} aria-label="资源库" title="从资源库插入">
              <Icon name="folder" size={17} />
            </button>
            <button className="icon-btn" onClick={onUndo} disabled={!canUndo} aria-label="撤销" title="撤销 Ctrl+Z">
              <Icon name="undo" size={18} />
            </button>
            <button className="icon-btn" onClick={onRedo} disabled={!canRedo} aria-label="重做" title="重做 Ctrl+Shift+Z">
              <Icon name="redo" size={18} />
            </button>
            <span className="topbar-divider" />
          </>
        )}
        <button className="btn btn-ghost btn-sm" onClick={onOpenAi} title="AI 助手与 MCP 集成">
          <Icon name="spark" size={15} />
          AI
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onExportVideo} title="离屏渲染导出视频或 PNG 序列">
          <Icon name="video" size={16} />
          导出视频
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onExport}>
          <Icon name="download" size={16} />
          导出
        </button>
        <button className="btn btn-primary btn-sm" onClick={onPresent}>
          <Icon name="play" size={15} />
          演示
        </button>
      </div>
    </header>
  );
}
