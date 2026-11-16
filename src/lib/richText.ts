/**
 * richText.ts —— 富文本（HTML）清洗、纯文本投影与高度估算
 *
 * 职责：
 * - 把剪贴板 / 工程文件里拿到的任意 HTML 清洗成受控子集：只保留 `<div>` 块、`<br>` 换行
 *   与带内联样式的 `<span>`，可以安全交给 HTML-in-Canvas 渲染；
 * - 生成纯文本投影（text），供「HTML in Canvas 关闭」时的纯文本渲染、AI 检索与快照使用；
 * - 依据每块的字号倍率估算富文本高度，让文本框随内容自动增高。
 *
 * 设计要点：
 * - 字号一律换算成相对基线的 em：粘贴来源各不相同（Word 11pt、网页 13px、设计稿 16px），
 *   归一成 em 后才能跟随对象的 fontSize 一起缩放；
 * - 只保留「看得见」的样式：颜色、背景色、粗体、斜体、下划线 / 删除线、字号、对齐、
 *   上下标与通用字体族；边距、行高、id、class、超链接地址等一律丢弃；
 * - 空白按 CSS normal 规则折叠：文本节点内的连续空白压成单个空格，并裁掉行首行尾空格，
 *   避免 pre-wrap 容器里出现多余缩进；
 * - 输出中的文本一律转义、标签只来自白名单，因此不存在脚本注入风险。
 *
 * 与其他模块的关系：
 * - 只依赖 lib/text 的折行测量；被 validate / deckStore / SceneManager / Stage / Inspector 共用。
 */

import type { FontPreset } from '../types';
import { wrapLines } from './text';

/** 整体丢弃的标签：脚本、样式、媒体与表单控件都不参与文本渲染 */
const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE',
  'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'SOURCE', 'CANVAS',
  'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'OPTION', 'PROGRESS', 'METER',
]);

/** 会被输出成独立文本块的标签：块边界等价于换行 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HGROUP', 'HR', 'HTML', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

/** 标题标签的默认字号倍率（与浏览器默认样式一致） */
const HEADING_EM: Record<string, number> = { H1: 2, H2: 1.5, H3: 1.2, H4: 1.05, H5: 1, H6: 0.9 };

/** 等宽语义的标签：粘贴时按 monospace 呈现 */
const MONO_TAGS = new Set(['CODE', 'PRE', 'KBD', 'SAMP']);

/** 需要按 em 保留的字号上下限：过小看不清，过大会撑破文本框 */
const MIN_EM = 0.4;
const MAX_EM = 5;

/**
 * 富文本清洗结果。
 * html 是可直接塞进 drawable 子树的受控 HTML；text 是它的纯文本投影。
 */
export interface RichTextResult {
  /** 清洗后的 HTML：由 `<div>` 块与 `<span style>` 组成，块之间不包含额外空白 */
  html: string;
  /** 纯文本投影：块之间用 \n 连接，`<br>` 也是 \n */
  text: string;
  /** 是否包含真正的富文本信息（多块、样式或换行）；false 表示等价于纯文本 */
  rich: boolean;
}

/** 富文本中的一个文本块（一行或一段），用于高度估算与文本投影 */
export interface RichBlock {
  /** 块内文本，`<br>` 已转成 \n */
  text: string;
  /** 块内最大字号倍率（相对对象 fontSize） */
  em: number;
  /** 块内是否出现粗体 */
  bold: boolean;
}

/* ------------------------------ 基础工具 ------------------------------ */

/** HTML 文本转义：只处理会破坏标记结构的三个字符 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 按 CSS normal 空白规则折叠文本：连续空白（含不间断空格）压成单个空格。
 *
 * @param text 原始文本节点内容
 * @returns 折叠后的文本；全为空白时返回单个空格（由调用方决定是否保留）
 */
function collapseSpace(text: string): string {
  return text.replace(/[\t\n\r\f\v\u00a0]+/g, ' ').replace(/ {2,}/g, ' ');
}

