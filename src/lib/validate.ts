/**
 * validate.ts —— 作品数据的校验、裁剪与工程文件编解码
 *
 * 职责：
 * - 把来自 IndexedDB 或 .slide 文件的「不可信数据」规范化成合法的 Deck；
 * - 对每个字段做类型判断、默认值兜底与范围裁剪（坐标、尺寸、角度、时长、文本长度等）；
 * - 生成 / 解析 .slide 工程文件（JSON 包装），导入时重新生成 id 避免主键冲突；
 * - 提供文件名清洗、重名去重与默认图片对象的工具函数。
 *
 * 校验策略（宽松修复而非直接拒绝）：
 * - 结构性缺失（不是对象、缺少标题、对象 / 视点缺少 id、未知对象类型）抛错；
 * - 单个字段异常（类型错误、超出范围、非法颜色）则回退默认值或裁剪到合法区间；
 * - 缺少素材 src 不算错误，记录到 warnings，由 UI 以占位图 / 占位卡形式提示。
 *
 * 数据流：
 *   读取 IndexedDB -> normalizeDeck -> deckStore；
 *   导入 .slide -> parseSlideFile -> normalizeDeckWithWarnings(regenerateIds) -> 新建作品。
 */

import type {
  Deck,
  Frame,
  ImageObject,
  ModelFormat,
  ShapeObject,
  SlideObject,
  TextObject,
  ViewState,
} from '../types';
import {
  DEFAULT_BACKGROUND,
  DEFAULT_DURATION,
  DEFAULT_HOLD,
  DEFAULT_SHAPE_COLOR,
  DEFAULT_TEXT_COLOR,
  DEFAULT_VIEW,
  LIMITS,
} from './constants';
import { layoutText } from './text';
import { getChartPlugin, getDefaultChartPlugin } from '../plugins/registry';

/** .slide 工程文件格式版本号；导入时高于此版本的文件会被拒绝。 */
export const PROJECT_VERSION = 1;

/** .slide 文件的 app 标识，用于识别「这是本应用的工程文件」而非任意 JSON。 */
export const PROJECT_APP_ID = '3d-slide';

/** 读取数字：仅接受有限数字，其余（字符串、NaN、null 等）返回兜底值。 */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 读取字符串：仅接受字符串，其余返回兜底值。 */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** 读取布尔值：仅接受布尔，其余返回兜底值。 */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 数值裁剪到 [min, max]（调用前已确保 value 是有限数字）。 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 规范化相机视角。
 *
 * @param raw      待校验的原始值（可能缺失 / 类型错误）
 * @param fallback 缺省视角，默认 DEFAULT_VIEW
 * @returns 新对象（target 为深拷贝，避免与 fallback 共享引用）
 *
 * 裁剪规则：
 * - target 的 x / y 限制在 ±LIMITS.coord，z 限制在 ±LIMITS.depth；
 * - distance 限制在 20–60000（下限避免相机穿模，上限避免视角过远看不到内容）；
 * - pitch 限制在 ±1.45 弧度（约 ±83°），防止相机翻转到物体背后。
 */
function normalizeView(raw: unknown, fallback: ViewState = DEFAULT_VIEW): ViewState {
  if (!raw || typeof raw !== 'object') return { ...fallback, target: { ...fallback.target } };
  const v = raw as Record<string, unknown>;
  const targetRaw = (v.target as Record<string, unknown>) ?? {};
  const target = {
    x: clamp(num(targetRaw.x, fallback.target.x), -LIMITS.coord, LIMITS.coord),
    y: clamp(num(targetRaw.y, fallback.target.y), -LIMITS.coord, LIMITS.coord),
    z: clamp(num(targetRaw.z, fallback.target.z), -LIMITS.depth, LIMITS.depth),
  };
  return {
    target,
    distance: clamp(num(v.distance, fallback.distance), 20, 60000),
    yaw: num(v.yaw, fallback.yaw),
    pitch: clamp(num(v.pitch, fallback.pitch), -1.45, 1.45),
  };
}

