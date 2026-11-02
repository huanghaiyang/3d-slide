/**
 * text.ts —— 文本排版与尺寸测量工具
 *
 * 负责把一段文本按文本框宽度折行，并计算渲染所需的高度与行高像素值。
 * 测量依赖一个复用的离屏 canvas 2D 上下文（惰性创建），避免每次测量都新建
 * canvas 造成内存与性能浪费。
 *
 * 关键概念：
 * - 折行规则：中日韩字符按单字断行，拉丁文本按单词断行，连续空白作为独立 token；
 * - scale 缩放系数：排版通常在舞台坐标系（宽 1920）中计算，若在缩小的 DOM 中
 *   测量，可同时放大字号与可用宽度，使测量结果与真实比例一致；
 * - 高度公式包含上下各 0.3em 的留白，保证首行上缘与末行下缘不被裁切。
 *
 * 本模块只做纯计算与 canvas 测量，不创建 DOM 元素、不修改传入参数。
 */

import type { FontPreset } from '../types';
import { FONT_STACKS } from './constants';

/** 复用的离屏测量上下文；第一次调用时惰性创建，之后共享。 */
let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * 获取（必要时创建）用于文本测量的 2D 上下文。
 *
 * 该 canvas 不插入 DOM，仅用于 ctx.measureText。上下文是模块级单例，
 * 调用方修改 font 等状态时会影响后续测量，因此每次测量前都会重新设置 font。
 *
 * @returns 可用的 CanvasRenderingContext2D
 */
function getCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    measureCtx = canvas.getContext('2d')!;
  }
  return measureCtx;
}

/**
 * 生成 canvas 可识别的 CSS font 简写字符串。
 *
 * 字体族来自预设映射（sans / serif / round / mono）；粗体使用 700 字重，
 * 常规使用 400。scale 会乘到字号上，便于按比例测量。
 *
 * @param font     字体预设
 * @param fontSize 逻辑字号（像素，舞台坐标系）
 * @param bold     是否粗体
 * @param scale    测量缩放系数，默认 1
 * @returns 形如 `700 48px "PingFang SC",...` 的 font 字符串
 */
export function fontCss(font: FontPreset, fontSize: number, bold: boolean, scale = 1): string {
  const stack = FONT_STACKS[font] ?? FONT_STACKS.sans;
  return `${bold ? '700 ' : '400 '}${fontSize * scale}px ${stack}`;
}

/**
 * 按文本框宽度折行；中日韩逐字断行，拉丁按词断行。
 *
 * 实现要点：
 * - 文本先按换行符拆成多个段落，空段落保留为空行；
 * - 每个段落用正则切成「单个中日韩字符 / 非空白词 / 连续空白」三类 token；
 * - 每次尝试把 token 拼到当前行，超过宽度则在 token 前换行；
 * - 单个 token 本身就超宽（例如超长英文单词或 URL）时退化为逐字符拆分；
 * - 行首空白会被跳过，行尾空白会被去除，避免出现视觉上的缩进或多余空隙。
 *
 * @param text     原始文本，可包含 \n
 * @param maxWidth 文本框宽度（逻辑像素）
 * @param fontSize 字号（逻辑像素）
 * @param font     字体预设
 * @param bold     是否粗体
 * @param scale    测量缩放系数，默认 1；字号与可用宽度会同步放大
 * @returns 折行后的行数组，至少包含一个元素（空文本返回 ['']）
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  fontSize: number,
  font: FontPreset,
  bold: boolean,
  scale = 1,
): string[] {
  const ctx = getCtx();
  // 设置本次测量使用的字体；scale 让字号与宽度保持同一比例
  ctx.font = fontCss(font, fontSize, bold, scale);
  const limit = Math.max(1, maxWidth * scale);
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const para of paragraphs) {
    if (para.length === 0) {
      // 空段落对应一个空行，保留段间距
      lines.push('');
      continue;
    }
    // token 化：CJK 字符单独成 token，拉丁文本按空白切词，空白本身也保留
    const tokens = para.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]|\S+|\s+/g) ?? [];
    let line = '';
    for (let token of tokens) {
      // 行首空白没有意义（通常是上一行换行后残留的缩进），直接跳过
      if (/^\s+/.test(token) && line === '') continue;
      const candidate = line + token;
      if (ctx.measureText(candidate).width <= limit || line === '') {
        if (ctx.measureText(candidate).width > limit && token.length > 1) {
          // 单个超长 token：逐字符拆开
          for (const ch of token) {
            const next = line + ch;
            if (ctx.measureText(next).width > limit && line !== '') {
              lines.push(line.replace(/\s+$/, ''));
              line = ch;
            } else {
              line = next;
            }
          }
        } else {
          line = candidate;
        }
      } else {
        // 放不下：当前行定稿，token 去掉前导空白后作为新行开头
        lines.push(line.replace(/\s+$/, ''));
        line = token.replace(/^\s+/, '');
      }
    }
    // 段落最后一行定稿，并清理行尾空白
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines;
}

/**
 * 根据行数计算文本框所需高度。
 *
 * 公式为 lines * fontSize * lineHeightFactor + fontSize * 0.6：
 * 前者是行数乘以行高，后者是上下各 0.3em 的留白（用于容纳字形上下伸出部分）。
 * 高度不小于 0.6em，保证空文本 / 单行时仍有可见的文本框。
 *
 * @param lines            行数
 * @param fontSize         字号（逻辑像素）
 * @param lineHeightFactor 行高倍数（如 1.4）
 * @returns 文本高度（逻辑像素）
 */
export function textHeight(
  lines: number,
  fontSize: number,
  lineHeightFactor: number,
): number {
  return Math.max(fontSize * 0.6, lines * fontSize * lineHeightFactor + fontSize * 0.6);
}

/**
 * 一次性完成文本排版：折行 + 计算总高度与单行行高。
 *
 * 供属性面板、3D 文本网格与 DOM 预览统一使用，确保各处尺寸一致。
 *
 * @param text             原始文本
 * @param width            文本框宽度
 * @param fontSize         字号
 * @param font             字体预设
 * @param bold             是否粗体
 * @param lineHeightFactor 行高倍数
 * @returns lines 折行结果；height 文本总高度；lineHeightPx 单行行高（像素）
 */
export function layoutText(
  text: string,
  width: number,
  fontSize: number,
  font: FontPreset,
  bold: boolean,
  lineHeightFactor: number,
): { lines: string[]; height: number; lineHeightPx: number } {
  const lines = wrapLines(text, width, fontSize, font, bold);
  return {
    lines,
    height: textHeight(lines.length, fontSize, lineHeightFactor),
    lineHeightPx: fontSize * lineHeightFactor,
  };
}

/**
 * 按最大字符数截断文本（不做省略号处理，不区分宽窄字符）。
 *
 * @param text 原始文本
 * @param max  允许的最大字符数
 * @returns 截断后的文本；未超长时原样返回
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}
