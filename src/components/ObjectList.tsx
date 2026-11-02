/**
 * ObjectList.tsx —— 左侧「内容（对象）列表」
 *
 * 组件职责：
 * - 以列表形式展示当前作品的所有对象，按 z 值从前到后排序（越靠前越在上层）；
 * - 支持单击选中、Ctrl/Cmd 点选追加、Shift 范围选择、拖拽调整图层顺序；
 * - 提供可见性切换（眼睛图标），以及折叠 / 展开侧栏；
 * - 空状态与底部提供新增文本、图片、视频、音频、模型、Lottie、形状的入口，
 *   并在达到对象数量上限时禁用这些按钮。
 *
 * 主要交互：
 * - Shift+点击：以上次点击的对象为锚点，选择列表中两者之间的所有对象；
 * - Ctrl/Cmd+点击：切换单个对象的选中状态；
 * - 拖拽：把源对象拖到目标对象上，由 onChange 交给 store 的 moveObjectLayer 完成重排。
 *
 * 与其他模块的关系：
 * - 组件本身不读写 store，全部操作通过 props 回调交给 Editor / deckStore；
 * - 对象类型中文名来自 types 中的 OBJECT_LABELS，图标来自 Icon。
 */

import { useRef, useState } from 'react';
import type { ObjectType, SlideObject } from '../types';
import { LIMITS } from '../lib/constants';
import { OBJECT_LABELS } from '../types';
import { Icon, type IconName } from './Icon';

interface ObjectListProps {
  /** 全部对象（未排序，组件内部按 z 值排序）。 */
  objects: SlideObject[];
  /** 主选中对象 id，用于高亮与「主选中」标记。 */
  selectedId: string | null;
  /** 多选集合，包含主选中对象。 */
  selectedIds: string[];
  /** 只读模式：隐藏新增入口、禁用拖拽与可见性切换。 */
  readonly: boolean;
  /** 是否折叠为窄条。 */
  collapsed: boolean;
  /** 折叠 / 展开回调。 */
  onToggleCollapsed: () => void;
  /** 点选对象；additive 为 true 表示 Ctrl/Cmd 追加选择。 */
  onSelect: (id: string, additive: boolean) => void;
  /** Shift 范围选择回调，参数为区间内的对象 id 列表。 */
  onRangeSelect: (ids: string[]) => void;
  /** 切换对象可见性。 */
  onToggleVisible: (id: string, visible: boolean) => void;
  /** 拖拽重排：把 sourceId 移到 targetId 所在图层。 */
  onReorder: (sourceId: string, targetId: string) => void;
  /** 新增文本。 */
  onAddText: () => void;
  /** 新增图片。 */
  onAddImage: () => void;
  /** 新增视频。 */
  onAddVideo: () => void;
  /** 新增音频。 */
  onAddAudio: () => void;
  /** 新增 3D 模型。 */
  onAddModel: () => void;
  /** 新增 Lottie 动画。 */
  onAddLottie: () => void;
  /** 新增形状（默认矩形）。 */
  onAddShape: () => void;
}

// 每种对象类型对应的图标名称；Lottie 没有专用图标，复用 spark 星芒
const typeIcon: Record<ObjectType, IconName> = {
  text: 'text',
  image: 'image',
  shape: 'shape',
  video: 'video',
  audio: 'audio',
  model: 'model',
  svg: 'svg',
  lottie: 'spark',
};

/**
 * 对象列表主组件。
 *
 * @param props 见 ObjectListProps；所有修改操作均通过回调交由上层处理
 */
