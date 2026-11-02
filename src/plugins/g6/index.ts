/**
 * plugins/g6/index.ts —— G6 图表插件入口
 *
 * 插件职责：
 * - 向核心注册「实时 G6 渲染器」：SceneManager 把图表数据画到离屏画布，
 *   插件负责创建 G6 实例、逐帧把画面拷进画布，从而实现布局动画；
 * - 向注册中心贡献 5 个 G6 示例模板（关系网络 / 思维导图 / 流程编排 / 辐射图谱 / 环形生态）；
 * - 在首次使用前预热 @antv/g6 模块，避免第一次点击模板时出现明显等待。
 *
 * 图表以 ChartObject 形式进入作品：数据随作品保存，渲染由本插件实时完成，
 * 因此编辑器里可以改节点 / 边与布局，图表也会随数据变化重新布局。
 */

import type { SlidePlugin } from '../types';
import { registerChartRenderer } from '../../lib/chartRenderer';
import { mountG6Chart } from './live';
import { G6_TEMPLATES } from './slides';

// 模块加载即注册渲染器：首页可能在创建模板 / 生成封面时就需要它
registerChartRenderer(mountG6Chart);

export const g6Plugin: SlidePlugin = {
  id: 'g6-charts',
  name: 'G6 图表插件',
  version: '2.0.0',
  description: '使用 AntV G6 实时渲染关系网络、思维导图、流程、辐射与环形图表模板。',
  templates: G6_TEMPLATES,
  setup: async () => {
    // 预热动态模块；失败会由首页捕获并提示，不影响其他插件
    await import('@antv/g6');
  },
};

export { G6_TEMPLATES } from './slides';
export { mountG6Chart } from './live';
