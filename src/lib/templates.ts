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

function view(distance: number, x = 0, y = 0, yaw = 0, pitch = 0, z = 0): ViewState {
  return { target: { x, y, z }, distance, yaw, pitch };
}

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

export type TemplateId = 'cover' | 'launch' | 'dashboard' | 'roam';

export interface DeckTemplate {
  id: TemplateId;
  name: string;
  description: string;
  background: string;
  accent: string;
  frameCount: number;
  build: (title: string) => Deck;
}

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

function buildDashboard(title: string): Deck {
  const deck = createDeck(title);
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

export function buildTemplateDeck(id: TemplateId, title: string): Deck {
  const template = DECK_TEMPLATES.find((item) => item.id === id);
  if (!template) throw new Error('模板不存在');
  return template.build(title);
}
