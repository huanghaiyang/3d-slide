/**
 * svg.ts —— SVG 文件读取与原始尺寸推断
 *
 * SVG 是矢量格式，没有天然的「像素尺寸」，但编辑器需要按宽高比放置对象。
 * 本模块按以下优先级推断尺寸：
 * 1. 根节点显式的 width / height（仅接受纯数字或 px 单位）；
 * 2. viewBox 的宽高（若只给了 width 或 height，则按 viewBox 比例补全另一边）；
 * 3. 只有单边尺寸时按正方形处理；
 * 4. 全部缺失时退回 800x600 的占位尺寸。
 *
 * 文件以 data URL 形式返回，内容同时校验包含 <svg> 根节点，避免误把普通 XML
 * 当作矢量图导入。
 */

import { LIMITS } from './constants';
import { formatBytes } from './image';

/** SVG 读取结果：src 为 data URL，尺寸为推断后的逻辑像素宽高。 */
export interface SvgFileResult {
  /** base64 data URL，可直接用于 <img> 或 Three.js 纹理加载器 */
  src: string;
  /** 推断出的原始宽度，至少为 1 */
  naturalWidth: number;
  /** 推断出的原始高度，至少为 1 */
  naturalHeight: number;
}

/**
 * 判断文件是否为 SVG。
 *
 * 优先看 MIME 类型；某些系统 / 浏览器给出空类型，因此再按 .svg 扩展名兜底。
 *
 * @param file 待检查的文件
 * @returns 是否为 SVG 文件
 */
export function isSvgFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === 'image/svg+xml') return true;
  return file.name.toLowerCase().endsWith('.svg');
}

/**
 * 用 FileReader 把 SVG 读取为 data URL（保留原始二进制 / 文本编码）。
 *
 * @param file 待读取文件
 * @returns data URL 字符串
 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 用 FileReader 把 SVG 读取为纯文本，用于解析根节点属性。
 *
 * @param file 待读取文件
 * @returns SVG 源码文本
 */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

/**
 * 从 SVG 源码中解析根节点的 width / height / viewBox，推断逻辑尺寸。
 *
 * 使用 DOMParser 而非正则，能正确处理命名空间与属性顺序；解析失败或根节点
 * 不是 <svg> 时返回 null。尺寸解析规则见文件头注释。
 *
 * @param text SVG 源码
 * @returns 推断出的宽高；无法推断时返回 null
 */
function sizeFromMarkup(text: string): { width: number; height: number } | null {
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') return null;
    // 只接受 "数字" 或 "数字px"；百分比、em 等相对单位无法在没有上下文时换算，视为缺失
    const numeric = (value: string | null) => {
      if (!value) return 0;
      const match = /^(\d+(?:\.\d+)?)(px)?$/.exec(value.trim());
      return match ? Number(match[1]) : 0;
    };
    const width = numeric(root.getAttribute('width'));
    const height = numeric(root.getAttribute('height'));
    if (width > 0 && height > 0) return { width, height };
    // viewBox 形如 "minX minY width height"，后两个值才是内容尺寸
    const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number);
    if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
      if (width > 0) return { width, height: width * (viewBox[3] / viewBox[2]) };
      if (height > 0) return { width: height * (viewBox[2] / viewBox[3]), height };
      return { width: viewBox[2], height: viewBox[3] };
    }
    // 只有单边尺寸时按正方形处理，避免出现 0 值导致对象不可见
    if (width > 0) return { width, height: width };
    if (height > 0) return { width: height, height };
  } catch {
    return null;
  }
  return null;
}

/**
 * 读取并校验用户选择的 SVG 文件。
 *
 * 依次校验类型、体积与内容（必须包含 <svg>），随后推断尺寸并读取 data URL。
 * 类型 / 体积 / 内容不合法时抛出异常；尺寸无法推断时使用 800x600 占位。
 * 宽高会四舍五入并保证不小于 1，避免出现零尺寸对象。
 *
 * @param file 用户选择的 SVG 文件
 * @returns data URL 与推断尺寸
 * @throws 非 SVG、超过体积上限或缺少 svg 根节点时抛出错误
 */
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
