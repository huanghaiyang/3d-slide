/**
 * textLayout.ts —— 进阶文本排版（PPT / WPS 风格）
 *
 * 在基础排版（lib/text.ts）之上补齐编辑类产品里必用的排版能力：
 * 字间距、段间距、首行缩进、项目符号 / 自动编号与多级缩进、竖排、
 * 内边距（背景色块）以及「自动缩小字号适配框高」。
 *
 * 为什么单独成模块：Canvas 手绘路径（SceneManager.paintTextCanvas）与
 * 对象高度计算（deck.autoTextHeight）必须共用同一套度量，否则框高与实际字形
 * 会错位；HTML-in-Canvas 路径则用同一批数值转成 CSS（字号 em、行高、缩进、内边距）。
 *
 * 关键约定：
 * - 所有数值都是「世界单位」，与对象 width / height 同一量纲；
 * - 度量使用复用的离屏 canvas，不创建 DOM 元素；
 * - 字间距不依赖 ctx.letterSpacing（兼容性不稳），统一用「测量宽度 + 间距补偿」计算；
 * - 竖排按「每列自上而下、列从右向左」处理：用框高作为每列可用长度，
 *   列宽进 = 行高，需要的框宽由列数推导。
 */

import type { ListType, WritingMode } from '../types';
import { FONT_STACKS } from './constants';

/** 复用的度量上下文；首次使用时惰性创建。 */
let measureCtx: CanvasRenderingContext2D | null = null;

/** 取（必要时创建）度量用的 2D 上下文。 */
function getCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    measureCtx = canvas.getContext('2d')!;
  }
  return measureCtx;
}

