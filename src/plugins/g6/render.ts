/**
 * plugins/g6/render.ts —— G6 图表离屏渲染器
 *
 * 目标：把一份声明式的图表描述（节点 + 边 + 布局）渲染成 PNG dataURL，
 * 供 3D 幻灯片作为普通图片对象使用。这样图表在编辑与演示时都不需要额外运行时，
 * 也不会把 G6 的画布生命周期耦合进 SceneManager。
 *
 * 实现要点：
 * - G6 通过动态 import 按需加载，未使用插件模板时不会进入首屏 bundle；
 * - 在屏幕外创建临时容器，渲染完成后立即 destroy 图实例并移除容器，避免画布泄漏；
 * - 关闭全局动画与布局动画，确保 render() 返回时布局已收敛，导出结果稳定。
 */

import type { GraphData, GraphOptions, LayoutOptions, NodeData } from '@antv/g6';

/** 节点的视觉层级：core 为重点节点，node 为中间节点，leaf 为叶子节点。 */
type ChartNodeKind = 'core' | 'node' | 'leaf';

/** 图表节点描述。 */
export interface G6ChartNode {
  /** 节点唯一 id，同时用于边引用。 */
  id: string;
  /** 节点显示文案；过长时请自行换行或缩短。 */
  label: string;
  /** 视觉层级，决定尺寸、配色与字号，默认 node。 */
  kind?: ChartNodeKind;
}

/** 图表边描述。 */
export interface G6ChartEdge {
  /** 起点节点 id。 */
  source: string;
  /** 终点节点 id。 */
  target: string;
}

/** 支持的布局类型，封装成业务语义，避免调用方直接依赖 G6 布局名。 */
export type G6ChartLayout = 'force' | 'dagre-lr' | 'dagre-tb' | 'radial' | 'circular';

/** 一份 G6 图表的完整渲染描述。 */
export interface G6ChartSpec {
  /** 布局类型。 */
  layout: G6ChartLayout;
  /** 节点列表。 */
  nodes: G6ChartNode[];
  /** 边列表。 */
  edges: G6ChartEdge[];
  /** 画布背景色；应与作品背景一致，图片贴到 3D 平面上才不会出现色块边界。 */
  background: string;
  /** 主强调色，用于重点节点与连线。 */
  accent: string;
  /** 渲染宽度（像素），默认 1600。 */
  width?: number;
  /** 渲染高度（像素），默认 900。 */
  height?: number;
  /** radial 布局的焦点节点 id；缺省时使用第一个节点。 */
  focusNode?: string;
}

/** 依次尝试的字体栈，保证中英文与常见系统字体都能正确显示。 */
const FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';

/** 是否为层次布局（使用矩形节点与箭头连线）。 */
function usesRectNodes(layout: G6ChartLayout): boolean {
  return layout === 'dagre-lr' || layout === 'dagre-tb';
}

/**
 * 把业务布局名转换为 G6 布局配置。
 *
 * force 显式关闭 animate：默认布局是逐帧迭代的，关闭后 render() 会在一次调用内完成，
 * 从而保证随后的 toDataURL 拿到已经收敛的最终位置。
 */
function layoutOptions(spec: G6ChartSpec): LayoutOptions {
  if (spec.layout === 'dagre-lr') {
    return { type: 'dagre', rankdir: 'LR', nodesep: 34, ranksep: 96 };
  }
  if (spec.layout === 'dagre-tb') {
    return { type: 'dagre', rankdir: 'TB', nodesep: 46, ranksep: 82 };
  }
  if (spec.layout === 'radial') {
    return {
      type: 'radial',
      focusNode: spec.focusNode ?? spec.nodes[0]?.id ?? null,
      unitRadius: 240,
      linkDistance: 210,
      preventOverlap: true,
      nodeSize: 96,
    };
  }
  if (spec.layout === 'circular') {
    return { type: 'circular', radius: 300 };
  }
  return {
    type: 'force',
    animate: false,
    maxIteration: 320,
    minMovement: 0.6,
    linkDistance: 200,
    nodeStrength: -320,
    preventOverlap: true,
    nodeSize: 104,
  };
}

