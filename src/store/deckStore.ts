/**
 * deckStore.ts —— 3D 幻灯片编辑器全局状态仓库
 *
 * 基于 Zustand 实现，集中管理编辑器中所有跨组件共享的状态与操作：
 * - 作品（Deck）的打开 / 关闭、只读编辑锁、加载错误与保存状态
 * - 对象的选中状态，以及各类对象的增删改
 * - 对象层级（z 轴）排序、以及帧（Frame）的捕获 / 更新 / 排序
 * - 视角与相机（镜头）运镜请求
 * - 撤销 / 重做历史栈（最多保留 50 步）
 * - 图片加载失败信息与重试计数
 *
 * 设计约定：
 * - 所有会修改 deck 的操作都统一走内部辅助函数 `applyDeck`，由它集中处理
 *   历史记录、脏标记与自动保存调度，避免各处逻辑不一致。
 * - 只读模式（readonly === true，通常是锁未获取成功）下，所有写操作直接返回。
 * - 每次修改先标记为 dirty，再延迟 2 秒自动保存，避免拖拽时频繁写存储。
 */

import { create } from 'zustand';
// 仅导入类型：这些接口描述 Deck、对象、帧与保存状态的数据结构，
// TypeScript 编译后会被擦除，不会产生任何运行时依赖。
import type {
  CameraRequest,
  ChartObject,
  Deck,
  Frame,
  ImageObject,
  MediaKind,
  ModelFormat,
  SaveStatus,
  ShapeKind,
  ShapeObject,
  SlideObject,
  TextObject,
  ViewState,
} from '../types';
// 全局限制值（对象数量上限、坐标范围、文本字数、时长范围等）与各项默认值。
import { LIMITS, DEFAULT_VIEW, DEFAULT_SHAPE_COLOR, DEFAULT_HOLD } from '../lib/constants';
// 对象工厂与计算工具：负责创建各类对象、计算新层级、自动命名、数值裁剪等。
import {
  autoTextHeight,
  clampNumber,
  createAudioObject,
  createChartObject,
  createImageObject,
  createLottieObject,
  createModelObject,
  createShapeObject,
  createSvgObject,
  createTextObject,
  createVideoObject,
  nameForObject,
  nextDepth,
  nextFrameName,
} from '../lib/deck';
// 持久化层：读取 / 写入作品数据，以及跨标签页的编辑锁（避免同一作品被同时编辑）。
import { acquireDeckLock, getDeck, putDeck, releaseDeckLock } from '../lib/storage';
// 各形状类型对应的中文显示名，用于生成「矩形 1」这类自动名称。
import { SHAPE_LABELS } from '../types';
// 图表插件注册中心：插入图表与编辑数据时按对象上的 plugin 字段解析能力。
import { resolveChartPlugin } from '../plugins/registry';

/** 对象局部更新补丁：只携带需要修改的字段，未出现的字段保持原值。 */
type ObjectPatch = Partial<SlideObject>;

/**
 * 编辑器全局状态与可用操作的定义。
 * 上半部分是状态字段（只读数据），下半部分是操作方法（按功能分组排列）。
 */
interface DeckStore {
  /** 当前打开的作品；为 null 表示尚未打开任何作品。 */
  deck: Deck | null;
  /** 当前相机视角（距离、朝向、目标点），是 3D 场景渲染的唯一数据源。 */
  view: ViewState;
  /** 主选中对象 id；多选时取选中集合中的第一个，便于属性面板展示。 */
  selectedObjectId: string | null;
  /** 选中对象集合（支持多选）；单选时长度为 1。 */
  selectedIds: string[];
  /** 当前选中的帧 id（与选中对象互斥）。 */
  selectedFrameId: string | null;
  /** 当前播放/定位到的帧 id，用于播放器与时间轴高亮。 */
  currentFrameId: string | null;
  /** 是否只读：true 时无法编辑、无法保存（通常因为未获取到编辑锁或加载失败）。 */
  readonly: boolean;
  /** 是否正在加载作品数据。 */
  loading: boolean;
  /** 加载失败的提示文案；为 null 表示无错误。 */
  loadError: string | null;
  /** 保存状态机的当前状态：saved / dirty / saving / error。 */
  saveStatus: SaveStatus;
  /** 撤销历史栈，栈顶为最近一次修改前的 deck 快照；最多保留 50 条。 */
  past: Deck[];
  /** 重做历史栈，栈首为最近一次被撤销的 deck 快照。 */
  future: Deck[];
  /** 待执行的相机请求；id 自增，场景消费后据此触发运镜。 */
  cameraRequest: CameraRequest | null;
  /** 图片加载失败信息：对象 id -> 错误提示。 */
  imageErrors: Record<string, string>;
  /** 图片重试计数：对象 id -> 重试次数，次数变化会促使图片重新加载。 */
  imageRetry: Record<string, number>;

  // —— 作品生命周期 ——
  /** 按 id 加载作品并获取编辑锁；失败时写入 loadError 并进入只读。 */
  openDeck: (id: string) => Promise<void>;
  /** 关闭当前作品，必要时先强制保存；保存失败且非 force 时返回 false。 */
  closeDeck: (force?: boolean) => Promise<boolean>;
  /** 仅供测试使用：直接把 deck 注入 store，跳过持久化与加锁。 */
  loadDeckForTest: (deck: Deck, readonly?: boolean) => void;

  // —— 保存状态与视角 ——
  /** 外部手动更新保存状态（例如导入后置为 dirty）。 */
  setSaveStatus: (status: SaveStatus) => void;
  /** 提交视角：更新实时 view，并在有变化时写入 deck.lastView 触发保存。 */
  commitView: (view: ViewState) => void;
  /** 发起通用相机请求（如飞行、聚焦到帧等），id 会自动补齐。 */
  requestCamera: (request: Omit<CameraRequest, 'id'>) => void;
  /** 请求相机恢复默认视角。 */
  requestReset: () => void;
  /** 请求相机聚焦到某个对象。 */
  requestFocus: (objectId: string) => void;