/**
 * 规范化所有对象共有的基础字段。
 *
 * @param raw 原始对象记录
 * @returns 仅包含公共字段的对象（id / name / 坐标 / 尺寸 / 旋转 / 透明度 / 可见性）
 * @throws 缺少 id 或空名称时抛错（属于结构性错误，无法安全修复）
 *
 * 尺寸缺失时默认 400x300（近似旧版文本框尺寸）；不透明度默认 100、可见默认 true。
 */
function normalizeBase(raw: Record<string, unknown>): {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  rotation: number;
  rotationX: number;
  rotationY: number;
  opacity: number;
  visible: boolean;
} {
  if (typeof raw.id !== 'string' || !raw.id) throw new Error('对象缺少 id');
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('对象缺少名称');
  return {
    id: raw.id,
    name: raw.name.slice(0, LIMITS.objectNameChars),
    x: clamp(num(raw.x, 0), -LIMITS.coord, LIMITS.coord),
    y: clamp(num(raw.y, 0), -LIMITS.coord, LIMITS.coord),
    z: clamp(num(raw.z, 0), -LIMITS.depth, LIMITS.depth),
    width: clamp(num(raw.width, 400), LIMITS.minSize, LIMITS.maxSize),
    height: clamp(num(raw.height, 300), LIMITS.minSize, LIMITS.maxSize),
    rotation: clamp(num(raw.rotation, 0), LIMITS.minRotation, LIMITS.maxRotation),
    rotationX: clamp(num(raw.rotationX, 0), LIMITS.minRotation, LIMITS.maxRotation),
    rotationY: clamp(num(raw.rotationY, 0), LIMITS.minRotation, LIMITS.maxRotation),
    opacity: clamp(num(raw.opacity, 100), 0, 100),
    visible: bool(raw.visible, true),
  };
}

/**
 * 规范化单个内容对象，按 `type` 分派到对应分支。
 *
 * @param raw      原始对象记录
 * @param warnings 收集「缺少素材」等非致命问题，供导入结果提示
 * @returns 规范化后的 SlideObject
 * @throws 对象不是对象类型 / 未知 type 时抛错
 *
 * 实现要点：
 * - 枚举型字段（font / align / fit / shape / format）都用白名单校验，非法值回退默认；
 * - 文本高度始终由 layoutText 重新测量，不信任存档中的旧高度；
 * - 自由路径只保留有限数字并把点坐标裁剪到 0–1。
 */
