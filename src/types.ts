/**
 * types.ts —— 作品数据模型与中文标签常量
 *
 * 本模块是整个编辑器的数据契约：只声明 TypeScript 类型与纯常量映射，
 * 不含运行时逻辑，供状态仓库（store）、3D 渲染层、持久化层与 AI 工具共用。
 *
 * 关键概念：
 * - ViewState：一次相机取景快照。作品最后一帧视角（Deck.lastView）与每个视点（Frame.view）。
 * - SlideObject：画布内容对象的可辨识联合（discriminated union），按 `type` 字段区分成员。
 * - Deck：可序列化的作品结构，整体写入 IndexedDB 的 decks 表。
 * - 标签常量：对象类型 / 3D 模型格式 / 形状 / 字体的中文显示名，仅用于 UI 展示。
 *
 * 数据流：
 *   用户编辑 -> deckStore 生成新的 Deck -> validate.normalizeDeck 校验并裁剪
 *   -> storage.putDeck 落盘 -> 渲染层只读消费 Deck 的 objects / frames / lastView。
 *
 * 坐标与单位约定：
 * - x / y 为世界坐标，x 向右为正，y 向下为正（与屏幕坐标方向一致）；
 * - z 为深度，数值越大越靠近相机（越靠上层）；
 * - 角度（rotation、rotationX、rotationY）单位为「度」；
 * - 相机 view 中的 yaw / pitch 单位为「弧度」；
 * - opacity / volume 使用 0–100 的百分比整数；
 * - duration / hold 单位为「秒」。
 */

/** 三维向量：既表示世界坐标点，也表示相机目标点。 */
export interface Vec3 {
  /** 水平坐标，向右为正。 */
  x: number;
  /** 垂直坐标，向下为正。 */
  y: number;
  /** 深度坐标，越大越靠近观察者。 */
  z: number;
}

/** 相机取景快照：看向点 + 距离 + 朝向 */
export interface ViewState {
  /** 相机看向（并围绕其旋转）的世界坐标点 */
  target: Vec3;
  /** 相机到 target 的距离；默认值让 16:9 安全框恰好充满画布 */
  distance: number;
  /** 水平环绕角（弧度），绕 target 的竖轴旋转 */
  yaw: number;
  /** 俯仰角（弧度）；正值把相机抬高到 target 上方，形成俯视 */
  pitch: number;
}

/** 画布内容对象的类型标识，对应 SlideObject 联合成员的 `type` 字段。 */
export type ObjectType =
  | 'text'
  | 'image'
  | 'shape'
  | 'video'
  | 'audio'
  | 'model'
  | 'svg'
  | 'lottie'
  | 'chart';
/** 形状种类：基础几何图形与自由路径（path 的点坐标见 ShapeObject.points）。 */
export type ShapeKind =
  | 'rect'
  | 'roundedRect'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'star'
  | 'arrow'
  | 'line'
  | 'path';
/** 字体预设名；实际字体栈由 constants.FONT_STACKS 映射到具体 CSS 字体。 */
export type FontPreset = 'sans' | 'serif' | 'round' | 'mono';
/** 文本水平对齐方式。 */
export type TextAlign = 'left' | 'center' | 'right';
/** 图片等资源在对象框内的填充方式：contain 完整显示、cover 裁切铺满。 */
export type ImageFit = 'contain' | 'cover';
/** 可播放媒体类型：视频或音频。 */
export type MediaKind = 'video' | 'audio';
/** 3D 模型文件格式；决定渲染层使用哪个加载器（glTF / OBJ / FBX 等）。 */
export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'fbx' | 'stl' | 'ply' | 'dae' | '3mf' | 'usdz';

/**
 * 所有内容对象共有的基础字段（不直接对外导出，仅被各对象接口继承）。
 * 坐标为对象中心点；尺寸以世界单位表示（约等于 1920x1080 舞台上的像素）。
 */