  // —— 选中与删除 ——
  /** 单选：id 为 null 时清空选择。 */
  selectObject: (id: string | null) => void;
  /** 多选：自动去重，并以第一个 id 作为主选中。 */
  selectObjects: (ids: string[]) => void;
  /** 切换某个对象的选中状态（已选中则取消，否则追加）。 */
  toggleObjectSelection: (id: string) => void;
  /** 批量删除对象，并同步清理选中集合。 */
  removeObjects: (ids: string[]) => void;
  /** 选中帧；默认会触发相机飞行到该帧视角。 */
  selectFrame: (id: string | null, fly?: boolean) => void;
  /** 仅更新「当前帧」指针，不改变选中状态（播放时使用）。 */
  setCurrentFrame: (id: string | null) => void;

  // —— 作品属性 ——
  /** 重命名作品（自动 trim 并按字数上限截断）。 */
  renameDeck: (title: string) => void;
  /** 更新作品设置（背景、默认帧时长、是否显示进度条）。 */
  updateDeckSettings: (patch: Partial<Pick<Deck, 'background' | 'defaultDuration' | 'showProgress'>>, historyKey?: string) => void;

  // —— 新增对象（均返回新对象 id，失败或超限时返回 null）——
  /** 在当前视角中心新增文本对象。 */
  addText: () => string | null;
  /** 新增指定形状对象。 */
  addShape: (shape: ShapeKind) => string | null;
  /** 新增 SVG 矢量对象，可指定落点坐标（世界坐标）。 */
  addSvg: (src: string, naturalWidth: number, naturalHeight: number, point?: { x: number; y: number }) => string | null;
  /** 新增 Lottie 动画对象，poster 可作为未播放时的封面。 */
  addLottie: (
    src: string,
    naturalWidth: number,
    naturalHeight: number,
    duration: number,
    point?: { x: number; y: number },
    poster?: string,
  ) => string | null;
  /** 新增手绘路径对象；points 为归一化坐标序列，box 为包围盒。 */
  addPath: (
    points: number[],
    box: { x: number; y: number; width: number; height: number },
    strokeWidth?: number,
  ) => string | null;
  /** 新增图片对象。 */
  addImage: (src: string, naturalWidth: number, naturalHeight: number, point?: { x: number; y: number }) => string | null;
  /** 新增视频或音频对象，meta 携带尺寸、时长与视频封面。 */
  addMedia: (
    kind: MediaKind,
    src: string,
    meta: { width: number; height: number; duration: number; poster?: string },
    point?: { x: number; y: number },
  ) => string | null;
  /** 新增 3D 模型对象（glb / gltf 等格式）。 */
  addModel: (src: string, format: ModelFormat, point?: { x: number; y: number }) => string | null;
  /** 新增图表对象；pluginId 缺省时使用默认图表插件，数据由该插件生成。 */
  addChart: (pluginId?: string, point?: { x: number; y: number }) => string | null;

  // —— 对象编辑 ——
  /** 局部更新对象；会先做边界裁剪与文本/图片的自动尺寸修正。 */
  updateObject: (id: string, patch: ObjectPatch, historyKey?: string) => void;
  /** 删除对象并清空选中（保留当前选中的帧）。 */
  removeObject: (id: string) => void;
  /** 静默删除对象：只清理与它相关的选中 id，不影响其他选中项。 */
  removeObjectSilent: (id: string) => void;
  /** 交换两个对象的 z 值，实现上下层互换。 */
  swapDepth: (sourceId: string, targetId: string) => void;
  /** 把对象移动到目标对象所在层级，并重排整组 z 值。 */
  moveObjectLayer: (sourceId: string, targetId: string) => void;
  /** 结束一次连续修改的历史合并窗口，使下一次修改必然成为独立历史。 */
  endHistoryCoalesce: () => void;

  // —— 帧管理 ——
  /** 以当前视角捕获一个新帧，并选中它。 */
  captureFrame: (view: ViewState) => void;
  /** 用新视角覆盖指定帧的视角。 */
  updateFrameView: (id: string, view: ViewState) => void;
  /** 重命名帧（自动 trim 并截断）。 */
  renameFrame: (id: string, name: string) => void;
  /** 设置帧播放时长（毫秒，会裁剪到合法范围并合并历史）。 */
  setFrameDuration: (id: string, duration: number) => void;
  /** 设置帧备注（演讲备注），空内容会存为 undefined。 */
  setFrameNotes: (id: string, notes: string) => void;
  /** 设置帧停留时长（播放到该帧后额外停顿的时间）。 */
  setFrameHold: (id: string, hold: number) => void;
  /** 删除帧，并把选中/当前帧切换到相邻帧。 */
  deleteFrame: (id: string) => void;
  /** 拖拽重排帧顺序：把 sourceId 移动到 targetId 的位置。 */
  reorderFrame: (sourceId: string, targetId: string) => void;

  // —— 图片加载状态 ——
  /** 记录图片加载失败信息（相同信息不会重复写入）。 */
  markImageError: (id: string, message: string) => void;
  /** 重试加载图片：清除错误并递增重试计数。 */
  retryImage: (id: string) => void;
  /** 图片成功加载后清除其错误信息。 */
  clearImageError: (id: string) => void;

  // —— 撤销 / 重做 ——
  /** 撤销：从 past 栈弹出最近快照，并把当前 deck 压入 future。 */
  undo: () => void;
  /** 重做：从 future 栈取回快照，并把当前 deck 压回 past。 */
  redo: () => void;
}

// —— 模块级私有状态：不放进 store，避免无谓的重渲染，也不参与序列化 ——

/** 自动保存定时器句柄；重复调度前会先清除上一个，实现防抖。 */
let autosaveTimer: number | undefined;
/** 相机请求自增序号：每次请求都用新 id，3D 场景据此识别并响应新的一次运镜。 */
let requestSeq = 0;
/** 上一次历史合并使用的 key；相同 key 在时间窗口内连续修改只记一步历史。 */
let lastHistoryKey: string | null = null;
/** 上一次记录历史的时间戳，与 lastHistoryKey 配合做 1 秒窗口判断。 */
let lastHistoryAt = 0;
/** 进行中的保存 Promise；用于并发去重，确保同一时刻只写一次存储。 */
let savingPromise: Promise<boolean> | null = null;

