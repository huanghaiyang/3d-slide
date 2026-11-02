/**
 * plugins/types.ts —— 插件系统契约
 *
 * 插件通过向注册中心声明自己的元数据、模板与图表能力来扩展应用：
 * - 模板贡献（PluginTemplate）让首页自动出现该插件的作品模板；
 * - 图表贡献（ChartPlugin）让编辑器能插入对应图表，并提供渲染器与属性面板；
 * - 插件可以选择实现 setup，在首次使用前预热资源或校验运行环境。
 *
 * 约束：插件不能直接修改 store 或存储，只能返回完整、合法的 Deck 或声明式图表数据；
 * 写入存储、跳转编辑器等副作用统一由调用方（首页 / 编辑器）负责。
 */

import type { ComponentType } from 'react';
import type { ChartObject, ChartSpec, Deck } from '../types';
import type { ChartRenderer } from '../lib/chartRenderer';
import type { IconName } from '../components/Icon';

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
 * 图表属性面板的入参。
 *
 * 面板只负责「显示与提交数据」，不直接读写 store：
 * 修改通过 onChange 交回核心，由核心统一写入撤销历史与自动保存。
 */
export interface ChartInspectorProps {
  /** 当前图表对象；spec 由插件自行解释。 */
  object: ChartObject;
  /** 提交图表数据或动画开关；historyKey 用于把连续编辑合并成一步撤销。 */
  onChange: (patch: Partial<Pick<ChartObject, 'spec' | 'animate'>>, historyKey?: string) => void;
  /** 渲染错误提示；没有错误时为 undefined。 */
  error?: string;
  /** 请求重新挂载渲染（用于「重试」按钮）。 */
  onRetry?: () => void;
}

/**
 * 图表插件贡献。
 *
 * 一个图表插件同时提供四样东西：
 * 1. 数据能力：默认数据、规范化、脏检查键；
 * 2. 渲染能力：把数据画到核心提供的画布上（通常是实时动画）；
 * 3. 编辑能力：属性面板 React 组件；
 * 4. 展示能力：对象列表按钮与缩略图使用的名称、图标。
 *
 * 核心只依赖本接口，不依赖任何具体图表库。
 */
export interface ChartPlugin {
  /** 图表插件唯一标识；会写入 ChartObject.plugin 并随作品保存。 */
  id: string;
  /** 属性面板与提示文案使用的完整名称，例如「G6 图表」。 */
  name: string;
  /** 对象列表新增按钮与自动命名使用的短名称，例如「图表」。 */
  label: string;
  /** 对象列表 / 缩略图图标。 */
  icon: IconName;
  /** 新建图表时的默认数据。 */
  createSpec: () => ChartSpec;
  /** 规范化任意来源（存档、输入框、AI）的数据。 */
  normalizeSpec: (raw: unknown) => ChartSpec;
  /** 生成用于场景脏检查的稳定键。 */
  specKey: (spec: ChartSpec) => string;
  /** 渲染器：把图表画到核心提供的离屏画布上，并逐帧回调 onFrame。 */
  render: ChartRenderer;
  /** 属性编辑面板。 */
  Inspector: ComponentType<ChartInspectorProps>;
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
  /** 插件贡献的图表能力；没有图表时可以不填。 */
  charts?: ChartPlugin[];
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
