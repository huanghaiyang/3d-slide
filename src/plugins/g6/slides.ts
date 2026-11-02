/**
 * plugins/g6/slides.ts —— G6 图表示例作品
 *
 * 每个示例都是完整 Deck：一张由 G6 离屏渲染的图表图片 + 标题文案 + 3 个视点。
 * 模板构建是异步的：先等待 G6 渲染出 PNG dataURL，再组装成普通 ImageObject，
 * 因此运行时不需要 G6 参与渲染，3D 场景与导出流程完全复用现有图片能力。
 *
 * 图表渲染结果按模板 id 缓存：同一模板被多次创建时只渲染一次。
 */

import type { Deck, Frame, ImageObject, TextObject, ViewState } from '../../types';
import { DEFAULT_DISTANCE, DEFAULT_HOLD } from '../../lib/constants';
import { autoTextHeight, createDeck } from '../../lib/deck';
import { defaultImageObject } from '../../lib/validate';
import { renderG6Chart, type G6ChartSpec } from './render';
import type { PluginTemplate } from '../types';

/** 图表渲染缓存：模板 id -> 渲染 Promise，避免重复创建时重复渲染。 */
const chartCache = new Map<string, Promise<string>>();

/**
 * 带缓存的图表渲染。
 *
 * @param key  模板 id
 * @param spec 图表描述
 * @returns PNG dataURL；失败的 Promise 会从缓存中移除，允许下次重试
 */
function renderCached(key: string, spec: G6ChartSpec): Promise<string> {
  const cached = chartCache.get(key);
  if (cached) return cached;
  const promise = renderG6Chart(spec).catch((error) => {
    chartCache.delete(key);
    throw error;
  });
  chartCache.set(key, promise);
  return promise;
}

/** 便捷构造相机视角，参数含义与 lib/templates 中的同名函数一致。 */
function view(distance: number, x = 0, y = 0, yaw = 0, pitch = 0, z = 0): ViewState {
  return { target: { x, y, z }, distance, yaw, pitch };
}

/** 构造一个示例视点。 */
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

/** 文本对象的构造参数。 */
interface TextOptions {
  x: number;
  y: number;
  z: number;
  width: number;
  fontSize: number;
  color: string;
  bold?: boolean;
  font?: TextObject['font'];
  lineHeight?: number;
  align?: TextObject['align'];
}

/**
 * 构造文本对象并测量高度。
 * 与 deck.createTextObject 不同，这里允许直接指定世界坐标与宽度，便于版式精确排版。
 */
function text(name: string, content: string, options: TextOptions): TextObject {
  const object: TextObject = {
    id: crypto.randomUUID(),
    type: 'text',
    name,
    x: options.x,
    y: options.y,
    z: options.z,
    width: options.width,
    height: 0,
    rotation: 0,
    opacity: 100,
    visible: true,
    text: content,
    fontSize: options.fontSize,
    font: options.font ?? 'sans',
    bold: options.bold ?? false,
    align: options.align ?? 'left',
    color: options.color,
    lineHeight: options.lineHeight ?? 1.3,
    depth3d: 0,
  };
  object.height = autoTextHeight(object);
  return object;
}

/**
 * 构造图表图片对象。
 *
 * G6 以 1600x900 渲染，展示尺寸固定为 1280x720（16:9），保证文字标签清晰、
 * 又能与标题和说明文字留出间距。
 */
function chartImage(name: string, src: string): ImageObject {
  const base = defaultImageObject(crypto.randomUUID(), name, src, 1600, 900, 0, 80, 0);
  return {
    ...base,
    width: 1280,
    height: 720,
    aspectLocked: true,
    fit: 'contain',
  };
}

/** 组装示例作品所需的文案与图表。 */
interface ComposeInput {
  title: string;
  background: string;
  accent: string;
  eyebrow: string;
  heading: string;
  caption: string;
  chartSrc: string;
  notes: [string, string, string];
}

/**
 * 把图表与文案组装为完整 Deck。
 *
 * 版式：顶部眉标 + 主标题，中间图表，底部说明；三个视点分别对应全景、聚焦图表、收尾。
 */