/** 初始 / 重置后的保存状态：默认视为已保存，时间戳为 0。 */
const EMPTY_STATUS: SaveStatus = { state: 'saved', at: 0 };

/** 从任意异常中提取可读信息；不是 Error 时退回到调用方给的兜底文案。 */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * 判断本次修改是否应写入撤销历史（history）。
 *
 * 带 historyKey 的连续操作（例如拖动滑块调时长、连续输入文字）会被「合并」：
 * 同一个 key 在 1 秒内再次触发时不新增历史，这样一次连续操作只占一步撤销。
 * 不传 key 视为独立操作，一定记录历史，并重置合并状态。
 *
 * @returns true 表示需要新增一条历史快照
 */
function historyAllowed(key?: string): boolean {
  if (!key) {
    lastHistoryKey = null;
    lastHistoryAt = 0;
    return true;
  }
  const now = Date.now();
  if (key === lastHistoryKey && now - lastHistoryAt < 1000) {
    // 同一操作仍在合并窗口内：刷新时间戳但不记录历史
    lastHistoryAt = now;
    return false;
  }
  lastHistoryKey = key;
  lastHistoryAt = now;
  return true;
}

/** 校验 id 是否仍存在于给定列表中；不存在（可能已被删除）时返回 null。 */
function validId<T extends { id: string }>(list: T[], id: string | null): string | null {
  if (!id) return null;
  return list.some((item) => item.id === id) ? id : null;
}

/** 撤销 / 重做后重建选中集合：主选中 id 仍有效则恢复为单选，否则返回空数组。 */
function selectedObjectFallback(deck: Deck, id: string | null): string[] {
  const valid = validId(deck.objects, id);
  return valid ? [valid] : [];
}

/** 清除自动保存定时器（关闭作品、打开新作品或组件卸载时调用）。 */
function clearTimer() {
  if (autosaveTimer !== undefined) {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
  }
}

/**
 * 把保存状态标记为 dirty（有未保存改动）。
 * 若当前正在保存或已处于错误状态则不覆盖，避免打断进行中的保存或掩盖错误提示。
 */
function markDirty() {
  const { saveStatus } = useDeckStore.getState();
  if (saveStatus.state === 'error' || saveStatus.state === 'saving') return;
  useDeckStore.setState({ saveStatus: { state: 'dirty' } });
}

/**
 * 调度一次自动保存：2 秒防抖。
 * 只读、未打开作品或处于错误状态时不调度；重复调用会重置计时器。
 */
function scheduleAutosave() {
  const state = useDeckStore.getState();
  if (state.readonly || !state.deck) return;
  if (state.saveStatus.state === 'error') return;
  clearTimer();
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = undefined;
    void saveNow();
  }, 2000);
}

/**
 * 立即把当前 deck 写入存储。
 *
 * 关键点：
 * - 只读或无作品时视为成功（无需保存）。
 * - 已有保存进行中时直接复用同一个 Promise，避免并发写。
 * - 已处于 saved 状态时直接返回，避免无意义的写操作。
 * - 保存期间 deck 若又发生变化（引用不同），保存成功后重新标记 dirty 并继续调度，
 *   保证最新的改动最终一定被落盘。
 *
 * @returns 是否保存成功
 */
async function saveNow(): Promise<boolean> {
  const state = useDeckStore.getState();
  if (!state.deck || state.readonly) return true;
  if (savingPromise) return savingPromise;
  if (state.saveStatus.state === 'saved') return true;

  // 冻结本次要保存的数据快照，后续比较用它判断保存期间是否又产生了新改动
  const snapshot = state.deck;
  useDeckStore.setState({ saveStatus: { state: 'saving' } });
  savingPromise = (async () => {
    try {
      await putDeck(snapshot);
      const current = useDeckStore.getState();
      if (current.deck === snapshot) {
        // 保存期间没有新改动：标记为已保存并记录时间
        useDeckStore.setState({ saveStatus: { state: 'saved', at: Date.now() } });
      } else if (current.deck) {
        // 保存期间产生了新改动：重新标记 dirty 并再次调度自动保存
        if (current.saveStatus.state !== 'error') {
          useDeckStore.setState({ saveStatus: { state: 'dirty' } });
          scheduleAutosave();
        }
      }
      return true;
    } catch (error) {
      // 写入失败：进入 error 状态并保留错误信息，由 UI 提示用户重试
      useDeckStore.setState({
        saveStatus: { state: 'error', message: errorMessage(error, '保存失败') },
      });
      return false;
    } finally {
      // 无论成功失败都释放保存锁，允许下一次保存
      savingPromise = null;
    }
  })();
  return savingPromise;
}

/**
 * 等待所有待保存改动落盘（用于关闭作品或离开页面前确保数据不丢失）。
 *
 * 先执行一次保存；若失败直接返回 false。若保存期间又出现了新的 dirty 改动，
 * 则再补一次保存，直到状态不再是 dirty。
 *
 * @returns 是否最终保存成功
 */
export async function flushDeckSave(): Promise<boolean> {
  const first = await saveNow();
  if (!first) return false;
  const state = useDeckStore.getState();
  // 首次保存可能只落盘了旧快照，若仍有新改动则再保存一次
  if (state.saveStatus.state === 'dirty') return saveNow();
  return true;
}

/**
 * 规范化被编辑后的对象：把补丁合并进原对象，并把各字段裁剪到合法范围。
 *
 * 这样做可以防止输入框、拖拽等途径产生越界数据（例如超大尺寸、负坐标），
 * 同时保证文本高度随字号自动调整、锁定宽高比的图片不会变形。
 *
 * @param object 修改前的对象
 * @param patch  本次要应用的局部修改
 * @returns 规范化后的新对象（不修改传入的原对象）
 */
