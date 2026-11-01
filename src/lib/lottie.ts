import type { AnimationConfigWithData, AnimationItem } from 'lottie-web';
import { LIMITS } from './constants';
import { formatBytes } from './image';

export function isLottieName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'json' || ext === 'lottie';
}

export function isLottieFile(file: File): boolean {
  return isLottieName(file.name);
}

export interface LottiePayload {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  duration: number;
}

export interface LottieDocument {
  w?: number;
  h?: number;
  ip?: number;
  op?: number;
  fr?: number;
  layers?: unknown[];
}

/** 解析 Lottie JSON 文本并校验必要字段 */
export function parseLottieDocument(text: string): LottieDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const document = raw as LottieDocument;
  if (!Array.isArray(document.layers)) return null;
  return document;
}

/** 从 data URL 或纯 JSON 文本中解析 Lottie 数据 */
export function parseLottieSource(src: string): LottieDocument | null {
  if (!src) return null;
  try {
    if (src.startsWith('data:')) {
      const comma = src.indexOf(',');
      if (comma < 0) return null;
      const head = src.slice(0, comma);
      const body = src.slice(comma + 1);
      const text = head.includes('base64') ? atob(body) : decodeURIComponent(body);
      return parseLottieDocument(text);
    }
    return parseLottieDocument(src);
  } catch {
    return null;
  }
}

export function lottieSize(document: LottieDocument): { width: number; height: number; duration: number } {
  const width = Math.max(1, Math.round(Number(document.w) || 0));
  const height = Math.max(1, Math.round(Number(document.h) || 0));
  const fr = Number(document.fr) || 30;
  const start = Number(document.ip) || 0;
  const end = Number(document.op) || start + fr;
  return { width, height, duration: Math.max(0, (end - start) / fr) };
}

export async function readLottieFile(file: File): Promise<LottiePayload> {
  if (file.size > LIMITS.mediaBytes) {
    throw new Error(`Lottie 文件超过 ${formatBytes(LIMITS.mediaBytes)} 上限（当前 ${formatBytes(file.size)}）`);
  }
  const text = await file.text();
  const document = parseLottieDocument(text);
  if (!document) throw new Error('不是有效的 Lottie JSON 文件（缺少 layers）');
  if (!Number(document.w) || !Number(document.h)) throw new Error('Lottie 文件缺少画布尺寸（w / h）');
  const size = lottieSize(document);
  const encoded = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
  return {
    src: encoded,
    naturalWidth: size.width,
    naturalHeight: size.height,
    duration: size.duration,
  };
}

/** 用离屏 canvas 渲染 Lottie 第一帧，返回 PNG dataURL（失败时返回空串） */
export async function renderLottieThumbnail(src: string, max = 480): Promise<string> {
  const data = parseLottieSource(src);
  if (!data) return '';
  const width = Math.max(1, Number(data.w) || 0);
  const height = Math.max(1, Number(data.h) || 0);
  const scale = Math.min(1, max / Math.max(width, height));
  let animation: AnimationItem | null = null;
  try {
    const { default: lottie } = await import('lottie-web');
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return '';
    let failed = false;
    animation = lottie.loadAnimation<'canvas'>({
      renderer: 'canvas',
      loop: false,
      autoplay: false,
      animationData: data,
      rendererSettings: {
        context,
        clearCanvas: true,
        preserveAspectRatio: 'xMidYMid meet',
      },
      // 与舞台一致：不传 container，直接绘制到传入的 context
    } as unknown as AnimationConfigWithData<'canvas'>);
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      animation!.addEventListener('DOMLoaded', done);
      animation!.addEventListener('data_failed', () => {
        failed = true;
        done();
      });
      animation!.addEventListener('error', () => {
        failed = true;
        done();
      });
      window.setTimeout(done, 1200);
    });
    if (failed) return '';
    animation.goToAndStop(0, true);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  } finally {
    animation?.destroy();
  }
}
