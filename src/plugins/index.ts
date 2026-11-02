/**
 * plugins/index.ts —— 插件系统对外入口
 *
 * 应用启动时在这里注册内置插件；UI 层只需要从这里读取模板列表，
 * 不需要关心插件具体是如何实现的。
 *
 * 新增插件步骤：
 * 1. 在 plugins/<plugin-id>/ 下实现插件对象（遵循 SlidePlugin 契约）；
 * 2. 在下方 import 并调用 registerPlugin；
 * 3. 首页会自动出现该插件贡献的模板卡片，无需再改 UI。
 */

import { registerPlugin } from './registry';
import { g6Plugin } from './g6';

// 内置插件注册；registerPlugin 会校验 id 与模板 id 唯一性
registerPlugin(g6Plugin);

export {
  registerPlugin,
  listPlugins,
  getPlugin,
  listPluginTemplates,
  ensurePluginSetup,
  listChartPlugins,
  getChartPlugin,
  getDefaultChartPlugin,
  resolveChartPlugin,
} from './registry';
export type { PluginTemplate, PluginTemplateEntry, SlidePlugin, ChartPlugin, ChartInspectorProps } from './types';