function composeDeck(input: ComposeInput): Deck {
  const deck = createDeck(input.title);
  const objects = [
    text('眉标', input.eyebrow, {
      x: 0,
      y: -448,
      z: -40,
      width: 1200,
      fontSize: 18,
      font: 'mono',
      bold: true,
      color: input.accent,
    }),
    text('主标题', input.heading, {
      x: 0,
      y: -352,
      z: -20,
      width: 1240,
      fontSize: 64,
      bold: true,
      lineHeight: 1.12,
      color: '#F3EEE4',
    }),
    chartImage('G6 图表', input.chartSrc),
    text('图表说明', input.caption, {
      x: 0,
      y: 486,
      z: 10,
      width: 1200,
      fontSize: 20,
      color: '#9FB2C2',
      lineHeight: 1.5,
    }),
  ];

  return {
    ...deck,
    background: input.background,
    objects,
    frames: [
      frame('全景', view(DEFAULT_DISTANCE * 1.22), {
        duration: 1.4,
        hold: 6,
        notes: input.notes[0],
      }),
      frame('图表 · 聚焦', view(DEFAULT_DISTANCE * 0.84, 0, 60), {
        duration: 1.1,
        hold: 7,
        notes: input.notes[1],
      }),
      frame('说明 · 收尾', view(DEFAULT_DISTANCE * 0.96, 0, -140, 0, 0.03), {
        duration: 1.2,
        hold: 5,
        notes: input.notes[2],
      }),
    ],
  };
}

/** 关系网络：力导布局展示业务节点之间的多对多连接。 */
async function buildNetwork(title: string): Promise<Deck> {
  const background = '#08111B';
  const accent = '#5B8FF9';
  const chart = await renderCached('g6-network', {
    layout: 'force',
    background,
    accent,
    nodes: [
      { id: 'core', label: '增长目标', kind: 'core' },
      { id: 'segment', label: '用户分层' },
      { id: 'content', label: '内容运营' },
      { id: 'channel', label: '渠道投放' },
      { id: 'data', label: '数据分析' },
      { id: 'social', label: '社群裂变' },
      { id: 'goods', label: '商品中心' },
      { id: 'member', label: '会员体系' },
      { id: 'rec', label: '推荐算法' },
      { id: 'campaign', label: '活动运营' },
      { id: 'funnel', label: '转化漏斗', kind: 'leaf' },
    ],
    edges: [
      { source: 'core', target: 'segment' },
      { source: 'core', target: 'content' },
      { source: 'core', target: 'channel' },
      { source: 'core', target: 'data' },
      { source: 'core', target: 'social' },
      { source: 'segment', target: 'goods' },
      { source: 'content', target: 'rec' },
      { source: 'channel', target: 'funnel' },
      { source: 'goods', target: 'member' },
      { source: 'rec', target: 'campaign' },
      { source: 'social', target: 'campaign' },
      { source: 'data', target: 'social' },
      { source: 'member', target: 'funnel' },
    ],
  });

  return composeDeck({
    title,
    background,
    accent,
    eyebrow: 'ANTV G6 · NETWORK',
    heading: '关系网络\n一图看清业务连接',
    caption: 'G6 力导布局 · 11 个节点 / 13 条关系 · 节点大小与颜色表达层级',
    chartSrc: chart,
    notes: [
      '先用全景建立整体印象，让观众看到节点密度与连线关系。',
      '推近图表中心，逐条讲解「增长目标」到各业务模块的连接。',
      '后撤到说明文字，用一句话总结关系网络的价值。',
    ],
  });
}

/** 思维导图：dagre 横向层次布局，展示从根主题到叶子要点的结构。 */
async function buildMindmap(title: string): Promise<Deck> {
  const background = '#0B1412';
  const accent = '#61DDAA';
  const chart = await renderCached('g6-mindmap', {
    layout: 'dagre-lr',
    background,
    accent,
    nodes: [
      { id: 'root', label: '空间演示', kind: 'core' },
      { id: 'content', label: '内容对象' },
      { id: 'frame', label: '视点编排' },
      { id: 'scene', label: '3D 场景' },
      { id: 'share', label: '导出分享' },
      { id: 'content-text', label: '文本 / 图片', kind: 'leaf' },
      { id: 'content-chart', label: 'G6 图表', kind: 'leaf' },
      { id: 'frame-capture', label: '捕获视点', kind: 'leaf' },
      { id: 'frame-time', label: '时长 / 备注', kind: 'leaf' },
      { id: 'scene-camera', label: '相机 / 光照', kind: 'leaf' },
      { id: 'scene-model', label: '3D 模型', kind: 'leaf' },
      { id: 'share-video', label: '视频导出', kind: 'leaf' },
      { id: 'share-file', label: '工程文件', kind: 'leaf' },
    ],
    edges: [
      { source: 'root', target: 'content' },
      { source: 'root', target: 'frame' },
      { source: 'root', target: 'scene' },
      { source: 'root', target: 'share' },
      { source: 'content', target: 'content-text' },
      { source: 'content', target: 'content-chart' },
      { source: 'frame', target: 'frame-capture' },
      { source: 'frame', target: 'frame-time' },
      { source: 'scene', target: 'scene-camera' },
      { source: 'scene', target: 'scene-model' },
      { source: 'share', target: 'share-video' },
      { source: 'share', target: 'share-file' },
    ],
  });

  return composeDeck({
    title,
    background,
    accent,
    eyebrow: 'ANTV G6 · MINDMAP',
    heading: '思维导图\n把结构讲清楚',
    caption: 'G6 Dagre 布局 · 从根主题向右展开 4 个分支与 8 个要点',
    chartSrc: chart,
    notes: [
      '全景展示整棵结构树，先讲清楚四个一级分支。',
      '聚焦图表，从上到下依次介绍每个分支下的关键能力。',
      '回到说明文字，强调「结构先于细节」的表达原则。',
    ],
  });
}

