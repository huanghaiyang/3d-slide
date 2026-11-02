/**
 * plugins/g6/live.ts —— G6 实时图表渲染器
 *
 * 与旧的 render.ts（离屏渲染成 PNG）不同，这里把 G6 保留为一个常驻实例：
 * - 在屏幕外创建一个 div 容器，G6 在其内部绘制自己的 canvas；
 * - 用 requestAnimationFrame 循环把 G6 画布逐帧拷贝到核心提供的目标画布；
 * - 核心把目标画布包装成 CanvasTexture 贴到 3D 平面上，于是力导布局的迭代过程、
 *   节点入场的淡入与位移都能在幻灯片里实时看到。
 *
 * 生命周期：
 * 1. 挂载：创建离屏容器 -> 动态 import G6 -> new Graph -> await render()；
 * 2. 产帧：布局收敛前每帧拷贝，收敛后再多拷贝一小段时间以覆盖尾部过渡动画；
 * 3. 销毁：停止循环、销毁图实例、移除离屏容器。
 */

import type { GraphData, GraphOptions, LayoutOptions, NodeData } from '@antv/g6';
import type { ChartHandle, ChartMountOptions, ChartRenderer } from '../../lib/chartRenderer';
import { normalizeG6Spec } from './chart';
import type { G6ChartSpec } from './types';

/** 中英文都能正常显示的系统字体栈，与旧静态渲染器保持一致。 */
const FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';

/** 布局收敛后继续拷贝画面的时长，用于覆盖节点入场 / 视口自适应的尾部动画。 */
const SETTLE_COPY_MS = 900;

/** 是否使用矩形节点（层次布局用矩形 + 箭头，其余布局用圆形 + 细连线）。 */
function usesRectNodes(layout: G6ChartSpec['layout']): boolean {
  return layout === 'dagre-lr' || layout === 'dagre-tb';
}

/**
 * 业务布局 -> G6 布局配置。
 *
 * 只有力导布局支持迭代式动画，因此 animate 只传给 force；
 * 其余布局的位置变化由 Graph 级别的 animation 选项负责过渡。
 */
function layoutOptions(spec: G6ChartSpec, animate: boolean): LayoutOptions {
  const focus = spec.focusNode ?? spec.nodes[0]?.id ?? null;
  if (spec.layout === 'dagre-lr') {
    return { type: 'dagre', rankdir: 'LR', nodesep: 34, ranksep: 92 };
  }
  if (spec.layout === 'dagre-tb') {
    return { type: 'dagre', rankdir: 'TB', nodesep: 44, ranksep: 76 };
  }
  if (spec.layout === 'radial') {
    return {
      type: 'radial',
      focusNode: focus,
      unitRadius: 240,
      linkDistance: 205,
      preventOverlap: true,
      nodeSize: 96,
    };
  }
  if (spec.layout === 'circular') {
    return { type: 'circular', radius: 292 };
  }
  return {
    type: 'force',
    animate,
    maxIteration: 320,
    // 收敛阈值取得很小：G6 的力导动画是逐个 tick（约 4ms）推进的，
    // 阈值过大会在几十个 tick 内提前结束，肉眼几乎看不到布局展开过程。
    minMovement: 0.02,
    linkDistance: 198,
    nodeStrength: -320,
    preventOverlap: true,
    nodeSize: 104,
  };
}

/**
 * 单个节点的样式。
 * 配色约定：重点节点使用实心强调色，常规节点低透明度填充 + 强调色描边，
 * 叶子节点更暗、字号更小，保证层级一眼可辨。
 */
function nodeStyle(datum: NodeData, spec: G6ChartSpec): Record<string, unknown> {
  const kind = (datum.data?.kind as 'core' | 'node' | 'leaf' | undefined) ?? 'node';
  const label = String(datum.data?.label ?? datum.id);
  const rect = usesRectNodes(spec.layout);
  const core = kind === 'core';
  const leaf = kind === 'leaf';

  const size = core
    ? rect
      ? [212, 62]
      : 104
    : leaf
      ? rect
        ? [150, 40]
        : 60
      : rect
        ? [178, 48]
        : 78;

  return {
    size,
    radius: rect ? 12 : undefined,
    fill: core ? spec.accent : leaf ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.08)',
    stroke: core ? 'rgba(255,255,255,0.86)' : leaf ? 'rgba(255,255,255,0.24)' : spec.accent,
    lineWidth: core ? 2.5 : 1.4,
    shadowColor: core ? spec.accent : 'transparent',
    shadowBlur: core ? 24 : 0,
    labelText: label,
    labelPlacement: 'center',
    labelFill: core ? '#FFFFFF' : leaf ? '#93A6B8' : '#E7F0FF',
    labelFontSize: core ? 19 : leaf ? 12 : 14,
    labelFontWeight: core ? 700 : 500,
    labelFontFamily: FONT_FAMILY,
    cursor: 'default',
  };
}

