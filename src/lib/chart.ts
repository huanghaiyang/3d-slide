/**
 * chart.ts —— 图表数据模型工具
 *
 * 图表对象只保存声明式数据（布局 + 节点 + 边 + 配色），真正的绘制由插件提供的
 * 图表渲染器完成。本模块负责：
 * - 提供插入图表时可直接使用的示例数据集（也供插件模板复用）；
 * - 对来自存档、输入框或 AI 的原始数据进行规范化，保证节点 / 边始终自洽；
 * - 生成用于脏检查的稳定键，避免数据没变时重复重建图表。
 *
 * 约束：节点最多 MAX_CHART_NODES 个、边最多 MAX_CHART_EDGES 条，
 * 超出部分会被截断；边的两端必须指向存在的节点，否则会被丢弃。
 */

import type { ChartEdge, ChartLayout, ChartNode, ChartSpec } from '../types';
import { CHART_DEFAULT_ACCENT } from './constants';

/** 图表节点数量上限。 */
export const MAX_CHART_NODES = 40;
/** 图表边数量上限。 */
export const MAX_CHART_EDGES = 120;
/** 节点 / 边文案长度上限。 */
const MAX_LABEL_CHARS = 28;
const MAX_ID_CHARS = 64;

/** 布局类型 -> 中文名称，供属性面板下拉框使用。 */
export const CHART_LAYOUT_LABELS: Record<ChartLayout, string> = {
  force: '力导网络',
  'dagre-lr': '层次 · 横向',
  'dagre-tb': '层次 · 纵向',
  radial: '中心辐射',
  circular: '环形',
};

/** 节点层级 -> 中文名称。 */
export const CHART_KIND_LABELS: Record<'core' | 'node' | 'leaf', string> = {
  core: '重点',
  node: '常规',
  leaf: '细节',
};

/** 内置示例数据集：插入图表与插件模板共用同一份数据。 */
export interface ChartPreset {
  /** 示例唯一 id。 */
  id: string;
  /** 示例名称。 */
  name: string;
  /** 一句话说明。 */
  description: string;
  /** 图表数据。 */
  spec: ChartSpec;
}

/**
 * 关系网络：力导布局展示业务节点之间的多对多连接。
 * 这是插入图表时的默认数据集。
 */
const NETWORK_SPEC: ChartSpec = {
  layout: 'force',
  accent: '#5B8FF9',
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
};

/** 思维导图：dagre 横向层次布局。 */
const MINDMAP_SPEC: ChartSpec = {
  layout: 'dagre-lr',
  accent: '#61DDAA',
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
};

/** 流程编排：dagre 纵向布局，展示主流程与旁支。 */
const FLOW_SPEC: ChartSpec = {
  layout: 'dagre-tb',
  accent: '#F6BD16',
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
};

/** 辐射图谱：以产品中台为中心向外辐射能力域。 */
const RADIAL_SPEC: ChartSpec = {
  layout: 'radial',
  accent: '#E8684A',
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
};

/** 环形生态：12 个能力节点首尾相连，表达闭环协作。 */
const CIRCULAR_SPEC: ChartSpec = {
  layout: 'circular',
  accent: '#7DD3C0',
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
};

/** 全部内置示例，顺序即属性面板「载入示例」中的展示顺序。 */
export const CHART_PRESETS: ChartPreset[] = [
  { id: 'network', name: '关系网络', description: '力导布局，适合表达多对多连接', spec: NETWORK_SPEC },
  { id: 'mindmap', name: '思维导图', description: '横向层次，适合拆解能力结构', spec: MINDMAP_SPEC },
  { id: 'flow', name: '流程编排', description: '纵向流程，适合讲清步骤链路', spec: FLOW_SPEC },
  { id: 'radial', name: '辐射图谱', description: '中心辐射，适合表达平台能力', spec: RADIAL_SPEC },
  { id: 'circular', name: '环形生态', description: '环形闭环，适合表达协作生态', spec: CIRCULAR_SPEC },
];

/** 插入新图表时默认使用的示例 id。 */
export const DEFAULT_CHART_PRESET = 'network';

/** 深拷贝一份图表数据，避免调用方与常量共享节点 / 边数组。 */
export function cloneChartSpec(spec: ChartSpec): ChartSpec {
  return {
    ...spec,
    nodes: spec.nodes.map((node) => ({ ...node })),
    edges: spec.edges.map((edge) => ({ ...edge })),
  };
}

