import { useState } from 'react';
import type { SlideObject } from '../types';
import { LIMITS } from '../lib/constants';
import { OBJECT_LABELS } from '../types';
import { Icon } from './Icon';

interface ObjectListProps {
  objects: SlideObject[];
  selectedId: string | null;
  readonly: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string, visible: boolean) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onAddText: () => void;
  onAddImage: () => void;
  onAddShape: () => void;
}

const typeIcon = {
  text: 'text',
  image: 'image',
  shape: 'shape',
} as const;

export function ObjectList({
  objects,
  selectedId,
  readonly,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onToggleVisible,
  onReorder,
  onAddText,
  onAddImage,
  onAddShape,
}: ObjectListProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const sorted = [...objects].sort((a, b) => b.z - a.z);
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
            const selected = object.id === selectedId;
            const dragging = object.id === dragId;
            return (
              <li key={object.id}>
                {overId === object.id && dragId && dragId !== object.id && <div className="drop-line" />}
                <button
                  className={`obj-item ${selected ? 'is-selected' : ''} ${dragging ? 'is-dragging' : ''} ${
                    !object.visible ? 'is-hidden' : ''
                  }`}
                  draggable={!readonly}
                  onClick={() => onSelect(object.id)}
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
