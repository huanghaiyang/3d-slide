/**
 * plugins/registry.ts —— 插件注册中心
 *
 * 职责：
 * - 维护插件 id -> 插件的映射，拒绝重复注册，避免模板 id 冲突；
 * - 把插件贡献的模板摊平成 PluginTemplateEntry 列表，供首页直接渲染；
 * - 提供按需初始化（ensurePluginSetup）给需要异步预热资源的插件使用。
 *
 * 本模块不依赖 React / store，保持纯数据层，便于测试和第三方插件接入。
 */

import type { PluginTemplateEntry, SlidePlugin } from './types';

/** 已注册插件的内部映射；Map 保持注册顺序，首页展示顺序与之保持一致。 */
const pluginMap = new Map<string, SlidePlugin>();

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
  pluginMap.set(plugin.id, plugin);
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