/**
 * 读取指定示例的数据；id 不存在时回退到默认示例。
 *
 * @param id 示例 id（CHART_PRESETS[].id）
 * @returns 全新深拷贝，调用方可直接修改
 */
export function chartPresetSpec(id: string): ChartSpec {
  const preset = CHART_PRESETS.find((item) => item.id === id);
  return cloneChartSpec((preset ?? CHART_PRESETS[0]).spec);
}

/** 插入新图表时使用的默认数据。 */
export function defaultChartSpec(): ChartSpec {
  return chartPresetSpec(DEFAULT_CHART_PRESET);
}

/** 判断是否为合法布局名。 */
function isChartLayout(value: unknown): value is ChartLayout {
  return (
    value === 'force' ||
    value === 'dagre-lr' ||
    value === 'dagre-tb' ||
    value === 'radial' ||
    value === 'circular'
  );
}

/** 判断是否为合法节点层级。 */
function isNodeKind(value: unknown): value is 'core' | 'node' | 'leaf' {
  return value === 'core' || value === 'node' || value === 'leaf';
}

/**
 * 规范化图表数据。
 *
 * 用于三个入口：导入存档（validate）、属性面板编辑（store）、AI 生成。
 * 规则：
 * - 名称 / id 统一 trim 并截断，重复 id 只保留第一个；
 * - 边只保留两端都存在且不是自环的记录，重复连接去重；
 * - 节点为空时回退到默认示例，保证图表永远有内容可画。
 *
 * @param raw      原始数据（可能来自任意 JSON）
 * @param fallback 兜底数据，默认使用内置关系网络示例
 */
export function normalizeChartSpec(raw: unknown, fallback: ChartSpec = NETWORK_SPEC): ChartSpec {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const layout = isChartLayout(source.layout) ? source.layout : fallback.layout;
  const accent =
    typeof source.accent === 'string' && source.accent.trim()
      ? source.accent.trim().slice(0, 24)
      : CHART_DEFAULT_ACCENT;

  // 节点：过滤非法项、截断过长字段、去重 id
  const seenIds = new Set<string>();
  const nodes: ChartNode[] = [];
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  for (const entry of rawNodes) {
    if (nodes.length >= MAX_CHART_NODES) break;
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim().slice(0, MAX_ID_CHARS) : '';
    if (!id || seenIds.has(id)) continue;
    const label = typeof record.label === 'string' && record.label.trim()
      ? record.label.trim().slice(0, MAX_LABEL_CHARS)
      : id;
    seenIds.add(id);
    nodes.push({
      id,
      label,
      kind: isNodeKind(record.kind) ? record.kind : 'node',
    });
  }
  // 空数据回退到兜底示例的节点，避免渲染出一张空白图表
  if (nodes.length === 0) {
    for (const node of fallback.nodes) {
      if (nodes.length >= MAX_CHART_NODES) break;
      nodes.push({ ...node });
    }
    for (const node of nodes) seenIds.add(node.id);
  }

  // 边：两端必须存在、不能自环、不能重复
  const edges: ChartEdge[] = [];
  const seenEdges = new Set<string>();
  const rawEdges = Array.isArray(source.edges) ? source.edges : [];
  for (const entry of rawEdges) {
    if (edges.length >= MAX_CHART_EDGES) break;
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const from = typeof record.source === 'string' ? record.source.trim() : '';
    const to = typeof record.target === 'string' ? record.target.trim() : '';
    if (!from || !to || from === to) continue;
    if (!seenIds.has(from) || !seenIds.has(to)) continue;
    const key = `${from}->${to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ source: from, target: to });
  }

  const focusNode =
    typeof source.focusNode === 'string' && seenIds.has(source.focusNode)
      ? source.focusNode
      : nodes[0].id;

  return { layout, accent, nodes, edges, focusNode };
}

/**
 * 生成图表数据的稳定键，用于 3D 场景的脏检查。
 *
 * 规范化后的数据字段顺序固定，因此直接序列化即可；数据量大时也只用于比较，
 * 不会写入存储。
 */
export function chartSpecKey(spec: ChartSpec): string {
  const nodes = spec.nodes.map((node) => `${node.id}:${node.label}:${node.kind ?? 'node'}`).join(',');
  const edges = spec.edges.map((edge) => `${edge.source}>${edge.target}`).join(',');
  return `${spec.layout}|${spec.accent}|${spec.focusNode ?? ''}|${nodes}|${edges}`;
}