/** 校验 CSS 颜色值：只接受十六进制、rgb(a)、hsl(a) 与普通颜色关键字 */
function isColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3,8})$|^(?:rgba?|hsla?)\([^)]*\)$|^[a-z]{3,20}$/i.test(value);
}

/**
 * 把 CSS 长度换算成像素。
 *
 * 支持 px / pt / pc / em / rem / % 与无单位数字；无法识别时返回 null。
 * 百分比与 em / rem 都按基线字号换算，保证粘贴内容与对象字号成比例。
 */
function cssLengthToPx(value: string, basePx: number): number | null {
  const match = /^(-?[\d.]+)\s*(px|pt|pc|em|rem|%)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  switch ((match[2] ?? 'px').toLowerCase()) {
    case 'pt':
      return (amount * 4) / 3;
    case 'pc':
      return amount * 16;
    case 'em':
    case 'rem':
      return amount * basePx;
    case '%':
      return (amount / 100) * basePx;
    default:
      return amount;
  }
}

/* ------------------------------ 样式解析 ------------------------------ */

/** 单层元素的内联样式差异；undefined 表示该属性没有声明，需要继承上层 */
interface StyleDelta {
  /** 颜色（CSS 颜色字符串） */
  color?: string;
  /** 背景色（高亮） */
  background?: string;
  /** 字重（数字） */
  weight?: number;
  /** 是否斜体 */
  italic?: boolean;
  /** 是否下划线 */
  underline?: boolean;
  /** 是否删除线 */
  strike?: boolean;
  /** 相对上一层的字号倍率 */
  em?: number;
  /** 通用字体族：只在 monospace / serif / sans-serif 之间取值 */
  family?: string;
  /** 上下标 */
  vAlign?: 'super' | 'sub';
  /** 块级水平对齐 */
  align?: 'left' | 'center' | 'right' | 'justify';
}

/** 解析元素的内联 style（不使用 className，避免依赖外部 CSS） */
function parseStyle(el: HTMLElement, basePx: number): StyleDelta {
  const delta: StyleDelta = {};
  const style = el.style;
  if (!style) return delta;
  const color = style.color.trim();
  if (color && isColor(color)) delta.color = color;
  const background = (style.backgroundColor || '').trim();
  // 透明背景没有意义，直接忽略
  if (background && isColor(background) && !/^(transparent|rgba?\(0,\s*0,\s*0,\s*0\))$/i.test(background)) {
    delta.background = background;
  }
  const weight = style.fontWeight.trim().toLowerCase();
  if (weight) {
    if (weight === 'normal') delta.weight = 400;
    else if (weight === 'bold' || weight === 'bolder') delta.weight = 700;
    else if (weight === 'lighter') delta.weight = 300;
    else {
      const numeric = Number(weight);
      if (Number.isFinite(numeric)) delta.weight = Math.max(100, Math.min(900, numeric));
    }
  }
  const fontStyle = style.fontStyle.trim().toLowerCase();
  if (fontStyle === 'italic' || fontStyle === 'oblique') delta.italic = true;
  else if (fontStyle === 'normal') delta.italic = false;
  const decoration = `${style.textDecorationLine || ''} ${style.textDecoration || ''}`.toLowerCase();
  if (decoration.includes('underline')) delta.underline = true;
  if (decoration.includes('line-through')) delta.strike = true;
  if (decoration.includes('none')) {
    delta.underline = false;
    delta.strike = false;
  }
  const fontSize = (style.fontSize || '').trim();
  if (fontSize) {
    const px = cssLengthToPx(fontSize, basePx);
    if (px !== null) delta.em = Math.max(MIN_EM, Math.min(MAX_EM, px / basePx));
  }
  const family = (style.fontFamily || '').toLowerCase();
  if (family) {
    if (family.includes('mono') || family.includes('courier')) delta.family = 'monospace';
    else if (family.includes('serif') && !family.includes('sans-serif')) delta.family = 'serif';
  }
  const vAlign = (style.verticalAlign || '').trim().toLowerCase();
  if (vAlign === 'super') delta.vAlign = 'super';
  else if (vAlign === 'sub') delta.vAlign = 'sub';
  const align = (style.textAlign || '').trim().toLowerCase();
  if (align === 'left' || align === 'center' || align === 'right' || align === 'justify' || align === 'start') {
    delta.align = align === 'start' ? 'left' : align;
  }
  return delta;
}

