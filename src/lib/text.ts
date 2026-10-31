import type { FontPreset } from '../types';
import { FONT_STACKS } from './constants';

let measureCtx: CanvasRenderingContext2D | null = null;

function getCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    measureCtx = canvas.getContext('2d')!;
  }
  return measureCtx;
}

export function fontCss(font: FontPreset, fontSize: number, bold: boolean, scale = 1): string {
  const stack = FONT_STACKS[font] ?? FONT_STACKS.sans;
  return `${bold ? '700 ' : '400 '}${fontSize * scale}px ${stack}`;
}

/** 按文本框宽度折行；中日韩逐字断行，拉丁按词断行。 */
export function wrapLines(
  text: string,
  maxWidth: number,
  fontSize: number,
  font: FontPreset,
  bold: boolean,
  scale = 1,
): string[] {
  const ctx = getCtx();
  ctx.font = fontCss(font, fontSize, bold, scale);
  const limit = Math.max(1, maxWidth * scale);
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const para of paragraphs) {
    if (para.length === 0) {
      lines.push('');
      continue;
    }
    const tokens = para.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]|\S+|\s+/g) ?? [];
    let line = '';
    for (let token of tokens) {
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
        lines.push(line.replace(/\s+$/, ''));
        line = token.replace(/^\s+/, '');
      }
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines;
}

export function textHeight(
  lines: number,
  fontSize: number,
  lineHeightFactor: number,
): number {
  return Math.max(fontSize * 0.6, lines * fontSize * lineHeightFactor + fontSize * 0.6);
}

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

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}
