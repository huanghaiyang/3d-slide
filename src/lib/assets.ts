/**
 * assets.ts —— 资源库的类型定义与文件解析
 *
 * 职责：
 * - 定义资源元数据（AssetMeta）、文件夹（AssetFolder）与读取结果（AssetPayload）结构；
 * - 根据文件类型分派到 image / svg / media / lottie / model 的读取器，
 *   生成统一的 dataURL 内容与尺寸 / 时长 / 缩略图元数据；
 * - 提供文件名、后缀、大小格式化与文件夹层级（面包屑 / 后代集合）等工具函数。
 *
 * 关键概念：
 * - 资源内容统一以 dataURL 保存在 src 中，元数据与内容在 IndexedDB 中分表存储；
 * - 缩略图 thumb 是小尺寸 JPEG dataURL，用于资源列表快速预览；
 * - 删除采用软删除（deletedAt 时间戳），回收站清空时才真正删除内容；
 * - 文件夹通过 parentId 组成树，父节点缺失时资源回退到根目录。
 *
 * 异步与错误：readAssetFile 会等待文件读取 / 视频抓帧 / Lottie 解析完成；
 * 超过 LIMITS.mediaBytes 的普通文件直接抛错，其余读取失败多数降级为空缩略图。
 */

import type { ModelFormat } from '../types';
import { LIMITS } from './constants';
import { formatBytes, isAcceptedImage, readImageFile } from './image';
import { readLottieFile, renderLottieThumbnail } from './lottie';
import { mediaKindOf, readMediaFile } from './media';
import { modelFormatOf } from './model3d';
import { isSvgFile, readSvgFile } from './svg';

/** 资源种类：决定可用哪种对象形式放到画布上，以及列表筛选分组。 */
export type AssetKind = 'image' | 'video' | 'audio' | 'model' | 'lottie' | 'file';

/**
 * 资源元数据（不含内容本体）。
 * 内容本体单独存放在 assetData 表，避免列表查询时读取大字段。
 */
export interface AssetMeta {
  /** 资源唯一 id。 */
  id: string;
  /** 文件名（含后缀），也用于按名称搜索。 */
  name: string;
  /** 资源种类。 */
  kind: AssetKind;
  /** MIME 类型，例如 image/png；部分文件可能为空字符串。 */
  mime: string;
  /** 小写后缀（不含点），例如 png / mp4。 */
  ext: string;
  /** 文件字节数。 */
  size: number;
  /** 所属文件夹 id；null 表示根目录。 */
  folderId: string | null;
  /** 首次导入时间（毫秒）。 */
  createdAt: number;
  /** 最后修改（重命名 / 移动 / 回收）时间（毫秒）。 */
  updatedAt: number;
  /** 像素宽；非媒体类可能为 0。 */
  width: number;
  /** 像素高；非媒体类可能为 0。 */
  height: number;
  /** 秒，仅视频/音频 */
  duration: number;
  /** 小尺寸预览图（dataURL） */
  thumb: string;
  /** 软删除时间戳；null 表示未删除。 */
  deletedAt: number | null;
  /** 3D 模型格式（仅 kind === 'model' 时存在）。 */
  format?: ModelFormat;
}

/** 资源文件夹：通过 parentId 组成可嵌套的树。 */
export interface AssetFolder {
  /** 文件夹唯一 id。 */
  id: string;
  /** 文件夹名称。 */
  name: string;
  /** 父文件夹 id；null 表示根目录。 */
  parentId: string | null;
  /** 创建时间（毫秒）。 */
  createdAt: number;
}

/**
 * 读取单个文件后的结果。
 * id / 归属目录 / 时间戳等由调用方（资源库 store）补充，文件读取器只负责内容与固有属性。
 */
export interface AssetPayload {
  /** 资源内容（dataURL）。 */
  src: string;
  /** 由文件本身推导出的元数据（不含 id、文件夹与生命周期字段）。 */
  meta: Omit<AssetMeta, 'id' | 'folderId' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
}

/** 资源种类 -> 中文显示名，用于资源库分组标题。 */
export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  model: '3D 模型',
  lottie: 'Lottie 动画',
  file: '文件',
};

/** 资源库列表中的分组顺序（图片优先，普通文件最后）。 */
export const ASSET_KIND_ORDER: AssetKind[] = ['image', 'video', 'audio', 'model', 'lottie', 'file'];

/**
 * 用 FileReader 把文件读成 dataURL。
 *
 * @param file 浏览器 File 对象
 * @returns dataURL 字符串
 * @throws 读取失败时抛出「文件读取失败」
 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 取文件名；浏览器偶发空文件名时回退「未命名资源」。 */