/* ------------------------------ 上下文 ------------------------------ */

/** 渲染上下文：沿元素树累积的最终样式 */
interface StyleContext {
  em: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string;
  background: string;
  family: string;
  vAlign: '' | 'super' | 'sub';
  align: '' | 'left' | 'center' | 'right' | 'justify';
}

/** 初始上下文：全部继承对象自身的字体设置（字号倍率为 1） */
const BASE_CONTEXT: StyleContext = {
  em: 1, bold: false, italic: false, underline: false, strike: false,
  color: '', background: '', family: '', vAlign: '', align: '',
};

/**
 * 合并一层元素的样式与标签语义，得到新的上下文。
 *
 * 标签语义（<b> / <i> / <u> / 标题 / <code>）先参与合并，再被显式 style 覆盖，
 * 这样 `<b style="font-weight:normal">` 这类写法仍然按用户意图表现为常规字重。
 */
function mergeContext(tag: string, delta: StyleDelta, ctx: StyleContext): StyleContext {
  const next: StyleContext = { ...ctx };
  // 标签默认语义
  if (tag === 'B' || tag === 'STRONG') next.bold = true;
  if (tag === 'I' || tag === 'EM') next.italic = true;
  if (tag === 'U' || tag === 'INS') next.underline = true;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next.strike = true;
  if (MONO_TAGS.has(tag)) next.family = 'monospace';
  if (tag === 'SUB') next.vAlign = 'sub';
  if (tag === 'SUP') next.vAlign = 'super';
  // 标题：默认放大并加粗
  const heading = HEADING_EM[tag];
  if (heading) {
    next.em = Math.min(MAX_EM, ctx.em * heading);
    next.bold = true;
  }
  // 显式样式覆盖标签语义
  if (delta.weight !== undefined) next.bold = delta.weight >= 600;
  if (delta.italic !== undefined) next.italic = delta.italic;
  if (delta.underline !== undefined) next.underline = delta.underline;
  if (delta.strike !== undefined) next.strike = delta.strike;
  if (delta.color) next.color = delta.color;
  if (delta.background) next.background = delta.background;
  if (delta.family) next.family = delta.family;
  if (delta.vAlign) next.vAlign = delta.vAlign;
  if (delta.align) next.align = delta.align;
  if (delta.em !== undefined && !heading) next.em = Math.min(MAX_EM, Math.max(MIN_EM, ctx.em * delta.em));
  return next;
}

/**
 * 生成行内 span 的 style 属性值。
 *
 * 只输出与「父层默认样式」不同的差异项，保证 HTML 体积小、也便于阅读；
 * 空字符串表示这一层不需要包裹 span。
 */
function spanStyle(ctx: StyleContext, next: StyleContext): string {
  const parts: string[] = [];
  if (next.color !== ctx.color && next.color) parts.push(`color:${next.color}`);
  if (next.background !== ctx.background && next.background) parts.push(`background-color:${next.background}`);
  if (next.bold !== ctx.bold) parts.push(`font-weight:${next.bold ? 700 : 400}`);
  if (next.italic !== ctx.italic) parts.push(`font-style:${next.italic ? 'italic' : 'normal'}`);
  if (next.underline !== ctx.underline || next.strike !== ctx.strike) {
    const decorations = [next.underline ? 'underline' : '', next.strike ? 'line-through' : ''].filter(Boolean);
    parts.push(`text-decoration:${decorations.length ? decorations.join(' ') : 'none'}`);
  }
  // 标题的字号由 HEADING_EM 提供，即使没有 style 也要写进 span
  if (next.em !== ctx.em) parts.push(`font-size:${round2(next.em / ctx.em)}em`);
  if (next.family !== ctx.family && next.family) parts.push(`font-family:${next.family}`);
  if (next.vAlign !== ctx.vAlign) {
    parts.push(`vertical-align:${next.vAlign === 'super' ? 'super' : next.vAlign === 'sub' ? 'sub' : 'baseline'}`);
  }
  return parts.join(';');
}

