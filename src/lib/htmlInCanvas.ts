/**
 * htmlInCanvas.ts —— Chrome「HTML in Canvas」能力封装
 *
 * Chrome 157 起默认开启的 HTML-in-Canvas API 允许让真实 DOM 子树由浏览器排版引擎
 * 直接绘制到画布上，无需 html2canvas 之类的截图模拟：
 * - `<canvas layoutsubtree>`（Chromium 147–156）/ `<canvas content="drawable">` + 子元素
 *   `drawable` 属性（157+）让画布子元素参与排版；
 * - `ctx.drawElementImage(element, dx, dy)` 把子元素绘制到 2D 画布；
 * - `paint` 事件在子树渲染完成后触发，首次绘制必须发生在事件回调内（在此之前调用会抛错）。
 *
 * 本模块只负责「能力检测 + 一张带可绘制子树的离屏画布」的生命周期，文案样式由调用方传入。
 * 不支持的浏览器（Firefox / Safari / 旧版 Chromium）返回 null，调用方继续走原有 Canvas 2D 手绘。
 */

import type { FontPreset, TextAlign } from '../types';
import { FONT_STACKS } from './constants';
import { fontCss } from './text';

/** 文本画布的样式参数；画布按 density 放大，DOM 仍按逻辑像素排版。 */
export interface HtmlTextSpec {
  /** 纯文本内容；没有 html 时直接作为文本节点绘制 */
  text: string;
  /** 富文本内容（受控 HTML 子集）；存在时用 innerHTML 完整渲染，保留内联样式 */
  html?: string;
  width: number;
  height: number;
  fontSize: number;
  font: FontPreset;
  bold: boolean;
  align: TextAlign;
  color: string;
  lineHeight: number;
  density: number;
}

/** 一张内嵌可绘制子树、可随时取用的文本画布。 */
export interface HtmlTextSurface {
  /** 画布本体，可直接作为 CanvasTexture 来源或读取像素 */
  canvas: HTMLCanvasElement;
  /** 首次 HTML 绘制完成时 resolve(true)；超时或绘制失败 resolve(false) */
  ready: Promise<boolean>;
  /** 释放画布与子树，必须由调用方在对象销毁时调用 */
  dispose: () => void;
}

/** Chrome 的 HTML-in-Canvas 扩展（尚未进入 TS 标准库），这里只声明用到的部分 */
interface DrawElementContext {
  drawElementImage: (element: Element, dx: number, dy: number) => DOMMatrix;
}

interface PaintableCanvas extends HTMLCanvasElement {
  requestPaint?: () => void;
}

/** 能力检测结果缓存：同一会话内不需要重复探测 */
let supported: boolean | null = null;

/** 承载离屏画布的容器；所有文本画布共用，避免每次创建都改 DOM 结构 */
let host: HTMLDivElement | null = null;

/** 复用的字体度量上下文，用于推算 CSS 首行基线位置 */
let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * 当前浏览器是否支持 HTML-in-Canvas。
 *
 * 按 API 是否存在判断而不是 UA 版本：Chromium 147 起（含 Brave）可通过
 * `chrome://flags/#canvas-draw-element` 开启，Chrome 157 起默认可用。
 *
 * @returns 支持返回 true；不支持返回 false
 */
export function htmlInCanvasSupported(): boolean {
  if (supported === null) {
    const proto = typeof CanvasRenderingContext2D === 'undefined'
      ? undefined
      : (CanvasRenderingContext2D.prototype as unknown as Partial<DrawElementContext>);
    supported = typeof proto?.drawElementImage === 'function';
  }
  return supported;
}

/**
 * 计算 CSS 首行需要的 padding-top，使首行基线与原有 Canvas 手绘路径一致
 * （手绘路径把首行基线放在「0.3em 上留白 + 0.8em 字形高度」处）。
 *
 * @param spec 文本样式参数
 * @returns padding-top 像素值（不小于 0）
 */
function firstLinePadding(spec: HtmlTextSpec): number {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  if (!measureCtx) return spec.fontSize * 0.3;
  measureCtx.font = fontCss(spec.font, spec.fontSize, spec.bold);
  const metrics = measureCtx.measureText('Hg国');
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) return spec.fontSize * 0.3;
  // CSS 行盒：半行距加在内容区上下，基线距行盒顶部 = 半行距 + 上沿
  const halfLeading = (spec.fontSize * spec.lineHeight - (ascent + descent)) / 2;
  return Math.max(0, spec.fontSize * 1.1 - halfLeading - ascent);
}

/** 把子元素样式写进 drawable 子树：字体、行高、对齐、折行规则与编辑器 textarea 保持一致 */
function applyTextStyle(div: HTMLDivElement, spec: HtmlTextSpec) {
  const style = div.style;
  style.boxSizing = 'border-box';
  style.width = `${spec.width}px`;
  style.height = `${spec.height}px`;
  style.paddingTop = `${firstLinePadding(spec)}px`;
  style.margin = '0';
  style.fontFamily = FONT_STACKS[spec.font] ?? FONT_STACKS.sans;
  style.fontSize = `${spec.fontSize}px`;
  style.fontWeight = spec.bold ? '700' : '400';
  style.lineHeight = `${spec.fontSize * spec.lineHeight}px`;
  style.color = spec.color;
  style.textAlign = spec.align;
  // 与 wrapLines 的折行规则对齐：保留换行与空白，超长单词允许断行
  style.whiteSpace = 'pre-wrap';
  style.overflowWrap = 'break-word';
  style.wordBreak = 'normal';
  // 富文本可能比文本框高（块内字号不一），超出部分直接裁掉，与 3D 挤出轮廓一致
  style.overflow = 'hidden';
}

