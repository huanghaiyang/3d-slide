/**
 * plugins/g6/types.ts —— G6 图表插件私有数据结构
 *
 * 这些类型只属于 G6 插件：核心只把图表数据当作不透明 JSON 透传，
 * 因此核心不需要、也不应该知道节点 / 边 / 布局长什么样。
 *
 * 注意：这里刻意使用 `type` 而不是 `interface`。
 * 对象类型的 type alias 具备隐式索引签名，可以直接赋给核心的 ChartSpec
 * （即 Record<string, unknown>）；interface 缺少隐式索引签名，会赋值失败。
 */

/** 节点层级：重点 / 常规 / 细节，决定节点尺寸、配色与字号。 */
export type G6ChartNodeKind = 'core' | 'node' | 'leaf';

/**
 * 图表能力 id：写入 ChartObject.plugin 并随作品保存。
 * 改名会导致旧存档只能回退到默认图表插件，因此需要保持稳定。
 */
export const G6_CHART_PLUGIN_ID = 'g6-charts';

/** 图表节点。 */
export type G6ChartNode = {
  /** 节点唯一 id，边通过它建立连接。 */
  id: string;
  /** 展示文案。 */
  label: string;
  /** 层级；缺省视为 'node'。 */
  kind?: G6ChartNodeKind;
};

/** 图表边（有向连接）。 */
export type G6ChartEdge = {
  /** 起点节点 id。 */
  source: string;
  /** 终点节点 id。 */
  target: string;
};

/** G6 布局类型：力导 / 层次（横向、纵向）/ 辐射 / 环形。 */
export type G6ChartLayout = 'force' | 'dagre-lr' | 'dagre-tb' | 'radial' | 'circular';

/**
 * G6 图表的完整声明式数据。
 * 随作品保存；由本插件负责规范化、渲染与编辑。
 */
export type G6ChartSpec = {
  /** 布局算法。 */
  layout: G6ChartLayout;
  /** 强调色，用于重点节点与连线。 */
  accent: string;
  /** 节点列表。 */
  nodes: G6ChartNode[];
  /** 边列表。 */
  edges: G6ChartEdge[];
  /** 辐射布局的中心节点 id；缺省使用第一个节点。 */
  focusNode?: string;
};