/** 保留两位小数，避免 em 换算后出现一长串尾数 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------ 结构构建 ------------------------------ */

/** 清洗过程中累积的文本块 */
interface BlockAccumulator {
  html: string;
  text: string;
  em: number;
  bold: boolean;
  align: string;
}

/**
 * 富文本构建器：把 DOM 遍历结果累积成「块 + 行内 run」的扁平结构。
 *
 * 所有块最终都会输出成 `<div>`（可选 text-align），块内是转义文本与带样式的 span，
 * 因此渲染侧只需要一套固定的 CSS（字体、行高、折行）即可。
 */
class RichBuilder {
  /** 已完成清洗的块（含 html 与纯文本） */
  readonly blocks: (BlockAccumulator & { html: string })[] = [];
  /** 当前块是否有过内联内容（用于行首空格裁剪） */
  private acc: BlockAccumulator = { html: '', text: '', em: 1, bold: false, align: '' };
  /** 是否出现过样式 / 换行 / 多块，用于判断内容是否真的是富文本 */
  private styled = false;

  /** 当前块是否还没有任何文本（行首） */
  get atLineStart(): boolean {
    return this.acc.text.length === 0;
  }

  /** 写入一段行内内容：html 片段与对应的纯文本 */
  push(html: string, text: string, em: number, bold: boolean, styled: boolean) {
    if (!html && !text) return;
    this.acc.html += html;
    this.acc.text += text;
    this.acc.em = Math.max(this.acc.em, Math.min(MAX_EM, em));
    if (bold) this.acc.bold = true;
    if (styled) this.styled = true;
  }

  /** 只写入标记（span 开闭标签），不产生文本 */
  pushMarkup(markup: string) {
    this.acc.html += markup;
  }

  /** 插入一个显式换行（`<br>`） */
  newline() {
    this.acc.html += '<br/>';
    this.acc.text += '\n';
    this.styled = true;
  }

  /** 设置当前块的水平对齐（块开始时调用） */
  setAlign(align: string) {
    this.acc.align = align;
    if (align && align !== 'left') this.styled = true;
  }

  /** 结束当前块；没有内容时直接丢弃，避免产生空行 */
  breakBlock() {
    const html = trimHtmlTail(this.acc.html).trim();
    const text = this.acc.text.replace(/[ \t]+$/, '');
    if (html || text.trim()) {
      const style = this.acc.align && this.acc.align !== 'left' ? ` style="text-align:${this.acc.align}"` : '';
      this.blocks.push({
        html: `<div${style}>${html}</div>`,
        text,
        em: this.acc.em,
        bold: this.acc.bold,
        align: this.acc.align,
      });
    }
    this.acc = { html: '', text: '', em: 1, bold: false, align: '' };
  }

  /** 汇总为清洗结果 */
  finish(): RichTextResult {
    this.breakBlock();
    const html = this.blocks.map((block) => block.html).join('');
    const text = this.blocks
      .map((block) => block.text.replace(/\n{3,}/g, '\n\n'))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
    return { html, text, rich: this.blocks.length > 1 || this.styled };
  }
}

/**
 * 去掉块尾的空白：既要去掉纯空格，也要去掉位于 span 内部的尾随空格，
 * 否则 pre-wrap 容器会在行末留下可见的宽度。
 */
