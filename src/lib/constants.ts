/**
 * constants.ts —— 全局几何常量、限制值与默认样式
 *
 * 本模块集中定义编辑器的「魔数」与硬性上限，避免同一数值散落在各处：
 * - 舞台几何：1920x1080 的 16:9 参考舞台、相机垂直视场角 FOV、默认取景距离；
 * - LIMITS：对象 / 视点数量、素材字节数、文本字数与各类坐标、尺寸、角度、时长范围；
 * - 默认值：背景色、过渡时长、停留时长、文本与形状颜色；
 * - 字体栈：预设字体名到真实 CSS font-family 的映射。
 *
 * 这些值同时被校验层（validate.normalizeDeck）、编辑层（deckStore）、
 * AI 工具层与导出流程引用，修改时需考虑已存作品的兼容性。
 */

import type { ViewState } from '../types';

/**
 * 相机垂直视场角（度）。
 * 用于反推默认取景距离，也用于 fitDistance 与画面锚点换算（AITools.placement）。
 */
export const FOV = 50;
/** 参考舞台宽度（世界单位），对应 1080p 画布宽度。 */
export const STAGE_WIDTH = 1920;
/** 参考舞台高度（世界单位），对应 1080p 画布高度。 */
export const STAGE_HEIGHT = 1080;
/** 舞台宽高比（16:9），用于按高度推算画面宽度。 */
export const ASPECT = STAGE_WIDTH / STAGE_HEIGHT;
/** 16:9 安全框在 z=0 平面恰好充满视口时的相机距离 */
export const DEFAULT_DISTANCE = STAGE_HEIGHT / 2 / Math.tan((FOV / 2) * (Math.PI / 180));

/** 新建作品的默认取景：对准原点、正前方、无俯仰。 */
export const DEFAULT_VIEW: ViewState = {
  target: { x: 0, y: 0, z: 0 },
  distance: DEFAULT_DISTANCE,
  yaw: 0,
  pitch: 0,
};

/**
 * 作品与资源的硬性限制集合。
 *
 * 这些上限同时约束三种入口：UI 输入（滑块 / 输入框）、AI 工具参数、以及
 * 从存储或 .slide 文件读入的不可信数据（validate 会按此裁剪）。
 * 若调大某上限，需要评估渲染性能与导入文件的体积风险。
 */
export const LIMITS = {
  /** 单个作品允许的最大内容对象数（防止场景渲染过载）。 */
  objects: 200,
  /** 单个作品允许的最大视点数。 */
  frames: 50,
  /** 单张图片资源的最大字节数（20 MB，避免 IndexedDB 过度膨胀）。 */
  imageBytes: 20 * 1024 * 1024,
  /** 视频 / 音频 / 模型等媒体资源单文件上限（100 MB）。 */
  mediaBytes: 100 * 1024 * 1024,
  /** 单个工程文件导入时的体积上限（200 MB）。 */
  projectBytes: 200 * 1024 * 1024,
  /** 单个文本对象的字符上限。 */
  textChars: 5000,
  /** 作品标题字符上限。 */
  titleChars: 80,
  /** 对象名称字符上限。 */
  objectNameChars: 60,
  /** 视点名称字符上限。 */
  frameNameChars: 40,
  /** 演讲备注字符上限。 */
  frameNotesChars: 2000,
  /** 世界坐标绝对值上限（x / y），超出会被裁剪到 ±coord。 */
  coord: 99999,
  /** 深度坐标绝对值上限（z）。 */
  depth: 10000,
  /** 对象最小边长，防止出现零面积、无法点选的对象。 */
  minSize: 8,
  /** 对象最大边长，防止放大到撑爆场景 / GPU 纹理。 */
  maxSize: 20000,
  /** 最小字号。 */
  minFontSize: 8,
  /** 最大字号。 */
  maxFontSize: 400,
  /** 最小不透明度（0 表示完全透明）。 */
  minOpacity: 0,
  /** 最大不透明度（100 表示完全不透明）。 */
  maxOpacity: 100,
  /** 最小旋转角度（度）。 */
  minRotation: -180,
  /** 最大旋转角度（度）。 */
  maxRotation: 180,
  /** 文本 3D 挤出厚度上限（世界单位）。 */
  maxTextDepth: 600,
  /** 自由路径最多采样点数；存储时用 2 个数字表示一个点，故实际数组上限为 2 倍。 */
  maxPathPoints: 2000,
  /** 最小行高倍率。 */
  minLineHeight: 0.8,
  /** 最大行高倍率。 */
  maxLineHeight: 3,
  /** 最小描边宽度（0 表示无描边）。 */
  minStroke: 0,
  /** 最大描边宽度。 */
  maxStroke: 40,
  /** 视点过渡时长下限（秒）。 */
  minDuration: 0.2,
  /** 视点过渡时长上限（秒）。 */
  maxDuration: 5,
  /** 自动播放停留时长下限（秒）。 */
  minHold: 0.5,
  /** 自动播放停留时长上限（秒）。 */
  maxHold: 120,
} as const;

/** 新建作品的默认背景色（深蓝黑）。 */
export const DEFAULT_BACKGROUND = '#10161F';
/** 新建视点的默认过渡时长（秒）。 */
export const DEFAULT_DURATION = 1.2;
/** 自动播放时每个视点的默认停留时长（秒） */
export const DEFAULT_HOLD = 5;
/** 新建文本的默认颜色（暖白）。 */
export const DEFAULT_TEXT_COLOR = '#F3EEE4';
/** 新建形状的默认填充色（青绿）。 */
export const DEFAULT_SHAPE_COLOR = '#2DD4BF';
/** 品牌强调色，用于高亮按钮与选中态。 */
export const ACCENT = '#14B8A6';
/**
 * 字体预设 -> CSS font-family 字体栈。
 * 每项都给出多级回退：优先系统中文字体，再退回通用族，保证跨平台可读。
 */
export const FONT_STACKS: Record<string, string> = {
  sans: '"PingFang SC","Microsoft YaHei",system-ui,"Segoe UI",sans-serif',
  serif: '"Songti SC","Noto Serif SC","SimSun",Georgia,serif',
  round: '"Hiragino Maru Gothic ProN","Yuanti SC","PingFang SC",system-ui,sans-serif',
  mono: '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
};