function normalizeObject(raw: unknown, warnings: string[]): SlideObject {
  if (!raw || typeof raw !== 'object') throw new Error('存在无效的内容对象');
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (type === 'text') {
    const base = normalizeBase(r);
    const text = str(r.text, '');
    const fontSize = clamp(num(r.fontSize, 48), LIMITS.minFontSize, LIMITS.maxFontSize);
    const lineHeight = clamp(num(r.lineHeight, 1.4), LIMITS.minLineHeight, LIMITS.maxLineHeight);
    const font = (['sans', 'serif', 'round', 'mono'].includes(String(r.font))
      ? r.font
      : 'sans') as TextObject['font'];
    const bold = bool(r.bold, false);
    const layout = layoutText(text, base.width, fontSize, font, bold, lineHeight);
    return {
      ...base,
      type: 'text',
      text,
      fontSize,
      font,
      bold,
      align: (['left', 'center', 'right'].includes(String(r.align)) ? r.align : 'left') as TextObject['align'],
      color: str(r.color, DEFAULT_TEXT_COLOR),
      lineHeight,
      depth3d: clamp(num(r.depth3d, 0), 0, LIMITS.maxTextDepth),
      height: layout.height,
    };
  }
  if (type === 'image') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`图片「${base.name}」缺少素材，已以占位图导入`);
    return {
      ...base,
      type: 'image',
      src,
      fit: r.fit === 'cover' ? 'cover' : 'contain',
      aspectLocked: bool(r.aspectLocked, false),
      naturalWidth: Math.max(1, num(r.naturalWidth, 1600)),
      naturalHeight: Math.max(1, num(r.naturalHeight, 900)),
    };
  }
  if (type === 'svg') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`SVG「${base.name}」缺少素材，已以占位图导入`);
    return {
      ...base,
      type: 'svg',
      src,
      fit: r.fit === 'cover' ? 'cover' : 'contain',
      naturalWidth: Math.max(1, num(r.naturalWidth, 1600)),
      naturalHeight: Math.max(1, num(r.naturalHeight, 900)),
    };
  }
  if (type === 'lottie') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`Lottie「${base.name}」缺少动画数据，已以占位卡导入`);
    return {
      ...base,
      type: 'lottie',
      src,
      fit: r.fit === 'cover' ? 'cover' : 'contain',
      naturalWidth: Math.max(1, num(r.naturalWidth, 800)),
      naturalHeight: Math.max(1, num(r.naturalHeight, 600)),
      duration: Math.max(0, num(r.duration, 0)),
      loop: bool(r.loop, true),
      speed: clamp(num(r.speed, 1), 0.1, 4),
      // 渲染后端 id：旧存档没有该字段，保持 undefined 以便运行时回退到默认 canvas 后端
      renderer: str(r.renderer, '').trim().slice(0, 32) || undefined,
    };
  }
  if (type === 'video') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`视频「${base.name}」缺少素材，已以占位卡导入`);
    return {
      ...base,
      type: 'video',
      src,
      fit: r.fit === 'cover' ? 'cover' : 'contain',
      naturalWidth: Math.max(1, num(r.naturalWidth, 1280)),
      naturalHeight: Math.max(1, num(r.naturalHeight, 720)),
      duration: Math.max(0, num(r.duration, 0)),
      loop: bool(r.loop, true),
      muted: bool(r.muted, false),
      volume: clamp(num(r.volume, 80), 0, 100),
      autoplay: bool(r.autoplay, false),
    };
  }
  if (type === 'audio') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`音频「${base.name}」缺少素材，已以占位卡导入`);
    return {
      ...base,
      type: 'audio',
      src,
      duration: Math.max(0, num(r.duration, 0)),
      loop: bool(r.loop, true),
      volume: clamp(num(r.volume, 80), 0, 100),
      autoplay: bool(r.autoplay, false),
    };
  }
  if (type === 'model') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`模型「${base.name}」缺少素材，已以占位框导入`);
    return {
      ...base,
      type: 'model',
      src,
      format: (['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'dae', '3mf', 'usdz'].includes(String(r.format))
        ? r.format
        : 'glb') as ModelFormat,
      autoRotate: bool(r.autoRotate, false),
      rotateSpeed: clamp(num(r.rotateSpeed, 45), 0, 360),
    };
  }
  if (type === 'chart') {
    const base = normalizeBase(r);
    // 图表数据来自存档，可能被手工修改过；交给提供该图表的插件规范化，
    // 保证节点 / 边（或其他插件自定义结构）始终自洽。
    const requested = str(r.plugin, '');
    // 旧存档没有 plugin 字段，或插件被卸载时，回退到默认图表插件：
    // 数据仍然保留，等对应插件可用后即可继续渲染与编辑。
    const plugin = (requested ? getChartPlugin(requested) : undefined) ?? getDefaultChartPlugin();
    if (!plugin) warnings.push(`图表「${base.name}」缺少可用插件，已保留原始数据但无法渲染`);
    return {
      ...base,
      type: 'chart',
      plugin: plugin?.id ?? requested,
      spec: plugin
        ? plugin.normalizeSpec(r.spec)
        : r.spec && typeof r.spec === 'object'
          ? (r.spec as Record<string, unknown>)
          : {},
      animate: bool(r.animate, true),
    };
  }
  if (type === 'shape') {
    const base = normalizeBase(r);
    return {
      ...base,
      type: 'shape',
      shape: (['rect', 'roundedRect', 'ellipse', 'triangle', 'diamond', 'star', 'arrow', 'line', 'path'].includes(
        String(r.shape),
      )
        ? r.shape
        : 'rect') as ShapeObject['shape'],
      fill: str(r.fill, DEFAULT_SHAPE_COLOR),
      stroke: typeof r.stroke === 'string' ? r.stroke : null,
      strokeWidth: clamp(num(r.strokeWidth, 0), LIMITS.minStroke, LIMITS.maxStroke),
      points: Array.isArray(r.points)
        ? (r.points as unknown[])
            .slice(0, LIMITS.maxPathPoints * 2)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
            .map((value) => clamp(value, 0, 1))
        : undefined,
    };
  }
  throw new Error(`未知的对象类型：${String(type)}`);
}

