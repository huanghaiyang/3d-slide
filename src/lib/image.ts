import { LIMITS } from './constants';

export interface ImageFileResult {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  decoded: boolean;
  error?: string;
}

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

export function isAcceptedImage(file: File): boolean {
  return ACCEPTED_TYPES.includes(file.type.toLowerCase());
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function decode(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

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
    return {
      src,
      naturalWidth: 1600,
      naturalHeight: 900,
      decoded: false,
      error: '图片解码失败，将以占位图显示',
    };
  }
}