/** 流程编排：dagre 纵向布局，展示从素材到发布的线性流程与旁支。 */
async function buildFlow(title: string): Promise<Deck> {
  const background = '#12100A';
  const accent = '#F6BD16';
  const chart = await renderCached('g6-flow', {
    layout: 'dagre-tb',
    background,
    accent,
    nodes: [
      { id: 'upload', label: '上传素材', kind: 'core' },
      { id: 'parse', label: '解析资源' },
      { id: 'canvas', label: '放置画布' },
      { id: 'frame', label: '捕获视点' },
      { id: 'present', label: '演示播放' },
      { id: 'export', label: '导出分享', kind: 'leaf' },
      { id: 'ai', label: 'AI 生成', kind: 'leaf' },
      { id: 'plugin', label: '插件模板', kind: 'leaf' },
      { id: 'edit', label: '编辑对象', kind: 'leaf' },
    ],
    edges: [
      { source: 'upload', target: 'parse' },
      { source: 'parse', target: 'canvas' },
      { source: 'canvas', target: 'frame' },
      { source: 'frame', target: 'present' },
      { source: 'present', target: 'export' },
      { source: 'ai', target: 'canvas' },
      { source: 'plugin', target: 'canvas' },
      { source: 'edit', target: 'frame' },
    ],
  });

  return composeDeck({
    title,
    background,
    accent,
    eyebrow: 'ANTV G6 · PIPELINE',
    heading: '流程编排\n从素材到演示',
    caption: 'G6 Dagre 布局 · 主流程 6 步，AI 与插件作为旁支汇入画布',
    chartSrc: chart,
    notes: [
      '先交代主流程的起点与终点，让观众建立路径感。',
      '聚焦图表，逐步说明解析、放置、捕获、播放四个关键节点。',
      '补充旁支能力：AI 生成与插件模板可以直接产出画布内容。',
    ],
  });
}

/** 辐射图谱：radial 布局以产品中台为中心，向外辐射八个能力域。 */
async function buildRadial(title: string): Promise<Deck> {
  const background = '#140D0B';
  const accent = '#E8684A';
  const chart = await renderCached('g6-radial', {
    layout: 'radial',
    background,
    accent,
    focusNode: 'core',
    nodes: [
      { id: 'core', label: '产品中台', kind: 'core' },
      { id: 'user', label: '用户' },
      { id: 'content', label: '内容' },
      { id: 'data', label: '数据' },
      { id: 'trade', label: '交易' },
      { id: 'risk', label: '风控' },
      { id: 'service', label: '客服' },
      { id: 'growth', label: '营销' },
      { id: 'tech', label: '技术' },
      { id: 'user-profile', label: '画像', kind: 'leaf' },
      { id: 'content-asset', label: '素材库', kind: 'leaf' },
      { id: 'data-metric', label: '指标', kind: 'leaf' },
      { id: 'trade-order', label: '订单', kind: 'leaf' },
      { id: 'risk-audit', label: '审核', kind: 'leaf' },
      { id: 'service-ticket', label: '工单', kind: 'leaf' },
      { id: 'growth-campaign', label: '活动', kind: 'leaf' },
      { id: 'tech-gateway', label: '网关', kind: 'leaf' },
    ],
    edges: [
      { source: 'core', target: 'user' },
      { source: 'core', target: 'content' },
      { source: 'core', target: 'data' },
      { source: 'core', target: 'trade' },
      { source: 'core', target: 'risk' },
      { source: 'core', target: 'service' },
      { source: 'core', target: 'growth' },
      { source: 'core', target: 'tech' },
      { source: 'user', target: 'user-profile' },
      { source: 'content', target: 'content-asset' },
      { source: 'data', target: 'data-metric' },
      { source: 'trade', target: 'trade-order' },
      { source: 'risk', target: 'risk-audit' },
      { source: 'service', target: 'service-ticket' },
      { source: 'growth', target: 'growth-campaign' },
      { source: 'tech', target: 'tech-gateway' },
    ],
  });

  return composeDeck({
    title,
    background,
    accent,
    eyebrow: 'ANTV G6 · RADIAL',
    heading: '辐射图谱\n以中台为中心',
    caption: 'G6 辐射布局 · 1 个中心、8 个能力域、8 个叶子节点',
    chartSrc: chart,
    notes: [
      '全景展示辐射结构，强调「一个中心、多个能力域」。',
      '推近中心节点，讲解产品中台的聚合作用。',
      '拉远收尾，说明叶子节点代表每个能力域的最小交付单元。',
    ],
  });
}

