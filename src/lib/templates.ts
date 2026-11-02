/**
 * templates.ts —— 内置演示模板
 *
 * 职责：以纯代码方式构造几套开箱即用的作品（封面 / 产品发布 / 数据看板 / 空间漫游），
 * 包含对象摆放与视点编排，新建作品时可直接套用。
 *
 * 关键概念：
 * - 模板全部在同一个 1920x1080 世界坐标系内布置对象：x 向右、y 向下、z 越大越靠前；
 * 标题类文本通常放在 y 为负的上半区，卡片 / 柱状图放在 y 为正的下半区；
 * - 每个视点由 (distance, x, y, yaw, pitch, z) 组合而成，通过推近 / 下移 / 拉远
 *   形成叙事节奏；hold 控制自动播放时的停留时长，notes 为演讲者备注；
 * - 模板中的颜色是写死的设计色板，与 constants 的通用默认色不同；
 * - 所有构建函数都返回全新 Deck，对象 / 视点 id 由 crypto.randomUUID 生成。
 *
 * 数据流：buildTemplateDeck -> template.build(title) -> 完整的 Deck -> 由调用方落库。
 */

import type {
  Deck,
  FontPreset,
  Frame,
  ShapeKind,
  ShapeObject,
  TextAlign,
  TextObject,
  ViewState,
} from '../types';
import { createDeck } from './deck';
import { DEFAULT_DISTANCE, DEFAULT_HOLD } from './constants';
import { layoutText } from './text';

/**
 * 模板内部使用的文本对象工厂。
 *
 * @param args 文本内容、位置、行宽与字号等；z 默认 0，字体默认 sans，
 *             行高默认 1.3，对齐默认居中，颜色默认暖白，不透明度默认 100
 * @returns 文本对象；高度由 layoutText 按内容测量
 *
 * 与 deck.createTextObject 的区别：不依赖当前视角，位置完全由模板写死。
 */
function textObject(args: {
  name: string;
  text: string;
  x: number;
  y: number;
  z?: number;
  width: number;
  fontSize: number;
  font?: FontPreset;
  bold?: boolean;
  color?: string;
  align?: TextAlign;
  lineHeight?: number;
  opacity?: number;
}): TextObject {
  const font = args.font ?? 'sans';
  const bold = args.bold ?? false;
  const lineHeight = args.lineHeight ?? 1.3;
  const layout = layoutText(args.text, args.width, args.fontSize, font, bold, lineHeight);
  return {
    id: crypto.randomUUID(),
    type: 'text',
    name: args.name,
    x: args.x,
    y: args.y,
    z: args.z ?? 0,
    width: args.width,
    height: layout.height,
    rotation: 0,
    opacity: args.opacity ?? 100,
    visible: true,
    text: args.text,
    fontSize: args.fontSize,
    font,
    bold,
    align: args.align ?? 'center',
    color: args.color ?? '#F3EEE4',
    lineHeight,
    depth3d: 0,
  };
}

/**
 * 模板内部使用的形状对象工厂。
 *
 * @param args 形状种类、中心坐标、宽高、填充色；z 默认 0，不透明度默认 100
 * @returns 无描边、无旋转的形状对象
 *
 * 光晕 / 背景卡等装饰性形状通常使用负的 z 值，确保位于文字下层。
 */
function shapeObject(args: {
  name: string;
  shape: ShapeKind;
  x: number;
  y: number;
  z?: number;
  width: number;
  height: number;
  fill: string;
  opacity?: number;
}): ShapeObject {
  return {
    id: crypto.randomUUID(),
    type: 'shape',
    name: args.name,
    x: args.x,
    y: args.y,
    z: args.z ?? 0,
    width: args.width,
    height: args.height,
    rotation: 0,
    opacity: args.opacity ?? 100,
    visible: true,
    shape: args.shape,
    fill: args.fill,
    stroke: null,
    strokeWidth: 0,
  };
}

/**
 * 便捷构造相机视角。
 *
 * @param distance 相机到目标点的距离（默认取景距离的倍数常用来做推近 / 拉远）
 * @param x / y / z 相机看向的目标点世界坐标
 * @param yaw      水平环绕角（弧度），用于轻微侧转
 * @param pitch    俯仰角（弧度），正值俯视
 * @returns ViewState
 */
function view(distance: number, x = 0, y = 0, yaw = 0, pitch = 0, z = 0): ViewState {
  return { target: { x, y, z }, distance, yaw, pitch };
}

