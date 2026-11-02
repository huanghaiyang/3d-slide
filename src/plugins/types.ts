/**
 * plugins/types.ts —— 插件系统契约
 *
 * 插件通过向注册中心声明自己的元数据与「模板贡献」来扩展应用：
 * - 一个插件可以贡献任意数量的模板（PluginTemplate）；
 * - 模板的 build 允许异步（例如 G6 需要先离屏渲染图表再生成作品数据）；
 * - 插件可以选择实现 setup，在首次使用前预热资源或校验运行环境。
 *
 * 约束：插件不能直接修改 store 或存储，只能返回完整、合法的 Deck；
 * 写入存储、跳转编辑器等副作用统一由调用方（首页）负责。
 */

import type { Deck } from '../types';

/**
 * 插件贡献的模板描述。
 *
 * 字段与内置模板（lib/templates 的 DeckTemplate）保持一致，方便首页复用同一套卡片 UI；
 * 唯一的差异是 build 可以返回 Promise，以支持需要异步渲染的图表类模板。
 */
export interface PluginTemplate {
  /** 模板唯一标识；建议带插件前缀，避免与内置模板或其他插件冲突。 */
  id: string;
  /** 展示名称。 */
  name: string;
  /** 一句话说明，描述版式与适用场景。 */
  description: string;
  /** 卡片预览背景色。 */
  background: string;
  /** 卡片预览强调色。 */
  accent: string;
  /** 预置视点数量（仅用于展示，实际以 build 结果为准）。 */
  frameCount: number;
  /**
   * 构造完整作品。
   *
   * @param title 已由调用方去重的作品标题
   * @returns 全新的 Deck；允许异步（图表渲染、资源加载等）
   */
  build: (title: string) => Promise<Deck> | Deck;
}

/**
 * 插件描述。
 *
 * 插件是静态注册的：应用启动时由 plugins/index.ts 收集内置插件，
 * 第三方插件也可以在启动阶段调用 registerPlugin 自行注册。
 */
export interface SlidePlugin {
  /** 插件唯一标识（kebab-case）。 */
  id: string;
  /** 插件展示名称。 */
  name: string;
  /** 语义化版本号，便于以后做兼容性提示。 */
  version: string;
  /** 插件能力说明。 */
  description: string;
  /** 插件贡献的模板列表；没有模板时可以为空数组。 */
  templates: PluginTemplate[];
  /**
   * 可选初始化钩子。
   * 在注册后、首次使用插件模板前调用；可用于预加载依赖或检测运行环境。
   */
  setup?: () => Promise<void>;
}

/** 带插件来源信息的模板条目，供首页展示与创建时使用。 */
export interface PluginTemplateEntry extends PluginTemplate {
  /** 提供该模板的插件 id。 */
  pluginId: string;
  /** 提供该模板的插件名称，用于卡片角标与提示文案。 */
  pluginName: string;
}
