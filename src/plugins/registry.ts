/**
 * plugins/registry.ts —— 插件注册中心
 *
 * 职责：
 * - 维护插件 id -> 插件的映射，拒绝重复注册，避免模板 id 冲突；
 * - 维护图表插件 id -> 图表能力的映射，供核心按对象上的 plugin 字段解析；
 * - 把插件贡献的模板摊平成 PluginTemplateEntry 列表，供首页直接渲染；
 * - 提供按需初始化（ensurePluginSetup）给需要异步预热资源的插件使用。
 *
 * 本模块不依赖 React / store，保持纯数据层，便于测试和第三方插件接入。
 */

import type { ChartPlugin, PluginTemplateEntry, SlidePlugin } from './types';

/** 已注册插件的内部映射；Map 保持注册顺序，首页展示顺序与之保持一致。 */
const pluginMap = new Map<string, SlidePlugin>();

/**
 * 已注册的图表能力映射：图表 id -> ChartPlugin。
 * 核心（Store / 校验 / 场景）通过 chart 对象上的 plugin 字段查到这里，
 * 从而不需要知道 G6 等具体图表库的存在。
 */
const chartPluginMap = new Map<string, ChartPlugin>();

/** 记录每个图表能力来自哪个插件，便于报错时给出可读信息。 */
const chartOwnerMap = new Map<string, string>();

/** 已完成 setup 的插件 id，避免重复初始化。 */
const readyPlugins = new Set<string>();

/**
 * 注册一个插件。
 *
 * @param plugin 插件描述；id 与模板 id 必须在全局唯一
 * @throws 插件 id 重复、模板 id 重复时抛错，尽早暴露冲突而不是静默覆盖
 *
 * 注册本身是同步的，不执行 setup；setup 在首次使用插件模板时按需调用。
 */
export function registerPlugin(plugin: SlidePlugin): void {
  if (pluginMap.has(plugin.id)) {
    throw new Error(`插件已注册：${plugin.id}`);
  }
  const seen = new Set<string>();
  for (const template of plugin.templates) {
    if (seen.has(template.id)) {
      throw new Error(`插件「${plugin.name}」内存在重复模板 id：${template.id}`);
    }
    seen.add(template.id);
  }
  // 图表能力在注册阶段就完成唯一性校验：图表 id 会写入作品文件，
  // 一旦冲突会导致旧作品打开时解析到错误的渲染器 / 属性面板。
  for (const chart of plugin.charts ?? []) {
    if (chartPluginMap.has(chart.id)) {
      const owner = chartOwnerMap.get(chart.id);
      throw new Error(`图表类型已注册：${chart.id}（已由插件「${owner}」提供）`);
    }
  }
  pluginMap.set(plugin.id, plugin);
  for (const chart of plugin.charts ?? []) {
    chartPluginMap.set(chart.id, chart);
    chartOwnerMap.set(chart.id, plugin.name);
  }
}

/** 返回全部已注册的图表能力（按注册顺序），供对象列表等 UI 渲染新增入口。 */
export function listChartPlugins(): ChartPlugin[] {
  return [...chartPluginMap.values()];
}

/** 按图表 id 查找图表能力；未注册时返回 undefined。 */
export function getChartPlugin(id: string): ChartPlugin | undefined {
  return chartPluginMap.get(id);
}

/**
 * 默认图表能力：第一个注册的图表插件。
 * 用于兼容早期存档——这些文件的 chart 对象还没有 plugin 字段。
 */
export function getDefaultChartPlugin(): ChartPlugin | undefined {
  return chartPluginMap.values().next().value;
}

/**
 * 解析图表对象应使用的插件。
 *
 * @param id 对象上的 plugin 字段；可能缺失（旧存档）或指向尚未安装的插件
 * @returns 命中的图表能力；id 无效时回退到默认图表能力，完全没有插件时为 undefined
 *
 * 回退策略保证作品不会因为插件缺失而完全打不开：图表数据仍会保存，
 * 等对应插件安装后再由调用方按需升级 plugin 字段。
 */
export function resolveChartPlugin(id?: string): ChartPlugin | undefined {
  if (id) {
    const found = chartPluginMap.get(id);
    if (found) return found;
  }
  return getDefaultChartPlugin();
}

/** 返回全部已注册插件（按注册顺序）。 */
export function listPlugins(): SlidePlugin[] {
  return [...pluginMap.values()];
}

/** 按 id 查找插件；未注册时返回 undefined。 */
export function getPlugin(id: string): SlidePlugin | undefined {
  return pluginMap.get(id);
}

/**
 * 汇总所有插件贡献的模板，并附带插件来源信息。
 * 首页只需要这个列表即可渲染插件模板卡片，不需要逐个遍历插件。
 */
export function listPluginTemplates(): PluginTemplateEntry[] {
  const entries: PluginTemplateEntry[] = [];
  for (const plugin of pluginMap.values()) {
    for (const template of plugin.templates) {
      entries.push({
        ...template,
        pluginId: plugin.id,
        pluginName: plugin.name,
      });
    }
  }
  return entries;
}

/**
 * 确保指定插件已完成 setup（幂等）。
 *
 * @param plugin 插件实例
 * @throws setup 抛出的错误会原样向上传递，由调用方决定是否中止模板创建
 *
 * 只有实现了 setup 的插件才会执行；并发调用共用同一个 Promise。
 */
const setupPromises = new Map<string, Promise<void>>();

export function ensurePluginSetup(plugin: SlidePlugin): Promise<void> {
  if (!plugin.setup || readyPlugins.has(plugin.id)) return Promise.resolve();
  const existing = setupPromises.get(plugin.id);
  if (existing) return existing;
  const promise = plugin
    .setup()
    .then(() => {
      readyPlugins.add(plugin.id);
    })
    .finally(() => {
      setupPromises.delete(plugin.id);
    });
  setupPromises.set(plugin.id, promise);
  return promise;
}
