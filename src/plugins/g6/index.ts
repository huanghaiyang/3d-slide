/**
 * plugins/g6/index.ts —— G6 图表插件入口
 *
 * 插件职责：
 * - 向注册中心贡献 5 个 G6 示例模板（关系网络 / 思维导图 / 流程编排 / 辐射图谱 / 环形生态）；
 * - 在首次使用前预热 @antv/g6 模块，避免第一次点击模板时出现明显等待。
 *
 * 图表本身由 render.ts 离屏渲染为 PNG，并作为普通图片对象进入作品，
 * 因此插件不需要修改对象模型、3D 渲染或存储格式。
 */

import type { SlidePlugin } from '../types';
import { G6_TEMPLATES } from './slides';

export const g6Plugin: SlidePlugin = {
  id: 'g6-charts',
  name: 'G6 图表插件',
  version: '1.0.0',
  description: '使用 AntV G6 生成关系网络、思维导图、流程、辐射与环形图表模板。',
  templates: G6_TEMPLATES,
  setup: async () => {
    // 预热动态模块；失败会由首页捕获并提示，不影响其他插件
    await import('@antv/g6');
  },
};

export { G6_TEMPLATES } from './slides';
export { renderG6Chart } from './render';
export type { G6ChartLayout, G6ChartNode, G6ChartEdge, G6ChartSpec } from './render';