/**
 * 构造视点。
 *
 * @param viewState 取景参数
 * @param options   duration 过渡时长（默认 1.2 秒）、hold 停留时长（默认 DEFAULT_HOLD）、
 *                  notes 演讲者备注
 * @returns Frame；id 自动生成
 */
function frame(
  name: string,
  viewState: ViewState,
  options: { duration?: number; hold?: number; notes?: string } = {},
): Frame {
  return {
    id: crypto.randomUUID(),
    name,
    duration: options.duration ?? 1.2,
    hold: options.hold ?? DEFAULT_HOLD,
    notes: options.notes,
    view: viewState,
  };
}

/** 内置模板 id 联合类型，与 DECK_TEMPLATES 中的 id 一一对应。 */
export type TemplateId = 'cover' | 'launch' | 'dashboard' | 'roam';

/**
 * 模板描述：元数据（用于新建面板展示）+ 构建函数。
 * 构建函数是纯工厂：每次调用都返回全新的对象与 id，可反复套用。
 */
export interface DeckTemplate {
  /** 模板标识。 */
  id: TemplateId;
  /** 展示名称。 */
  name: string;
  /** 一句话说明，列出适用场景。 */
  description: string;
  /** 该模板的主背景色，用于面板预览。 */
  background: string;
  /** 该模板的强调色，用于面板预览的色块。 */
  accent: string;
  /** 预置视点数量（仅用于展示，实际以 build 结果为准）。 */
  frameCount: number;
  /** 以给定标题构造完整作品。 */
  build: (title: string) => Deck;
}

/**
 * 构建「深色科技封面」模板：大标题 + 光晕装饰 + 三段推镜。
 *
 * @param title 作品标题
 * @returns 3 个视点的封面作品
 *
 * 视点节奏：全景 -> 推近主标题 -> 轻微后撤收尾，适合提案开场。
 */
function buildCover(title: string): Deck {
  const deck = createDeck(title);
  return {
    ...deck,
    background: '#0A1118',
    objects: [
      shapeObject({
        name: '背景光晕',
        shape: 'ellipse',
        x: 520,
        y: -30,
        z: -320,
        width: 1240,
        height: 1240,
        fill: '#0F766E',
        opacity: 34,
      }),
      textObject({
        name: '眉标',
        text: 'SPATIAL DECK · 2026',
        x: 0,
        y: -318,
        z: -20,
        width: 760,
        fontSize: 20,
        font: 'mono',
        bold: true,
        color: '#2DD4BF',
      }),
      textObject({
        name: '主标题',
        text: '把想法\n放进空间',
        x: 0,
        y: -70,
        z: 0,
        width: 1180,
        fontSize: 100,
        bold: true,
        lineHeight: 1.14,
      }),
      textObject({
        name: '副标题',
        text: '一次取景，一段叙事。\n所有内容都在同一个连续空间里。',
        x: 0,
        y: 168,
        z: 0,
        width: 900,
        fontSize: 28,
        color: '#9FB2C2',
        lineHeight: 1.5,
      }),
      shapeObject({
        name: '分隔线',
        shape: 'rect',
        x: 0,
        y: 306,
        z: -10,
        width: 760,
        height: 4,
        fill: '#2DD4BF',
        opacity: 62,
      }),
    ],
    frames: [
      frame('封面 · 全景', view(DEFAULT_DISTANCE * 1.26), {
        duration: 1.4,
        hold: 7,
        notes: '开场先停一拍，让观众看清整页的层次与光晕。',
      }),
      frame('标题 · 推近', view(DEFAULT_DISTANCE * 0.82, 0, -78, 0, 0.02), {
        duration: 1.2,
        hold: 6,
        notes: '推近主标题，配合口播念出主题。',
      }),
      frame('收尾 · 回望', view(DEFAULT_DISTANCE * 1.08, 0, 140, 0, 0.04), {
        duration: 1.4,
        hold: 5,
        notes: '轻微后撤并下移，留出呼吸感，然后切下一份作品。',
      }),
    ],
  };
}

/**
 * 构建「产品发布」模板：标题、一句话介绍与三列参数卡。
 *
 * @param title 作品标题
 * @returns 4 个视点的发布页作品
 *
 * 参数卡使用圆角矩形作为底、三个文本块左右排列，视点先全景再聚焦标题、下移讲卖点。
 */