/**
 * 规范化单个视点。
 *
 * @param raw   原始视点记录
 * @param index 视点在数组中的下标，用于生成缺省的「视点 N」名称
 * @returns 规范化后的 Frame
 * @throws 视点不是对象或缺少 id 时抛错
 *
 * 备注：空字符串或仅空白的备注会存为 undefined，避免导出 JSON 时出现空字段；
 * duration / hold 均裁剪到 LIMITS 规定区间。
 */
function normalizeFrame(raw: unknown, index: number): Frame {
  if (!raw || typeof raw !== 'object') throw new Error('存在无效的视点');
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) throw new Error('视点缺少 id');
  // 先截断到字数上限，再判断是否为空，避免超长备注里的空白被误判
  const notes = typeof r.notes === 'string' ? r.notes.slice(0, LIMITS.frameNotesChars) : '';
  return {
    id: r.id,
    name: str(r.name, `视点 ${index + 1}`).slice(0, LIMITS.frameNameChars) || `视点 ${index + 1}`,
    duration: clamp(num(r.duration, DEFAULT_DURATION), LIMITS.minDuration, LIMITS.maxDuration),
    notes: notes.trim() ? notes : undefined,
    hold: clamp(num(r.hold, DEFAULT_HOLD), LIMITS.minHold, LIMITS.maxHold),
    view: normalizeView(r.view),
  };
}

/** normalizeDeck 的可选行为。 */
export interface NormalizeOptions {
  /** 强制使用新的作品 id（例如导入时覆盖原 id）。 */
  newId?: string;
  /** 为重复的对象 / 视点 id 追加下标，保证同一作品内 id 唯一（导入时使用）。 */
  regenerateIds?: boolean;
}

/**
 * 把任意来源的数据规范化为合法的 Deck。
 *
 * @param raw     待规范化的原始数据（IndexedDB 行记录 / 文件中的 deck 字段）
 * @param options 附加行为（替换 id、修复重复 id）
 * @returns 合法的 Deck（所有字段都已裁剪 / 兜底）
 * @throws 结构性错误：非对象、缺标题、对象 / 视点列表缺失或超过上限
 *
 * 说明：
 * - 标题超长会截断到 LIMITS.titleChars；背景色必须是标准的 #RRGGBB 格式；
 * - counters 只保留值为数字的项，防止注入非数字类型；
 * - createdAt / updatedAt 缺失时用当前时间兜底。
 */
