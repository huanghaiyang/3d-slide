/**
 * deck.ts —— 作品与内容对象的工厂函数
 *
 * 职责：
 * - 创建空白作品（createDeck），统一填充默认背景、时长、视角与时间戳；
 * - 为各类对象（文本 / 图片 / 视频 / 音频 / 模型 / 形状 / SVG / Lottie）生成
 *   带完整默认值的对象字面量；
 * - 提供层级、命名、帧命名与数值裁剪等纯计算工具。
 *
 * 关键概念：
 * - 新对象的落点由 `viewCenterAtZ(view, z)` 计算：把当前视口中心射线投影到
 *   目标深度平面，保证新对象出现在用户当前看到的画面中央；
 * - 对象坐标是中心点，尺寸是世界单位（参考舞台 1920x1080）；
 * - 新对象默认不透明度 100、可见、无旋转；媒体默认循环播放、不自动播放。
 *
 * 本模块不修改传入数据、不访问存储，所有函数都是纯函数，便于复用与测试。
 */

import type {
  AudioObject,
  ChartObject,
  ChartSpec,
  Deck,
  ImageObject,
  LottieObject,
  ModelFormat,
  ModelObject,
  ShapeKind,
  ShapeObject,
  SlideObject,
  SvgObject,
  TextObject,
  VideoObject,
  ViewState,
} from '../types';
import {
  DEFAULT_BACKGROUND,
  DEFAULT_DURATION,
  DEFAULT_SHAPE_COLOR,
  DEFAULT_TEXT_COLOR,
  DEFAULT_VIEW,
  LIMITS,
} from './constants';
import { viewCenterAtZ } from './camera';
import { layoutText } from './text';
import { normalizeChartSpec } from './chart';
import { defaultImageObject } from './validate';

/**
 * 创建一个空白作品。
 *
 * @param title 作品标题（调用方负责 trim 与长度限制）
 * @returns 全新的 Deck：无对象、无视点、默认背景 / 过渡时长、显示进度条，
 *          视角为 DEFAULT_VIEW 的深拷贝（避免与常量共享 target 引用）
 *
 * 副作用：读取系统时间生成 createdAt / updatedAt，并生成随机 id，因此不是纯函数。
 */