function buildLaunch(title: string): Deck {
  const deck = createDeck(title);
  return {
    ...deck,
    background: '#131820',
    objects: [
      textObject({
        name: '标签',
        text: 'PRODUCT LAUNCH',
        x: 0,
        y: -345,
        z: -20,
        width: 760,
        fontSize: 18,
        font: 'mono',
        bold: true,
        color: '#2DD4BF',
      }),
      textObject({
        name: '发布标题',
        text: '新产品，\n新的叙事方式。',
        x: 0,
        y: -152,
        z: 0,
        width: 1240,
        fontSize: 84,
        bold: true,
        lineHeight: 1.16,
      }),
      textObject({
        name: '一句话介绍',
        text: '更快、更轻、更专注。',
        x: 0,
        y: 18,
        z: 0,
        width: 820,
        fontSize: 28,
        color: '#9FB2C2',
      }),
      shapeObject({
        name: '参数卡背景',
        shape: 'roundedRect',
        x: 0,
        y: 238,
        z: -18,
        width: 1280,
        height: 286,
        fill: '#182230',
        opacity: 76,
      }),
      shapeObject({
        name: '强调圆点',
        shape: 'ellipse',
        x: 710,
        y: 238,
        z: -12,
        width: 220,
        height: 220,
        fill: '#2DD4BF',
        opacity: 72,
      }),
      textObject({
        name: '参数一',
        text: '01 · 即刻发布',
        x: -430,
        y: 196,
        z: 0,
        width: 360,
        fontSize: 25,
        bold: true,
        color: '#E7F0F7',
      }),
      textObject({
        name: '参数一说明',
        text: '从空白到可演示，只要几分钟。',
        x: -430,
        y: 268,
        z: 0,
        width: 360,
        fontSize: 17,
        color: '#8CA0B3',
      }),
      textObject({
        name: '参数二',
        text: '02 · 空间取景',
        x: 0,
        y: 196,
        z: 0,
        width: 360,
        fontSize: 25,
        bold: true,
        color: '#E7F0F7',
      }),
      textObject({
        name: '参数二说明',
        text: '所有对象共用一个 3D 空间。',
        x: 0,
        y: 268,
        z: 0,
        width: 360,
        fontSize: 17,
        color: '#8CA0B3',
      }),
      textObject({
        name: '参数三',
        text: '03 · 离线可用',
        x: 430,
        y: 196,
        z: 0,
        width: 360,
        fontSize: 25,
        bold: true,
        color: '#E7F0F7',
      }),
      textObject({
        name: '参数三说明',
        text: '工程文件保存在本机浏览器。',
        x: 430,
        y: 268,
        z: 0,
        width: 360,
        fontSize: 17,
        color: '#8CA0B3',
      }),
    ],
    frames: [
      frame('开场 · 全景', view(DEFAULT_DISTANCE * 1.22), {
        duration: 1.4,
        hold: 6,
        notes: '先交代标题与三张参数卡的整体关系。',
      }),
      frame('标题 · 聚焦', view(DEFAULT_DISTANCE * 0.88, 0, -130, 0, 0.02), {
        duration: 1.1,
        hold: 5,
        notes: '聚焦主标题，强调「新的叙事方式」。',
      }),
      frame('参数 · 下移', view(DEFAULT_DISTANCE * 0.74, 0, 170, 0, 0.06), {
        duration: 1.1,
        hold: 6,
        notes: '下移到参数卡，逐条说明三个卖点。',
      }),
      frame('收尾 · 拉远', view(DEFAULT_DISTANCE * 1.12, 0, -20, 0, 0.03), {
        duration: 1.3,
        hold: 4,
        notes: '整体拉远，准备进入下一页。',
      }),
    ],
  };
}

/**
 * 构建「数据看板」模板：三组指标 + 柱状图。
 *
 * @param title 作品标题
 * @returns 3 个视点的数据页作品
 *
 * bars 数组同时描述柱高与配色，后续按索引等间距（210）横向排布，
 * 柱子的 y 以坐标轴为基线向上生长，因此取 `336 - height / 2` 作为中心点。
 */