function trimHtmlTail(html: string): string {
  let out = html;
  for (let guard = 0; guard < 64; guard += 1) {
    if (out.endsWith(' ')) {
      out = out.slice(0, -1);
      continue;
    }
    if (out.endsWith('</span>')) {
      const head = out.slice(0, -'</span>'.length);
      const trimmed = head.replace(/ +$/, '');
      if (trimmed === head) break;
      out = `${trimmed}</span>`;
      continue;
    }
    break;
  }
  return out;
}

/**
 * 判断某个节点之后是否还有同一行的行内内容。
 *
 * 用于裁掉「文本节点末尾空格」：只有后面还有同一块内的内容时才保留空格，
 * 否则行末空格会撑出可见空白。向上递归直到块级父元素为止。
 */
function hasInlineAfter(node: Node): boolean {
  let sibling = node.nextSibling;
  while (sibling) {
    if (sibling.nodeType === 3) {
      if (/\S/.test(collapseSpace(sibling.nodeValue ?? ''))) return true;
    } else if (sibling.nodeType === 1) {
      const el = sibling as HTMLElement;
      if (BLOCK_TAGS.has(el.tagName)) return false;
      if (hasTextInside(el)) return true;
    }
    sibling = sibling.nextSibling;
  }
  const parent = node.parentElement;
  if (!parent || BLOCK_TAGS.has(parent.tagName)) return false;
  return hasInlineAfter(parent);
}

/** 递归检查元素内是否存在可见文本 */
function hasTextInside(el: HTMLElement): boolean {
  if (/\S/.test(collapseSpace(el.textContent ?? ''))) return true;
  return Array.from(el.children).some((child) => !BLOCK_TAGS.has(child.tagName) && hasTextInside(child as HTMLElement));
}

/** 递归遍历子节点，把文本与样式累积进构建器 */
function walkChildren(parent: Node, ctx: StyleContext, builder: RichBuilder, basePx: number) {
  const children = Array.from(parent.childNodes);
  for (const child of children) {
    walkNode(child, ctx, builder, basePx);
  }
}