export function normalizeDeck(raw: unknown, options: NormalizeOptions = {}): Deck {
  if (!raw || typeof raw !== 'object') throw new Error('作品数据不是有效对象');
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || !r.title.trim()) throw new Error('作品缺少标题');
  if (!Array.isArray(r.objects)) throw new Error('作品缺少内容对象列表');
  if (r.objects.length > LIMITS.objects) throw new Error('内容对象数量超过上限');
  if (!Array.isArray(r.frames)) throw new Error('作品缺少视点路径');
  if (r.frames.length > LIMITS.frames) throw new Error('视点数量超过上限');

  const warnings: string[] = [];
  let objects = r.objects.map((o) => normalizeObject(o, warnings));
  let frames = r.frames.map((f, i) => normalizeFrame(f, i));

  // 导入时若文件内存在重复 id，追加下标保证唯一；未开启时保持原 id
  if (options.regenerateIds) {
    const seen = new Set<string>();
    objects = objects.map((o, i) => {
      const id = seen.has(o.id) ? `${o.id}-${i}` : o.id;
      seen.add(id);
      return { ...o, id };
    });
    const seenFrames = new Set<string>();
    frames = frames.map((f, i) => {
      const id = seenFrames.has(f.id) ? `${f.id}-${i}` : f.id;
      seenFrames.add(id);
      return { ...f, id };
    });
  }

  const counters = typeof r.counters === 'object' && r.counters ? (r.counters as Record<string, number>) : {};
  const now = Date.now();
  return {
    id: options.newId ?? (typeof r.id === 'string' && r.id ? r.id : crypto.randomUUID()),
    title: r.title.slice(0, LIMITS.titleChars),
    background: typeof r.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.background)
      ? r.background
      : DEFAULT_BACKGROUND,
    defaultDuration: clamp(num(r.defaultDuration, DEFAULT_DURATION), LIMITS.minDuration, LIMITS.maxDuration),
    showProgress: bool(r.showProgress, true),
    objects,
    frames,
    lastView: normalizeView(r.lastView),
    counters: Object.fromEntries(Object.entries(counters).filter(([, v]) => typeof v === 'number')),
    createdAt: num(r.createdAt, now),
    updatedAt: num(r.updatedAt, now),
  };
  // warnings 由调用方通过 normalizeDeckWithWarnings 获取
}

/**
 * 规范化作品并额外返回非致命警告列表。
 *
 * 与 normalizeDeck 的区别：normalizeDeck 内部会把「缺少素材」的警告丢弃，
 * 这里在规范化完成后再扫一遍对象，把缺 src / 缺动画数据的提示汇总返回，
 * 供导入界面展示「已以占位图显示」等提示。
 *
 * @param raw     原始作品数据
 * @param options 同 normalizeDeck
 * @returns deck 与 warnings
 * @throws 同 normalizeDeck
 */
export function normalizeDeckWithWarnings(
  raw: unknown,
  options: NormalizeOptions = {},
): { deck: Deck; warnings: string[] } {
  const deck = normalizeDeck(raw, options);
  const warnings: string[] = [];
  for (const o of deck.objects) {
    if ((o.type === 'image' || o.type === 'svg') && !o.src) {
      warnings.push(`图片「${o.name}」缺少素材，已以占位图显示`);
    }
    if ((o.type === 'video' || o.type === 'audio') && !o.src) {
      warnings.push(`媒体「${o.name}」缺少素材，已以占位卡显示`);
    }
    if (o.type === 'lottie' && !o.src) {
      warnings.push(`Lottie「${o.name}」缺少动画数据，已以占位卡显示`);
    }
  }
  return { deck, warnings };
}

/**
 * .slide 工程文件的外层结构。
 * 用 app + version 做格式识别与向前兼容；deck 内联完整作品数据。
 */
export interface SlideProjectFile {
  /** 固定为 PROJECT_APP_ID，用于确认文件类型。 */
  app: typeof PROJECT_APP_ID;
  /** 格式版本号，导入时会拒绝高于当前版本的文件。 */
  version: number;
  /** 导出时间（ISO 8601 字符串），仅作信息展示。 */
  exportedAt: string;
  /** 作品标题的冗余副本，便于不解包 deck 也能显示文件名。 */
  title: string;
  /** 完整作品数据。 */
  deck: Deck;
}

