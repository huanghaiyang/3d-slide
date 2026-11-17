/**
 * Stage.tsx —— 3D 舞台组件（渲染层 + 交互层）
 *
 * 职责：
 * - 在页面中挂载一个 SceneManager（Three.js 渲染器），负责其创建、尺寸同步与销毁。
 * - 把 React 侧的 deck / 选中集合 / 模式（edit / view / present）同步给 SceneManager；
 *   反过来把相机视图变化、对象位移 / 缩放、素材拖放、图片加载错误等事件上抛给上层。
 * - 处理舞台上的所有指针手势：选择、拖拽、框选、角点缩放、Alt 环绕、右键平移、
 *   滚轮缩放、画笔绘制、双击编辑文本 / 打开媒体。
 * - 提供文本原地编辑、媒体浮层、视图工具条、鱼眼 / 网格 / 坐标轴 / 视角锁定等编辑辅助 UI。
 *
 * 主要交互：
 * - 编辑模式：左键点选（Shift / Ctrl / Cmd 多选），拖拽对象，四角手柄缩放，空白处拖框；
 *   Alt + 拖拽环绕视角，右键拖拽平移，滚轮缩放；双击文本进入原地编辑，双击媒体打开播放器。
 * - 演示模式：左键拖拽环绕、单击触发回调、双击触发回调，滚轮缩放幅度限制在初始视角附近。
 *
 * 数据流：
 * - 视图状态以 SceneManager 为准，组件内的 liveView 只用于展示缩放百分比；
 *   拖拽结束 / 滚轮停止后调用 onViewChange 提交，由 App 写入 store。
 * - 对象修改不直接改 store：移动 / 缩放通过 onMoveObject / onResizeObject 回调交给上层，
 *   便于统一走 historyKey 合并与自动保存。
 */
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
import type { CameraRequest, Deck, ImageCrop, ImageObject, ShapeKind, TextObject, ViewState } from '../types';
import { ASPECT, DEFAULT_VIEW, FONT_STACKS } from '../lib/constants';
import { fitDistance, formatZoom } from '../lib/camera';
import { nextDepth } from '../lib/deck';
import { smoothPathD } from '../lib/curve';
import { htmlInCanvasSupported } from '../lib/htmlInCanvas';
import { sanitizeRichHtml } from '../lib/richText';
import { SceneManager } from '../three/SceneManager';
import type { MediaPlaybackState, StageMode } from '../three/SceneManager';
import { useDeckStore } from '../store/deckStore';
import { Icon } from './Icon';
import { MediaPlayer } from './MediaPlayer';

/** 六个正交观察方向，用于坐标轴快捷切视角。 */
export type AxisDir = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/**
 * Stage 通过 ref 暴露的命令式 API，供 App 与演示端调用。
 * 之所以用命令式接口，是因为运镜、媒体控制、XR 等操作都由 SceneManager 直接持有，
 * 不需要也不适合通过 props 来回同步。
 */
export interface StageApi {
  captureView: () => ViewState;
  waitAssets: (timeout?: number) => Promise<void>;
  flyTo: (view: ViewState, duration?: number) => Promise<void>;
  focus: (objectId: string) => Promise<void>;
  reset: () => Promise<void>;
  /** 重播场景内所有图表的入场动画（演示翻页时调用）。 */
  replayCharts: () => void;
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
  /** 当前作品数据；任何字段变化都会触发 SceneManager.sync。 */
  deck: Deck;
  /** 舞台模式：edit（编辑）、view（只读查看）、present（演示）。 */
  mode: StageMode;
  /** 主选中对象 id，用于聚焦按钮、媒体浮层与手柄命中判断。 */
  selectedObjectId?: string | null;
  /** 完整选中集合（含主选中），用于多选拖拽与框选合并。 */
  selectedObjectIds?: string[];
  /** 来自 store 的一次性相机请求，按 id 去重消费。 */
  cameraRequest?: CameraRequest | null;
  /** 图片重试计数：计数变化时通知 SceneManager 重新加载对应素材。 */
  imageRetry?: Record<string, number>;
  /** 初始视角；缺省时使用 deck.lastView。 */
  initialView?: ViewState;
  /** 相机视角变化（拖拽结束 / 滚轮停止）时回调，用于写回 store。 */
  onViewChange?: (view: ViewState) => void;
  /** 单选回调；id 为 null 表示清空选择。 */
  onSelect?: (id: string | null) => void;
  /** 多选回调，数组第一项约定为主选中对象。 */
  onSelectMany?: (ids: string[]) => void;
  /** 拖拽移动单个 / 多个对象时回调世界坐标。 */
  onMoveObject?: (id: string, x: number, y: number) => void;
  /** 角点缩放时回调新的中心坐标与尺寸。 */
  onResizeObject?: (id: string, patch: { x: number; y: number; width: number; height: number }) => void;
  /** 图片 / 媒体 / 模型加载失败回调。 */
  onImageError?: (id: string, message: string) => void;
  /** 空舞台快捷按钮：新建文本。 */
  onAddText?: () => void;
  /** 空舞台快捷按钮：新建形状。 */
  onAddShape?: (shape: ShapeKind) => void;
  /** 拖放文件回调；point 为落点在当前深度平面上的世界坐标。 */
  onAddImageFile?: (file: File, point?: { x: number; y: number }) => void;
  /** 通用拖放回调（优先于 onAddImageFile，可自动识别素材类型）。 */
  onAddFile?: (file: File, point?: { x: number; y: number }) => void;
  /** 空舞台快捷按钮：选择图片文件。 */
  onPickImage?: () => void;
  /** 文本原地编辑提交回调；html 仅在富文本编辑时提供（提交时清洗后的受控 HTML）。 */
  onTextCommit?: (id: string, text: string, html?: string) => void;
  /** 画笔绘制完成回调：归一化点列、包围盒与线宽（px）。 */
  onDrawPath?: (points: number[], box: { x: number; y: number; width: number; height: number }, strokeWidth?: number) => void;
  /** 一次有效拖拽 / 缩放手势结束（用于关闭历史合并窗口）。 */
  onGestureEnd?: () => void;
  /** 演示模式单击回调。 */
  onStageClick?: () => void;
  /** 演示模式双击回调。 */
  onStageDoubleClick?: () => void;
}

/**
 * 文本原地编辑状态。
 * rect 与 SceneManager.projectRect 的输出一致，包含由文字排版换算出的
 * fontPx / lineHeightPx / paddingTop，使 textarea 与 3D 文本尽量对齐。
 */