/**
 * 计算单个节点的样式。
 *
 * 配色约定：核心节点使用实心强调色，其余节点使用低透明度填充 + 强调色描边，
 * 在深色背景上形成清晰的层级，同时不会喧宾夺主。
 */
function nodeStyle(datum: NodeData, spec: G6ChartSpec): Record<string, unknown> {
  const kind = (datum.data?.kind as ChartNodeKind | undefined) ?? 'node';
  const label = String(datum.data?.label ?? datum.id);
  const rect = usesRectNodes(spec.layout);
  const core = kind === 'core';
  const leaf = kind === 'leaf';

  const size = core
    ? rect
      ? [220, 64]
      : 108
    : leaf
      ? rect
        ? [156, 42]
        : 62
      : rect
        ? [184, 50]
        : 80;

  return {
    size,
    radius: rect ? 12 : undefined,
    fill: core ? spec.accent : leaf ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.08)',
    stroke: core ? 'rgba(255,255,255,0.86)' : leaf ? 'rgba(255,255,255,0.24)' : spec.accent,
    lineWidth: core ? 2.5 : 1.4,
    shadowColor: core ? spec.accent : 'transparent',
    shadowBlur: core ? 26 : 0,
    labelText: label,
    labelPlacement: 'center',
    labelFill: core ? '#FFFFFF' : leaf ? '#93A6B8' : '#E7F0FF',
    labelFontSize: core ? 20 : leaf ? 13 : 15,
    labelFontWeight: core ? 700 : 500,
    labelFontFamily: FONT_FAMILY,
    cursor: 'default',
  };
}

/**
 * 将图表描述渲染为 PNG dataURL。
 *
 * @param spec 图表描述
 * @returns `data:image/png;base64,...`
 * @throws G6 加载失败或渲染失败时向上抛出，由模板构建流程转成用户可读提示
 */
export async function renderG6Chart(spec: G6ChartSpec): Promise<string> {
  const width = spec.width ?? 1600;
  const height = spec.height ?? 900;
  const rect = usesRectNodes(spec.layout);

  // 屏幕外容器：参与布局与绘制，但用户不可见、不可交互
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  container.style.cssText = [
    'position:fixed',
    'left:-20000px',
    'top:0',
    `width:${width}px`,
    `height:${height}px`,
    'pointer-events:none',
    'opacity:0',
  ].join(';');
  document.body.appendChild(container);

  // 图实例在 try 之前声明，确保动态 import 失败时 finally 依然能清理离屏容器
  let graph: import('@antv/g6').Graph | undefined;

  try {
    // 动态加载 G6，避免未使用插件时把图表运行时打进主包
    const { Graph } = await import('@antv/g6');

    const data: GraphData = {
      nodes: spec.nodes.map((node) => ({
        id: node.id,
        data: { kind: node.kind ?? 'node', label: node.label },
      })),
      edges: spec.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
      })),
    };

    const options: GraphOptions = {
      container,
      width,
      height,
      // DPR 1.5 在文字清晰度与导出体积之间折中
      devicePixelRatio: 1.5,
      background: spec.background,
      padding: 56,
      data,
      layout: layoutOptions(spec),
      autoFit: 'view',
      animation: false,
      node: {
        type: rect ? 'rect' : 'circle',
        style: (datum: NodeData) => nodeStyle(datum, spec),
      },
      edge: {
        type: 'line',
        style: {
          stroke: spec.accent,
          lineWidth: rect ? 1.8 : 1.2,
          opacity: rect ? 0.8 : 0.42,
          endArrow: rect,
          endArrowSize: 9,
          endArrowFill: spec.accent,
        },
      },
    };

    graph = new Graph(options);
    await graph.render();
    return await graph.toDataURL({ mode: 'viewport', type: 'image/png' });
  } finally {
    // 无论成功失败都释放画布与容器，防止离屏画布累积占用显存
    graph?.destroy();
    container.remove();
  }
}