/** 生成 canvas 字体串；italic 与 bold 可叠加。 */
function fontCssOf(font: string, fontPx: number, bold: boolean, italic: boolean): string {
  const stack = FONT_STACKS[font] ?? FONT_STACKS.sans;
  const style = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}`;
  return `${style}${fontPx}px ${stack}`;
}

/**
 * 测量一行文本宽度（含字间距补偿）。
 * 字间距按「字符之间」计，因此补偿量为 (字符数 - 1) * 间距。
 */
function measureWidth(ctx: CanvasRenderingContext2D, text: string, letterSpacing: number): number {
  if (!text) return 0;
  const base = ctx.measureText(text).width;
  if (!letterSpacing) return base;
  // 用 Array.from 而不是 length：避免把表情等代理对算成两个字符
  const chars = Array.from(text).length;
  return base + Math.max(0, chars - 1) * letterSpacing;
}

/** 排版输入：文本对象的排版相关字段子集。 */
export interface TextLayoutInput {
  text: string;
  /** 对象框宽度（世界单位） */
  width: number;
  /** 对象框高度（世界单位）；autoFit 时作为约束上限 */
  height: number;
  fontSize: number;
  font: string;
  bold: boolean;
  italic?: boolean;
  lineHeight: number;
  letterSpacing?: number;
  paragraphSpacing?: number;
  indent?: number;
  listType?: ListType;
  listLevel?: number;
  writingMode?: WritingMode;
  padding?: number;
  autoFit?: boolean;
}

/** 单段落的排版结果。 */
export interface ParagraphLayout {
  /** 折行后的各行文本（不含列表标记） */
  lines: string[];
  /** 列表标记文本（空串表示无标记） */
  marker: string;
  /** 正文起点的左侧缩进（相对内容区左边界，世界单位） */
  indent: number;
  /** 段落顶部相对内容区顶部的偏移 */
  top: number;
  /** 段落自身高度（行数 * 行高） */
  height: number;
}

/** 完整排版结果。 */
export interface TextLayoutResult {
  /** 实际使用的字号（autoFit 收缩后的结果） */
  fontPx: number;
  /** 行高像素 */
  lineHeightPx: number;
  /** 内边距（已裁剪） */
  padding: number;
  /** 内容区宽度（扣除内边距） */
  contentWidth: number;
  /** 内容区高度（扣除内边距） */
  contentHeight: number;
  /** 横排段落；竖排时为空数组 */
  paragraphs: ParagraphLayout[];
  /** 竖排的每一列文本（从右往左阅读顺序） */
  columns: string[];
  /** 竖排时每列的步进宽度（= 行高） */
  columnWidth: number;
  /** 排版所需总高度（含内边距） */
  height: number;
  /** 竖排时排版所需总宽度 */
  verticalWidth: number;
  /** 是否竖排 */
  vertical: boolean;
  /** 是否因为 autoFit 发生了字号收缩 */
  shrunk: boolean;
}

/** 各层级项目符号：层级越高越轻。 */
const BULLETS = ['•', '○', '▪', '–'];

/**
 * 生成列表标记。
 * 编号为「1.」式，层级不同用不同括号形式，便于一眼看出层级。
 *
 * @param type  列表类型
 * @param level 层级（0–3）
 * @param index 段落序号（从 1 开始）
 */
export function listMarker(type: ListType | undefined, level: number, index: number): string {
  if (!type || type === 'none') return '';
  const safeLevel = Math.max(0, Math.min(3, Math.round(level ?? 0)));
  if (type === 'bullet') return BULLETS[safeLevel];
  if (safeLevel === 0) return `${index}.`;
  if (safeLevel === 1) return `${index})`;
  if (safeLevel === 2) return `(${index})`;
  return `${index}-`;
}

/**
 * 按可用宽度折行，并把字间距计入宽度判断。
 * 与基础 wrapLines 的断行策略一致（CJK 逐字、拉丁按词、超长 token 逐字符）。
 */
function wrapParagraph(
  ctx: CanvasRenderingContext2D,
  text: string,
  firstWidth: number,
  restWidth: number,
  letterSpacing: number,
): string[] {
  if (text === '') return [''];
  const tokens = text.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]|\S+|\s+/g) ?? [];
  const lines: string[] = [];
  let line = '';
  let limit = Math.max(1, firstWidth);
  for (let token of tokens) {
    if (/^\s+/.test(token) && line === '') continue;
    const candidate = line + token;
    const width = measureWidth(ctx, candidate, letterSpacing);
    if (width <= limit) {
      line = candidate;
      continue;
    }
    if (line === '') {
      // 单个 token 就超宽：逐字符放置，保证不溢出可用宽度
      for (const ch of Array.from(token)) {
        const next = line + ch;
        if (measureWidth(ctx, next, letterSpacing) > limit && line !== '') {
          lines.push(line);
          line = ch;
          limit = Math.max(1, restWidth);
        } else {
          line = next;
        }
      }
      continue;
    }
    lines.push(line.replace(/\s+$/, ''));
    line = token.replace(/^\s+/, '');
    limit = Math.max(1, restWidth);
  }
  lines.push(line.replace(/\s+$/, ''));
  return lines;
}

/**
 * 计算一次排版。
 *
 * autoFit 打开时会在内部循环收缩字号（每次 ×0.92），直到内容高度不超过框高，
 * 最低收缩到输入字号的 30% 与 8 单位中的较大者，避免文字小到不可读。
 *
 * @param input 排版输入
 * @returns 排版结果；调用方据 paragraphs / columns 绘制，据 height 决定框高
 */
export function layoutTextBox(input: TextLayoutInput): TextLayoutResult {
  const ctx = getCtx();
  const fontSize = Math.max(1, input.fontSize);
  const letterSpacing = input.letterSpacing ?? 0;
  const paragraphSpacing = Math.max(0, input.paragraphSpacing ?? 0);
  const userIndent = Math.max(0, input.indent ?? 0);
  const padding = Math.max(0, Math.min(input.padding ?? 0, input.width / 2 - 1, input.height / 2 - 1));
  const level = Math.max(0, Math.min(3, Math.round(input.listLevel ?? 0)));
  const vertical = input.writingMode === 'vertical';
  const paragraphs = input.text.split('\n');
  const minFont = Math.max(8, fontSize * 0.3);
  const targetHeight = Math.max(1, input.height);

  /** 用给定字号排一次；返回完整结果。 */
  const run = (fontPx: number): TextLayoutResult => {
    ctx.font = fontCssOf(input.font, fontPx, input.bold, Boolean(input.italic));
    const lineHeightPx = fontPx * input.lineHeight;
    const contentWidth = Math.max(1, input.width - padding * 2);
    const contentHeight = Math.max(1, input.height - padding * 2);
    // 层级缩进：每级 0.9em，视觉上明显但不至于把内容区吃光
    const levelIndent = vertical ? 0 : level * fontPx * 0.9;
    const markers: string[] = [];
    let numberIndex = 0;
    for (const para of paragraphs) {
      // 编号只对非空段计数，空行不占号，符合演示文稿里的习惯
      if (para.trim()) numberIndex += 1;
      markers.push(listMarker(input.listType, level, numberIndex));
    }

    if (vertical) {
      // 竖排：以框高作为每列的阅读长度，折行结果即「列」
      const columns: string[] = [];
      const limit = Math.max(1, contentHeight);
      for (const para of paragraphs) {
        const pieces = wrapParagraph(ctx, para, limit, limit, letterSpacing);
        columns.push(...pieces);
      }
      const columnWidth = lineHeightPx;
      const verticalWidth = padding * 2 + fontPx * 0.6 + Math.max(1, columns.length) * columnWidth;
      return {
        fontPx,
        lineHeightPx,
        padding,
        contentWidth,
        contentHeight,
        paragraphs: [],
        columns,
        columnWidth,
        height: input.height,
        verticalWidth,
        vertical: true,
        shrunk: fontPx < fontSize,
      };
    }

    const resultParagraphs: ParagraphLayout[] = [];
    let cursor = 0;
    paragraphs.forEach((para, index) => {
      const marker = markers[index];
      const markerWidth = marker ? measureWidth(ctx, marker, 0) + fontPx * 0.4 : 0;
      const indent = levelIndent + markerWidth;
      const firstWidth = Math.max(1, contentWidth - indent - userIndent);
      const restWidth = Math.max(1, contentWidth - indent);
      const lines = wrapParagraph(ctx, para, firstWidth, restWidth, letterSpacing);
      const height = Math.max(lineHeightPx, lines.length * lineHeightPx);
      resultParagraphs.push({ lines, marker, indent, top: cursor, height });
      cursor += height;
      if (index < paragraphs.length - 1) cursor += paragraphSpacing;
    });

    return {
      fontPx,
      lineHeightPx,
      padding,
      contentWidth,
      contentHeight,
      paragraphs: resultParagraphs,
      columns: [],
      columnWidth: lineHeightPx,
      // 上下各留 0.3em 容纳字形伸出部分，与基础排版的高度公式保持一致
      height: padding * 2 + fontPx * 0.6 + cursor,
      verticalWidth: 0,
      vertical: false,
      shrunk: fontPx < fontSize,
    };
  };

  let layout = run(fontSize);
  if (!input.autoFit) return layout;
  // 自动字号：只收缩、不放大；高度不达标就按比例降一档重排
  let fontPx = fontSize;
  while (layout.height > targetHeight + 0.5 && fontPx > minFont) {
    fontPx = Math.max(minFont, fontPx * 0.92);
    layout = run(fontPx);
  }
  return layout;
}

/**
 * 文本所需的框高（横排）或框宽（竖排）。
 * autoFit 打开时框高由用户固定，直接返回设定值。
 */
export function textBoxSize(input: TextLayoutInput): { height: number; width: number } {
  const layout = layoutTextBox(input);
  if (input.autoFit) return { height: input.height, width: input.width };
  if (layout.vertical) return { height: input.height, width: Math.max(input.width, layout.verticalWidth) };
  return { height: layout.height, width: input.width };
}