/** 环形生态：circular 布局把 12 个能力节点均匀排布在同一个环上。 */
async function buildCircular(title: string): Promise<Deck> {
  const background = '#0A1118';
  const accent = '#7DD3C0';
  const chart = await renderCached('g6-circular', {
    layout: 'circular',
    background,
    accent,
    nodes: [
      { id: 'content', label: '内容', kind: 'core' },
      { id: 'frame', label: '视点' },
      { id: 'camera', label: '相机' },
      { id: 'light', label: '光照' },
      { id: 'model', label: '模型' },
      { id: 'anim', label: '动画' },
      { id: 'asset', label: '素材' },
      { id: 'ai', label: 'AI' },
      { id: 'plugin', label: '插件' },
      { id: 'export', label: '导出' },
      { id: 'storage', label: '存储' },
      { id: 'collab', label: '协作' },
    ],
    edges: [
      { source: 'content', target: 'frame' },
      { source: 'frame', target: 'camera' },
      { source: 'camera', target: 'light' },
      { source: 'light', target: 'model' },
      { source: 'model', target: 'anim' },
      { source: 'anim', target: 'asset' },
      { source: 'asset', target: 'ai' },
      { source: 'ai', target: 'plugin' },
      { source: 'plugin', target: 'export' },
      { source: 'export', target: 'storage' },
      { source: 'storage', target: 'collab' },
      { source: 'collab', target: 'content' },
    ],
  });

  return composeDeck({
    title,
    background,
    accent,
    eyebrow: 'ANTV G6 · ECOSYSTEM',
    heading: '环形生态\n能力彼此连接',
    caption: 'G6 环形布局 · 12 个能力节点首尾相连，表达闭环协作',
    chartSrc: chart,
    notes: [
      '先看整体环形结构，强调「没有绝对起点」。',
      '沿环顺时针介绍内容、视点、相机、光照与模型链路。',
      '最后点出插件与协作能力，说明生态可以持续扩展。',
    ],
  });
}

/** G6 插件贡献的全部示例模板，顺序即首页展示顺序。 */
export const G6_TEMPLATES: PluginTemplate[] = [
  {
    id: 'g6-network',
    name: 'G6 关系网络',
    description: '力导布局展示业务节点之间的多对多连接',
    background: '#08111B',
    accent: '#5B8FF9',
    frameCount: 3,
    build: buildNetwork,
  },
  {
    id: 'g6-mindmap',
    name: 'G6 思维导图',
    description: '层次树结构，从根主题向右展开能力分支',
    background: '#0B1412',
    accent: '#61DDAA',
    frameCount: 3,
    build: buildMindmap,
  },
  {
    id: 'g6-flow',
    name: 'G6 流程编排',
    description: '纵向流程与旁支汇入，适合讲解产品链路',
    background: '#12100A',
    accent: '#F6BD16',
    frameCount: 3,
    build: buildFlow,
  },
  {
    id: 'g6-radial',
    name: 'G6 辐射图谱',
    description: '中心辐射结构，展示中台与能力域的关系',
    background: '#140D0B',
    accent: '#E8684A',
    frameCount: 3,
    build: buildRadial,
  },
  {
    id: 'g6-circular',
    name: 'G6 环形生态',
    description: '环形布局表达能力闭环与协作生态',
    background: '#0A1118',
    accent: '#7DD3C0',
    frameCount: 3,
    build: buildCircular,
  },
];
