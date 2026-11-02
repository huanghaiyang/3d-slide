/**
 * plugins/g6/index.ts —— G6 图表插件入口
 *
 * 插件职责：
 * - 向注册中心贡献「图表能力」：核心通过 ChartObject.plugin 解析到这里，
 *   再使用本插件提供的默认数据、规范化规则、渲染器与属性面板；
 * - 向注册中心贡献 5 个 G6 示例模板（关系网络 / 思维导图 / 流程编排 / 辐射图谱 / 环形生态）；
 * - 在首次使用前预热 @antv/g6 模块，避免第一次点击模板时出现明显等待。
 *
 * 图表以 ChartObject 形式进入作品：数据随作品保存，渲染由本插件实时完成，
 * 因此编辑器里可以改节点 / 边与布局，图表也会随数据变化重新布局。
 *
 * 核心不依赖 G6：移除本插件后，应用仍可正常打开，图表对象会提示缺少插件；
 * 重新安装插件即可恢复渲染。
 */

import type { SlidePlugin } from '../types';
import { G6ChartInspector } from './Inspector';
import { defaultG6Spec, g6SpecKey, normalizeG6Spec } from './chart';
import { mountG6Chart } from './live';
import { G6_TEMPLATES } from './slides';
import { G6_CHART_PLUGIN_ID } from './types';

export const g6Plugin: SlidePlugin = {
  id: 'g6-charts',
  name: 'G6 图表插件',
  version: '2.1.0',
  description: '使用 AntV G6 实时渲染关系网络、思维导图、流程、辐射与环形图表模板。',
  templates: G6_TEMPLATES,
  charts: [
    {
      id: G6_CHART_PLUGIN_ID,
      name: 'G6 图表',
      label: '图表',
      icon: 'chart',
      createSpec: defaultG6Spec,
      normalizeSpec: normalizeG6Spec,
      specKey: g6SpecKey,
      render: mountG6Chart,
      Inspector: G6ChartInspector,
    },
  ],
  setup: async () => {
    // 预热动态模块；失败会由首页捕获并提示，不影响其他插件
    await import('@antv/g6');
  },
};

export { G6_TEMPLATES } from './slides';
export { mountG6Chart } from './live';
export { G6_CHART_PLUGIN_ID } from './types';