/**
 * 取（必要时创建）离屏容器；容器必须留在文档视口内，子树才有排版与绘制。
 *
 * 用 opacity: 0 隐藏而不是移到视口外：实测（Chrome 157）把容器放到
 * left: -100000px 时浏览器不绘制 drawable 子树，drawElementImage 拿到的是一张空画布，
 * 文字会整块消失；opacity:0 仍参与绘制，只是合成阶段不可见。
 * pointer-events: none 保证这层不拦截任何交互，position: fixed 也不会产生滚动条。
 */
function ensureHost(): HTMLDivElement {
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none;';
    document.body.appendChild(host);
  }
  return host;
}

/**
 * 创建一张由浏览器 HTML 排版引擎绘制的文本画布。
 *
 * 画布创建后立刻用 `paintFallback` 填入手绘内容，保证在首次 `paint` 之前
 * 纹理与挤出轮廓都有可用像素；`paint` 到达后用 `drawElementImage` 覆盖为 HTML 渲染结果，
 * 并回调 `onPaint` 让调用方刷新纹理 / 重建几何。
 *
 * @param spec          文本样式参数
 * @param paintFallback 手绘兜底；参数为已按 density 分配好尺寸的画布
 * @param onPaint       首次 HTML 绘制完成后的回调（之后不再触发）
 * @returns 画布句柄；浏览器不支持该 API 时返回 null
 */
export function createHtmlTextSurface(
  spec: HtmlTextSpec,
  paintFallback: (canvas: HTMLCanvasElement) => void,
  onPaint: () => void,
): HtmlTextSurface | null {
  if (!htmlInCanvasSupported()) return null;

  const canvas = document.createElement('canvas') as PaintableCanvas;
  canvas.width = Math.max(1, Math.round(spec.width * spec.density));
  canvas.height = Math.max(1, Math.round(spec.height * spec.density));
  canvas.style.cssText = `display:block;width:${spec.width}px;height:${spec.height}px;`;
  // 两个属性同时写：147–156 只认 layoutsubtree，157+ 只认 content="drawable"，
  // 各版本会忽略自己不认识的属性
  canvas.setAttribute('layoutsubtree', '');
  canvas.setAttribute('content', 'drawable');

  const div = document.createElement('div');
  div.setAttribute('drawable', '');
  // 富文本用 innerHTML 完整渲染（内容已在 richText 侧清洗成受控子集），
  // 纯文本走 textContent，避免用户输入的 & / < 被当成标记解析
  if (spec.html) div.innerHTML = spec.html;
  else div.textContent = spec.text;
  applyTextStyle(div, spec);

  canvas.appendChild(div);
  ensureHost().appendChild(canvas);

  // 先手绘一份，保证首帧可用；HTML 绘制完成后会被覆盖
  paintFallback(canvas);

  let firstPaint = false;
  let settled = false;
  let timer = 0;
  let resolveReady: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });

  /** 结束等待：只结算一次，超时与绘制成功都走这里 */
  const settle = (ok: boolean) => {
    if (settled) return;
    settled = true;
    if (timer) window.clearTimeout(timer);
    resolveReady(ok);
  };

  /**
   * 把子树绘制到画布。
   * 必须在 paint 回调内执行：事件外读取的是上一帧快照，首次调用会直接抛错。
   */
  const paint = () => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const drawElementImage = (ctx as unknown as Partial<DrawElementContext>).drawElementImage;
    if (typeof drawElementImage !== 'function') return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 子树按逻辑像素排版，画布按 density 放大；用 CTM 一次性换算
    ctx.setTransform(spec.density, 0, 0, spec.density, 0, 0);
    drawElementImage.call(ctx, div, 0, 0);
    if (!firstPaint) {
      firstPaint = true;
      onPaint();
    }
  };

  const onPaintEvent = () => {
    try {
      paint();
      settle(true);
    } catch {
      // 157 的 drawable 语义异常时会抛 InvalidStateError；此时保留手绘内容
      settle(false);
    }
  };

  canvas.addEventListener('paint', onPaintEvent);
  // 子元素刚插入时浏览器可能已经排过版，主动请求一次 paint 保证有回调
  canvas.requestPaint?.();
  // 兜底：极少数环境（例如画布被完全遮挡）可能不派发 paint，避免调用方一直等下去
  timer = window.setTimeout(() => settle(false), 2000);

  return {
    canvas,
    ready,
    dispose: () => {
      // 让仍在等待 ready 的调用方立即拿到结果，避免悬挂的 Promise
      settle(false);
      canvas.removeEventListener('paint', onPaintEvent);
      div.remove();
      canvas.remove();
    },
  };
}
