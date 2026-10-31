import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { CameraRequest, Deck, ShapeKind, TextObject, ViewState } from '../types';
import { ASPECT, DEFAULT_VIEW, FONT_STACKS } from '../lib/constants';
import { fitDistance, formatZoom } from '../lib/camera';
import { nextDepth } from '../lib/deck';
import { SceneManager } from '../three/SceneManager';
import type { StageMode } from '../three/SceneManager';
import { Icon } from './Icon';

export interface StageApi {
  captureView: () => ViewState;
  flyTo: (view: ViewState, duration?: number) => Promise<void>;
  focus: (objectId: string) => Promise<void>;
  reset: () => Promise<void>;
  projectObject: (id: string) => { left: number; top: number; width: number; height: number } | null;
}

interface StageProps {
  deck: Deck;
  mode: StageMode;
  selectedObjectId?: string | null;
  cameraRequest?: CameraRequest | null;
  imageRetry?: Record<string, number>;
  initialView?: ViewState;
  onViewChange?: (view: ViewState) => void;
  onSelect?: (id: string | null) => void;
  onMoveObject?: (id: string, x: number, y: number) => void;
  onImageError?: (id: string, message: string) => void;
  onAddText?: () => void;
  onAddShape?: (shape: ShapeKind) => void;
  onAddImageFile?: (file: File, point?: { x: number; y: number }) => void;
  onPickImage?: () => void;
  onTextCommit?: (id: string, text: string) => void;
  onGestureEnd?: () => void;
  onStageClick?: () => void;
  onStageDoubleClick?: () => void;
}

interface EditingState {
  id: string;
  draft: string;
  rect: { left: number; top: number; width: number; height: number; fontPx: number; lineHeightPx: number; paddingTop: number };
  object: TextObject;
}

type GestureMode = 'pan' | 'orbit' | 'object' | null;

interface GestureState {
  mode: GestureMode;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  objectId?: string;
  startWorld?: { x: number; y: number };
  startObject?: { x: number; y: number; z: number };
  pointerId: number;
}