function fileNameOf(file: File): string {
  return file.name || '未命名资源';
}

/** 取小写后缀（不含点）；没有后缀时返回空字符串。 */
function extOf(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase();
}

/**
 * 根据文件特征判断资源种类。
 *
 * 判定顺序（先命中先返回）：
 * 1. SVG 与常见图片 -> image；
 * 2. 可识别的 3D 模型后缀 -> model；
 * 3. 后缀为 lottie -> lottie；
 * 4. 可识别的音视频 MIME / 后缀 -> video / audio；
 * 5. 其他一律为 file（仍可导入，但不能直接作为对象放置）。
 *
 * @param file 浏览器 File 对象
 * @returns 资源种类
 */
export function assetKindOf(file: File): AssetKind {
  if (isSvgFile(file)) return 'image';
  if (isAcceptedImage(file)) return 'image';
  if (modelFormatOf(file.name)) return 'model';
  if (extOf(file.name) === 'lottie') return 'lottie';
  const media = mediaKindOf(file);
  if (media) return media;
  return 'file';
}

/**
 * 生成图片缩略图（JPEG dataURL）。
 *
 * @param src 图片地址（dataURL）
 * @param max 缩略图最长边像素上限，默认 360
 * @returns JPEG dataURL（质量 0.72）；加载 / 绘制失败时返回空字符串（不抛错）
 *
 * 绘制前按比例缩放，避免把大图直接塞进缩略图；canvas 使用 2D 上下文并检查其可用性。
 */
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

/**
 * 从视频中抓取首帧缩略图，并顺带探测时长与分辨率。
 *
 * @param src     视频地址（dataURL / object URL）
 * @param max     缩略图最长边像素上限，默认 360
 * @param timeout 抓帧超时（毫秒），默认 6 秒；超时返回空缩略图但保留已探测的元数据
 * @returns 缩略图（JPEG dataURL）与 duration / width / height；失败时字段降级为 0
 *
 * 流程：静音预加载 -> loadeddata 后 seek 到 0.4 秒或视频中点（避开纯黑首帧）
 * -> seeked 时 drawImage 到 canvas -> toDataURL。finish 用 settled 保证只结算一次，
 * 并清理定时器与 video 的 src，避免媒体元素长期占用资源。
 */
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

/** 无尺寸 / 时长 / 缩略图时的元数据默认值，用于普通文件与无法探测的资源。 */
const emptyMeta = {
  width: 0,
  height: 0,
  duration: 0,
  thumb: '',
};

/**
 * 读取任意资源文件并生成统一的结果。
 *
 * @param file 用户选择 / 拖入的 File
 * @returns src（dataURL）与元数据；kind 会按文件特征自动判定
 * @throws 视频 / 音频等普通文件超过 LIMITS.mediaBytes 时抛出带体积提示的错误；
 *         Lottie 文件解析失败且明确标记为 lottie 时向上抛出
 *
 * 分派逻辑：
 * - image：SVG 与位图分别读取，再生成缩略图；
 * - video：读取内容后额外抓取首帧，优先采用抓帧得到的尺寸 / 时长；
 * - audio：只探测时长，无缩略图；
 * - lottie：解析 JSON 动画，失败时若原本被判定为 lottie 则报错，否则继续按普通文件处理；
 * - 其他：检查体积后整体读成 dataURL，模型会额外记录 format。
 */
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
  // 后缀为 .lottie 或 .json 的文件先尝试按 Lottie 解析；失败时普通 JSON 允许继续按文件导入
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

/** 把资源大小格式化为人类可读字符串（例如「1.2 MB」）。 */
export function formatAssetSize(asset: AssetMeta): string {
  return formatBytes(asset.size);
}

/**
 * 生成文件夹面包屑路径（从根到当前文件夹）。
 *
 * @param folders 全部文件夹
 * @param id      当前文件夹 id；null 表示根目录，返回空数组
 * @returns 按从根到当前的顺序排列的文件夹数组
 *
 * 通过 guard < 32 限制最大深度，防止 parentId 形成环时死循环；
 * 若中间某个父节点缺失，则提前截断（返回已收集到的部分路径）。
 */
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

/**
 * 收集某个文件夹及其全部后代文件夹的 id（用于删除目录树 / 递归筛选资源）。
 *
 * @param folders 全部文件夹
 * @param rootId  根文件夹 id
 * @returns id 数组，包含 rootId 本身；采用深度优先遍历
 *
 * 注意：若数据中存在环，可能重复访问，调用方需保证文件夹树结构合法。
 */
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
