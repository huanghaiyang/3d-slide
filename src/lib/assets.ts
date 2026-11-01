import type { ModelFormat } from '../types';
import { LIMITS } from './constants';
import { formatBytes, isAcceptedImage, readImageFile } from './image';
import { readLottieFile, renderLottieThumbnail } from './lottie';
import { mediaKindOf, readMediaFile } from './media';
import { modelFormatOf } from './model3d';
import { isSvgFile, readSvgFile } from './svg';

export type AssetKind = 'image' | 'video' | 'audio' | 'model' | 'lottie' | 'file';

export interface AssetMeta {
  id: string;
  name: string;
  kind: AssetKind;
  mime: string;
  ext: string;
  size: number;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  width: number;
  height: number;
  /** 秒，仅视频/音频 */
  duration: number;
  /** 小尺寸预览图（dataURL） */
  thumb: string;
  deletedAt: number | null;
  format?: ModelFormat;
}

export interface AssetFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface AssetPayload {
  src: string;
  meta: Omit<AssetMeta, 'id' | 'folderId' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
}

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  model: '3D 模型',
  lottie: 'Lottie 动画',
  file: '文件',
};

export const ASSET_KIND_ORDER: AssetKind[] = ['image', 'video', 'audio', 'model', 'lottie', 'file'];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function fileNameOf(file: File): string {
  return file.name || '未命名资源';
}

function extOf(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase();
}

export function assetKindOf(file: File): AssetKind {
  if (isSvgFile(file)) return 'image';
  if (isAcceptedImage(file)) return 'image';
  if (modelFormatOf(file.name)) return 'model';
  if (extOf(file.name) === 'lottie') return 'lottie';
  const media = mediaKindOf(file);
  if (media) return media;
  return 'file';
}

function imageThumb(src: string, max = 360): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve('');
          return;
        }
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        resolve('');
      }
    };
    image.onerror = () => resolve('');
    image.src = src;
  });
}

export function readVideoThumb(
  src: string,
  max = 360,
  timeout = 6000,
): Promise<{ thumb: string; duration: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let settled = false;
    const finish = (thumb: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      const result = {
        thumb,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
      };
      video.removeAttribute('src');
      video.load();
      resolve(result);
    };
    const timer = window.setTimeout(() => finish(''), timeout);
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.4, Number.isFinite(video.duration) ? video.duration / 2 : 0.4);
      } catch {
        finish('');
      }
    };
    video.onseeked = () => {
      try {
        const scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish('');
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        finish('');
      }
    };
    video.onerror = () => finish('');
    video.src = src;
  });
}

const emptyMeta = {
  width: 0,
  height: 0,
  duration: 0,
  thumb: '',
};

export async function readAssetFile(file: File): Promise<AssetPayload> {
  const name = fileNameOf(file);
  const kind = assetKindOf(file);
  const base = {
    name,
    kind,
    mime: file.type || '',
    ext: extOf(name),
    size: file.size,
  };
  if (kind === 'image') {
    const result = isSvgFile(file)
      ? await readSvgFile(file)
      : await readImageFile(file);
    return {
      src: result.src,
      meta: {
        ...base,
        width: result.naturalWidth,
        height: result.naturalHeight,
        duration: 0,
        thumb: await imageThumb(result.src),
      },
    };
  }
  if (kind === 'video' || kind === 'audio') {
    const result = await readMediaFile(file);
    if (kind === 'video') {
      const captured = await readVideoThumb(result.src);
      return {
        src: result.src,
        meta: {
          ...base,
          width: captured.width || result.width,
          height: captured.height || result.height,
          duration: captured.duration || result.duration,
          thumb: captured.thumb,
        },
      };
    }
    return {
      src: result.src,
      meta: { ...base, width: 0, height: 0, duration: result.duration, thumb: '' },
    };
  }
  if (kind === 'lottie' || (extOf(name) === 'json' && kind === 'file')) {
    try {
      const payload = await readLottieFile(file);
      return {
        src: payload.src,
        meta: {
          ...base,
          kind: 'lottie',
          width: payload.naturalWidth,
          height: payload.naturalHeight,
          duration: payload.duration,
          thumb: await renderLottieThumbnail(payload.src),
        },
      };
    } catch (error) {
      if (kind === 'lottie') throw error;
    }
  }
  if (file.size > LIMITS.mediaBytes) {
    throw new Error(`资源超过 ${formatBytes(LIMITS.mediaBytes)} 上限（当前 ${formatBytes(file.size)}）`);
  }
  const src = await readAsDataUrl(file);
  const format = modelFormatOf(name);
  return {
    src,
    meta: {
      ...base,
      ...emptyMeta,
      format: format ?? undefined,
    },
  };
}

export function formatAssetSize(asset: AssetMeta): string {
  return formatBytes(asset.size);
}

export function folderBreadcrumb(folders: AssetFolder[], id: string | null): AssetFolder[] {
  const map = new Map(folders.map((folder) => [folder.id, folder]));
  const result: AssetFolder[] = [];
  let current = id ? map.get(id) : undefined;
  let guard = 0;
  while (current && guard < 32) {
    result.unshift(current);
    current = current.parentId ? map.get(current.parentId) : undefined;
    guard += 1;
  }
  return result;
}

export function folderDescendantIds(folders: AssetFolder[], rootId: string): string[] {
  const ids: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    ids.push(id);
    for (const folder of folders) {
      if (folder.parentId === id) stack.push(folder.id);
    }
  }
  return ids;
}
