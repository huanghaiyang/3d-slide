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
import type { MediaPlaybackState, StageMode } from '../three/SceneManager';
import { Icon } from './Icon';
import { MediaPlayer } from './MediaPlayer';

export type AxisDir = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export interface StageApi {
  captureView: () => ViewState;
  flyTo: (view: ViewState, duration?: number) => Promise<void>;
  focus: (objectId: string) => Promise<void>;
  reset: () => Promise<void>;
  projectObject: (id: string) => { left: number; top: number; width: number; height: number } | null;
  roamStep: (forward: number, right: number, up: number, dt: number) => void;
  lookAlong: (axis: AxisDir) => void;
  setAxesVisible: (visible: boolean) => void;
  setLens: (effect: 'none' | 'fisheye', strength?: number) => void;
  setSpaceMode: (mode: 'none' | 'stars') => void;
  setViewLocked: (locked: boolean) => void;
  mediaList: () => { id: string; name: string; kind: 'video' | 'audio' }[];
  mediaState: (id: string) => MediaPlaybackState | null;
  mediaToggle: (id: string) => void;
  mediaSeek: (id: string, time: number) => void;
  mediaVolume: (id: string, volume: number) => void;
  mediaMute: (id: string) => void;
  getXRSupported: () => Promise<boolean>;
  enterXR: () => Promise<boolean>;
  exitXR: () => Promise<void>;
}