export function createDeck(title: string): Deck {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title,
    background: DEFAULT_BACKGROUND,
    defaultDuration: DEFAULT_DURATION,
    showProgress: true,
    objects: [],
    frames: [],
    lastView: { ...DEFAULT_VIEW, target: { ...DEFAULT_VIEW.target } },
    counters: {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 计算新对象应使用的 z 值，使其显示在所有现有对象之上。
 *
 * @param objects 当前画布对象列表
 * @returns 空画布返回 0；否则返回最大 z + 10（留出间距便于后续插入对象）
 *
 * 注意：使用 Math.max(...array)，对象数量受 LIMITS.objects（200）约束，不会栈溢出。
 */
export function nextDepth(objects: SlideObject[]): number {
  if (objects.length === 0) return 0;
  return Math.max(...objects.map((o) => o.z)) + 10;
}

/** 读取并递增某类对象的命名计数；计数器缺失时按 0 处理。 */
function nextCounter(deck: Deck, key: string): number {
  return (deck.counters[key] ?? 0) + 1;
}

/**
 * 生成「标签 + 序号」形式的默认对象名，例如「矩形 3」。
 *
 * @param deck  当前作品（用于读取 counters）
 * @param key   计数器 key（通常是对象类型或形状种类）
 * @param label 中文标签，来自 OBJECT_LABELS / SHAPE_LABELS 等
 * @returns 用于展示与 AI 引用的名称；实际计数器的写回由 store 负责
 */
export function nameForObject(deck: Deck, key: string, label: string): string {
  return `${label} ${nextCounter(deck, key)}`;
}

/**
 * 创建文本对象（默认内容「新文本」）。
 *
 * @param id   预先由调用方生成的唯一 id
 * @param name 自动名称（例如「文本 1」）
 * @param view 当前视角，用于把新对象放到画面中心
 * @param z    新对象的层级值（通常来自 nextDepth）
 * @returns 文本对象；高度由 layoutText 按内容与宽度测量得到
 *
 * 默认值来源：行宽 760 约等于画面宽度的 40%，字号 48 保证首屏可读，
 * 行高 1.4 是中文正文的常见舒适值。
 */
export function createTextObject(
  id: string,
  name: string,
  view: ViewState,
  z: number,
): TextObject {
  const center = viewCenterAtZ(view, z);
  const width = 760;
  const fontSize = 48;
  const lineHeight = 1.4;
  // 先排版一次，用测得的总高度作为对象初始高度
  const layout = layoutText('新文本', width, fontSize, 'sans', false, lineHeight);
  return {
    id,
    type: 'text',
    name,
    x: center.x,
    y: center.y,
    z,
    width,
    height: layout.height,
    rotation: 0,
    opacity: 100,
    visible: true,
    text: '新文本',
    fontSize,
    font: 'sans',
    bold: false,
    align: 'left',
    color: DEFAULT_TEXT_COLOR,
    lineHeight,
    depth3d: 0,
  };
}

/**
 * 创建图片对象。
 *
 * @param src           图片资源地址（dataURL / object URL）
 * @param naturalWidth  原图宽度（像素），非法值由 defaultImageObject 兜底
 * @param naturalHeight 原图高度（像素）
 * @returns 初始尺寸按原始宽高比缩放到最长边 900 的图片对象
 *
 * 坐标由当前视角中心投影到 z 平面得到，再交给 validate.defaultImageObject 统一构造。
 */
export function createImageObject(
  id: string,
  name: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  view: ViewState,
  z: number,
): ImageObject {
  const center = viewCenterAtZ(view, z);
  return defaultImageObject(id, name, src, naturalWidth, naturalHeight, center.x, center.y, z);
}

/**
 * 按原始宽高比把媒体缩放到指定最大边长（等比缩放，不裁剪）。
 *
 * @param naturalWidth  原始宽度；为 0 或 NaN 时按 16:9 兜底，避免除以 0
 * @param naturalHeight 原始高度
 * @param maxDim        宽 / 高中较大者的上限（世界单位）
 * @returns 四舍五入后的宽高，至少一边等于 maxDim
 */
function fitMediaSize(naturalWidth: number, naturalHeight: number, maxDim: number): { width: number; height: number } {
  const ratio = naturalWidth / naturalHeight || 16 / 9;
  let width = maxDim;
  let height = width / ratio;
  if (height > maxDim) {
    height = maxDim;
    width = height * ratio;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * 创建视频对象。
 *
 * @param naturalWidth  视频原始像素宽；缺失时按 1280 兜底
 * @param naturalHeight 视频原始像素高；缺失时按 720 兜底
 * @param duration      视频时长（秒）
 * @param poster        可选首帧截图（dataURL），解码完成前作为占位显示
 * @returns 默认循环、不静音、音量 80、不自动播放的视频对象
 *
 * 初始显示尺寸按原始比例缩放到最长边 960（约半个画面宽）。
 */
export function createVideoObject(
  id: string,
  name: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  duration: number,
  view: ViewState,
  z: number,
  poster?: string,
): VideoObject {
  const center = viewCenterAtZ(view, z);
  // 缺失尺寸时按 720p 估算，保证初始比例合理
  const size = fitMediaSize(naturalWidth || 1280, naturalHeight || 720, 960);
  return {
    id,
    type: 'video',
    name,
    x: center.x,
    y: center.y,
    z,
    width: size.width,
    height: size.height,
    rotation: 0,
    opacity: 100,
    visible: true,
    src,
    fit: 'contain',
    naturalWidth: Math.max(1, Math.round(naturalWidth || 1280)),
    naturalHeight: Math.max(1, Math.round(naturalHeight || 720)),
    duration,
    loop: true,
    muted: false,
    volume: 80,
    autoplay: false,
    poster: poster || undefined,
  };
}

/**
 * 创建音频对象。
 *
 * @param duration 音频时长（秒）
 * @returns 占位卡片尺寸固定为 560x168 的音频对象（无画面，尺寸仅影响编辑态占位）
 *
 * 默认循环、音量 80、不自动播放，与视频保持一致。
 */
export function createAudioObject(
  id: string,
  name: string,
  src: string,
  duration: number,
  view: ViewState,
  z: number,
): AudioObject {
  const center = viewCenterAtZ(view, z);
  return {
    id,
    type: 'audio',
    name,
    x: center.x,
    y: center.y,
    z,
    width: 560,
    height: 168,
    rotation: 0,
    opacity: 100,
    visible: true,
    src,
    duration,
    loop: true,
    volume: 80,
    autoplay: false,
  };
}

/**
 * 创建 3D 模型对象。
 *
 * @param format 模型格式，决定渲染层选用哪个加载器
 * @returns 初始包围框 760x760、不自动旋转、自转速度 45 度/秒的模型对象
 *
 * 模型的实际尺寸由加载器读取包围盒后适配到该对象框，此处的 width/height 只是占位。
 */
export function createModelObject(
  id: string,
  name: string,
  src: string,
  format: ModelFormat,
  view: ViewState,
  z: number,
): ModelObject {
  const center = viewCenterAtZ(view, z);
  return {
    id,
    type: 'model',
    name,
    x: center.x,
    y: center.y,
    z,
    width: 760,
    height: 760,
    rotation: 0,
    opacity: 100,
    visible: true,
    src,
    format,
    autoRotate: false,
    rotateSpeed: 45,
  };
}

/**
 * 创建形状对象。
 *
 * @param shape 形状种类
 * @returns 形状对象；自由路径（path）的 points 初始为空数组，等待绘制填充
 *
 * 尺寸约定：普通形状 520x340；直线特殊化为 640x8（细长条），并默认带描边。
 */
export function createShapeObject(
  id: string,
  name: string,
  shape: ShapeKind,
  view: ViewState,
  z: number,
): ShapeObject {
  const center = viewCenterAtZ(view, z);
  const width = shape === 'line' ? 640 : 520;
  const height = shape === 'line' ? 8 : 340;
  return {
    id,
    type: 'shape',
    name,
    x: center.x,
    y: center.y,
    z,
    width,
    height,
    rotation: 0,
    opacity: 100,
    visible: true,
    shape,
    fill: DEFAULT_SHAPE_COLOR,
    stroke: shape === 'line' ? DEFAULT_SHAPE_COLOR : null,
    strokeWidth: shape === 'line' ? 6 : 0,
    points: shape === 'path' ? [] : undefined,
  };
}

/**
 * 创建 Lottie 动画对象。
 *
 * @param duration 动画时长（秒）
 * @param poster   可选首帧截图，动画数据尚未解析时作为占位显示
 * @returns 默认循环、播放速度 1 倍的 Lottie 对象；初始尺寸最长边 720
 */
export function createLottieObject(
  id: string,
  name: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  duration: number,
  view: ViewState,
  z: number,
  poster?: string,
): LottieObject {
  const center = viewCenterAtZ(view, z);
  const size = fitMediaSize(naturalWidth || 800, naturalHeight || 600, 720);
  return {
    id,
    type: 'lottie',
    name,
    x: center.x,
    y: center.y,
    z,
    width: size.width,
    height: size.height,
    rotation: 0,
    opacity: 100,
    visible: true,
    src,
    fit: 'contain',
    naturalWidth: Math.max(1, Math.round(naturalWidth || 800)),
    naturalHeight: Math.max(1, Math.round(naturalHeight || 600)),
    duration,
    loop: true,
    speed: 1,
    poster: poster || undefined,
  };
}

/**
 * 创建图表对象。
 *
 * @param spec 图表数据；构造时会经过 normalizeChartSpec 规范化，非法节点 / 边会被剔除
 * @returns 1280x720、默认播放布局动画的图表对象
 *
 * 图表不携带渲染结果，只保存声明式数据；真正绘制由插件渲染器在 3D 场景中实时完成。
 */
export function createChartObject(
  id: string,
  name: string,
  spec: ChartSpec,
  view: ViewState,
  z: number,
): ChartObject {
  const center = viewCenterAtZ(view, z);
  return {
    id,
    type: 'chart',
    name,
    x: center.x,
    y: center.y,
    z,
    width: 1280,
    height: 720,
    rotation: 0,
    opacity: 100,
    visible: true,
    spec: normalizeChartSpec(spec),
    animate: true,
  };
}

/**
 * 创建 SVG 对象。
 *
 * @param naturalWidth  从 SVG viewBox 解析出的原始宽度
 * @param naturalHeight 原始高度
 * @returns SVG 对象：先复用图片对象的尺寸计算，再改写 type 与落点坐标
 *
 * 复用 defaultImageObject 可保证 SVG 与图片拥有完全一致的初始尺寸策略。
 */
export function createSvgObject(
  id: string,
  name: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  view: ViewState,
  z: number,
): SvgObject {
  // 先以 (0,0) 为落点生成图片基座，稍后覆盖为视角中心
  const base = defaultImageObject(id, name, src, naturalWidth, naturalHeight, 0, 0, z);
  const center = viewCenterAtZ(view, z);
  return {
    ...base,
    type: 'svg',
    x: center.x,
    y: center.y,
  };
}

/**
 * 按当前文本内容与排版参数计算对象高度。
 *
 * @param obj   文本对象
 * @param width 可选行宽，默认取对象自身宽度（用于计算换行后的总高度）
 * @returns 排版高度，且不小于 LIMITS.minSize，避免空文本产生零高度
 *
 * 纯计算、无副作用；字体度量依赖 text.layoutText 的测量实现。
 */
export function autoTextHeight(obj: TextObject, width = obj.width): number {
  const layout = layoutText(obj.text, width, obj.fontSize, obj.font, obj.bold, obj.lineHeight);
  return Math.max(LIMITS.minSize, layout.height);
}

/**
 * 生成下一个视点的默认名称（「视点 N」）。
 *
 * 先从已有名称中解析出最大的「视点 N」序号，保证重命名过或删除过视点后
 * 新名称仍不重复；没有可解析名称时退回帧数量。
 *
 * @param frames 当前视点列表
 * @returns 形如「视点 3」的新名称
 */
export function nextFrameName(frames: Deck['frames']): string {
  let max = frames.length;
  for (const f of frames) {
    // 只识别默认命名格式，自定义名称不参与序号计算
    const match = /视点\s*(\d+)/.exec(f.name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `视点 ${max + 1}`;
}

/**
 * 把数值裁剪到 [min, max] 区间。
 *
 * @param value    待裁剪值；NaN / Infinity 等非有限值直接返回 fallback
 * @param min      下限
 * @param max      上限
 * @param fallback 非法值兜底
 * @returns 合法范围内的数字
 *
 * 用于编辑与导入两条路径的统一裁剪，避免 NaN 污染场景计算。
 */
export function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
