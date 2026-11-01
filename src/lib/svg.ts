import { LIMITS } from './constants';
import { formatBytes } from './image';

export interface SvgFileResult {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
}

export function isSvgFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === 'image/svg+xml') return true;
  return file.name.toLowerCase().endsWith('.svg');
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

function sizeFromMarkup(text: string): { width: number; height: number } | null {
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') return null;
    const numeric = (value: string | null) => {
      if (!value) return 0;
      const match = /^(\d+(?:\.\d+)?)(px)?$/.exec(value.trim());
      return match ? Number(match[1]) : 0;
    };
    const width = numeric(root.getAttribute('width'));
    const height = numeric(root.getAttribute('height'));
    if (width > 0 && height > 0) return { width, height };
    const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number);
    if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
      if (width > 0) return { width, height: width * (viewBox[3] / viewBox[2]) };
      if (height > 0) return { width: height * (viewBox[2] / viewBox[3]), height };
      return { width: viewBox[2], height: viewBox[3] };
    }
    if (width > 0) return { width, height: width };
    if (height > 0) return { width: height, height };
  } catch {
    return null;
  }
  return null;
}

export async function readSvgFile(file: File): Promise<SvgFileResult> {
  if (!isSvgFile(file)) throw new Error('不是有效的 SVG 文件');
  if (file.size > LIMITS.imageBytes) {
    throw new Error(`SVG 超过 ${formatBytes(LIMITS.imageBytes)} 上限（当前 ${formatBytes(file.size)}）`);
  }
  const text = await readAsText(file);
  if (!text.includes('<svg')) throw new Error('SVG 文件缺少 svg 根节点');
  const size = sizeFromMarkup(text) ?? { width: 800, height: 600 };
  const src = await readAsDataUrl(file);
  return {
    src,
    naturalWidth: Math.max(1, Math.round(size.width)),
    naturalHeight: Math.max(1, Math.round(size.height)),
  };
}