function buildDashboard(title: string): Deck {
  const deck = createDeck(title);
  // 每根柱子的高度与填充色；颜色从品牌青绿过渡到琥珀与天蓝，用于区分指标
  const bars = [
    { height: 150, fill: '#2DD4BF' },
    { height: 260, fill: '#14B8A6' },
    { height: 214, fill: '#0F766E' },
    { height: 330, fill: '#F59E0B' },
    { height: 244, fill: '#38BDF8' },
  ];
  return {
    ...deck,
    background: '#0B1216',
    objects: [
      textObject({
        name: '数据标签',
        text: 'DATA REVIEW · Q4',
        x: -370,
        y: -282,
        z: -20,
        width: 1000,
        fontSize: 17,
        font: 'mono',
        bold: true,
        align: 'left',
        color: '#2DD4BF',
      }),
      textObject({
        name: '看板标题',
        text: '本季度数据',
        x: -370,
        y: -352,
        z: 0,
        width: 1000,
        fontSize: 62,
        bold: true,
        align: 'left',
      }),
      textObject({
        name: '指标一数值',
        text: '82%',
        x: -560,
        y: -120,
        z: 0,
        width: 340,
        fontSize: 76,
        bold: true,
        color: '#2DD4BF',
      }),
      textObject({
        name: '指标一标签',
        text: '内容复用率',
        x: -560,
        y: -46,
        z: 0,
        width: 340,
        fontSize: 18,
        color: '#8CA0B3',
      }),
      textObject({
        name: '指标二数值',
        text: '1.4M',
        x: 0,
        y: -120,
        z: 0,
        width: 340,
        fontSize: 76,
        bold: true,
      }),
      textObject({
        name: '指标二标签',
        text: '累计观看次数',
        x: 0,
        y: -46,
        z: 0,
        width: 340,
        fontSize: 18,
        color: '#8CA0B3',
      }),
      textObject({
        name: '指标三数值',
        text: '24',
        x: 560,
        y: -120,
        z: 0,
        width: 340,
        fontSize: 76,
        bold: true,
        color: '#F59E0B',
      }),
      textObject({
        name: '指标三标签',
        text: '本周新增作品',
        x: 560,
        y: -46,
        z: 0,
        width: 340,
        fontSize: 18,
        color: '#8CA0B3',
      }),
      shapeObject({
        name: '坐标轴',
        shape: 'rect',
        x: 0,
        y: 338,
        z: -18,
        width: 1120,
        height: 3,
        fill: '#334155',
      }),
      ...bars.map((bar, index) =>
        shapeObject({
          name: `柱状图 ${index + 1}`,
          shape: 'rect',
          x: -420 + index * 210,
          y: 336 - bar.height / 2,
          z: index * 2,
          width: 72,
          height: bar.height,
          fill: bar.fill,
        }),
      ),
    ],
    frames: [
      frame('看板 · 全景', view(DEFAULT_DISTANCE * 1.2), {
        duration: 1.4,
        hold: 6,
        notes: '先给整体数据一个全景，点出季度主题。',
      }),
      frame('指标 · 聚焦', view(DEFAULT_DISTANCE * 0.86, 0, -100, 0, 0.02), {
        duration: 1.1,
        hold: 6,
        notes: '逐个念出三个核心指标。',
      }),
      frame('趋势 · 下移', view(DEFAULT_DISTANCE * 0.9, 0, 190, 0, 0.1), {
        duration: 1.2,
        hold: 7,
        notes: '下移到柱状图，解释增长趋势与异常峰值。',
      }),
    ],
  };
}

/**
 * 构建「空间漫游」模板：内容分布在多个深度层，镜头沿路径穿行。
 *
 * @param title 作品标题
 * @returns 5 个视点的空间漫游作品
 *
 * 这是最能体现「一个空间、多条路径」的模板：三处光斑放在 z=-600 / -1200 / -1800
 * 的不同深度，视点依次转向左侧、向前、深入右下角，最后拉远回望。
 */