interface ObjectBase {
  /** 对象唯一标识，由 crypto.randomUUID 生成；也是存储与选中状态的 key。 */
  id: string;
  /** 显示名称，用于图层列表与 AI 引用；空名称会在校验时被拒绝。 */
  name: string;
  /** 中心点世界坐标 x，向右为正。 */
  x: number;
  /** 中心点世界坐标 y，向下为正。 */
  y: number;
  /** 深度层级，数值越大越靠前（渲染时更上层）。 */
  z: number;
  /** 对象宽度（世界单位）。 */
  width: number;
  /** 对象高度（世界单位）；文本对象会随排版结果自动计算。 */
  height: number;
  /** 绕 Z 轴旋转（度） */
  rotation: number;
  /** 绕 X 轴倾斜（度） */
  rotationX?: number;
  /** 绕 Y 轴倾斜（度） */
  rotationY?: number;
  /** 0–100 */
  opacity: number;
  visible: boolean;
}

/** 文本对象：以字体栅格化后贴在 3D 平面上，支持可选挤出厚度。 */
export interface TextObject extends ObjectBase {
  type: 'text';
  /** 文本内容，可包含换行符 \n，长度上限见 LIMITS.textChars。 */
  text: string;
  /** 字号（世界单位），上限见 LIMITS.maxFontSize。 */
  fontSize: number;
  /** 字体预设，渲染时映射为具体字体栈。 */
  font: FontPreset;
  /** 是否加粗；影响文字排版测量出的高度。 */
  bold: boolean;
  /** 水平对齐方式，相对于对象框宽度。 */
  align: TextAlign;
  /** CSS 颜色字符串（十六进制），例如 #F3EEE4。 */
  color: string;
  /** 行高倍率（相对字号的倍数）。 */
  lineHeight: number;
  /** 3D 挤出厚度（0 表示平面文本） */
  depth3d?: number;
}

/** 图片对象：src 通常是 dataURL 或 blob URL，渲染为带材质的平面。 */
export interface ImageObject extends ObjectBase {
  type: 'image';
  /** 图片资源地址（dataURL / object URL）。 */
  src: string;
  /** 在对象框内的填充方式。 */
  fit: ImageFit;
  /** 是否锁定原始宽高比；为 true 时只改一边，另一边按比例联动。 */
  aspectLocked: boolean;
  /** 图片原始像素宽度，用于计算宽高比；异常数据会被规范化为至少 1。 */
  naturalWidth: number;
  /** 图片原始像素高度。 */
  naturalHeight: number;
}

/** 形状对象：由渲染层按 shape 用 Canvas / 几何体绘制，path 类型使用 points 描边。 */
export interface ShapeObject extends ObjectBase {
  type: 'shape';
  /** 具体形状种类。 */
  shape: ShapeKind;
  /** 填充色（CSS 颜色）。 */
  fill: string;
  /** 描边色；null 表示不描边。 */
  stroke: string | null;
  /** 描边宽度（世界单位），上限见 LIMITS.maxStroke。 */
  strokeWidth: number;
  /** 自由绘制路径：归一化坐标 [x0, y0, x1, y1, ...]（0–1，原点左上） */
  points?: number[];
}

/** SVG 矢量对象：与图片字段相似，但渲染为可缩放的矢量图形。 */
export interface SvgObject extends ObjectBase {
  type: 'svg';
  /** SVG 资源地址（dataURL），由 resources/svg 读取后写入。 */
  src: string;
  /** 在对象框内的填充方式。 */
  fit: ImageFit;
  /** SVG viewBox 对应的原始宽度。 */
  naturalWidth: number;
  /** SVG viewBox 对应的原始高度。 */
  naturalHeight: number;
}

/** Lottie 动画对象：JSON 动画数据直接内联为 dataURL，可在 3D 平面上播放。 */
export interface LottieObject extends ObjectBase {
  type: 'lottie';
  /** Lottie JSON 的 data URL */
  src: string;
  fit: ImageFit;
  naturalWidth: number;
  naturalHeight: number;
  /** 秒 */
  duration: number;
  loop: boolean;
  /** 播放速度倍率 */
  speed: number;
  /**
   * Lottie 渲染后端 id（见 lib/lottieBackends）。
   * 缺省表示使用默认的 canvas 后端，用于兼容旧存档；切换到 GPU 后端后写入具体 id。
   */
  renderer?: string;
  /** 首帧截图（dataURL），加载动画前先作为占位图显示 */
  poster?: string;
}