/**
 * 把 G6 画布实时拷入核心目标画布。
 *
 * @param canvas  核心提供的画布（CanvasTexture 的来源）
 * @param options 图表数据与回调
 * @returns 可销毁的句柄；失败时也会返回空句柄，并通过 onError 上报原因
 */
export const mountG6Chart: ChartRenderer = async (
  canvas: HTMLCanvasElement,
  options: ChartMountOptions,
): Promise<ChartHandle> => {
  const { animate, width, height } = options;
  // 核心只透传不透明 JSON，进入渲染前必须先由本插件规范化成 G6 自己的结构
  const spec = normalizeG6Spec(options.spec);
  const rect = usesRectNodes(spec.layout);

  // 屏幕外容器：参与布局与绘制，但不可见、不可交互
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

  const context = canvas.getContext('2d');
  if (!context) {
    container.remove();
    options.onError('无法创建图表画布');
    return { destroy() {} };
  }
  // 显式标注类型：下面的箭头函数在闭包里使用，避免丢失上面的空值收窄
  const ctx: CanvasRenderingContext2D = context;

  // 图实例在 try 之前声明，确保动态 import 失败时也能清理离屏容器
  let graph: import('@antv/g6').Graph | undefined;
  let frameId = 0;
  let settleTimer = 0;
  /** 是否已停止逐帧拷贝（布局与尾部动画结束，或被主动销毁）。 */
  let stopped = false;
  /** 是否已被核心主动销毁；用于区分「正常失败」与「销毁导致的中断」。 */
  let destroyed = false;

  /**
   * 把 G6 的全部图层画布按顺序合成到目标画布，并通知核心上传纹理。
   * G6 5 会为图表创建多张 canvas 图层（背景层、主层等），
   * 内容通常并不在第一层，因此必须逐层叠加，不能只拷贝第一张。
   */
  const paintFrame = (): boolean => {
    const sources = container.querySelectorAll('canvas');
    if (!sources.length) return false;
    ctx.clearRect(0, 0, width, height);
    let painted = false;
    sources.forEach((source) => {
      try {
        ctx.drawImage(source, 0, 0, width, height);
        painted = true;
      } catch {
        // 画布尺寸切换的瞬间可能抛错，跳过这一层即可
      }
    });
    if (painted) options.onFrame();
    return painted;
  };

  /** 逐帧循环：布局动画与入场动画都靠它实时反映到纹理上。 */
  const copyFrame = () => {
    if (stopped) return;
    paintFrame();
    frameId = requestAnimationFrame(copyFrame);
  };

  /** 停止逐帧拷贝。 */
  const stopPump = () => {
    stopped = true;
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
    if (settleTimer) window.clearTimeout(settleTimer);
    settleTimer = 0;
  };

  // 立即开始拷贝：即使 G6 还没加载完，目标画布也会被清空为透明，避免残留旧画面
  frameId = requestAnimationFrame(copyFrame);

  try {
    // 动态加载 G6，未使用图表时不会进入主包
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

    const graphOptions: GraphOptions = {
      container,
      width,
      height,
      // 目标画布本身已是 1:1 像素，G6 内部再放大只会让拷贝变模糊
      devicePixelRatio: 1,
      // 透明背景：作品的背景色与 3D 场景直接透出，不出现色块边界
      background: 'transparent',
      padding: 40,
      data,
      layout: layoutOptions(spec, animate),
      autoFit: 'view',
      // 元素入场动画与布局动画共用一个开关，关闭时立刻呈现最终状态
      animation: animate ? { duration: 600 } : false,
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

    graph = new Graph(graphOptions);
    await graph.render();

    // 布局收敛后继续拷贝一小段时间，覆盖 autoFit 视口缩放等尾部动画，
    // 之后停止 rAF 循环，避免静止图表持续占用 CPU。
    if (!stopped) {
      settleTimer = window.setTimeout(() => {
        copyFrameOnce();
        stopPump();
      }, SETTLE_COPY_MS);
    }

    return {
      destroy() {
        destroyed = true;
        stopPump();
        graph?.destroy();
        graph = undefined;
        container.remove();
      },
    };
  } catch (error) {
    stopPump();
    graph?.destroy();
    graph = undefined;
    container.remove();
    // 主动销毁导致的绘制中断属于正常流程，不再上报错误
    if (destroyed) return { destroy() {} };
    const message = error instanceof Error ? error.message : '图表渲染失败';
    options.onError(message);
    return { destroy() {} };
  }

  /** 停止前最后再合成一帧，确保尾部动画的最终状态已经进入纹理。 */
  function copyFrameOnce() {
    paintFrame();
  }
};