/** 遍历单个节点：文本节点写入内容，元素节点按块 / 行内分别处理 */
function walkNode(node: Node, ctx: StyleContext, builder: RichBuilder, basePx: number) {
  if (node.nodeType === Node.TEXT_NODE) {
    let text = collapseSpace(node.nodeValue ?? '');
    if (!text.trim()) {
      // 全空白节点只有在行中段才有意义（保留单个空格）
      if (!builder.atLineStart && hasInlineAfter(node)) builder.push(' ', ' ', ctx.em, ctx.bold, false);
      return;
    }
    if (builder.atLineStart) text = text.replace(/^ +/, '');
    if (!hasInlineAfter(node)) text = text.replace(/ +$/, '');
    if (!text) return;
    builder.push(escapeHtml(text), text, ctx.em, ctx.bold, false);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (DROP_TAGS.has(tag)) return;
  if (tag === 'BR') {
    builder.newline();
    return;
  }
  const delta = parseStyle(el, basePx);
  const next = mergeContext(tag, delta, ctx);
  if (BLOCK_TAGS.has(tag)) {
    builder.breakBlock();
    builder.setAlign(next.align);
    // 块元素自身的行内样式也要落成 span：从 Word / 网页复制的段落几乎都是
    // `<div style="color:…;font-size:…">正文</div>` 这种写法，若只把样式并进上下文，
    // 块内纯文本节点没有任何元素包裹，颜色与字号会整段丢失。
    // 子块（div 套 div）各自处理自己的样式，这里只在没有子块时包裹，避免 span 跨块。
    const hasBlockChild = Array.from(el.children).some((child) => BLOCK_TAGS.has(child.tagName));
    const blockStyle = hasBlockChild ? '' : spanStyle(ctx, next);
    if (blockStyle) builder.pushMarkup(`<span style="${blockStyle}">`);
    walkChildren(el, next, builder, basePx);
    if (blockStyle) builder.pushMarkup('</span>');
    builder.breakBlock();
    return;
  }
  const style = spanStyle(ctx, next);
  if (!style) {
    walkChildren(el, next, builder, basePx);
    return;
  }
  builder.pushMarkup(`<span style="${style}">`);
  walkChildren(el, next, builder, basePx);
  builder.pushMarkup('</span>');
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 从一份 HTML 文档中推断基线字号（像素）。
 *
 * 优先读取 body 的 font-size；否则取出现次数最多的元素字号，
 * 这样「Word 11pt / 网页 16px」都能被正确归一成 1em。
 */
function resolveBaseFontPx(doc: Document): number {
  const bodySize = doc.body ? cssLengthToPx(doc.body.style.fontSize, 16) : null;
  if (bodySize && bodySize >= 4 && bodySize <= 96) return bodySize;
  const counts = new Map<number, number>();
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const size = cssLengthToPx((el as HTMLElement).style?.fontSize ?? '', 16);
    if (!size || size < 4 || size > 96) continue;
    const key = Math.round(size);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [size, count] of counts) {
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  }
  return best || 16;
}

/**
 * 清洗任意 HTML。
 *
 * @param raw 原始 HTML（可以带 css、脚本、class 等任意内容）
 * @returns 受控子集与纯文本投影；没有任何可渲染文本时返回 null
 */
export function sanitizeRichHtml(raw: string): RichTextResult | null {
  if (!raw || !raw.trim()) return null;
  // 非浏览器环境（如命令行脚本）没有 DOMParser，直接放弃富文本，调用方退回纯文本
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  if (!doc.body) return null;
  const basePx = resolveBaseFontPx(doc);
  const builder = new RichBuilder();
  walkChildren(doc.body, { ...BASE_CONTEXT }, builder, basePx);
  const result = builder.finish();
  if (!result.text.trim()) return null;
  return result;
}

/** 纯文本 -> 受控 HTML：把换行转成 `<br/>`，其余内容转义 */
export function plainTextToHtml(text: string): string {
  return text
    .split('\n')
    .map((line) => escapeHtml(line))
    .join('<br/>');
}

/**
 * 读取剪贴板里的富文本（用于 textarea / contentEditable 的粘贴拦截）。
 *
 * @param data 粘贴事件的 clipboardData
 * @returns 清洗结果；以下情况返回 null，让浏览器执行原生粘贴：
 *          - 没有 `text/html`（纯文本或文件粘贴）；
 *          - 带文件（图片 / 文档，交给拖放 / 上传流程处理）；
 *          - 清洗后与纯文本等价（例如从纯文本编辑器复制，没必要转成富文本对象）。
 */
export function readClipboardRich(data: DataTransfer | null): RichTextResult | null {
  if (!data) return null;
  if (data.types && data.types.includes('Files')) return null;
  const html = data.getData('text/html');
  if (!html || !html.trim()) return null;
  const rich = sanitizeRichHtml(html);
  return rich && rich.rich ? rich : null;
}

/**
 * 读取「在画布上粘贴新建文本对象」需要的内容。
 *
 * @param data 粘贴事件的 clipboardData
 * @returns text 必有，html 仅在剪贴板带真正富文本时提供；没有可用文本时返回 null
 */
export function readClipboardText(data: DataTransfer | null): { text: string; html?: string } | null {
  if (!data) return null;
  if (data.types && data.types.includes('Files')) return null;
  const rich = readClipboardRich(data);
  if (rich) return { text: rich.text, html: rich.html };
  const plain = (data.getData('text/plain') ?? '').replace(/\r\n?/g, '\n').trim();
  if (!plain) return null;
  return { text: plain.slice(0, 5000) };
}

/**
 * 从清洗后的 HTML 中提取纯文本。
 * 与 sanitizeRichHtml 的 text 结果一致，用于把存档里的 html 投影回 text。
 */
export function richHtmlToText(html: string): string {
  // 非浏览器环境没有 DOMParser：宁可退回空字符串，也不抛错打断调用方
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.body) return '';
  const builder = new RichBuilder();
  walkChildren(doc.body, { ...BASE_CONTEXT }, builder, 16);
  return builder.finish().text;
}