interface EditingState {
  id: string;
  /**
   * 编辑方式：
   * - plain —— 普通 textarea，只编辑纯文本（提交时会清掉富文本样式）；
   * - rich  —— contentEditable，直接编辑 HTML，粘贴与输入都能保留样式。
   * 富文本 + HTML-in-Canvas 打开且浏览器支持时用 rich，否则用 plain。
   */
  kind: 'plain' | 'rich';
  draft: string;
  rect: { left: number; top: number; width: number; height: number; fontPx: number; lineHeightPx: number; paddingTop: number };
  object: TextObject;
}

/** 当前手势类型；null 表示没有进行中的拖拽。 */
type GestureMode = 'pan' | 'orbit' | 'object' | 'resize' | 'marquee' | 'draw' | null;

/** 缩放开始时的对象几何快照，拖拽过程中所有计算都以它为基准，避免累计误差。 */
interface ResizeStart {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z: number;
  ratio: number | null;
}

/** 框选矩形，坐标为舞台容器内的局部像素坐标。 */
interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 吸附参考线：axis 决定横竖，pos 是屏幕坐标，from / to 决定线段范围 */
interface GuideLine {
  axis: 'x' | 'y';
  pos: number;
  from: number;
  to: number;
}

/** 媒体播放浮层的定位与播放状态快照。 */
interface MediaPanelState {
  id: string;
  name: string;
  left: number;
  top: number;
  width: number;
  state: MediaPlaybackState;
}

/**
 * 一次指针手势的完整上下文。
 * 指针按下时创建，移动期间读写，抬起时清空；用 ref 保存以避免闭包拿到旧值。
 */
interface GestureState {
  mode: GestureMode;
  /** 按下点与上一次移动点（client 坐标），用于计算增量位移。 */
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** 是否已超过 4px 阈值；未移动的点击不应触发位移或框选。 */
  moved: boolean;
  objectId?: string;
  corner?: 'nw' | 'ne' | 'se' | 'sw';
  /** 按下时的世界坐标（所在 z 平面），用于把指针位移换算成对象位移。 */
  startWorld?: { x: number; y: number };
  startObject?: { x: number; y: number; z: number };
  /** 多选拖拽时记录的每个对象初始位置。 */
  startPositions?: { id: string; x: number; y: number; z: number }[];
  resize?: ResizeStart;
  /** 框选开始前已有的选中集合（Shift / Ctrl / Cmd 时为并集基础）。 */
  baseSelection?: string[];
  marquee?: MarqueeRect;
  /** 画笔采样点（client 坐标）。 */
  drawPoints?: { x: number; y: number }[];
  /** 舞台容器在页面中的偏移，用于把 client 坐标转成局部坐标预览笔迹。 */
  drawOrigin?: { left: number; top: number };
  /** 指针捕获 id，抬起时用于 releasePointerCapture。 */
  pointerId: number;
}

