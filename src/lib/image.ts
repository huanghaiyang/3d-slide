/**
 * image.ts —— 图片文件读取与校验
 *
 * 用户通过文件选择 / 拖拽添加图片时，本模块负责：
 * 1. 按 MIME 类型白名单校验（PNG / JPEG / WebP / GIF）；
 * 2. 校验文件体积上限；
 * 3. 读取为 data URL（便于随作品一起持久化，不依赖外部文件路径）；
 * 4. 解码获得原始像素尺寸，用于按宽高比计算默认显示尺寸。
 *
 * 若浏览器无法解码（例如文件损坏或编码不受支持），仍返回 data URL，
 * 但使用 1600x900 的占位尺寸并标记 decoded=false，由界面显示占位内容。
 */

import { LIMITS } from './constants';

/**
 * 图片读取结果。
 * src 为可直接用于 img / 纹理的 data URL；naturalWidth / naturalHeight 为原始像素尺寸。
 */
export interface ImageFileResult {
  /** base64 data URL，可直接赋给 <img> 或 Three.js 纹理加载器 */
  src: string;
  /** 原始像素宽度；解码失败时为占位值 1600 */
  naturalWidth: number;
  /** 原始像素高度；解码失败时为占位值 900 */
  naturalHeight: number;
  /** 是否成功解码；false 表示尺寸是占位值，需按占位图展示 */
  decoded: boolean;
  /** 解码失败时的提示文案；成功时不存在 */
  error?: string;
}

/** 允许导入的图片 MIME 类型白名单（统一转小写后比较）。 */
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

/**
 * 判断文件是否为受支持的图片类型。
 *
 * 仅按 MIME 类型判断，不检查扩展名；浏览器给不出类型的文件会被拒绝。
 *
 * @param file 待检查的文件
 * @returns 是否属于图片白名单
 */
export function isAcceptedImage(file: File): boolean {
  return ACCEPTED_TYPES.includes(file.type.toLowerCase());
}

/**
 * 把字节数格式化为便于阅读的 B / KB / MB 字符串（保留一位小数）。
 *
 * 用于错误提示与上传信息展示；不做本地化数字格式化。
 *
 * @param bytes 字节数
 * @returns 形如 "512 B"、"1.5 KB"、"20.0 MB" 的字符串
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 用 FileReader 把文件读取为 data URL。
 *
 * 使用 Promise 包装回调式 API；读取失败时 reject 一个中文错误。
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
 * 通过 <img> 解码 data URL，获取原始像素尺寸。
 *
 * 只创建一次 Image 对象、不插入 DOM；依赖 onload / onerror 回调。
 * 浏览器会缓存同一 data URL 的解码结果，因此后续渲染通常无需再次解码。
 *
 * @param src 图片 data URL
 * @returns 原始宽高（naturalWidth / naturalHeight）
 */
function decode(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

/**
 * 读取并校验用户选择的图片文件。
 *
 * 处理顺序：类型校验 -> 体积校验 -> 读取 data URL -> 解码尺寸。
 * 类型或体积不合法时抛出异常（由调用方转为提示），不会产生副作用。
 * 解码失败不抛出，而是降级为占位尺寸并附带 error 文案。
 *
 * @param file 用户选择的文件
 * @returns 包含 data URL 与原始尺寸的结果
 * @throws 文件类型不支持或超过体积上限时抛出错误
 */
export async function readImageFile(file: File): Promise<ImageFileResult> {
  if (!isAcceptedImage(file)) {
    throw new Error('不支持的文件类型，请选择 PNG / JPG / WebP / GIF');
  }
  if (file.size > LIMITS.imageBytes) {
    throw new Error(`图片超过 ${formatBytes(LIMITS.imageBytes)} 上限（当前 ${formatBytes(file.size)}）`);
  }
  const src = await readAsDataUrl(file);
  try {
    const dims = await decode(src);
    return { src, naturalWidth: dims.width, naturalHeight: dims.height, decoded: true };
  } catch {
    // 浏览器无法解码：保留图片数据，用 16:9 占位尺寸避免布局出现 0 宽高
    return {
      src,
      naturalWidth: 1600,
      naturalHeight: 900,
      decoded: false,
      error: '图片解码失败，将以占位图显示',
    };
  }
}