function buildRoam(title: string): Deck {
  const deck = createDeck(title);
  return {
    ...deck,
    background: '#0D1417',
    objects: [
      shapeObject({
        name: '左侧光斑',
        shape: 'ellipse',
        x: -900,
        y: 140,
        z: -620,
        width: 440,
        height: 440,
        fill: '#0F766E',
        opacity: 48,
      }),
      shapeObject({
        name: '前方光斑',
        shape: 'ellipse',
        x: 0,
        y: -220,
        z: -1220,
        width: 520,
        height: 520,
        fill: '#B45309',
        opacity: 42,
      }),
      shapeObject({
        name: '深处光斑',
        shape: 'ellipse',
        x: 800,
        y: 250,
        z: -1820,
        width: 460,
        height: 460,
        fill: '#155E75',
        opacity: 48,
      }),
      textObject({
        name: '主标题',
        text: '空间漫游',
        x: 0,
        y: -20,
        z: 0,
        width: 1000,
        fontSize: 92,
        bold: true,
      }),
      textObject({
        name: '主标题说明',
        text: '内容分布在多个深度层，跟着取景向前走。',
        x: 0,
        y: 86,
        z: 0,
        width: 880,
        fontSize: 26,
        color: '#93A7B8',
      }),
      textObject({
        name: '第一幕标题',
        text: '向左，是第一幕',
        x: -900,
        y: 250,
        z: -600,
        width: 760,
        fontSize: 46,
        bold: true,
        color: '#7DD3C0',
      }),
      textObject({
        name: '第一幕说明',
        text: '空间中的内容不必平均分布，\n镜头会替你找到重点。',
        x: -900,
        y: 330,
        z: -600,
        width: 760,
        fontSize: 22,
        color: '#9FB2C2',
        lineHeight: 1.5,
      }),
      textObject({
        name: '第二幕标题',
        text: '向前，是新的线索',
        x: 0,
        y: -150,
        z: -1200,
        width: 900,
        fontSize: 52,
        bold: true,
        color: '#FCD34D',
      }),
      textObject({
        name: '第二幕说明',
        text: '视点只记录相机怎么看你，\n对象始终留在原来的位置。',
        x: 0,
        y: -52,
        z: -1200,
        width: 900,
        fontSize: 22,
        color: '#C7BDA9',
        lineHeight: 1.5,
      }),
      textObject({
        name: '第三幕标题',
        text: '深处，仍有内容',
        x: 800,
        y: 320,
        z: -1800,
        width: 760,
        fontSize: 44,
        bold: true,
        color: '#E2F2FF',
        opacity: 88,
      }),
    ],
    frames: [
      frame('起点 · 全景', view(DEFAULT_DISTANCE * 1.3), {
        duration: 1.5,
        hold: 7,
        notes: '站定说明规则：一个空间，多条路径。',
      }),
      frame('左侧 · 第一幕', view(DEFAULT_DISTANCE * 0.84, -900, 180, 0, 0, -600), {
        duration: 1.4,
        hold: 6,
        notes: '转向左侧光斑，讲第一幕。',
      }),
      frame('前方 · 第二幕', view(DEFAULT_DISTANCE * 0.92, 0, -100, 0.12, 0, -1200), {
        duration: 1.5,
        hold: 6,
        notes: '沿路径向前，切到第二幕。',
      }),
      frame('深处 · 第三幕', view(DEFAULT_DISTANCE * 0.8, 760, 260, -0.16, 0, -1800), {
        duration: 1.5,
        hold: 6,
        notes: '继续深入，在右下角收束。',
      }),
      frame('回望 · 收尾', view(DEFAULT_DISTANCE * 1.6, 0, 0, 0.3, 0.05, -600), {
        duration: 1.6,
        hold: 5,
        notes: '拉远回望整个空间，结束漫游。',
      }),
    ],
  };
}

/**
 * 全部内置模板列表，顺序即新建面板中的展示顺序。
 * 新增模板时需同步扩展 TemplateId，并保证 frameCount 与实际视点数量一致。
 */
export const DECK_TEMPLATES: DeckTemplate[] = [
  {
    id: 'cover',
    name: '深色科技封面',
    description: '大标题 + 推镜开场，适合提案与作品集首页',
    background: '#0A1118',
    accent: '#2DD4BF',
    frameCount: 3,
    build: buildCover,
  },
  {
    id: 'launch',
    name: '产品发布',
    description: '标题与参数卡并置，三段运镜讲清新品卖点',
    background: '#131820',
    accent: '#38BDF8',
    frameCount: 4,
    build: buildLaunch,
  },
  {
    id: 'dashboard',
    name: '数据看板',
    description: '指标数字与柱状图，两段聚焦展示趋势',
    background: '#0B1216',
    accent: '#F59E0B',
    frameCount: 3,
    build: buildDashboard,
  },
  {
    id: 'roam',
    name: '空间漫游',
    description: '内容分布在多个深度层，沿路径穿行浏览',
    background: '#0D1417',
    accent: '#7DD3C0',
    frameCount: 5,
    build: buildRoam,
  },
];

/**
 * 按模板 id 构建作品。
 *
 * @param id    模板标识
 * @param title 作品标题
 * @returns 全新 Deck
 * @throws id 不在 DECK_TEMPLATES 中时抛出「模板不存在」
 *
 * 不访问存储；调用方负责把结果写入 IndexedDB 并设置当前作品。
 */
export function buildTemplateDeck(id: TemplateId, title: string): Deck {
  const template = DECK_TEMPLATES.find((item) => item.id === id);
  if (!template) throw new Error('模板不存在');
  return template.build(title);
}
