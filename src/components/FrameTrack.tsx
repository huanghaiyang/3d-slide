import { useState } from 'react';
import { LIMITS, DEFAULT_HOLD } from '../lib/constants';
import { useDeckStore } from '../store/deckStore';
import { Icon } from './Icon';

interface FrameTrackProps {
  readonly: boolean;
  onCapture: () => void;
}

export function FrameTrack({ readonly, onCapture }: FrameTrackProps) {
  const deck = useDeckStore((state) => state.deck);
  const selectedFrameId = useDeckStore((state) => state.selectedFrameId);
  const currentFrameId = useDeckStore((state) => state.currentFrameId);
  const selectFrame = useDeckStore((state) => state.selectFrame);
  const reorderFrame = useDeckStore((state) => state.reorderFrame);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  if (!deck) return null;
  const atLimit = deck.frames.length >= LIMITS.frames;

  return (
    <footer className="trackbar">
      <div className="track-head">
        <div className="track-title">
          <div className="pane-label">视点路径</div>
          <div className="pane-sub">点击卡片飞到该取景 · 拖拽改变演示顺序</div>
        </div>
        <span className="track-count">
          {deck.frames.length} / {LIMITS.frames}
        </span>
      </div>
      <div className="frame-track">
        {deck.frames.length === 0 ? (
          <div className="frame-empty">
            <p>
              添加视点后可串联叙事。
              <span>捕获当前视图，就是把这一刻的取景固定下来。</span>
            </p>
          </div>
        ) : (
          deck.frames.map((frame, index) => {
            const current = frame.id === currentFrameId;
            const selected = frame.id === selectedFrameId;
            return (
              <div
                key={frame.id}
                className={`frame-card ${current ? 'is-current' : ''} ${selected ? 'is-selected' : ''} ${
                  overId === frame.id && dragId && dragId !== frame.id ? 'is-drop' : ''
                }`}
                draggable={!readonly}
                onDragStart={(event) => {
                  setDragId(frame.id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', frame.id);
                }}
                onDragOver={(event) => {
                  if (!dragId || dragId === frame.id) return;
                  event.preventDefault();
                  setOverId(frame.id);
                }}
                onDragLeave={() => setOverId((value) => (value === frame.id ? null : value))}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragId) reorderFrame(dragId, frame.id);
                  setDragId(null);
                  setOverId(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
              >
                <button className="frame-body" onClick={() => selectFrame(frame.id, true)} aria-label={`前往${frame.name}`}>
                  <span className="frame-top">
                    <span className="frame-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="frame-name">{frame.name}</span>
                    {frame.notes && (
                      <span className="frame-note-flag" title={frame.notes}>
                        备注
                      </span>
                    )}
                    {current && <span className="frame-flag">当前</span>}
                  </span>
                  <span className="frame-meta">
                    <span className="frame-camera" aria-hidden="true">
                      <i />
                    </span>
                    <span>{frame.duration.toFixed(1)}s</span>
                    <span className="frame-dot" />
                    <span>停留 {frame.hold ?? DEFAULT_HOLD}s</span>
                  </span>
                </button>
              </div>
            );
          })
        )}
        {!readonly && (
          <button
            className="frame-add"
            onClick={onCapture}
            disabled={atLimit}
            title={atLimit ? `已达到单作品 ${LIMITS.frames} 个视点上限` : '捕获当前视图'}
          >
            <Icon name="plus" size={16} />
            <span>添加视点</span>
            <small>{atLimit ? '已达到上限' : '捕获当前视图'}</small>
          </button>
        )}
        {deck.frames.length > 0 && (
          <div className="frame-track-note">
            <span>过渡使用目标视点的时长</span>
            <span>Esc 退出演示 · R 回到路径</span>
          </div>
        )}
      </div>
    </footer>
  );
}