/**
 * 把作品包装成可下载的 .slide 工程文件对象（调用方再 JSON.stringify 落盘）。
 *
 * @param deck 要导出的作品
 * @returns 带 app / version / exportedAt 的外层结构
 *
 * 副作用：读取当前时间。
 */
export function createSlideFile(deck: Deck): SlideProjectFile {
  return {
    app: PROJECT_APP_ID,
    version: PROJECT_VERSION,
    exportedAt: new Date().toISOString(),
    title: deck.title,
    deck,
  };
}

/**
 * 解析 .slide 工程文件文本。
 *
 * @param text 文件内容（JSON 字符串）
 * @returns 规范化后的 deck 与 warnings；deck 的 id 会被换成新随机 id、
 *          updatedAt 更新为当前时间，使导入相当于「另存为一份新作品」
 * @throws JSON 解析失败、app 标识不符、版本过高、缺少 deck 字段或 normalize 的结构性错误
 *
 * 注意：重新生成 id 是导入安全性的关键——避免覆盖本地已有同名 id 的作品。
 */
export function parseSlideFile(text: string): { deck: Deck; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 .slide 工程文件');
  }
  if (!raw || typeof raw !== 'object') throw new Error('不是有效的 .slide 工程文件');
  const file = raw as Record<string, unknown>;
  if (file.app !== PROJECT_APP_ID) throw new Error('不是有效的 .slide 工程文件');
  const version = num(file.version, 0);
  if (version > PROJECT_VERSION) throw new Error('该文件版本高于当前应用，请升级后再打开');
  if (!file.deck || typeof file.deck !== 'object') throw new Error('工程文件缺少作品数据');
  const { deck, warnings } = normalizeDeckWithWarnings(file.deck, { regenerateIds: true });
  return { deck: { ...deck, id: crypto.randomUUID(), updatedAt: Date.now() }, warnings };
}

/**
 * 把作品标题转换成可安全用作文件名的字符串。
 *
 * Windows / macOS 常见非法字符（\ / : * ? " < > |）以及换行统一替换为下划线，
 * 再截断到 80 个字符；结果为空时回退「未命名演示」。
 *
 * @param title 原始标题
 * @returns 可直接拼进下载文件名的字符串
 */
export function sanitizeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80) || '未命名演示';
}

/**
 * 在已有标题集合中生成不重复的标题：重名时依次追加「（2）」「（3）」……
 *
 * @param title    期望的标题
 * @param existing 已存在的标题列表
 * @returns 不冲突的新标题
 *
 * 注意：只做完全匹配判断；不考虑大小写或空白差异。
 */
export function uniqueTitle(title: string, existing: string[]): string {
  if (!existing.includes(title)) return title;
  let index = 2;
  while (existing.includes(`${title}（${index}）`)) index += 1;
  return `${title}（${index}）`;
}

/**
 * 构造默认图片对象。
 *
 * @param x 中心点 x
 * @param y 中心点 y
 * @param z 层级
 * @returns 初始尺寸按原始宽高比缩放到最长边 900 的图片对象；
 *          宽高比缺失（0 / NaN）时按 4:3 兜底
 *
 * 同时被 deck.createImageObject 与 createSvgObject 复用，保证两者尺寸策略一致。
 */
export function defaultImageObject(
  id: string,
  name: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  x: number,
  y: number,
  z: number,
): ImageObject {
  // 最长边固定 900（约半个画面），保证新图片不会一上来就撑满画布
  const maxDim = 900;
  const ratio = naturalWidth / naturalHeight || 4 / 3;
  let width = maxDim;
  let height = width / ratio;
  if (height > maxDim) {
    height = maxDim;
    width = height * ratio;
  }
  return {
    id,
    type: 'image',
    name,
    x,
    y,
    z,
    width,
    height,
    rotation: 0,
    opacity: 100,
    visible: true,
    src,
    fit: 'contain',
    aspectLocked: false,
    naturalWidth,
    naturalHeight,
  };
}
