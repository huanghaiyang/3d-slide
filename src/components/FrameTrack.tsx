/**
 * FrameTrack.tsx —— 编辑底部「视点路径」时间轴
 *
 * 组件职责：
 * - 展示当前作品的全部视点（frame），按演示顺序横向排列；
 * - 点击卡片触发 store 的 selectFrame(id, true)，相机飞到该视点的取景；
 * - 支持拖拽卡片重排演示顺序，由 store 的 reorderFrame 完成数据更新；
 * - 展示每个视点的编号、名称、是否含备注、过渡时长与停留时长；
 * - 提供「添加视点」入口（捕获当前视图），达到 LIMITS.frames 时禁用。
 *
 * 主要交互：
 * - currentFrameId：演示过程中当前所处的视点，用于显示「当前」标记；
 * - selectedFrameId：编辑态下被选中的视点，用于高亮并与右侧属性面板联动；
 * - 拖拽过程中用 dragId / overId 记录源卡片与悬停目标，用于渲染投放高亮。
 *
 * 与其他模块的关系：
 * - 视点数据与选中状态均来自 store/deckStore，组件本身不持有业务数据；
 * - 捕获动作由父组件（Editor）通过 onCapture 提供；
 * - 时长与上限常量来自 lib/constants 的 DEFAULT_HOLD、LIMITS。
 */

import { useState } from 'react';
import { LIMITS, DEFAULT_HOLD } from '../lib/constants';
import { useDeckStore } from '../store/deckStore';
import { Icon } from './Icon';

interface FrameTrackProps {
  /** 只读模式：隐藏「添加视点」入口并禁用拖拽。 */
  readonly: boolean;
  /** 捕获当前相机视图为新视点的回调，由 Editor 实现。 */
  onCapture: () => void;
}

/**
 * 视点路径时间轴。
 *
 * 直接订阅 deckStore 中与视点相关的切片（deck、选中 / 当前视点、选择与重排动作），
 * 因此父组件只需提供只读标记与捕获回调即可。
 *
 * @param props 见 FrameTrackProps
 */
export function FrameTrack({ readonly, onCapture }: FrameTrackProps) {
  const deck = useDeckStore((state) => state.deck);
  const selectedFrameId = useDeckStore((state) => state.selectedFrameId);
  const currentFrameId = useDeckStore((state) => state.currentFrameId);
  const selectFrame = useDeckStore((state) => state.selectFrame);
  const reorderFrame = useDeckStore((state) => state.reorderFrame);
  // dragId 正在拖拽的视点；overId 当前悬停的目标视点
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // 尚未打开作品时整条路径栏不渲染
  if (!deck) return null;
  // 达到单作品视点上限后禁用捕获按钮
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
            // current / selected 分别对应「演示进行到的视点」与「编辑中选中的视点」
            const current = frame.id === currentFrameId;
            const selected = frame.id === selectedFrameId;
            return (
              <div
                key={frame.id}
                className={`frame-card ${current ? 'is-current' : ''} ${selected ? 'is-selected' : ''} ${
                  overId === frame.id && dragId && dragId !== frame.id ? 'is-drop' : ''
                }`}
                // 只读模式（如演示或只读作品）禁止拖拽重排
                draggable={!readonly}
                // HTML5 拖拽：记录源视点，并把 id 写入 dataTransfer 以便外部读取
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
                {/* 第二个参数 true 表示「飞到该视点」，即触发相机过渡而不只是选中 */}
                <button className="frame-body" onClick={() => selectFrame(frame.id, true)} aria-label={`前往${frame.name}`}>
                  <span className="frame-top">
                    {/* 演示序号按数组顺序从 1 开始，补齐两位（01、02…） */}
                    <span className="frame-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="frame-name">{frame.name}</span>
                    {/* 有备注时只显示标记，备注内容放在 title 里，避免卡片过宽 */}
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
                    {/* duration 为过渡到该视点的时长；hold 为到位后的停留时长，缺省用 DEFAULT_HOLD */}
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
            // 达到上限时禁用，并通过 title / small 文案说明原因
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
