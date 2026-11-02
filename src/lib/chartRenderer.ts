/**
 * chartRenderer.ts —— 图表渲染器契约（核心 <-> 插件解耦层）
 *
 * 核心渲染层（SceneManager）只知道「把图表数据画到一张画布上」这件事，
 * 并不知道底层用的是 G6、ECharts 还是别的库；具体绘制能力与数据格式
 * 由各个图表插件定义，并通过 plugins/registry 注册。
 *
 * 调用约定：
 * 1. 核心准备一张离屏画布与 CanvasTexture；
 * 2. 按 ChartObject.plugin 找到插件，调用它的 renderer，把 spec / animate 与回调传过去；
 * 3. 渲染器每产出一帧就调用 onFrame()，核心据此把画布重新上传 GPU；
 * 4. 数据变化或对象销毁时，核心调用返回的 handle.destroy() 释放运行时资源。
 *
 * 渲染器必须支持「返回 Promise」：动态 import 图表库、等待布局收敛都是异步的。
 * 若在 Promise resolve 之前句柄已被销毁，渲染器应自行忽略后续结果。
 */

import type { ChartSpec } from '../types';

/** 挂载一个图表所需的输入。 */
export interface ChartMountOptions {
  /** 插件自定义的声明式图表数据（已由插件规范化）。 */
  spec: ChartSpec;
  /** 是否播放布局动画；false 时应尽快收敛到最终位置。 */
  animate: boolean;
  /** 目标画布的像素宽度，渲染器应把内容铺满该尺寸。 */
  width: number;
  /** 目标画布的像素高度。 */
  height: number;
  /** 渲染器产出一帧后调用；核心会合并多次调用，每帧最多上传一次纹理。 */
  onFrame: () => void;
  /** 渲染失败时调用，参数为可直接展示给用户的中文提示。 */
  onError: (message: string) => void;
}

/** 渲染器返回的句柄，核心只负责调用 destroy。 */
export interface ChartHandle {
  /** 停止绘制并释放图表实例、离屏容器与事件监听。 */
  destroy: () => void;
}

/**
 * 图表渲染器签名。
 *
 * @param canvas  核心提供的目标画布，渲染器应在每一帧把最终画面画到它上面
 * @param options 数据、动画开关、尺寸与回调
 */
export type ChartRenderer = (
  canvas: HTMLCanvasElement,
  options: ChartMountOptions,
) => Promise<ChartHandle>;