function normalizeEditedObject(object: SlideObject, patch: ObjectPatch): SlideObject {
  // 先浅合并补丁（各对象类型的字段都在顶层，浅合并即可）
  const next = { ...object, ...patch } as SlideObject;
  // 名称不能为空，并限制最大长度
  next.name = String(next.name || object.name).slice(0, LIMITS.objectNameChars) || object.name;
  // 位置与层级裁剪到允许的世界坐标范围
  next.x = clampNumber(next.x, -LIMITS.coord, LIMITS.coord, object.x);
  next.y = clampNumber(next.y, -LIMITS.coord, LIMITS.coord, object.y);
  next.z = clampNumber(next.z, -LIMITS.depth, LIMITS.depth, object.z);
  // 尺寸裁剪，避免过小不可见或过大撑爆场景
  next.width = clampNumber(next.width, LIMITS.minSize, LIMITS.maxSize, object.width);
  next.height = clampNumber(next.height, LIMITS.minSize, LIMITS.maxSize, object.height);
  // 三个旋转轴统一裁剪到合法角度范围
  next.rotation = clampNumber(next.rotation, LIMITS.minRotation, LIMITS.maxRotation, object.rotation);
  next.rotationX = clampNumber(next.rotationX ?? 0, LIMITS.minRotation, LIMITS.maxRotation, 0);
  next.rotationY = clampNumber(next.rotationY ?? 0, LIMITS.minRotation, LIMITS.maxRotation, 0);
  // 不透明度限制在 0~100
  next.opacity = clampNumber(next.opacity, 0, 100, object.opacity);

  if (next.type === 'text') {
    // 文本：限制字数与字号 / 行高 / 3D 厚度，并根据内容自动计算高度
    const text = next as TextObject;
    text.text = text.text.slice(0, LIMITS.textChars);
    text.fontSize = clampNumber(text.fontSize, LIMITS.minFontSize, LIMITS.maxFontSize, 48);
    text.lineHeight = clampNumber(text.lineHeight, LIMITS.minLineHeight, LIMITS.maxLineHeight, 1.4);
    text.depth3d = clampNumber(text.depth3d ?? 0, 0, LIMITS.maxTextDepth, 0);
    text.height = autoTextHeight(text);
  } else if (next.type === 'chart') {
    // 图表：数据必须交给对应插件重新规范化，防止孤立边 / 重复节点进入场景
    const chart = next as ChartObject;
    const plugin = resolveChartPlugin(chart.plugin);
    if (plugin) {
      // 旧存档没有 plugin 字段：回填解析到的插件 id，之后即可正常渲染与编辑
      if (!chart.plugin) chart.plugin = plugin.id;
      chart.spec = plugin.normalizeSpec(chart.spec);
    }
  } else if (next.type === 'image') {
    // 图片：锁定宽高比时，只改宽/高中的一边，另一边按原始比例联动
    const image = next as ImageObject;
    const widthChanged = patch.width !== undefined;
    const heightChanged = patch.height !== undefined;
    if (image.aspectLocked && image.naturalWidth > 0 && image.naturalHeight > 0) {
      const ratio = image.naturalWidth / image.naturalHeight;
      if (widthChanged && !heightChanged) image.height = image.width / ratio;
      else if (heightChanged && !widthChanged) image.width = image.height * ratio;
    }
  }
  return next;
}