/**
 * Stage 组件本体。
 *
 * 使用 forwardRef 暴露命令式 API（运镜、媒体控制、XR 等），内部通过 managerRef
 * 持有 SceneManager 实例；React 只负责同步数据与渲染辅助 UI。
 */
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
  // box：16:9 画布在容器内实际渲染的像素尺寸；liveView：当前视角的显示快照。
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [liveView, setLiveView] = useState<ViewState>(initialView ?? deck.lastView);
  const [showGrid, setShowGrid] = useState(false);
  const [activeAxis, setActiveAxis] = useState<AxisDir | null>(null);
  const [lensOn, setLensOn] = useState(false);
  const [lensStrength, setLensStrength] = useState(50);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [mediaPanel, setMediaPanel] = useState<MediaPanelState | null>(null);
  const [penMode, setPenMode] = useState(false);
  const [viewLocked, setViewLocked] = useState(false);
  const [showAxes, setShowAxes] = useState(false);
  const [drawStroke, setDrawStroke] = useState<{ x: number; y: number }[] | null>(null);
  // 吸附参考线：拖动对象时命中的对齐线，抬起即清空
  const [guides, setGuides] = useState<GuideLine[]>([]);
  // 可视化编辑模式（裁剪 / 四角变形）由 Inspector 切换，属于纯视图状态
  const objectEditMode = useDeckStore((state) => state.objectEditMode);
  const updateObject = useDeckStore((state) => state.updateObject);
  // dismissedMediaRef：记录用户手动关闭过媒体浮层的对象 id，避免重新选中时又弹出。
  const dismissedMediaRef = useRef<string | null>(null);
  // 以下 ref 保存最新的 props / 派生状态：事件监听器是命令式注册的（wheel、pointer），
  // 若直接闭包捕获 state 会拿到旧值，因此统一通过 ref 读取当前值。
  const penRef = useRef(false);
  const lockRef = useRef(false);
  const drawCallbackRef = useRef(onDrawPath);
  const gesture = useRef<GestureState | null>(null);
  const wheelTimer = useRef<number>();
  // zoomBase：滚轮缩放的参考距离（最近一次显式 flyTo / 初始视角），用于计算缩放百分比范围。
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
  // 富文本原地编辑使用 contentEditable：DOM 内容由浏览器维护，提交时从这里读取 innerHTML
  const richEditorRef = useRef<HTMLDivElement | null>(null);

  // 每次渲染都把最新值写入 ref，保证事件回调中读到的是当前值而非首次渲染的值。
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

  /**
   * 富文本编辑器挂载后接管焦点，并把光标放到文末。
   * contentEditable 的 autoFocus 并不可靠，而点击双击进入编辑时光标落在开头会让用户误以为内容被替换。
   */
  useEffect(() => {
    if (editing?.kind !== 'rich') return;
    const element = richEditorRef.current;
    if (!element) return;
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    // 只在进入富文本编辑时执行一次；内容变化由浏览器自己维护
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.kind, editing?.id]);

  /**
   * 提交选中：优先使用多选回调；未提供时退化为单选回调（取数组第一项或 null）。
   * 之所以两个回调都可能存在，是为了兼容只需要单选能力的宿主页面。
   */
  const applySelection = (ids: string[]) => {
    if (onSelectMany) onSelectMany(ids);
    else onSelect?.(ids[0] ?? null);
  };

  // 统一选中顺序：把主选中对象放在最前，其余去重，保证 MultiPanel / 手柄只基于第一项。
  const selectionIds = selectedObjectId
    ? [selectedObjectId, ...selectedObjectIds.filter((id) => id !== selectedObjectId)]
    : selectedObjectIds;

  useLayoutEffect(() => {
    const container = boxRef.current;
    if (!container) return;
    // 仅创建一次：SceneManager 内部会自建 WebGL 渲染器与动画循环，
    // 重复创建会泄漏上下文，因此依赖数组为空，后续数据同步走下面的 sync effect。
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
    // 增量同步：SceneManager 会复用已有节点，只为新增对象建节点、删除失效节点、
    // 并按 visualKey 判断是否需要重建几何 / 纹理，避免每次渲染全量重建。
    manager.sync(deck, selectionIds, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, selectedObjectId, selectedObjectIds, mode]);

  useEffect(() => {
    // 网格只在编辑模式显示，查看 / 演示模式保持干净画面。
    managerRef.current?.setShowGrid(showGrid && mode === 'edit');
  }, [showGrid, mode]);

  useEffect(() => {
    managerRef.current?.setShowAxes(showAxes);
  }, [showAxes, mode]);

  useEffect(() => {
    if (mode !== 'edit') return;
    // 鱼眼强度在 UI 中是 10-100 的百分比，SceneManager 接收 0-1 的小数，这里做单位换算。
    managerRef.current?.setLens(lensOn ? 'fisheye' : 'none', lensStrength / 100);
  }, [lensOn, lensStrength, mode]);

  useEffect(() => {
    if (!imageRetry) return;
    const manager = managerRef.current;
    if (!manager) return;
    // 遍历所有计数条目并触发重载：store 中每次 retryImage 都会递增计数，
    // 这里不关心具体数值，只要映射对象变化就重试对应素材。
    for (const id of Object.keys(imageRetry)) manager.retryImage(id);
  }, [imageRetry]);

  useEffect(() => {
    // 切换选中对象时重置「已手动关闭媒体浮层」标记，允许新对象正常弹出播放器。
    dismissedMediaRef.current = null;
  }, [selectedObjectId]);

  useEffect(() => {
    if (mode !== 'edit' || !selectedObjectId) {
      setMediaPanel(null);
      return;
    }
    // 只有选中视频 / 音频对象时才显示媒体浮层；其他类型或已手动关闭则隐藏。
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
      // 用 projectRect 把对象在 3D 中的位置投影为屏幕矩形，让浮层跟随对象与运镜。
      const rect = manager.projectRect(selectedObjectId);
      // 宽度限制在 296-470px；位置同时被舞台边界约束，避免浮层跑出画布。
      const width = Math.max(296, Math.min(470, rect ? rect.width : 360));
      const left = Math.max(8, Math.min(Math.max(8, box.width - width - 8), rect ? rect.left : 8));
      let top = rect ? rect.top + rect.height + 10 : 8;
      // 下方空间不足时翻转到对象上方，最多再留 94px 高度。
      if (top + 94 > box.height) top = Math.max(8, (rect?.top ?? 0) - 94);
      setMediaPanel({ id: selectedObjectId, name: object.name, left, top, width, state });
    };
    refresh();
    // 150ms 轮询：相机可能由外部运镜或拖拽持续变化，用定时刷新比逐帧 setState 更省。
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
      // 舞台始终保持 16:9：以容器宽高中的较小约束为准，剩余空间留白（letterbox）。
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

  /**
   * 读取 SceneManager 当前视角，更新本地展示快照，并把变化上抛给 App。
   * 演示模式下是否写回 store 由调用方决定（flyTo 内即跳过）。
   */
  const commitView = () => {
    const manager = managerRef.current;
    if (!manager) return;
    const view = manager.getView();
    setLiveView(view);
    viewCallbackRef.current?.(view);
  };

  /** 编辑态运镜：等待动画结束后再提交视角，避免中间帧被写入历史。 */
  const flyEdit = async (view: ViewState, duration = 0.4) => {
    const manager = managerRef.current;
    if (!manager) return;
    await manager.flyTo(view, duration);
    commitView();
  };

  /**
   * 聚焦到指定对象：目标点取对象中心，距离由 fitDistance 按对象宽高与 FOV 计算，
   * 保留当前 yaw / pitch，只做平移与推拉，避免视角突然翻转。
   */
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
    // 展开默认视角对象，避免把 DEFAULT_VIEW 中的 target 引用直接共享给 SceneManager。
    await flyEdit({ ...DEFAULT_VIEW, target: { ...DEFAULT_VIEW.target } }, 0.35);
  };

  /**
   * 沿坐标轴观察：固定 yaw / pitch 组合切换到 ±X / ±Y / ±Z 方向。
   * 俯视 / 仰视用 1.42 rad（约 81°），因为相机 pitch 有 ±82° 的防翻转限制。
   */
  const lookAlong = (axis: AxisDir) => {
    if (lockRef.current) return;
    const manager = managerRef.current;
    if (!manager) return;
    setActiveAxis(axis);
    const current = manager.getView();
    // 方向定义：+X 从侧面看向原点；+Y / -Y 为俯视 / 仰视；+Z 为默认正面，-Z 为背面。
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
  // 输出的点列是相对包围盒的 0-1 归一化坐标（成对 x, y），对象后续缩放时路径可按比例重采样。
  const finalizeDraw = (points: { x: number; y: number }[]) => {
    const manager = managerRef.current;
    const callback = drawCallbackRef.current;
    // 少于 3 个采样点无法构成有意义的曲线，直接丢弃。
    if (!manager || !callback || points.length < 3) return;
    const strokeWidth = 6;
    // 包围盒要向外扩张半个线宽，否则笔画边缘会被裁掉。
    const padding = strokeWidth / 2;
    const z = nextDepth(deckRef.current.objects);
    // 关键坐标转换：把每个屏幕点投影到对象所在 z 平面，得到世界坐标。
    const world = points.map((point) => manager.screenToWorldOnPlane(point.x, point.y, z));
    const xs = world.map((point) => point.x);
    const ys = world.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = Math.max(8, maxX - minX + padding * 2);
    const height = Math.max(8, maxY - minY + padding * 2);
    // 包围盒左上角向内收缩半个线宽，使归一化后的路径落在 [0, 1] 内。
    const left = minX - padding;
    const top = minY - padding;
    const normalized: number[] = [];
    for (const point of world) {
      // clamp 到 0-1，防止世界坐标的浮点误差让路径越界。
      normalized.push(
        Math.max(0, Math.min(1, (point.x - left) / width)),
        Math.max(0, Math.min(1, (point.y - top) / height)),
      );
    }
    callback(normalized, { x: left, y: top, width, height }, strokeWidth);
  };

  /**
   * 向外部暴露命令式 API。
   * 这些方法大多直接转发给 SceneManager；只有视角、坐标轴、锁定等需要同步更新本地 UI 状态。
   */
  useImperativeHandle(
    ref,
    () => ({
      captureView: () => managerRef.current?.getView() ?? initialViewRef.current,
      waitAssets: async (timeout) => {
        await managerRef.current?.waitForAssets(timeout);
      },
      flyTo: async (view, duration = 0.4) => {
        const manager = managerRef.current;
        if (!manager) return;
        // 显式运镜后更新缩放基准，随后滚轮缩放会以新视角为中心。
        zoomBase.current = view.distance;
        await manager.flyTo(view, duration);
        const nextView = manager.getView();
        setLiveView(nextView);
        // 演示模式不把视角写回 store，避免播放过程中污染作品的 lastView。
        if (modeRef.current !== 'present') viewCallbackRef.current?.(nextView);
      },
      focus: focusObject,
      reset: resetView,
      replayCharts: () => managerRef.current?.replayChartAnimations(),
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
    // 相机请求是一次性指令：依赖 cameraRequest.id 而非整个对象，
    // 相同 id 不会重复执行，新请求才会触发对应运镜。
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
      // 编辑文本时滚轮用于滚动 textarea，不缩放舞台；同样跳过 textarea 自身的滚轮事件。
      if (modeRef.current === 'edit' && editingRef.current) return;
      if (event.target instanceof HTMLElement && event.target.tagName === 'TEXTAREA') return;
      event.preventDefault();
      if (lockRef.current) return;
      const manager = managerRef.current;
      if (!manager) return;
      // 指数缩放：deltaY 每约 580 对应 e 倍，滚轮手感更平滑且与浏览器缩放步长无关。
      const factor = Math.exp(event.deltaY * 0.0012);
      const base = zoomBase.current;
      // 演示模式限制在基准距离的 1/8 - 10 倍；编辑模式用固定世界距离范围。
      const min = modeRef.current === 'present' ? base / 8 : 20;
      const max = modeRef.current === 'present' ? base * 10 : 60000;
      manager.zoomAt(event.clientX, event.clientY, factor, min, max);
      setActiveAxis(null);
      const view = manager.getView();
      setLiveView(view);
      // 防抖 260ms：连续滚轮期间只在停下来后提交一次视角，避免频繁写 store 与历史。
      if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => {
        if (modeRef.current !== 'present') commitView();
      }, 260);
    };
    el.addEventListener('wheel', handler, { passive: false });
    // 必须 passive: false 才能 preventDefault，阻止页面随滚轮一起滚动。
    return () => el.removeEventListener('wheel', handler);
  }, []);

  useEffect(() => {
    return () => {
      if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    };
  }, []);

  /** 把 client 坐标换算为舞台容器的局部像素坐标（框选、画笔预览使用）。 */
  const localPoint = (clientX: number, clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  /**
   * 指针按下：按固定优先级决定本次手势类型，并记录初始快照。
   *
   * 判定顺序：右键平移 → 非编辑模式（演示环绕 / 查看平移）→ 画笔绘制
   * → 角点手柄缩放 → 对象点选 / 拖拽 → 空白处框选。
   * 先判断手柄再判断对象，保证点击手柄时不会误选并拖动整个对象。
   */
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (editingRef.current) return;
    const manager = managerRef.current;
    if (!manager) return;
    const target = event.target as HTMLElement;
    // 命中原生 textarea / 按钮 / 媒体浮层时不启动舞台手势，避免与控件自身交互冲突。
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
      // 右键拖拽平移；演示模式或锁定视角下不响应，右键菜单已在 JSX 中屏蔽。
      if (mode === 'present' || lockRef.current) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { ...base, mode: 'pan' };
      return;
    }
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.altKey && !lockRef.current) {
      // Alt + 左键拖拽环绕视角；优先于对象拖拽，便于在对象上方调整取景。
      gesture.current = { ...base, mode: 'orbit' };
      return;
    }
    if (mode !== 'edit') {
      if (lockRef.current) return;
      // 查看模式左键平移，演示模式左键环绕；两者都不做对象级操作。
      gesture.current = { ...base, mode: mode === 'present' ? 'orbit' : 'pan' };
      return;
    }
    if (penRef.current) {
      // 画笔模式：记录容器偏移与起点，后续移动用局部坐标实时预览笔迹。
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
    // 先测试四角缩放手柄；命中后用对象原始几何作为快照，并计算图片锁定比例。
    const handle = manager.hitTestHandle(event.clientX, event.clientY);
    if (handle) {
      const object = deckRef.current.objects.find((item) => item.id === handle.id);
      if (object) {
        // 只有图片且开启比例锁定时传入宽高比；其他类型为 null，允许自由缩放。
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
      // Shift / Ctrl / Cmd 为追加或取消选择；否则只保留命中项（已在选择中则保持现有集合）。
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
      // 取消选中（从追加集合中移除）时不进入拖拽，避免误移动刚被取消的对象。
      if (!ids.includes(hitId)) return;
      const object = deckRef.current.objects.find((item) => item.id === hitId);
      if (!object) return;
      // 记录所有选中对象的初始位置：多选拖拽时每个对象都叠加同一世界位移，保持相对布局。
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
    // 空白处按下进入框选；按住修饰键时以现有选择为基础做并集。
    gesture.current = {
      ...base,
      mode: 'marquee',
      baseSelection: event.shiftKey || event.ctrlKey || event.metaKey ? selectionRef.current : [],
      marquee: { left: start.x, top: start.y, width: 0, height: 0 },
    };
    // 先清空可视框选，等真正移动超过阈值后再显示。
    setMarquee(null);
  };

  /**
   * 计算拖拽吸附。
   *
   * 判定在世界坐标里做（旋转对象按未旋转包围盒近似，与框选 / 对齐策略一致），
   * 阈值用 6 个屏幕像素换算成世界单位，保证缩放到任何层级时手感一致；
   * 参考线本身要用屏幕坐标，因此命中后按对方对象的投影矩形取线位置，
   * 线段横跨「被拖对象 + 对齐对象」的范围，视觉上就像 PPT 的智能参考线。
   *
   * @param ids     本次拖拽的全部对象（参与吸附的对象自身要排除）
   * @param centerX 主拖拽对象的候选中心 X（世界坐标）
   * @param centerY 主拖拽对象的候选中心 Y（世界坐标）
   * @param width   主拖拽对象宽度
   * @param height  主拖拽对象高度
   * @returns 需要追加的位移与要显示的参考线
   */
  const snapDrag = (
    ids: string[],
    centerX: number,
    centerY: number,
    width: number,
    height: number,
  ): { dx: number; dy: number; guides: GuideLine[] } => {
    const manager = managerRef.current;
    if (!manager) return { dx: 0, dy: 0, guides: [] };
    const threshold = manager.pixelToWorld(6);
    const self = new Set(ids);
    // 拖拽对象的 3 条竖线（左 / 中 / 右）与 3 条横线（上 / 中 / 下）
    const movingX = [centerX - width / 2, centerX, centerX + width / 2];
    const movingY = [centerY - height / 2, centerY, centerY + height / 2];
    const selfRect = manager.projectRect(ids[0] ?? '');
    let bestX = Number.POSITIVE_INFINITY;
    let bestY = Number.POSITIVE_INFINITY;
    let dx = 0;
    let dy = 0;
    let lineX: GuideLine | null = null;
    let lineY: GuideLine | null = null;
    for (const other of deckRef.current.objects) {
      if (self.has(other.id) || !other.visible) continue;
      const rect = manager.projectRect(other.id);
      if (!rect) continue;
      const targetX = [other.x - other.width / 2, other.x, other.x + other.width / 2];
      const targetY = [other.y - other.height / 2, other.y, other.y + other.height / 2];
      for (let mi = 0; mi < 3; mi += 1) {
        for (let ti = 0; ti < 3; ti += 1) {
          const delta = targetX[ti] - movingX[mi];
          if (Math.abs(delta) < bestX) {
            bestX = Math.abs(delta);
            dx = delta;
            // 参考线的屏幕位置：对方矩形的左 / 中 / 右
            const pos = ti === 0 ? rect.left : ti === 1 ? rect.left + rect.width / 2 : rect.left + rect.width;
            const from = Math.min(rect.top, selfRect?.top ?? rect.top) - 12;
            const to = Math.max(
              rect.top + rect.height,
              (selfRect?.top ?? rect.top) + (selfRect?.height ?? rect.height),
            ) + 12;
            lineX = { axis: 'x', pos, from, to };
          }
          const deltaY = targetY[ti] - movingY[mi];
          if (Math.abs(deltaY) < bestY) {
            bestY = Math.abs(deltaY);
            dy = deltaY;
            const pos = ti === 0 ? rect.top : ti === 1 ? rect.top + rect.height / 2 : rect.top + rect.height;
            const from = Math.min(rect.left, selfRect?.left ?? rect.left) - 12;
            const to = Math.max(
              rect.left + rect.width,
              (selfRect?.left ?? rect.left) + (selfRect?.width ?? rect.width),
            ) + 12;
            lineY = { axis: 'y', pos, from, to };
          }
        }
      }
    }
    return {
      dx: bestX <= threshold ? dx : 0,
      dy: bestY <= threshold ? dy : 0,
      guides: [
        ...(bestX <= threshold && lineX ? [lineX] : []),
        ...(bestY <= threshold && lineY ? [lineY] : []),
      ],
    };
  };

  /**
   * 指针移动：没有手势时负责手柄光标反馈；有手势时按类型更新视图或对象。
   * 所有增量位移都基于 lastX / lastY 的差值，避免长距离拖拽时坐标漂移。
   */
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state) {
      // 悬停在缩放手柄上时切换对角线光标，提示可拖拽缩放。
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
    // 4px 阈值用于区分「点击」与「拖拽」：小于阈值不认为发生了移动。
    if (!state.moved && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 4) {
      state.moved = true;
    }
    if (state.mode === 'marquee') {
      // 框选：用按下点与当前点构造规范化矩形（允许任意方向拖拽）。
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
      // 采样节流：移动不足 2px 不记录新点，减少点列规模与后续贝塞尔计算量。
      if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 2) return;
      state.drawPoints.push({ x: event.clientX, y: event.clientY });
      // 预览用舞台局部坐标，避免画布随页面滚动时笔迹偏移。
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
      // 屏幕坐标 → 对象 z 平面上的世界坐标；两次世界坐标之差即为对象应移动的位移。
      const point = manager.screenToWorldOnPlane(
        event.clientX,
        event.clientY,
        state.startObject?.z ?? state.startPositions[0]?.z ?? 0,
      );
      let worldX = point.x - state.startWorld.x;
      let worldY = point.y - state.startWorld.y;
      // 吸附：按主拖拽对象的边缘 / 中心与其它对象的边缘 / 中心对齐
      const primaryStart = state.startPositions.find((item) => item.id === state.objectId);
      const primaryObject = deckRef.current.objects.find((item) => item.id === state.objectId);
      if (primaryStart && primaryObject) {
        const snap = snapDrag(
          state.startPositions.map((item) => item.id),
          primaryStart.x + worldX,
          primaryStart.y + worldY,
          primaryObject.width,
          primaryObject.height,
        );
        worldX += snap.dx;
        worldY += snap.dy;
        setGuides(snap.guides);
      }
      for (const start of state.startPositions) {
        onMoveObject?.(start.id, start.x + worldX, start.y + worldY);
      }
    } else if (state.mode === 'resize' && state.resize && state.startWorld && state.corner) {
      const start = state.resize;
      const point = manager.screenToWorldOnPlane(event.clientX, event.clientY, start.z);
      // 旋转对象需在「对象本地坐标系」里计算缩放：用旋转角的 cos / sin 把世界位移反旋。
      const rad = (start.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const wx = point.x - state.startWorld.x;
      const wy = point.y - state.startWorld.y;
      const lx = wx * cos + wy * sin;
      const ly = -wx * sin + wy * cos;
      // 角点方向决定缩放的正负：东 / 南方向为正，西 / 北方向为负。
      const sx = state.corner.includes('e') ? 1 : -1;
      const sy = state.corner.includes('s') ? 1 : -1;
      // 最小尺寸 8px，避免对象被缩成不可见或出现除零问题。
      let width = Math.max(8, start.width + sx * lx);
      let height = Math.max(8, start.height + sy * ly);
      if (start.ratio) {
        // 锁定比例时取主导轴（位移较大的方向）决定尺寸，另一轴按比例推导。
        if (Math.abs(sx * lx) >= Math.abs(sy * ly)) height = Math.max(8, width / start.ratio);
        else width = Math.max(8, height * start.ratio);
      }
      const dw = width - start.width;
      const dh = height - start.height;
      // 缩放时保持对角点不动，因此中心要沿角点方向偏移一半尺寸变化，并再旋回世界坐标。
      const cx = start.x + (sx * dw) / 2 * cos - (sy * dh) / 2 * sin;
      const cy = start.y + (sx * dw) / 2 * sin + (sy * dh) / 2 * cos;
      onResizeObject?.(state.objectId!, { x: cx, y: cy, width, height });
    } else if (state.mode === 'orbit') {
      // 环绕与平移都按「上一次移动增量」处理；一旦手动操作即取消轴视角高亮。
      manager.orbitBy(dx, dy);
      setActiveAxis(null);
    } else if (state.mode === 'pan') {
      manager.panBy(dx, dy);
      setActiveAxis(null);
    }
  };

  /**
   * 指针抬起：结束本次手势并统一收尾。
   *
   * 收尾内容：释放指针捕获、提交画笔路径 / 框选结果、通知上层手势结束、
   * 在编辑 / 查看模式下提交视角；演示模式下的「无位移点击」额外触发单击回调。
   */
  const endGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state) return;
    gesture.current = null;
    setMarquee(null);
    setGuides([]);
    if (boxRef.current) boxRef.current.style.cursor = '';
    try {
      event.currentTarget.releasePointerCapture(state.pointerId);
    } catch {
      // ignore
      // 指针可能已因窗口失焦被浏览器自动释放，重复释放抛错可安全忽略。
    }
    if (state.mode === 'draw') {
      setDrawStroke(null);
      // 只有发生过移动才生成路径，避免单击画笔模式时创建一条退化曲线。
      if (state.moved) finalizeDraw(state.drawPoints ?? []);
      if (mode === 'edit' || mode === 'view') commitView();
      return;
    }
    if (state.mode === 'marquee') {
      const rect = state.marquee;
      // 有效框选需满足最小 4px 尺寸；否则视为普通点击空白处。
      if (state.moved && rect && rect.width > 4 && rect.height > 4) {
        const manager = managerRef.current;
        const ids = manager?.hitTestRect(rect.left, rect.top, rect.width, rect.height) ?? [];
        // 与按下时的基础选择合并并去重，实现追加框选。
        const merged = [...new Set([...(state.baseSelection ?? []), ...ids])];
        applySelection(merged);
      } else if ((state.baseSelection ?? []).length === 0) {
        // 空白处单击（且未按住修饰键）：清空选择。
        applySelection([]);
      }
    }
    // 有效拖拽结束后通知上层关闭历史合并窗口，使下一次操作成为独立撤销步骤。
    if (state.moved) onGestureEnd?.();
    if (mode === 'edit' || mode === 'view') {
      // 视角可能已通过 orbit / pan 改变，统一在此提交一次。
      commitView();
    }
    if (!state.moved && mode === 'present') {
      // 演示模式单击（非拖拽）用于翻页 / 下一步等外部行为。
      stageClickCallbackRef.current?.();
    }
  };

  /**
   * 双击处理：演示模式上抛回调；编辑模式双击媒体打开播放器、双击文本进入原地编辑。
   * 其他对象类型双击不响应。
   */
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
      // 双击媒体：清除「已关闭」标记，选中对象并切换播放 / 暂停状态。
      dismissedMediaRef.current = null;
      onSelect?.(id);
      const state = manager.getMediaState(id);
      if (state) manager.toggleMedia(id);
      return;
    }
    if (object.type !== 'text') return;
    // 文本编辑需要屏幕矩形：projectRect 同时给出排版换算后的字号、行高与内边距。
    const rect = manager.projectRect(id);
    if (!rect) return;
    onSelect?.(id);
    const text = object as TextObject;
    // 富文本且 HTML-in-Canvas 可用时进入 contentEditable 编辑，样式与画布上的渲染一致；
    // 其他情况沿用 textarea 的纯文本编辑
    const rich = Boolean(text.html) && text.htmlInCanvas !== false && htmlInCanvasSupported();
    setEditing({ id, kind: rich ? 'rich' : 'plain', draft: text.text, rect, object: text });
  };

  /**
   * 提交文本编辑：只有内容确实变化时才写回 store；长度上限 5000 字与 LIMITS.textChars 对齐。
   * 失焦和 Ctrl / Cmd + Enter 都会走这里。
   *
   * 富文本路径读出 contentEditable 的 innerHTML 后重新清洗（浏览器粘贴进来的样式并不受控），
   * 再把清洗结果与纯文本投影一起提交；内容为空时上层会删除该对象。
   */
  const commitEditing = () => {
    const state = editingRef.current;
    if (!state) return;
    editingRef.current = null;
    setEditing(null);
    if (state.kind === 'rich') {
      const element = richEditorRef.current;
      richEditorRef.current = null;
      const raw = element?.innerHTML ?? '';
      const rich = sanitizeRichHtml(raw);
      if (!rich) {
        // 全部内容被删空：按空文本提交，让上层删除对象
        if (state.object.text) onTextCommit?.(state.id, '');
        return;
      }
      if (rich.html !== (state.object.html ?? '') || rich.text !== state.object.text) {
        onTextCommit?.(state.id, rich.text, rich.html);
      }
      return;
    }
    const text = state.draft.slice(0, 5000);
    if (text !== state.object.text) onTextCommit?.(state.id, text);
  };

  /** 取消文本编辑：直接丢弃草稿，不改动原对象。 */
  const cancelEditing = () => {
    editingRef.current = null;
    setEditing(null);
  };

  /**
   * 拖放文件到舞台：把落点换算到新对象深度平面上的世界坐标，
   * 优先交给通用 onAddFile（可识别图片 / 视频 / 模型等），否则退化为图片回调。
   */
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (mode !== 'edit') return;
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const manager = managerRef.current;
    if (!manager) return;
    const z = nextDepth(deckRef.current.objects);
    // 落点只在拖放瞬间换算一次，新对象会以该点为中心插入。
    const point = manager.screenToWorldOnPlane(event.clientX, event.clientY, z);
    if (onAddFile) onAddFile(file, point);
    else onAddImageFile?.(file, point);
  };

  /** 媒体浮层操作转发：toggle / seek / volume 直接透传，mute 依据当前状态取反。 */
  const mediaCommand = (id: string, action: 'toggle' | 'seek' | 'volume' | 'mute', value?: number) => {
    const manager = managerRef.current;
    if (!manager) return;
    if (action === 'toggle') manager.toggleMedia(id);
    else if (action === 'seek') manager.seekMedia(id, value ?? 0);
    else if (action === 'volume') manager.setMediaVolume(id, value ?? 0);
    else manager.setMediaMuted(id, !(manager.getMediaState(id)?.muted ?? false));
  };

  // 聚焦按钮只在编辑模式且有选中对象时可用。
  const canFocus = mode === 'edit' && selectedObjectId && deck.objects.some((item) => item.id === selectedObjectId);
  // 可视化编辑浮层只针对「当前选中的图片对象」；投影矩形随运镜更新
  const overlayObject =
    mode === 'edit' && selectedObjectId ? deck.objects.find((item) => item.id === selectedObjectId) : undefined;
  const overlayRect =
    overlayObject && overlayObject.type === 'image'
      ? managerRef.current?.projectRect(overlayObject.id) ?? null
      : null;

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
            {/* 视图工具条：重置 / 网格 / 聚焦 / 画笔 / 鱼眼 / 坐标轴 / 视角锁定，仅编辑模式可见 */}
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
              className={`stage-tool ${lensOn ? 'is-active' : ''}`}
              onClick={() => setLensOn((value) => !value)}
              title="鱼眼预览，可在右侧调节强度"
              aria-pressed={lensOn}
            >
              <Icon name="fisheye" size={16} />
              <span>鱼眼</span>
            </button>
            {lensOn && (
              <label className="stage-lens-control" title="鱼眼强度">
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={1}
                  value={lensStrength}
                  aria-label="鱼眼强度"
                  onChange={(event) => setLensStrength(Number(event.target.value))}
                />
                <span>{lensStrength}%</span>
              </label>
            )}
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
                    className={`stage-axis-btn${activeAxis === axis ? ' is-active' : ''}`}
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
            {/* 画笔实时预览层：用平滑贝塞尔路径连接采样点，仅作视觉反馈，松手后转为正式对象 */}
            <path
              d={smoothPathD(drawStroke)}
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

        {editing && editing.kind === 'plain' && (
          <textarea
            className="text-editor"
            autoFocus
            value={editing.draft}
            spellCheck={false}
            style={{
              // 把 SceneManager.projectRect 给出的屏幕矩形与排版度量直接套到 textarea，
              // 使其覆盖在原 3D 文本上，形成「原地编辑」的视觉效果。
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
              // 输入过程中只更新本地草稿，不写 store；失焦 / Ctrl+Enter 时统一提交。
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

        {editing && editing.kind === 'rich' && (
          <div
            className="text-editor text-editor-rich"
            ref={richEditorRef}
            contentEditable
            suppressContentEditableWarning
            autoFocus
            spellCheck={false}
            // 初始内容只在挂载时注入一次，之后由浏览器维护 DOM，避免 React 重置光标；
            // 粘贴走浏览器的原生富文本粘贴，样式原样进入 DOM，提交时再统一清洗。
            dangerouslySetInnerHTML={{ __html: editing.object.html ?? '' }}
            style={{
              // 版面度量与纯文本编辑器一致，保证「原地编辑」的浮层与 3D 文本重合
              left: editing.rect.left,
              top: editing.rect.top,
              width: Math.max(40, editing.rect.width),
              height: Math.max(40, editing.rect.height),
              fontFamily: FONT_STACKS[editing.object.font],
              // 富文本内部字号是 em 相对值，这里的基准字号必须与画布渲染一致
              fontSize: Math.max(8, editing.rect.fontPx),
              lineHeight: Math.max(6, editing.rect.lineHeightPx) / Math.max(8, editing.rect.fontPx),
              color: editing.object.color,
              textAlign: editing.object.align,
              fontWeight: editing.object.bold ? 700 : 400,
              paddingTop: editing.rect.paddingTop,
              background: deck.background,
            }}
            onPointerDown={(event) => event.stopPropagation()}
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

        {/* 媒体浮层由 150ms 轮询保持跟随对象；关闭时记录 id，防止再次自动弹出 */}
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

        {/* 框选可视矩形；命中检测在松手时由 SceneManager.hitTestRect 完成 */}
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

        {/* 吸附参考线：命中边缘 / 中心对齐时显示，拖动结束即清空 */}
        {guides.map((guide, index) => (
          <div
            key={`guide-${guide.axis}-${index}`}
            className="stage-guide"
            style={
              guide.axis === 'x'
                ? { left: guide.pos, top: guide.from, width: 1, height: Math.max(0, guide.to - guide.from) }
                : { left: guide.from, top: guide.pos, width: Math.max(0, guide.to - guide.from), height: 1 }
            }
          />
        ))}

        {/* 图片裁剪浮层：内部区域可整体拖动，八个把手调整取景框 */}
        {overlayObject && overlayObject.type === 'image' && overlayRect && objectEditMode === 'crop' && (
          <CropOverlay
            object={overlayObject}
            rect={overlayRect}
            onChange={(crop) => updateObject(overlayObject.id, { crop }, `crop:${overlayObject.id}`)}
          />
        )}

        {/* 四角变形浮层：拖动四个圆点把矩形拉成任意四边形 */}
        {overlayObject && overlayObject.type === 'image' && overlayRect && objectEditMode === 'perspective' && (
          <PerspectiveOverlay
            object={overlayObject}
            rect={overlayRect}
            onChange={(perspective) => updateObject(overlayObject.id, { perspective }, `perspective:${overlayObject.id}`)}
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

/** 把归一化裁剪框夹到合法范围：宽高至少 2%，整体不越界 */
function clampCrop(crop: ImageCrop): ImageCrop {
  const width = Math.min(1, Math.max(0.02, crop.width));
  const height = Math.min(1, Math.max(0.02, crop.height));
  return {
    x: Math.min(1 - width, Math.max(0, crop.x)),
    y: Math.min(1 - height, Math.max(0, crop.y)),
    width,
    height,
  };
}

/**
 * 图片可视化裁剪浮层。
 *
 * 取景框按投影矩形定位：crop 是原图比例，乘以屏幕矩形即得到取景框的屏幕位置。
 * 八个把手各自只改对应的边（角把手同时改两条边），框内区域整体平移取景。
 * 遮罩用超大 box-shadow 实现，不需要额外遮罩层就能压暗框外内容。
 */
function CropOverlay({
  object,
  rect,
  onChange,
}: {
  object: ImageObject;
  rect: { left: number; top: number; width: number; height: number };
  onChange: (crop: ImageCrop) => void;
}) {
  const crop = object.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const drag = useRef<{ key: string; startX: number; startY: number; crop: ImageCrop } | null>(null);
  const box = {
    left: rect.left + crop.x * rect.width,
    top: rect.top + crop.y * rect.height,
    width: crop.width * rect.width,
    height: crop.height * rect.height,
  };
  const handles: { key: string; left: number; top: number; cursor: string }[] = [
    { key: 'nw', left: box.left, top: box.top, cursor: 'nwse-resize' },
    { key: 'n', left: box.left + box.width / 2, top: box.top, cursor: 'ns-resize' },
    { key: 'ne', left: box.left + box.width, top: box.top, cursor: 'nesw-resize' },
    { key: 'e', left: box.left + box.width, top: box.top + box.height / 2, cursor: 'ew-resize' },
    { key: 'se', left: box.left + box.width, top: box.top + box.height, cursor: 'nwse-resize' },
    { key: 's', left: box.left + box.width / 2, top: box.top + box.height, cursor: 'ns-resize' },
    { key: 'sw', left: box.left, top: box.top + box.height, cursor: 'nesw-resize' },
    { key: 'w', left: box.left, top: box.top + box.height / 2, cursor: 'ew-resize' },
  ];

  const begin = (key: string) => (event: ReactPointerEvent<HTMLDivElement>) => {
    // 阻止冒泡：否则舞台会把拖拽当成「移动对象」
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { key, startX: event.clientX, startY: event.clientY, crop: { ...crop } };
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    event.stopPropagation();
    const dx = rect.width > 0 ? (event.clientX - state.startX) / rect.width : 0;
    const dy = rect.height > 0 ? (event.clientY - state.startY) / rect.height : 0;
    let left = state.crop.x;
    let top = state.crop.y;
    let right = state.crop.x + state.crop.width;
    let bottom = state.crop.y + state.crop.height;
    if (state.key === 'move') {
      // 整体平移：保持宽高，只移动左上角
      left = Math.min(1 - state.crop.width, Math.max(0, left + dx));
      top = Math.min(1 - state.crop.height, Math.max(0, top + dy));
      right = left + state.crop.width;
      bottom = top + state.crop.height;
    } else {
      if (state.key.includes('w')) left = Math.min(right - 0.02, Math.max(0, left + dx));
      if (state.key.includes('e')) right = Math.max(left + 0.02, Math.min(1, right + dx));
      if (state.key.includes('n')) top = Math.min(bottom - 0.02, Math.max(0, top + dy));
      if (state.key.includes('s')) bottom = Math.max(top + 0.02, Math.min(1, bottom + dy));
    }
    onChange(clampCrop({ x: left, y: top, width: right - left, height: bottom - top }));
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针可能已被浏览器释放，忽略重复释放
    }
  };

  return (
    <div className="crop-overlay" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
      <div
        className="crop-frame"
        style={{ left: box.left - rect.left, top: box.top - rect.top, width: box.width, height: box.height }}
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div
        className="crop-grid"
        style={{ left: box.left - rect.left, top: box.top - rect.top, width: box.width, height: box.height }}
      >
        {/* 三分构图辅助线，帮助判断取景比例 */}
        <span style={{ left: '33.33%' }} />
        <span style={{ left: '66.66%' }} />
        <span className="is-h" style={{ top: '33.33%' }} />
        <span className="is-h" style={{ top: '66.66%' }} />
      </div>
      {handles.map((handle) => (
        <div
          key={handle.key}
          className="crop-handle"
          // 把手定位在浮层内部坐标：减去浮层自身的 left/top，避免二次偏移
          style={{ left: handle.left - rect.left - 6, top: handle.top - rect.top - 6, cursor: handle.cursor }}
          onPointerDown={begin(handle.key)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
    </div>
  );
}

/**
 * 四角自由变形浮层。
 *
 * 角点用归一化坐标存（0–1，相对对象框），拖动时换算回屏幕位置，
 * 松手立即写回 perspective，Three.js 侧按四角双线性插值重建几何。
 */
function PerspectiveOverlay({
  object,
  rect,
  onChange,
}: {
  object: ImageObject;
  rect: { left: number; top: number; width: number; height: number };
  onChange: (perspective: NonNullable<ImageObject['perspective']>) => void;
}) {
  const corners = object.perspective ?? {
    tl: { x: 0, y: 0 },
    tr: { x: 1, y: 0 },
    br: { x: 1, y: 1 },
    bl: { x: 0, y: 1 },
  };
  const drag = useRef<{ key: 'tl' | 'tr' | 'br' | 'bl'; startX: number; startY: number; start: typeof corners } | null>(
    null,
  );
  const screen = (point: { x: number; y: number }) => ({
    left: rect.left + point.x * rect.width,
    top: rect.top + point.y * rect.height,
  });

  const begin = (key: 'tl' | 'tr' | 'br' | 'bl') => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { key, startX: event.clientX, startY: event.clientY, start: corners };
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    event.stopPropagation();
    const nx = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const ny = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
    onChange({
      ...state.start,
      [state.key]: { x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)) },
    });
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  };

  const list = (
    [
      ['tl', corners.tl],
      ['tr', corners.tr],
      ['br', corners.br],
      ['bl', corners.bl],
    ] as const
  ).map(([key, point]) => ({ key, ...screen(point) }));
  const polyline = list.map((item) => `${item.left - rect.left},${item.top - rect.top}`).join(' ');

  return (
    <div className="perspective-overlay" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
      <svg className="perspective-lines" width={rect.width} height={rect.height} aria-hidden="true">
        <polyline points={polyline} />
      </svg>
      {list.map((item) => (
        <div
          key={item.key}
          className="perspective-handle"
          style={{ left: item.left - rect.left - 7, top: item.top - rect.top - 7 }}
          onPointerDown={begin(item.key)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
    </div>
  );
}