export function ObjectList({
  objects,
  selectedId,
  selectedIds,
  readonly,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onRangeSelect,
  onToggleVisible,
  onReorder,
  onAddText,
  onAddImage,
  onAddVideo,
  onAddAudio,
  onAddModel,
  onAddLottie,
  onAddShape,
}: ObjectListProps) {
  // dragId 正在拖拽的对象；overId 当前悬停的目标对象（用于显示插入线）
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Shift 范围选择用的锚点：上一次普通点击的对象 id
  const anchorId = useRef<string | null>(null);
  // 按 z 值降序：z 越大越靠前，列表顶部即最上层对象
  const sorted = [...objects].sort((a, b) => b.z - a.z);
  // 对象数量达到上限时禁用所有新增按钮
  const atLimit = objects.length >= LIMITS.objects;

  if (collapsed) {
    return (
      <aside className="leftbar is-collapsed">
        <button className="icon-btn" onClick={onToggleCollapsed} aria-label="展开内容列表" title="展开内容列表">
          <Icon name="chevron" size={16} />
        </button>
        <span className="leftbar-vertical">内容 {objects.length}</span>
      </aside>
    );
  }

  return (
    <aside className="leftbar">
      <div className="leftbar-head">
        <div>
          <div className="pane-label">内容</div>
          <div className="pane-sub">按深度从近到远 · {objects.length}/{LIMITS.objects}</div>
        </div>
        <button className="icon-btn" onClick={onToggleCollapsed} aria-label="收起内容列表" title="收起">
          <span className="collapse-arrow">
            <Icon name="chevron" size={16} />
          </span>
        </button>
      </div>

      {objects.length === 0 ? (
        <div className="object-empty">
          <p>空间还是空的。先放一个对象，再开始布置。</p>
          {!readonly && (
            <div className="object-empty-actions">
              <button className="btn btn-light btn-sm" onClick={onAddText}>
                <Icon name="text" size={15} /> 文本
              </button>
              <button className="btn btn-light btn-sm" onClick={onAddImage}>
                <Icon name="image" size={15} /> 图片
              </button>
              <button className="btn btn-light btn-sm" onClick={onAddShape}>
                <Icon name="shape" size={15} /> 形状
              </button>
            </div>
          )}
        </div>
      ) : (
        <ul className="obj-list">
          {sorted.map((object, index) => {
            const selected = selectedIds.includes(object.id) || object.id === selectedId;
            const dragging = object.id === dragId;
            const primary = object.id === selectedId;
            return (
              <li key={object.id}>
                {overId === object.id && dragId && dragId !== object.id && <div className="drop-line" />}
                <button
                  className={`obj-item ${selected ? 'is-selected' : ''} ${primary ? 'is-primary' : ''} ${
                    dragging ? 'is-dragging' : ''
                  } ${!object.visible ? 'is-hidden' : ''}`}
                  draggable={!readonly}
                  // 选择逻辑：
                  // - Shift+点击且存在锚点：选中锚点到当前项之间的连续区间（不更新锚点）；
                  // - Ctrl/Cmd+点击：追加 / 取消单个对象；
                  // - 普通点击：单选，并把当前对象设为新的范围选择锚点。
                  onClick={(event) => {
                    if (event.shiftKey && anchorId.current) {
                      const from = sorted.findIndex((item) => item.id === anchorId.current);
                      if (from >= 0) {
                        const a = Math.min(from, index);
                        const b = Math.max(from, index);
                        onRangeSelect(sorted.slice(a, b + 1).map((item) => item.id));
                        return;
                      }
                    }
                    const additive = event.ctrlKey || event.metaKey;
                    onSelect(object.id, additive);
                    anchorId.current = object.id;
                  }}
                  // 原生 HTML5 拖拽：拖起时记录源对象并把 id 写入 dataTransfer（兼容外部读取）；
                  // 悬停在其他对象上时阻止默认行为并记录目标，用于渲染插入指示线
                  onDragStart={(event) => {
                    setDragId(object.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', object.id);
                  }}
                  onDragOver={(event) => {
                    if (!dragId || dragId === object.id) return;
                    event.preventDefault();
                    setOverId(object.id);
                  }}
                  onDragLeave={() => setOverId((value) => (value === object.id ? null : value))}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragId) onReorder(dragId, object.id);
                    setDragId(null);
                    setOverId(null);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverId(null);
                  }}
                >
                  {/* 显示对象的层级序号：最上层（列表中第一个）编号最大 */}
                  <span className="obj-index">{sorted.length - index}</span>
                  <span className="obj-type">
                    <Icon name={typeIcon[object.type]} size={15} />
                  </span>
                  <span className="obj-text">
                    <b>{object.name}</b>
                    <small>
                      {OBJECT_LABELS[object.type]} · Z {Math.round(object.z)}
                    </small>
                  </span>
                  {readonly ? (
                    <span className="obj-eye-static" title={object.visible ? '可见' : '隐藏'}>
                      <Icon name={object.visible ? 'eye' : 'eyeOff'} size={14} />
                    </span>
                  ) : (
                    <span
                      className="obj-eye"
                      role="button"
                      tabIndex={0}
                      aria-label={object.visible ? `隐藏 ${object.name}` : `显示 ${object.name}`}
                      title={object.visible ? '隐藏' : '显示'}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleVisible(object.id, !object.visible);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          event.stopPropagation();
                          onToggleVisible(object.id, !object.visible);
                        }
                      }}
                    >
                      <Icon name={object.visible ? 'eye' : 'eyeOff'} size={14} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!readonly && (
        <div className="object-add">
          <button
            className="btn btn-light btn-sm"
            onClick={onAddText}
            disabled={atLimit}
            title={atLimit ? '已达到单作品对象上限' : '添加文本'}
          >
            <Icon name="plus" size={14} /> 文本
          </button>
          <button
            className="btn btn-light btn-sm"
            onClick={onAddImage}
            disabled={atLimit}
            title={atLimit ? '已达到单作品对象上限' : '添加图片'}
          >
            <Icon name="image" size={14} /> 图片
          </button>
          <button
            className="btn btn-light btn-sm"
            onClick={onAddVideo}
            disabled={atLimit}
            title={atLimit ? '已达到单作品对象上限' : '添加视频'}
          >
            <Icon name="video" size={14} /> 视频
          </button>
          <button
            className="btn btn-light btn-sm"
            onClick={onAddAudio}
            disabled={atLimit}
            title={atLimit ? '已达到单作品对象上限' : '添加音频'}
          >
            <Icon name="audio" size={14} /> 音频
          </button>
          <button
            className="btn btn-light btn-sm"
            onClick={onAddModel}
            disabled={atLimit}
            title={atLimit ? '已达到单作品对象上限' : '添加 3D 模型'}
          >
            <Icon name="model" size={14} /> 模型
          </button>
          <button
            className="btn btn-light btn-sm"
            onClick={onAddLottie}
            disabled={atLimit}
            title={atLimit ? '已达到单作品对象上限' : '添加 Lottie 动画'}
          >
            <Icon name="spark" size={14} /> Lottie
          </button>
          <button
            className="btn btn-light btn-sm"
            onClick={onAddShape}
            disabled={atLimit}
            title={atLimit ? '已达到单作品对象上限' : '添加形状'}
          >
            <Icon name="shape" size={14} /> 形状
          </button>
        </div>
      )}
      {atLimit && <p className="leftbar-note">已达到单作品对象上限（{LIMITS.objects}）。删除对象后可继续添加。</p>}
      {!readonly && objects.length > 1 && <p className="leftbar-note">拖拽列表项可调整前后图层顺序。</p>}
    </aside>
  );
}