/**
 * 解析清洗后的 HTML，得到逐块的结构（文本、字号倍率、是否粗体）。
 *
 * @param html 受控子集 HTML
 * @returns 文本块数组；用于高度估算
 */
export function richTextBlocks(html: string): RichBlock[] {
  // 无 DOMParser 时无法解析结构，交给调用方按零块处理（高度估算会退回单行）
  if (typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.body) return [];
  const blocks: RichBlock[] = [];
  const pushBlock = (el: Element, inheritedEm: number, inheritedBold: boolean) => {
    // 只取本层直接文本（跳过嵌套 div），嵌套 div 会作为独立块递归处理
    let text = '';
    let em = inheritedEm;
    let bold = inheritedBold;
    const visit = (node: Node, ctxEm: number, ctxBold: boolean) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += (node.nodeValue ?? '').replace(/[\t\r\n\f]+/g, ' ');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const child = node as HTMLElement;
      if (child.tagName === 'BR') {
        text += '\n';
        return;
      }
      if (child.tagName === 'DIV') {
        if (text) blocks.push({ text, em, bold });
        text = '';
        pushBlock(child, ctxEm, ctxBold);
        return;
      }
      const delta = parseStyle(child, 16);
      const weightBold = delta.weight !== undefined ? delta.weight >= 600 : ctxBold;
      em = Math.max(em, ctxEm * (delta.em ?? 1));
      if (weightBold) bold = true;
      for (const grand of Array.from(child.childNodes)) visit(grand, ctxEm * (delta.em ?? 1), weightBold);
    };
    for (const node of Array.from(el.childNodes)) visit(node, inheritedEm, inheritedBold);
    if (text.trim()) blocks.push({ text: text.replace(/[ \t]+$/gm, ''), em, bold });
  };

  for (const child of Array.from(doc.body.children)) {
    if (child.tagName === 'DIV') pushBlock(child, 1, false);
    else {
      const text = (child.textContent ?? '').trim();
      if (text) blocks.push({ text, em: 1, bold: false });
    }
  }
  // 只有行内 span 而没有 div 的极端输入：整份文本当作一个块
  if (blocks.length === 0) {
    const text = (doc.body.textContent ?? '').trim();
    if (text) blocks.push({ text, em: 1, bold: false });
  }
  return blocks;
}

/**
 * 估算富文本排版高度（供 autoTextHeight 使用）。
 *
 * 逐块按「该块最大字号倍率」折行累加行高，再补上首末行的 0.3em 留白，
 * 与 lib/text 的 textHeight 公式保持一致，只是行高按块放大。
 *
 * @param html            受控子集 HTML
 * @param width           文本框宽度（世界单位）
 * @param fontSize        字号（世界单位）
 * @param font            字体预设
 * @param bold            对象级粗体
 * @param lineHeightFactor 行高倍率
 */
export function richTextHeight(
  html: string,
  width: number,
  fontSize: number,
  font: FontPreset,
  bold: boolean,
  lineHeightFactor: number,
): number {
  const blocks = richTextBlocks(html);
  if (blocks.length === 0) return Math.max(fontSize * 0.6, fontSize * lineHeightFactor + fontSize * 0.6);
  let height = 0;
  for (const block of blocks) {
    const em = Math.max(MIN_EM, Math.min(MAX_EM, block.em));
    // wrapLines 的 scale 会同时放大字号与可用宽度，因此宽度要预先除回 em
    const lines = wrapLines(block.text, width / em, fontSize, font, bold || block.bold, em);
    height += lines.length * fontSize * em * lineHeightFactor;
  }
  return Math.max(fontSize * 0.6, height + fontSize * 0.6);
}