export const Stage = forwardRef<StageApi, StageProps>(function Stage(props, ref) {
  const {
    deck,
    mode,
    selectedObjectId = null,
    cameraRequest = null,
    imageRetry,
    initialView,
    onViewChange,
    onSelect,
    onMoveObject,
    onImageError,
    onAddText,
    onAddShape,
    onAddImageFile,
    onPickImage,
    onTextCommit,
    onGestureEnd,
    onStageClick,
    onStageDoubleClick,
  } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<SceneManager | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [liveView, setLiveView] = useState<ViewState>(initialView ?? deck.lastView);
  const [showGrid, setShowGrid] = useState(true);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const gesture = useRef<GestureState | null>(null);
  const wheelTimer = useRef<number>();
  const zoomBase = useRef((initialView ?? deck.lastView).distance);
  const modeRef = useRef(mode);
  const editingRef = useRef<EditingState | null>(null);
  const viewCallbackRef = useRef(onViewChange);
  const imageErrorCallbackRef = useRef(onImageError);
  const stageClickCallbackRef = useRef(onStageClick);
  const stageDoubleCallbackRef = useRef(onStageDoubleClick);
  const initialViewRef = useRef(initialView ?? deck.lastView);
  const deckRef = useRef(deck);
  const selectedPropRef = useRef(selectedObjectId);

  modeRef.current = mode;
  editingRef.current = editing;
  viewCallbackRef.current = onViewChange;
  imageErrorCallbackRef.current = onImageError;
  stageClickCallbackRef.current = onStageClick;
  stageDoubleCallbackRef.current = onStageDoubleClick;
  deckRef.current = deck;
  selectedPropRef.current = selectedObjectId;

  useLayoutEffect(() => {
    const container = boxRef.current;
    if (!container) return;
    const initial = initialViewRef.current;
    const manager = new SceneManager(container, deckRef.current.background, initial, modeRef.current, {
      onImageError: (id, message) => imageErrorCallbackRef.current?.(id, message),
    });
    managerRef.current = manager;
    manager.sync(deckRef.current, selectedPropRef.current, modeRef.current);
    setLiveView(manager.getView());
    return () => {
      manager.dispose();
      managerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.sync(deck, selectedObjectId, mode);
  }, [deck, selectedObjectId, mode]);

  useEffect(() => {
    managerRef.current?.setShowGrid(showGrid && mode === 'edit');
  }, [showGrid, mode]);

  useEffect(() => {
    if (!imageRetry) return;
    const manager = managerRef.current;
    if (!manager) return;
    for (const id of Object.keys(imageRetry)) manager.retryImage(id);
  }, [imageRetry]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.min(rect.width, rect.height * ASPECT);
      const height = width / ASPECT;
      setBox({ width: Math.max(1, width), height: Math.max(1, height) });
      managerRef.current?.resize(width, height);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const commitView = () => {
    const manager = managerRef.current;
    if (!manager) return;
    const view = manager.getView();
    setLiveView(view);
    viewCallbackRef.current?.(view);
  };

  const flyEdit = async (view: ViewState, duration = 0.4) => {
    const manager = managerRef.current;
    if (!manager) return;
    await manager.flyTo(view, duration);
    commitView();
  };

  const focusObject = async (objectId: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    const object = deckRef.current.objects.find((item) => item.id === objectId);
    if (!object) return;
    const current = manager.getView();
    await flyEdit(
      {
        target: { x: object.x, y: object.y, z: object.z },
        distance: fitDistance(object.width, object.height),
        yaw: current.yaw,
        pitch: current.pitch,
      },
      0.35,
    );
  };

  const resetView = async () => {
    await flyEdit({ ...DEFAULT_VIEW, target: { ...DEFAULT_VIEW.target } }, 0.35);
  };

  useImperativeHandle(
    ref,
    () => ({
      captureView: () => managerRef.current?.getView() ?? initialViewRef.current,
      flyTo: async (view, duration = 0.4) => {
        const manager = managerRef.current;
        if (!manager) return;
        zoomBase.current = view.distance;
        await manager.flyTo(view, duration);
        const nextView = manager.getView();
        setLiveView(nextView);
        if (modeRef.current !== 'present') viewCallbackRef.current?.(nextView);
      },
      focus: focusObject,
      reset: resetView,
      projectObject: (id) => managerRef.current?.projectRect(id) ?? null,
    }),
  );

  useEffect(() => {
    if (!cameraRequest || mode !== 'edit') return;
    const manager = managerRef.current;
    if (!manager) return;
    if (cameraRequest.type === 'reset') {
      void resetView();
    } else if (cameraRequest.type === 'frame' && cameraRequest.view) {
      void flyEdit(cameraRequest.view, cameraRequest.duration ?? 0.4);
    } else if (cameraRequest.type === 'focus' && cameraRequest.objectId) {
      void focusObject(cameraRequest.objectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraRequest?.id]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const handler = (event: globalThis.WheelEvent) => {
      if (modeRef.current === 'edit' && editingRef.current) return;
      if (event.target instanceof HTMLElement && event.target.tagName === 'TEXTAREA') return;
      event.preventDefault();
      const manager = managerRef.current;
      if (!manager) return;
      const factor = Math.exp(event.deltaY * 0.0012);
      const base = zoomBase.current;
      const min = modeRef.current === 'present' ? base / 8 : 20;
      const max = modeRef.current === 'present' ? base * 10 : 60000;
      manager.zoomAt(event.clientX, event.clientY, factor, min, max);
      const view = manager.getView();
      setLiveView(view);
      if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => {
        if (modeRef.current !== 'present') commitView();
      }, 260);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  useEffect(() => {
    return () => {
      if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (editingRef.current) return;
    const manager = managerRef.current;
    if (!manager) return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || target.closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const hitId = mode === 'edit' ? manager.hitTest(event.clientX, event.clientY) : null;
    let gestureMode: GestureMode;
    const state: GestureState = {
      mode: null,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      pointerId: event.pointerId,
    };
    if (event.altKey) {
      gestureMode = 'orbit';
    } else if (mode === 'edit' && hitId) {
      const object = deckRef.current.objects.find((item) => item.id === hitId);
      onSelect?.(hitId);
      if (object) {
        gestureMode = 'object';
        state.objectId = hitId;
        state.startWorld = manager.screenToWorldOnPlane(event.clientX, event.clientY, object.z);
        state.startObject = { x: object.x, y: object.y, z: object.z };
      } else {
        gestureMode = 'pan';
      }
    } else {
      gestureMode = mode === 'edit' || mode === 'view' ? 'pan' : 'orbit';
    }
    state.mode = gestureMode;
    gesture.current = state;
    setEditing(null);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state) return;
    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    const totalX = event.clientX - state.startX;
    const totalY = event.clientY - state.startY;
    if (!state.moved && Math.hypot(totalX, totalY) > 4) state.moved = true;
    if (!state.moved) return;
    const manager = managerRef.current;
    if (!manager) return;
    if (state.mode === 'object' && state.objectId && state.startWorld && state.startObject) {
      const point = manager.screenToWorldOnPlane(event.clientX, event.clientY, state.startObject.z);
      onMoveObject?.(
        state.objectId,
        state.startObject.x + (point.x - state.startWorld.x),
        state.startObject.y + (point.y - state.startWorld.y),
      );
    } else if (state.mode === 'orbit') {
      manager.orbitBy(dx, dy);
    } else if (state.mode === 'pan') {
      manager.panBy(dx, dy);
    }
  };

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state) return;
    gesture.current = null;
    try {
      event.currentTarget.releasePointerCapture(state.pointerId);
    } catch {
      // ignore
    }
    if (state.moved) onGestureEnd?.();
    if (mode === 'edit' || mode === 'view') {
      commitView();
    }
    if (!state.moved) {
      if (mode === 'edit' && !state.objectId) {
        onSelect?.(null);
      } else if (mode === 'present') {
        stageClickCallbackRef.current?.();
      }
    }
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (mode === 'present') {
      stageDoubleCallbackRef.current?.();
      return;
    }
    if (mode !== 'edit') return;
    const manager = managerRef.current;
    if (!manager) return;
    const id = manager.hitTest(event.clientX, event.clientY);
    if (!id) return;
    const object = deckRef.current.objects.find((item) => item.id === id);
    if (!object || object.type !== 'text') return;
    const rect = manager.projectRect(id);
    if (!rect) return;
    onSelect?.(id);
    setEditing({ id, draft: object.text, rect, object: object as TextObject });
  };

  const commitEditing = () => {
    const state = editingRef.current;
    if (!state) return;
    editingRef.current = null;
    setEditing(null);
    const text = state.draft.slice(0, 5000);
    if (text !== state.object.text) onTextCommit?.(state.id, text);
  };

  const cancelEditing = () => {
    editingRef.current = null;
    setEditing(null);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (mode !== 'edit') return;
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const manager = managerRef.current;
    if (!manager) return;
    const z = nextDepth(deckRef.current.objects);
    const point = manager.screenToWorldOnPlane(event.clientX, event.clientY, z);
    onAddImageFile?.(file, point);
  };

  const canFocus = mode === 'edit' && selectedObjectId && deck.objects.some((item) => item.id === selectedObjectId);

  return (
    <div className={`stage-host stage-${mode}`} ref={hostRef}>
      <div
        className={`stage-box ${dragOver ? 'is-drop-target' : ''}`}
        ref={boxRef}
        style={box.width ? { width: box.width, height: box.height } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onDoubleClick={onDoubleClick}
        onContextMenu={(event) => event.preventDefault()}
        onDragOver={(event) => {
          if (mode !== 'edit' || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {mode === 'edit' && (
          <div className="stage-tools" aria-label="视图工具">
            <button className="stage-tool" onClick={() => void resetView()} title="重置视图">
              <Icon name="reset" size={16} />
              <span>重置</span>
            </button>
            <button
              className={`stage-tool ${showGrid ? 'is-active' : ''}`}
              onClick={() => setShowGrid((value) => !value)}
              title="切换网格"
              aria-pressed={showGrid}
            >
              <Icon name="grid" size={16} />
              <span>网格</span>
            </button>
            <button
              className="stage-tool"
              disabled={!canFocus}
              onClick={() => {
                if (selectedObjectId) void focusObject(selectedObjectId);
              }}
              title="聚焦选中对象"
            >
              <Icon name="focus" size={16} />
              <span>聚焦</span>
            </button>
          </div>
        )}

        {mode === 'edit' && deck.objects.length === 0 && (
          <div className="stage-empty">
            <div className="stage-empty-mark">
              <span />
              <span />
              <span />
            </div>
            <h3>空间还是空的</h3>
            <p>所有内容都在同一个空间里。先放下第一个对象，再调好取景。</p>
            <div className="stage-empty-actions">
              <button className="btn btn-light" onClick={onAddText}>
                <Icon name="text" size={16} /> 文本
              </button>
              <button className="btn btn-light" onClick={onPickImage}>
                <Icon name="image" size={16} /> 图片
              </button>
              <button className="btn btn-light" onClick={() => onAddShape?.('rect')}>
                <Icon name="shape" size={16} /> 形状
              </button>
            </div>
          </div>
        )}

        {mode === 'edit' && deck.objects.length > 0 && deck.objects.every((object) => !object.visible) && (
          <div className="stage-empty stage-empty-soft">
            <p>所有内容都是隐藏状态。在左侧列表中打开眼睛以重新显示。</p>
          </div>
        )}

        {editing && (
          <textarea
            className="text-editor"
            autoFocus
            value={editing.draft}
            spellCheck={false}
            style={{
              left: editing.rect.left,
              top: editing.rect.top,
              width: Math.max(40, editing.rect.width),
              height: Math.max(40, editing.rect.height),
              fontFamily: FONT_STACKS[editing.object.font],
              fontSize: Math.max(8, editing.rect.fontPx),
              lineHeight: `${Math.max(6, editing.rect.lineHeightPx)}px`,
              color: editing.object.color,
              textAlign: editing.object.align,
              fontWeight: editing.object.bold ? 700 : 400,
              paddingTop: editing.rect.paddingTop,
              background: deck.background,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const draft = event.target.value.slice(0, 5000);
              setEditing((value) => (value ? { ...value, draft } : value));
            }}
            onBlur={commitEditing}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelEditing();
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                commitEditing();
              }
            }}
          />
        )}

        {dragOver && <div className="stage-drop-hint">松开以放置图片</div>}
      </div>

      {mode !== 'present' && (
        <div className="stage-zoom" aria-live="off">
          <span className="stage-zoom-label">缩放</span>
          <b>{formatZoom(liveView.distance)}</b>
        </div>
      )}
      {mode === 'edit' && (
        <div className="stage-safe-tag" aria-hidden="true">
          16:9 · 安全框
        </div>
      )}
      {mode === 'view' && (
        <div className="stage-safe-tag" aria-hidden="true">
          只读查看 · 16:9
        </div>
      )}
    </div>
  );
});