interface StageProps {
  deck: Deck;
  mode: StageMode;
  selectedObjectId?: string | null;
  selectedObjectIds?: string[];
  cameraRequest?: CameraRequest | null;
  imageRetry?: Record<string, number>;
  initialView?: ViewState;
  onViewChange?: (view: ViewState) => void;
  onSelect?: (id: string | null) => void;
  onSelectMany?: (ids: string[]) => void;
  onMoveObject?: (id: string, x: number, y: number) => void;
  onResizeObject?: (id: string, patch: { x: number; y: number; width: number; height: number }) => void;
  onImageError?: (id: string, message: string) => void;
  onAddText?: () => void;
  onAddShape?: (shape: ShapeKind) => void;
  onAddImageFile?: (file: File, point?: { x: number; y: number }) => void;
  onAddFile?: (file: File, point?: { x: number; y: number }) => void;
  onPickImage?: () => void;
  onTextCommit?: (id: string, text: string) => void;
  onDrawPath?: (points: number[], box: { x: number; y: number; width: number; height: number }, strokeWidth?: number) => void;
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

type GestureMode = 'pan' | 'orbit' | 'object' | 'resize' | 'marquee' | 'draw' | null;

interface ResizeStart {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z: number;
  ratio: number | null;
}

interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface MediaPanelState {
  id: string;
  name: string;
  left: number;
  top: number;
  width: number;
  state: MediaPlaybackState;
}

interface GestureState {
  mode: GestureMode;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  objectId?: string;
  corner?: 'nw' | 'ne' | 'se' | 'sw';
  startWorld?: { x: number; y: number };
  startObject?: { x: number; y: number; z: number };
  startPositions?: { id: string; x: number; y: number; z: number }[];
  resize?: ResizeStart;
  baseSelection?: string[];
  marquee?: MarqueeRect;
  drawPoints?: { x: number; y: number }[];
  drawOrigin?: { left: number; top: number };
  pointerId: number;
}

export const Stage = forwardRef<StageApi, StageProps>(function Stage(props, ref) {
  const {
    deck,
    mode,
    selectedObjectId = null,
    selectedObjectIds = [],
    cameraRequest = null,
    imageRetry,
    initialView,
    onViewChange,
    onSelect,
    onSelectMany,
    onMoveObject,
    onResizeObject,
    onImageError,
    onAddText,
    onAddShape,
    onAddImageFile,
    onAddFile,
    onPickImage,
    onTextCommit,
    onDrawPath,
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
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [mediaPanel, setMediaPanel] = useState<MediaPanelState | null>(null);
  const [penMode, setPenMode] = useState(false);
  const [viewLocked, setViewLocked] = useState(false);
  const [showAxes, setShowAxes] = useState(false);
  const [drawStroke, setDrawStroke] = useState<{ x: number; y: number }[] | null>(null);
  const dismissedMediaRef = useRef<string | null>(null);
  const penRef = useRef(false);
  const lockRef = useRef(false);
  const drawCallbackRef = useRef(onDrawPath);
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
  const selectionRef = useRef(selectedObjectIds);

  modeRef.current = mode;
  editingRef.current = editing;
  viewCallbackRef.current = onViewChange;
  imageErrorCallbackRef.current = onImageError;
  stageClickCallbackRef.current = onStageClick;
  stageDoubleCallbackRef.current = onStageDoubleClick;
  deckRef.current = deck;
  selectedPropRef.current = selectedObjectId;
  selectionRef.current = selectedObjectIds;
  penRef.current = penMode && mode === 'edit';
  lockRef.current = viewLocked;
  drawCallbackRef.current = onDrawPath;

  const applySelection = (ids: string[]) => {
    if (onSelectMany) onSelectMany(ids);
    else onSelect?.(ids[0] ?? null);
  };

  const selectionIds = selectedObjectId
    ? [selectedObjectId, ...selectedObjectIds.filter((id) => id !== selectedObjectId)]
    : selectedObjectIds;

  useLayoutEffect(() => {
    const container = boxRef.current;
    if (!container) return;
    const initial = initialViewRef.current;
    const manager = new SceneManager(container, deckRef.current.background, initial, modeRef.current, {
      onImageError: (id, message) => imageErrorCallbackRef.current?.(id, message),
    });
    managerRef.current = manager;
    manager.sync(deckRef.current, selectionRef.current, modeRef.current);
    setLiveView(manager.getView());
    return () => {
      manager.dispose();
      managerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.sync(deck, selectionIds, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, selectedObjectId, selectedObjectIds, mode]);

  useEffect(() => {
    managerRef.current?.setShowGrid(showGrid && mode === 'edit');
  }, [showGrid, mode]);

  useEffect(() => {
    managerRef.current?.setShowAxes(showAxes);
  }, [showAxes, mode]);

  useEffect(() => {
    if (!imageRetry) return;
    const manager = managerRef.current;
    if (!manager) return;
    for (const id of Object.keys(imageRetry)) manager.retryImage(id);
  }, [imageRetry]);

  useEffect(() => {
    dismissedMediaRef.current = null;
  }, [selectedObjectId]);

  useEffect(() => {
    if (mode !== 'edit' || !selectedObjectId) {
      setMediaPanel(null);
      return;
    }
    const object = deckRef.current.objects.find((item) => item.id === selectedObjectId);
    if (!object || (object.type !== 'video' && object.type !== 'audio')) {
      setMediaPanel(null);
      return;
    }
    if (dismissedMediaRef.current === selectedObjectId) {
      setMediaPanel(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      const manager = managerRef.current;
      if (!manager) return;
      const state = manager.getMediaState(selectedObjectId);
      if (!state) return;
      const rect = manager.projectRect(selectedObjectId);
      const width = Math.max(296, Math.min(470, rect ? rect.width : 360));
      const left = Math.max(8, Math.min(Math.max(8, box.width - width - 8), rect ? rect.left : 8));
      let top = rect ? rect.top + rect.height + 10 : 8;
      if (top + 94 > box.height) top = Math.max(8, (rect?.top ?? 0) - 94);
      setMediaPanel({ id: selectedObjectId, name: object.name, left, top, width, state });
    };
    refresh();
    const timer = window.setInterval(refresh, 150);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [mode, selectedObjectId, box.width, box.height, deck.objects]);

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

  const lookAlong = (axis: AxisDir) => {
    if (lockRef.current) return;
    const manager = managerRef.current;
    if (!manager) return;
    const current = manager.getView();
    const angles: Record<AxisDir, { yaw: number; pitch: number }> = {
      '+x': { yaw: Math.PI / 2, pitch: 0 },
      '-x': { yaw: -Math.PI / 2, pitch: 0 },
      '+y': { yaw: 0, pitch: -1.42 },
      '-y': { yaw: 0, pitch: 1.42 },
      '+z': { yaw: 0, pitch: 0 },
      '-z': { yaw: Math.PI, pitch: 0 },
    };
    const next = angles[axis];
    void flyEdit(
      {
        target: { ...current.target },
        distance: current.distance,
        yaw: next.yaw,
        pitch: next.pitch,
      },
      0.4,
    );
  };

  /** 画笔结束：把屏幕点转成世界坐标并按包围盒归一化 */
  const finalizeDraw = (points: { x: number; y: number }[]) => {
    const manager = managerRef.current;
    const callback = drawCallbackRef.current;
    if (!manager || !callback || points.length < 3) return;
    const strokeWidth = 6;
    const padding = strokeWidth / 2;
    const z = nextDepth(deckRef.current.objects);
    const world = points.map((point) => manager.screenToWorldOnPlane(point.x, point.y, z));
    const xs = world.map((point) => point.x);
    const ys = world.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = Math.max(8, maxX - minX + padding * 2);
    const height = Math.max(8, maxY - minY + padding * 2);
    const left = minX - padding;
    const top = minY - padding;
    const normalized: number[] = [];
    for (const point of world) {
      normalized.push(
        Math.max(0, Math.min(1, (point.x - left) / width)),
        Math.max(0, Math.min(1, (point.y - top) / height)),
      );
    }
    callback(normalized, { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width, height }, strokeWidth);
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
      roamStep: (forward, right, up, dt) => managerRef.current?.roamStep(forward, right, up, dt),
      lookAlong,
      setAxesVisible: (visible) => {
        setShowAxes(visible);
        managerRef.current?.setShowAxes(visible);
      },
      setLens: (effect, strength) => managerRef.current?.setLens(effect, strength),
      setSpaceMode: (next) => managerRef.current?.setSpaceMode(next),
      setViewLocked: (locked) => {
        setViewLocked(locked);
        lockRef.current = locked;
      },
      mediaList: () =>
        deckRef.current.objects
          .filter((object) => object.type === 'video' || object.type === 'audio')
          .map((object) => ({
            id: object.id,
            name: object.name,
            kind: object.type as 'video' | 'audio',
          })),
      mediaState: (id) => managerRef.current?.getMediaState(id) ?? null,
      mediaToggle: (id) => managerRef.current?.toggleMedia(id),
      mediaSeek: (id, time) => managerRef.current?.seekMedia(id, time),
      mediaVolume: (id, volume) => managerRef.current?.setMediaVolume(id, volume),
      mediaMute: (id) => {
        const manager = managerRef.current;
        if (!manager) return;
        manager.setMediaMuted(id, !(manager.getMediaState(id)?.muted ?? false));
      },
      getXRSupported: () => managerRef.current?.getXRSupported() ?? Promise.resolve(false),
      enterXR: () => managerRef.current?.enterXR() ?? Promise.resolve(false),
      exitXR: async () => {
        await managerRef.current?.exitXR();
      },
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
      if (lockRef.current) return;
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

  const localPoint = (clientX: number, clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (editingRef.current) return;
    const manager = managerRef.current;
    if (!manager) return;
    const target = event.target as HTMLElement;
    if (
      target.tagName === 'TEXTAREA' ||
      target.closest('button') ||
      target.closest('.media-overlay') ||
      target.closest('.media-player')
    ) {
      return;
    }
    const base = {
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      pointerId: event.pointerId,
    };
    if (event.button === 2) {
      if (mode === 'present' || lockRef.current) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { ...base, mode: 'pan' };
      return;
    }
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.altKey && !lockRef.current) {
      gesture.current = { ...base, mode: 'orbit' };
      return;
    }
    if (mode !== 'edit') {
      if (lockRef.current) return;
      gesture.current = { ...base, mode: mode === 'present' ? 'orbit' : 'pan' };
      return;
    }
    if (penRef.current) {
      const rect = boxRef.current?.getBoundingClientRect();
      const origin = { left: rect?.left ?? 0, top: rect?.top ?? 0 };
      const start = localPoint(event.clientX, event.clientY);
      gesture.current = {
        ...base,
        mode: 'draw',
        drawPoints: [{ x: event.clientX, y: event.clientY }],
        drawOrigin: origin,
      };
      setDrawStroke([start]);
      return;
    }
    setEditing(null);
    const handle = manager.hitTestHandle(event.clientX, event.clientY);
    if (handle) {
      const object = deckRef.current.objects.find((item) => item.id === handle.id);
      if (object) {
        const ratio =
          object.type === 'image' && object.aspectLocked && object.naturalHeight > 0
            ? object.naturalWidth / object.naturalHeight
            : null;
        gesture.current = {
          ...base,
          mode: 'resize',
          objectId: handle.id,
          corner: handle.corner,
          startWorld: manager.screenToWorldOnPlane(event.clientX, event.clientY, object.z),
          resize: {
            x: object.x,
            y: object.y,
            width: object.width,
            height: object.height,
            rotation: object.rotation,
            z: object.z,
            ratio,
          },
        };
        return;
      }
    }
    const hitId = manager.hitTest(event.clientX, event.clientY);
    if (hitId) {
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      const current = selectionRef.current;
      const ids = additive
        ? current.includes(hitId)
          ? current.filter((id) => id !== hitId)
          : [...current, hitId]
        : current.includes(hitId)
          ? current
          : [hitId];
      applySelection(ids);
      if (!ids.includes(hitId)) return;
      const object = deckRef.current.objects.find((item) => item.id === hitId);
      if (!object) return;
      gesture.current = {
        ...base,
        mode: 'object',
        objectId: hitId,
        startWorld: manager.screenToWorldOnPlane(event.clientX, event.clientY, object.z),
        startObject: { x: object.x, y: object.y, z: object.z },
        startPositions: deckRef.current.objects
          .filter((item) => ids.includes(item.id))
          .map((item) => ({ id: item.id, x: item.x, y: item.y, z: item.z })),
      };
      return;
    }
    const start = localPoint(event.clientX, event.clientY);
    gesture.current = {
      ...base,
      mode: 'marquee',
      baseSelection: event.shiftKey || event.ctrlKey || event.metaKey ? selectionRef.current : [],
      marquee: { left: start.x, top: start.y, width: 0, height: 0 },
    };
    setMarquee(null);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state) {
      if (modeRef.current === 'edit' && boxRef.current) {
        const handle = managerRef.current?.hitTestHandle(event.clientX, event.clientY);
        boxRef.current.style.cursor = handle
          ? handle.corner === 'nw' || handle.corner === 'se'
            ? 'nwse-resize'
            : 'nesw-resize'
          : '';
      }
      return;
    }
    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    if (!state.moved && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 4) {
      state.moved = true;
    }
    if (state.mode === 'marquee') {
      const rect = boxRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x1 = state.startX - rect.left;
      const y1 = state.startY - rect.top;
      const x2 = event.clientX - rect.left;
      const y2 = event.clientY - rect.top;
      const next = {
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };
      state.marquee = next;
      if (state.moved) setMarquee(next);
      return;
    }
    if (state.mode === 'draw') {
      if (!state.drawPoints) return;
      const previous = state.drawPoints[state.drawPoints.length - 1];
      if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 2) return;
      state.drawPoints.push({ x: event.clientX, y: event.clientY });
      const origin = state.drawOrigin ?? { left: 0, top: 0 };
      setDrawStroke(
        state.drawPoints.map((point) => ({ x: point.x - origin.left, y: point.y - origin.top })),
      );
      return;
    }
    if (!state.moved) return;
    const manager = managerRef.current;
    if (!manager) return;
    if (state.mode === 'object' && state.startWorld && state.startPositions) {
      const point = manager.screenToWorldOnPlane(
        event.clientX,
        event.clientY,
        state.startObject?.z ?? state.startPositions[0]?.z ?? 0,
      );
      const worldX = point.x - state.startWorld.x;
      const worldY = point.y - state.startWorld.y;
      for (const start of state.startPositions) {
        onMoveObject?.(start.id, start.x + worldX, start.y + worldY);
      }
    } else if (state.mode === 'resize' && state.resize && state.startWorld && state.corner) {
      const start = state.resize;
      const point = manager.screenToWorldOnPlane(event.clientX, event.clientY, start.z);
      const rad = (start.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const wx = point.x - state.startWorld.x;
      const wy = point.y - state.startWorld.y;
      const lx = wx * cos + wy * sin;
      const ly = -wx * sin + wy * cos;
      const sx = state.corner.includes('e') ? 1 : -1;
      const sy = state.corner.includes('s') ? 1 : -1;
      let width = Math.max(8, start.width + sx * lx);
      let height = Math.max(8, start.height + sy * ly);
      if (start.ratio) {
        if (Math.abs(sx * lx) >= Math.abs(sy * ly)) height = Math.max(8, width / start.ratio);
        else width = Math.max(8, height * start.ratio);
      }
      const dw = width - start.width;
      const dh = height - start.height;
      const cx = start.x + (sx * dw) / 2 * cos - (sy * dh) / 2 * sin;
      const cy = start.y + (sx * dw) / 2 * sin + (sy * dh) / 2 * cos;
      onResizeObject?.(state.objectId!, { x: cx, y: cy, width, height });
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
    setMarquee(null);
    if (boxRef.current) boxRef.current.style.cursor = '';
    try {
      event.currentTarget.releasePointerCapture(state.pointerId);
    } catch {
      // ignore
    }
    if (state.mode === 'draw') {
      setDrawStroke(null);
      if (state.moved) finalizeDraw(state.drawPoints ?? []);
      if (mode === 'edit' || mode === 'view') commitView();
      return;
    }
    if (state.mode === 'marquee') {
      const rect = state.marquee;
      if (state.moved && rect && rect.width > 4 && rect.height > 4) {
        const manager = managerRef.current;
        const ids = manager?.hitTestRect(rect.left, rect.top, rect.width, rect.height) ?? [];
        const merged = [...new Set([...(state.baseSelection ?? []), ...ids])];
        applySelection(merged);
      } else if ((state.baseSelection ?? []).length === 0) {
        applySelection([]);
      }
    }
    if (state.moved) onGestureEnd?.();
    if (mode === 'edit' || mode === 'view') {
      commitView();
    }
    if (!state.moved && mode === 'present') {
      stageClickCallbackRef.current?.();
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
    if (!object) return;
    if (object.type === 'video' || object.type === 'audio') {
      dismissedMediaRef.current = null;
      onSelect?.(id);
      const state = manager.getMediaState(id);
      if (state) manager.toggleMedia(id);
      return;
    }
    if (object.type !== 'text') return;
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
    if (onAddFile) onAddFile(file, point);
    else onAddImageFile?.(file, point);
  };

  const mediaCommand = (id: string, action: 'toggle' | 'seek' | 'volume' | 'mute', value?: number) => {
    const manager = managerRef.current;
    if (!manager) return;
    if (action === 'toggle') manager.toggleMedia(id);
    else if (action === 'seek') manager.seekMedia(id, value ?? 0);
    else if (action === 'volume') manager.setMediaVolume(id, value ?? 0);
    else manager.setMediaMuted(id, !(manager.getMediaState(id)?.muted ?? false));
  };

  const canFocus = mode === 'edit' && selectedObjectId && deck.objects.some((item) => item.id === selectedObjectId);

  return (
    <div className={`stage-host stage-${mode}`} ref={hostRef}>
      <div
        className={`stage-box ${dragOver ? 'is-drop-target' : ''} ${penMode ? 'is-drawing' : ''}`}
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
            <button
              className={`stage-tool ${penMode ? 'is-active' : ''}`}
              onClick={() => setPenMode((value) => !value)}
              title="画笔：在画板上自由绘制路径"
              aria-pressed={penMode}
            >
              <Icon name="brush" size={16} />
              <span>画笔</span>
            </button>
            <button
              className={`stage-tool ${showAxes ? 'is-active' : ''}`}
              onClick={() => setShowAxes((value) => !value)}
              title="显示 X / Y / Z 坐标轴"
              aria-pressed={showAxes}
            >
              <Icon name="axes" size={16} />
              <span>坐标轴</span>
            </button>
            {showAxes && (
              <div className="stage-axis-group" role="group" aria-label="轴视角切换">
                {(['+x', '-x', '+y', '-y', '+z', '-z'] as AxisDir[]).map((axis) => (
                  <button
                    key={axis}
                    className="stage-axis-btn"
                    onClick={() => lookAlong(axis)}
                    title={`切换到 ${axis.toUpperCase()} 轴视角`}
                    disabled={viewLocked}
                  >
                    {axis.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
            <button
              className={`stage-tool ${viewLocked ? 'is-active' : ''}`}
              onClick={() => setViewLocked((value) => !value)}
              title={viewLocked ? '解锁视角' : '锁定视角，禁止平移/旋转/缩放'}
              aria-pressed={viewLocked}
            >
              <Icon name={viewLocked ? 'lock' : 'unlock'} size={16} />
              <span>{viewLocked ? '已锁' : '视角'}</span>
            </button>
          </div>
        )}

        {drawStroke && drawStroke.length > 1 && (
          <svg className="stage-draw-layer" aria-hidden="true">
            <polyline
              points={drawStroke.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke="#2DD4BF"
              strokeWidth={6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
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

        {mediaPanel && (
          <MediaPlayer
            left={mediaPanel.left}
            top={mediaPanel.top}
            width={mediaPanel.width}
            name={mediaPanel.name}
            state={mediaPanel.state}
            onToggle={() => mediaCommand(mediaPanel.id, 'toggle')}
            onSeek={(time) => mediaCommand(mediaPanel.id, 'seek', time)}
            onVolume={(volume) => mediaCommand(mediaPanel.id, 'volume', volume)}
            onToggleMute={() => mediaCommand(mediaPanel.id, 'mute')}
            onClose={() => {
              dismissedMediaRef.current = mediaPanel.id;
              setMediaPanel(null);
            }}
          />
        )}

        {marquee && (
          <div
            className="stage-marquee"
            style={{
              left: marquee.left,
              top: marquee.top,
              width: marquee.width,
              height: marquee.height,
            }}
          />
        )}

        {dragOver && <div className="stage-drop-hint">松开以放置素材</div>}
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