/** 视频对象：以视频纹理形式渲染，支持首帧海报与播放控制。 */
export interface VideoObject extends ObjectBase {
  type: 'video';
  /** 视频资源地址（dataURL / object URL）。 */
  src: string;
  fit: ImageFit;
  naturalWidth: number;
  naturalHeight: number;
  /** 秒 */
  duration: number;
  loop: boolean;
  muted: boolean;
  /** 0–100 */
  volume: number;
  autoplay: boolean;
  /** 首帧截图（dataURL），视频解码完成前先作为占位图显示 */
  poster?: string;
}

/**
 * 音频对象：没有可绘制画面，编辑态显示为占位卡片，演示时按时间轴播放。
 * 尺寸字段仅决定占位卡片大小，不影响声音。
 */
export interface AudioObject extends ObjectBase {
  type: 'audio';
  /** 音频资源地址（dataURL / object URL）。 */
  src: string;
  /** 音频时长（秒），由读取文件时探测得到。 */
  duration: number;
  /** 是否循环播放。 */
  loop: boolean;
  /** 0–100 */
  volume: number;
  /** 进入该视点后是否自动开始播放。 */
  autoplay: boolean;
}

/** 媒体对象联合：视频或音频，便于批量处理播放控制。 */
export type MediaObject = VideoObject | AudioObject;

/**
 * 图表插件自定义的声明式数据。
 *
 * 核心不关心图表内容（节点、边、布局等全部由插件定义），只把它当作
 * 可序列化 JSON 透传：随作品保存、参与导入导出与场景脏检查。
 */
export type ChartSpec = Record<string, unknown>;

/**
 * 图表对象：数据内联在作品中，由插件渲染器实时绘制到 3D 平面上。
 * animate 决定插入 / 数据变化时是否播放布局动画。
 */
export interface ChartObject extends ObjectBase {
  type: 'chart';
  /** 负责渲染与编辑该图表的插件 id；由插件注册中心解析。 */
  plugin: string;
  /** 插件自定义的图表数据。 */
  spec: ChartSpec;
  /** 是否播放布局动画。 */
  animate: boolean;
}

/**
 * 3D 模型对象：模型文件以 dataURL 保存，渲染时交给对应格式的加载器解析；
 * x / y / z 决定模型在空间中的摆放位置。
 */
export interface ModelObject extends ObjectBase {
  type: 'model';
  /** 模型资源地址（通常为 base64 dataURL）。 */
  src: string;
  /** 模型格式，决定加载器与解析方式。 */
  format: ModelFormat;
  /** 演示与编辑时绕竖轴自动旋转 */
  autoRotate: boolean;
  /** 自转速度，度/秒 */
  rotateSpeed: number;
}

/**
 * 画布对象的可辨识联合类型。
 * TypeScript 可借助 `type` 字段自动收窄到具体成员；运行时判定也统一依据该字段。
 */
export type SlideObject =
  | TextObject
  | ImageObject
  | ShapeObject
  | VideoObject
  | AudioObject
  | ModelObject
  | SvgObject
  | LottieObject
  | ChartObject;

/**
 * 视点（帧）：演示时相机按 frames 顺序依次飞行到的取景位置。
 * 注意它只记录「相机怎么看」，不记录对象；对象始终留在空间中固定位置。
 */
export interface Frame {
  /** 视点唯一标识。 */
  id: string;
  /** 视点名称，时间轴与缩略图上展示。 */
  name: string;
  /** 被进入时的过渡时长（秒） */
  duration: number;
  /** 演讲者备注，仅在演示端可见 */
  notes?: string;
  /** 自动播放时在该视点停留的秒数 */
  hold?: number;
  /** 该视点的相机取景参数（深拷贝保存，避免与实时视角共享引用）。 */
  view: ViewState;
}

/**
 * 作品（Deck）：整个可编辑文档的可序列化根结构。
 * 所有对象与视点都内联在同一个文档中，因此保存 / 导入导出时只需处理单一 JSON。
 */