export const useDeckStore = create<DeckStore>((set, get) => {
  /**
   * 修改 deck 的统一入口（内部辅助函数）。
   *
   * 所有写操作都应经由它完成，以保证：
   * 1. 只读或无作品时直接拒绝修改；
   * 2. updater 返回同一引用时视为「无变化」，不产生历史也不触发保存；
   * 3. 按 historyKey 决定是否记录撤销历史（连续同类操作会合并）；
   * 4. 每次实际修改后统一刷新 updatedAt、标记 dirty 并调度自动保存。
   *
   * @param updater 接收旧 deck、返回新 deck 的纯函数
   * @param options.historyKey 用于合并连续操作的历史 key
   * @param options.noHistory 为 true 时不记录历史（例如播放时的临时修改）
   * @returns 是否实际发生了修改
   */
  function applyDeck(
    updater: (deck: Deck) => Deck,
    options: { historyKey?: string; noHistory?: boolean } = {},
  ): boolean {
    const state = get();
    if (!state.deck || state.readonly) return false;
    const previous = state.deck;
    const next = updater(previous);
    // updater 返回原引用表示没有实际修改，提前返回避免多余渲染与保存
    if (next === previous) return false;
    const pushHistory =
      !options.noHistory && historyAllowed(options.historyKey);
    // 记录历史时：把修改前的快照压栈，并只保留最近 50 条；同时清空重做栈
    const past = pushHistory ? [...state.past, previous].slice(-50) : state.past;
    const future = pushHistory ? [] : state.future;
    set({
      deck: { ...next, updatedAt: Date.now() },
      past,
      future,
    });
    markDirty();
    scheduleAutosave();
    return true;
  }

  /**
   * 撤销 / 重做时用历史快照替换当前 deck。
   *
   * 除了恢复 deck 本身，还要：
   * - 保留当前实时视角（历史快照里的 lastView 可能已过期）；
   * - 清理已不存在的选中对象 / 帧 id，避免属性面板指向已删除的数据。
   */
  function replaceDeckFromHistory(deck: Deck) {
    const state = get();
    const restored: Deck = { ...deck, lastView: state.view, updatedAt: Date.now() };
    // 过滤掉在恢复后的 deck 中已不存在的选中 id
    const selectedIds = state.selectedIds.filter((id) => validId(restored.objects, id));
    set({
      deck: restored,
      selectedObjectId: validId(restored.objects, state.selectedObjectId),
      selectedIds: selectedIds.length > 0 ? selectedIds : selectedObjectFallback(restored, state.selectedObjectId),
      selectedFrameId: validId(restored.frames, state.selectedFrameId),
      currentFrameId: validId(restored.frames, state.currentFrameId),
    });
    markDirty();
    scheduleAutosave();
  }

  return {
    // —— 初始状态：未打开任何作品，处于空闲且已保存的状态 ——
    deck: null,
    // 深拷贝默认视角（含 target 对象），避免与常量共享引用被误改
    view: { ...DEFAULT_VIEW, target: { ...DEFAULT_VIEW.target } },
    selectedObjectId: null,
    selectedIds: [],
    selectedFrameId: null,
    currentFrameId: null,
    readonly: false,
    loading: false,
    loadError: null,
    saveStatus: EMPTY_STATUS,
    past: [],
    future: [],
    cameraRequest: null,
    imageErrors: {},
    imageRetry: {},

    openDeck: async (id) => {
      // 打开新作品前先清理上一部作品的定时器、编辑锁与历史合并状态
      clearTimer();
      releaseDeckLock();
      lastHistoryKey = null;
      lastHistoryAt = 0;
      // 进入 loading 并清空所有与上一部作品相关的状态，避免界面短暂串数据
      set({
        loading: true,
        loadError: null,
        deck: null,
        selectedObjectId: null,
        selectedIds: [],
        selectedFrameId: null,
        currentFrameId: null,
        past: [],
        future: [],
        cameraRequest: null,
        imageErrors: {},
        imageRetry: {},
        readonly: false,
      });
      try {
        const deck = await getDeck(id);
        if (!deck) throw new Error('作品不存在或已被删除');
        // 尝试获取编辑锁；获取失败说明其他标签页正在编辑，本页转为只读
        const writable = acquireDeckLock(id);
        set({
          deck,
          view: deck.lastView,
          loading: false,
          readonly: !writable,
          saveStatus: { state: 'saved', at: Date.now() },
        });
      } catch (error) {
        // 读取失败：记录错误并强制只读，避免对无效数据执行写操作
        set({
          loading: false,
          loadError: errorMessage(error, '作品数据无法读取'),
          readonly: true,
        });
      }
    },

    closeDeck: async (force = false) => {
      const state = get();
      // 有未保存的改动时先尝试落盘；失败且未强制关闭则中止，防止丢数据
      if (state.deck && !state.readonly && state.saveStatus.state !== 'saved') {
        const ok = await flushDeckSave();
        if (!ok && !force) return false;
      }
      // 正常关闭：释放定时器与编辑锁，并把 store 重置回初始状态
      clearTimer();
      releaseDeckLock();
      set({
        deck: null,
        view: { ...DEFAULT_VIEW, target: { ...DEFAULT_VIEW.target } },
        selectedObjectId: null,
        selectedIds: [],
        selectedFrameId: null,
        currentFrameId: null,
        readonly: false,
        loading: false,
        loadError: null,
        saveStatus: EMPTY_STATUS,
        past: [],
        future: [],
        cameraRequest: null,
        imageErrors: {},
        imageRetry: {},
      });
      return true;
    },

    // 仅供测试注入数据：跳过存储与加锁，直接把传入 deck 设为当前作品
    loadDeckForTest: (deck, readonly = false) => {
      set({
        deck,
        view: deck.lastView,
        readonly,
        saveStatus: { state: 'saved', at: Date.now() },
        past: [],
        future: [],
        selectedObjectId: null,
        selectedIds: [],
        selectedFrameId: null,
        currentFrameId: null,
      });
    },

    setSaveStatus: (status) => set({ saveStatus: status }),

    commitView: (view) => {
      const state = get();
      if (!state.deck) return;
      const last = state.deck.lastView;
      // 视角变化很小（低于阈值）时只更新实时 view，不写入 deck，避免产生大量无意义保存
      const changed =
        Math.abs(last.distance - view.distance) > 0.01 ||
        Math.abs(last.target.x - view.target.x) > 0.01 ||
        Math.abs(last.target.y - view.target.y) > 0.01 ||
        Math.abs(last.target.z - view.target.z) > 0.01 ||
        Math.abs(last.yaw - view.yaw) > 0.001 ||
        Math.abs(last.pitch - view.pitch) > 0.001;
      // 实时视角始终同步，保证 3D 场景即时响应
      set({ view });
      if (state.readonly || !changed) return;
      // 变化足够大：把视角写入 lastView 持久化（撤销历史不包含相机的细微移动）
      set({
        deck: { ...state.deck, lastView: view, updatedAt: Date.now() },
      });
      markDirty();
      scheduleAutosave();
    },

    // 以下三个方法都通过自增 id 生成新的相机请求，场景侧据此触发一次运镜
    requestCamera: (request) => {
      requestSeq += 1;
      set({ cameraRequest: { ...request, id: requestSeq } });
    },

    // 请求恢复到默认视角
    requestReset: () => {
      requestSeq += 1;
      set({ cameraRequest: { id: requestSeq, type: 'reset' } });
    },

    // 请求相机聚焦到指定对象
    requestFocus: (objectId) => {
      requestSeq += 1;
      set({ cameraRequest: { id: requestSeq, type: 'focus', objectId } });
    },

    // 单选：选中对象的同时会取消帧的选中（对象与帧的选择是互斥的）
    selectObject: (id) => {
      if (!id) {
        set({ selectedObjectId: null, selectedIds: [] });
        return;
      }
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
    },

    // 多选：先去重；空数组等价于清空选择，否则以第一个 id 作为主选中
    selectObjects: (ids) => {
      const unique = [...new Set(ids)];
      if (unique.length === 0) {
        set({ selectedObjectId: null, selectedIds: [], selectedFrameId: null });
        return;
      }
      set({ selectedObjectId: unique[0], selectedIds: unique, selectedFrameId: null });
    },

    // Shift / Ctrl 点选：已选中则从集合中移除，未选中则追加
    toggleObjectSelection: (id) => {
      const state = get();
      if (!state.deck) return;
      const exists = state.selectedIds.includes(id);
      if (exists) {
        const next = state.selectedIds.filter((item) => item !== id);
        set({
          selectedIds: next,
          // 移除后可能没有选中项了，取剩余集合的第一个
          selectedObjectId: next[0] ?? null,
          selectedFrameId: null,
        });
      } else {
        const next = [...state.selectedIds, id];
        set({ selectedIds: next, selectedObjectId: next[0], selectedFrameId: null });
      }
    },

    // 批量删除：先过滤出仍然存在的选中项，再删除对象并同步选中状态
    removeObjects: (ids) => {
      const state = get();
      if (!state.deck || ids.length === 0) return;
      const selected = state.selectedIds.filter((id) => !ids.includes(id));
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: deck.objects.filter((object) => !ids.includes(object.id)),
      }));
      if (applied) {
        set({
          selectedIds: selected,
          selectedObjectId: selected[0] ?? null,
          selectedFrameId: state.selectedFrameId,
        });
      }
    },

    // 选中帧：清空对象选择；若 fly 为 true 且帧存在，则让相机飞行到该帧视角
    selectFrame: (id, fly = true) => {
      if (!id) {
        set({ selectedFrameId: null });
        return;
      }
      const frame = get().deck?.frames.find((f) => f.id === id);
      set({
        selectedFrameId: id,
        selectedObjectId: null,
        selectedIds: [],
        currentFrameId: id,
      });
      if (fly && frame) {
        requestSeq += 1;
        set({
          // 通过相机请求触发 0.4 秒的飞行动画；同时同步 view 作为最终落点
          cameraRequest: { id: requestSeq, type: 'frame', view: frame.view, duration: 0.4 },
          view: frame.view,
        });
      }
    },

    // 播放过程中推进当前帧：不触发相机飞行，也不改变选中状态
    setCurrentFrame: (id) => set({ currentFrameId: id }),

    // 重命名作品：空白标题直接忽略，过长的标题按上限截断
    renameDeck: (title) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      applyDeck((deck) => ({ ...deck, title: trimmed.slice(0, LIMITS.titleChars) }));
    },

    // 更新作品设置；historyKey 由调用方传入，用于合并连续调整（如拖动滑块）
    updateDeckSettings: (patch, historyKey) => {
      applyDeck((deck) => ({ ...deck, ...patch }), { historyKey });
    },

    /*
     * 新增对象的统一流程（以下所有 add* 方法都遵循）
     * 1. 校验是否已打开作品、对象数量是否达到上限，不满足则返回 null；
     * 2. 用 nextDepth 计算新对象的 z 值，使其显示在最上层；
     * 3. 用 nameForObject 生成不重复的默认名称，并维护该类型的计数器；
     * 4. 调用对应的 create*Object 工厂函数，以当前视角 view 作为初始位置；
     * 5. 通过 applyDeck 写入 deck（自动记录历史并触发保存）；
     * 6. 成功后把新对象设为唯一选中项，并返回其 id。
     */

    // 新增文本对象
    addText: () => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters.text ?? 0) + 1;
      const name = nameForObject(deckAtStart, 'text', '文本');
      const id = crypto.randomUUID();
      const object = createTextObject(id, name, state.view, z);
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, text: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    // 新增形状对象（矩形、圆形、箭头等），shape 决定具体形状样式
    addShape: (shape) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters[shape] ?? 0) + 1;
      const id = crypto.randomUUID();
      const name = nameForObject(deckAtStart, shape, SHAPE_LABELS[shape]);
      const object = createShapeObject(id, name, shape, state.view, z);
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, [shape]: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    // 新增 SVG 对象；point 为可选落点（世界坐标），不传则按当前视角居中放置
    addSvg: (src, naturalWidth, naturalHeight, point) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters.svg ?? 0) + 1;
      const name = nameForObject(deckAtStart, 'svg', 'SVG');
      const id = crypto.randomUUID();
      const object = createSvgObject(id, name, src, naturalWidth, naturalHeight, state.view, z);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, svg: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    // 新增 Lottie 动画对象；poster 为可选封面图（动画未播放时展示）
    addLottie: (src, naturalWidth, naturalHeight, duration, point, poster) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters.lottie ?? 0) + 1;
      const name = nameForObject(deckAtStart, 'lottie', 'Lottie');
      const id = crypto.randomUUID();
      const object = createLottieObject(id, name, src, naturalWidth, naturalHeight, duration, state.view, z, poster);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, lottie: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    // 新增手绘路径对象：points 为归一化坐标序列（至少 2 个点即 4 个数字），box 为其包围盒
    addPath: (points, box, strokeWidth = 6) => {
      const state = get();
      if (!state.deck || points.length < 4) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters.path ?? 0) + 1;
      const id = crypto.randomUUID();
      // 宽高不能小于允许的最小尺寸，避免出现零面积、无法选中的对象
      const safeWidth = Math.max(LIMITS.minSize, box.width);
      const safeHeight = Math.max(LIMITS.minSize, box.height);
      const object: ShapeObject = {
        id,
        type: 'shape',
        name: nameForObject(deckAtStart, 'path', '手绘'),
        // 对象坐标以中心点表示，而 box 是左上角包围盒，因此要加上一半宽高
        x: clampNumber(box.x + safeWidth / 2, -LIMITS.coord, LIMITS.coord, 0),
        y: clampNumber(box.y + safeHeight / 2, -LIMITS.coord, LIMITS.coord, 0),
        z,
        width: clampNumber(safeWidth, LIMITS.minSize, LIMITS.maxSize, 400),
        height: clampNumber(safeHeight, LIMITS.minSize, LIMITS.maxSize, 300),
        rotation: 0,
        rotationX: 0,
        rotationY: 0,
        opacity: 100,
        visible: true,
        shape: 'path',
        fill: DEFAULT_SHAPE_COLOR,
        stroke: DEFAULT_SHAPE_COLOR,
        strokeWidth: clampNumber(strokeWidth, 1, LIMITS.maxStroke, 6),
        // 路径点使用归一化坐标（0~1），限制总点数并把越界值裁剪回 0~1
        points: points.slice(0, LIMITS.maxPathPoints * 2).map((value) => clampNumber(value, 0, 1, 0)),
      };
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, path: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    // 新增图片对象；naturalWidth / naturalHeight 用于计算默认尺寸与宽高比
    addImage: (src, naturalWidth, naturalHeight, point) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters.image ?? 0) + 1;
      const name = nameForObject(deckAtStart, 'image', '图片');
      const id = crypto.randomUUID();
      const object = createImageObject(id, name, src, naturalWidth, naturalHeight, state.view, z);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, image: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    // 新增媒体对象：kind 区分视频 / 音频，视频会额外使用 meta 中的尺寸与封面
    addMedia: (kind, src, meta, point) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const label = kind === 'video' ? '视频' : '音频';
      const name = nameForObject(deckAtStart, kind, label);
      const id = crypto.randomUUID();
      const object =
        kind === 'video'
          ? createVideoObject(id, name, src, meta.width, meta.height, meta.duration, state.view, z, meta.poster)
          : createAudioObject(id, name, src, meta.duration, state.view, z);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, [kind]: (deck.counters[kind] ?? 0) + 1 },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    // 新增 3D 模型对象，format 决定加载器类型（如 glb / gltf）
    addModel: (src, format, point) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const name = nameForObject(deckAtStart, 'model', '模型');
      const id = crypto.randomUUID();
      const object = createModelObject(id, name, src, format, state.view, z);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, model: (deck.counters.model ?? 0) + 1 },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    // 新增图表对象：解析插件后由插件生成默认数据；未安装图表插件时直接返回 null
    addChart: (pluginId, point) => {
      const state = get();
      if (!state.deck) return null;
      // 图表能力由插件贡献：没有插件就没有可用的数据规范与渲染器
      const plugin = resolveChartPlugin(pluginId);
      if (!plugin) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      // 自动命名使用插件短名称（如「图表」），不同插件不会互相串名
      const name = nameForObject(deckAtStart, 'chart', plugin.label);
      const id = crypto.randomUUID();
      const object = createChartObject(id, name, plugin.id, plugin.createSpec(), state.view, z);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, chart: (deck.counters.chart ?? 0) + 1 },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    // 局部更新对象：先规范化字段，再写入 deck；若修改包含 src（换图）则清除旧的加载错误
    updateObject: (id, patch, historyKey) => {
      const state = get();
      if (!state.deck) return;
      applyDeck(
        (deck) => ({
          ...deck,
          objects: deck.objects.map((object) =>
            object.id === id ? normalizeEditedObject(object, patch) : object,
          ),
        }),
        { historyKey },
      );
      if ('src' in patch) {
        // 更换了资源地址：旧错误信息已失效，顺手清理
        const errors = { ...state.imageErrors };
        delete errors[id];
        if (Object.keys(errors).length !== Object.keys(state.imageErrors).length) {
          set({ imageErrors: errors });
        }
      }
    },

    // 删除单个对象，并清空对象相关的选中状态（帧的选中状态保持不变）
    removeObject: (id) => {
      const state = get();
      if (!state.deck) return;
      const frameStillSelected = state.selectedFrameId;
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: deck.objects.filter((object) => object.id !== id),
      }));
      if (applied) {
        set({
          selectedObjectId: null,
          selectedIds: [],
          selectedFrameId: frameStillSelected,
        });
      }
    },

    // 静默删除：不整体清空选择，只把被删对象从选中集合中移除（用于清理失效对象）
    removeObjectSilent: (id) => {
      const state = get();
      if (!state.deck) return;
      applyDeck((deck) => ({
        ...deck,
        objects: deck.objects.filter((object) => object.id !== id),
      }));
      if (state.selectedObjectId === id) {
        const selected = state.selectedIds.filter((item) => item !== id);
        set({ selectedObjectId: selected[0] ?? null, selectedIds: selected });
      }
    },

    // 交换两个对象的 z 值：只改层级，不改变其他属性
    swapDepth: (sourceId, targetId) => {
      if (sourceId === targetId) return;
      applyDeck((deck) => {
        const source = deck.objects.find((object) => object.id === sourceId);
        const target = deck.objects.find((object) => object.id === targetId);
        // 任一对象不存在则视为无变化，返回原 deck 以跳过历史与保存
        if (!source || !target) return deck;
        return {
          ...deck,
          objects: deck.objects.map((object) => {
            if (object.id === sourceId) return { ...object, z: target.z };
            if (object.id === targetId) return { ...object, z: source.z };
            return object;
          }),
        };
      });
    },

    /**
     * 把对象移动到目标对象所在的层级（拖拽排序用）。
     *
     * 做法：先按 z 从大到小排出当前顺序，把源对象抽出并插入到目标位置，
     * 再按新顺序把原有的 z 值依次重新分配。这样能保持所有对象层级值互不冲突，
     * 不会因为简单复制 z 值而产生重叠。
     */
    moveObjectLayer: (sourceId, targetId) => {
      if (sourceId === targetId) return;
      applyDeck((deck) => {
        // 按 z 降序排列：z 越大越靠前（越上层）
        const sorted = [...deck.objects].sort((a, b) => b.z - a.z);
        const from = sorted.findIndex((object) => object.id === sourceId);
        const to = sorted.findIndex((object) => object.id === targetId);
        if (from < 0 || to < 0) return deck;
        // 记录原来的 z 值序列，用于按新顺序重新分配
        const originalZ = sorted.map((object) => object.z);
        const [moved] = sorted.splice(from, 1);
        sorted.splice(to, 0, moved);
        // 新顺序中每个对象应获得的 z：位置索引 -> 原 z 值
        const order = new Map(sorted.map((object, index) => [object.id, index]));
        return {
          ...deck,
          objects: deck.objects.map((object) => {
            const index = order.get(object.id);
            if (index === undefined) return object;
            return { ...object, z: originalZ[index] };
          }),
        };
      });
    },

    // 结束历史合并窗口：例如拖拽结束后调用，确保下一次修改单独成为一步历史
    endHistoryCoalesce: () => {
      lastHistoryKey = null;
      lastHistoryAt = 0;
    },

    /**
     * 把当前视角捕获为一个新帧（相当于「拍照」）。
     * 帧的默认时长取自作品设置 defaultDuration；视角对象会深拷贝，避免后续修改互相影响。
     * 成功捕获后自动选中该帧，方便继续编辑或播放。
     */
    captureFrame: (view) => {
      const state = get();
      if (!state.deck || state.deck.frames.length >= LIMITS.frames) return;
      const deckAtStart = state.deck;
      const frameId = crypto.randomUUID();
      const frame: Frame = {
        id: frameId,
        name: nextFrameName(deckAtStart.frames),
        duration: deckAtStart.defaultDuration,
        // 深拷贝 view 与 target，防止帧视角和实时视角共享引用
        view: { ...view, target: { ...view.target } },
      };
      const applied = applyDeck(
        (deck) => ({ ...deck, frames: [...deck.frames, frame] }),
      );
      if (applied) {
        set({
          selectedFrameId: frameId,
          currentFrameId: frameId,
          selectedObjectId: null,
          selectedIds: [],
        });
      }
    },

    // 用新视角覆盖指定帧；同样深拷贝，保证帧数据独立
    updateFrameView: (id, view) => {
      applyDeck((deck) => ({
        ...deck,
        frames: deck.frames.map((frame) =>
          frame.id === id ? { ...frame, view: { ...view, target: { ...view.target } } } : frame,
        ),
      }));
    },

    // 重命名帧：忽略空名称，并按上限截断
    renameFrame: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      applyDeck((deck) => ({
        ...deck,
        frames: deck.frames.map((frame) =>
          frame.id === id ? { ...frame, name: trimmed.slice(0, LIMITS.frameNameChars) } : frame,
        ),
      }));
    },

    // 设置帧播放时长；historyKey 按帧 id 区分，可合并连续拖动产生的多次修改
    setFrameDuration: (id, duration) => {
      applyDeck(
        (deck) => ({
          ...deck,
          frames: deck.frames.map((frame) =>
            frame.id === id
              ? {
                  ...frame,
                  duration: clampNumber(duration, LIMITS.minDuration, LIMITS.maxDuration, frame.duration),
                }
              : frame,
          ),
        }),
        { historyKey: `frame-duration:${id}` },
      );
    },

    // 设置演讲备注：空内容存为 undefined，避免序列化出空字符串
    setFrameNotes: (id, notes) => {
      const limited = notes.slice(0, LIMITS.frameNotesChars);
      applyDeck(
        (deck) => ({
          ...deck,
          frames: deck.frames.map((frame) =>
            frame.id === id
              ? { ...frame, notes: limited.trim() ? limited : undefined }
              : frame,
          ),
        }),
        { historyKey: `frame-notes:${id}` },
      );
    },

    // 设置帧停留时长：播放到该帧后额外停留的时间，未设置时回退到默认停留值
    setFrameHold: (id, hold) => {
      applyDeck(
        (deck) => ({
          ...deck,
          frames: deck.frames.map((frame) =>
            frame.id === id
              ? { ...frame, hold: clampNumber(hold, LIMITS.minHold, LIMITS.maxHold, frame.hold ?? DEFAULT_HOLD) }
              : frame,
          ),
        }),
        { historyKey: `frame-hold:${id}` },
      );
    },

    // 删除帧：删除后优先选中后一帧，没有则选中前一帧，保持编辑不中断
    deleteFrame: (id) => {
      const state = get();
      const deck = state.deck;
      if (!deck) return;
      const index = deck.frames.findIndex((frame) => frame.id === id);
      if (index < 0) return;
      const neighbor = deck.frames[index + 1] ?? deck.frames[index - 1] ?? null;
      const applied = applyDeck((oldDeck) => ({
        ...oldDeck,
        frames: oldDeck.frames.filter((frame) => frame.id !== id),
      }));
      if (!applied) return;
      set({
        selectedFrameId: neighbor?.id ?? null,
        currentFrameId: neighbor?.id ?? null,
      });
    },

    // 重排帧顺序：先从原位置移除源帧，再插入到目标帧的索引位置
    reorderFrame: (sourceId, targetId) => {
      if (sourceId === targetId) return;
      applyDeck((deck) => {
        const sourceIndex = deck.frames.findIndex((frame) => frame.id === sourceId);
        const targetIndex = deck.frames.findIndex((frame) => frame.id === targetId);
        if (sourceIndex < 0 || targetIndex < 0) return deck;
        const frames = [...deck.frames];
        const [moved] = frames.splice(sourceIndex, 1);
        frames.splice(targetIndex, 0, moved);
        return { ...deck, frames };
      });
    },

    // 记录图片加载失败信息；用对象 id 做 key，便于图片组件精确展示错误
    markImageError: (id, message) => {
      const state = get();
      // 错误信息未变化时不写入，避免无意义的重渲染
      if (state.imageErrors[id] === message) return;
      set({ imageErrors: { ...state.imageErrors, [id]: message } });
    },

    // 重试加载：先清除该对象的错误，再递增重试计数（计数变化会触发图片组件重新请求）
    retryImage: (id) => {
      const state = get();
      const errors = { ...state.imageErrors };
      delete errors[id];
      set({
        imageErrors: errors,
        imageRetry: { ...state.imageRetry, [id]: (state.imageRetry[id] ?? 0) + 1 },
      });
    },

    // 图片加载成功后清除错误信息；没有错误时直接返回
    clearImageError: (id) => {
      const state = get();
      if (!state.imageErrors[id]) return;
      const errors = { ...state.imageErrors };
      delete errors[id];
      set({ imageErrors: errors });
    },

    /**
     * 撤销：
     * - 从 past 栈顶取出上一份快照；
     * - 把当前 deck 压入 future 栈首（限制最多 50 条）；
     * - 重置历史合并状态，确保撤销后的下一次修改必定生成新历史。
     */
    undo: () => {
      const state = get();
      if (!state.deck || state.readonly || state.past.length === 0) return;
      const previous = state.past[state.past.length - 1];
      const current = state.deck;
      lastHistoryKey = null;
      set({
        past: state.past.slice(0, -1),
        future: [current, ...state.future].slice(0, 50),
      });
      replaceDeckFromHistory(previous);
    },

    /**
     * 重做：
     * - 从 future 栈首取出下一份快照；
     * - 把当前 deck 压回 past 栈尾（同样限制最多 50 条）；
     * - 重置历史合并状态。
     */
    redo: () => {
      const state = get();
      if (!state.deck || state.readonly || state.future.length === 0) return;
      const next = state.future[0];
      const current = state.deck;
      lastHistoryKey = null;
      set({
        future: state.future.slice(1),
        past: [...state.past, current].slice(-50),
      });
      replaceDeckFromHistory(next);
    },
  };
});

// 对外导出保存方法并额外提供 flushSave 别名，供关闭页面 / 路由切换时强制落盘
export { saveNow, flushDeckSave as flushSave };
