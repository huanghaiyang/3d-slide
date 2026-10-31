import { useEffect, useRef, useState } from 'react';
import type { Deck, SaveStatus } from '../types';
import { LIMITS } from '../lib/constants';
import { formatClock } from '../lib/file';
import { Icon } from './Icon';

interface TopBarProps {
  deck: Deck;
  readonly: boolean;
  saveStatus: SaveStatus;
  canUndo: boolean;
  canRedo: boolean;
  onBack: () => void;
  onRename: (title: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onPresent: () => void;
  onExport: () => void;
  onOpenAssets: () => void;
  onShowSaveError: () => void;
}

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
  onOpenAssets,
  onShowSaveError,
}: TopBarProps) {
  const [draft, setDraft] = useState(deck.title);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(deck.title);
  }, [deck.title]);

  const commit = () => {
    const title = draft.trim();
    if (!title) {
      setDraft(deck.title);
      return;
    }
    if (title !== deck.title) onRename(title.slice(0, LIMITS.titleChars));
  };

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