export interface Deck {
  /** 作品唯一标识，同时作为 IndexedDB decks 表的主键与编辑锁的 key。 */
  id: string;
  /** 作品标题，显示在首页卡片与导出文件名中。 */
  title: string;
  /** 画布背景色（CSS 颜色），也用于 3D 场景背景。 */
  background: string;
  /** 作品默认过渡时长（秒） */
  defaultDuration: number;
  /** 演示时是否在底部显示视点进度条。 */
  showProgress: boolean;
  /** 画布内容对象列表；渲染顺序与数组顺序无关，实际层级由每个对象的 z 决定。 */
  objects: SlideObject[];
  /** 演示视点序列，按数组顺序播放。 */
  frames: Frame[];
  /** 最后一次编辑视图 */
  lastView: ViewState;
  /** 默认名称计数，删除后不回收 */
  counters: Record<string, number>;
  /** 创建时间（毫秒时间戳）。 */
  createdAt: number;
  /** 最后修改时间（毫秒时间戳），首页列表按此倒序排列。 */
  updatedAt: number;
}

/** 保存状态机的状态值：dirty 待保存、saving 保存中、saved 已落盘、error 保存失败。 */
export type SaveState = 'dirty' | 'saving' | 'saved' | 'error';

/** 保存状态的附加信息，由 deckStore 维护供顶栏展示。 */
export interface SaveStatus {
  /** 当前状态。 */
  state: SaveState;
  /** 最近一次成功保存的时间戳（毫秒）；saved 时存在。 */
  at?: number;
  /** 保存失败时的可读错误信息；error 时存在。 */
  message?: string;
}

/** 相机请求类型：恢复默认、聚焦单个对象、飞行到某个视点。 */
export type CameraRequestType = 'reset' | 'focus' | 'frame';

/**
 * 相机请求：由 store 写入、3D 场景消费后执行一次运镜。
 * id 自增用于让场景区分「新的一次请求」，避免同参数请求被忽略。
 */
export interface CameraRequest {
  /** 自增请求序号，每次请求都会变化。 */
  id: number;
  /** 请求类型。 */
  type: CameraRequestType;
  /** 视点飞行目标 */
  view?: ViewState;
  /** type 为 focus 时要聚焦的对象 id。 */
  objectId?: string;
  /** 飞行时长（秒），缺省由场景使用默认值。 */
  duration?: number;
}

/** 作品摘要：在某些预览 / 选择场景中同时携带作品本体与损坏提示。 */
export type DeckSummary = {
  /** 完整作品数据。 */
  deck: Deck;
  /** 数据无法完整解析时的提示文案；正常作品为 undefined。 */
  broken?: string;
};

/** 对象类型 -> 中文显示名。 */
export const OBJECT_LABELS: Record<ObjectType, string> = {
  text: '文本',
  image: '图片',
  shape: '形状',
  video: '视频',
  audio: '音频',
  model: '3D 模型',
  svg: 'SVG 图形',
  lottie: 'Lottie 动画',
  chart: '图表',
};

/** 3D 模型格式 -> 中文 / 官方显示名。 */
export const MODEL_FORMAT_LABELS: Record<ModelFormat, string> = {
  glb: 'GLB',
  gltf: 'glTF',
  obj: 'OBJ',
  fbx: 'FBX',
  stl: 'STL',
  ply: 'PLY',
  dae: 'DAE',
  '3mf': '3MF',
  usdz: 'USDZ',
};

/** 形状种类 -> 中文显示名，也用于自动命名（例如「矩形 1」）。 */
export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: '矩形',
  roundedRect: '圆角矩形',
  ellipse: '椭圆',
  triangle: '三角形',
  diamond: '菱形',
  star: '星形',
  arrow: '箭头',
  line: '直线',
  path: '自由路径',
};

/** 字体预设 -> 字体选择器中的中文显示名。 */
export const FONT_LABELS: Record<FontPreset, string> = {
  sans: '系统黑体',
  serif: '宋体',
  round: '圆体',
  mono: '等宽',
};
