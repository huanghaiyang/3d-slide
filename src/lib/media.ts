/**
 * media.ts —— 视频 / 音频文件读取与元数据探测
 *
 * 用户导入媒体时，本模块负责：
 * 1. 识别媒体类型：优先看 MIME（video/、audio/），不识别时再按扩展名兜底；
 * 2. 校验体积上限，并读取为 data URL（随作品持久化）；
 * 3. 用浏览器内置的 video / audio 元素探测时长与视频分辨率（10000ms 超时）；
 * 4. 探测失败时仍保留文件，用 1280x720 的占位尺寸与 error 文案降级展示。
 *
 * 注意：data URL 形式的媒体没有真实网络地址，探测依赖浏览器能否解码该容器 /
 * 编码；缺少解码器时 onerror 会立即触发，不会无限等待。
 */

import type { MediaKind } from '../types';
import { LIMITS } from './constants';
import { formatBytes } from './image';

/** 媒体读取结果：duration 单位为秒；音频没有画面尺寸，读取时会补默认占位宽高。 */
export interface MediaFileResult {
  /** 媒体类型：video 或 audio */
  kind: MediaKind;
  /** base64 data URL，可直接用于 <video> / <audio> 或 Three.js 纹理源 */
  src: string;
  /** 秒 */
  duration: number;
  /** 视频像素宽度；探测不到或音频时使用默认值 1280 */
  width: number;
  /** 视频像素高度；探测不到或音频时使用默认值 720 */
  height: number;
  /** 探测失败时的提示文案；成功时不存在 */
  error?: string;
}

/** 视频扩展名兜底列表（部分系统无法为这些格式提供 MIME 类型）。 */
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', 'ogg', 'flv', 'wmv', 'mpeg', 'mpg', '3gp'];
/** 音频扩展名兜底列表；ogg 同时出现在视频与音频中，按 MIME 优先区分。 */
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'oga', 'ogg', 'opus', 'weba', 'wma'];

/**
 * 判断文件是否为可导入的媒体文件。
 *
 * @param file 待检查的文件
 * @returns 能识别为 video 或 audio 时为 true
 */
export function isAcceptedMedia(file: File): boolean {
  return mediaKindOf(file) !== null;
}

/**
 * 判断文件属于视频还是音频。
 *
 * 先按 MIME 前缀判断（最可靠）；MIME 缺失或为通用类型时再按扩展名查表。
 * 无法识别时返回 null，由调用方提示用户。
 *
 * @param file 待检查的文件
 * @returns 'video' / 'audio' / null
 */
export function mediaKindOf(file: File): MediaKind | null {
  const type = file.type.toLowerCase();
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  return null;
}

/**
 * 用 FileReader 把媒体文件读取为 data URL。
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
 * 媒体元数据探测结果。
 * ok=false 表示浏览器无法读取元数据，此时尺寸使用占位值、时长为 0。
 */
interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  ok: boolean;
}

/**
 * 探测视频的时长与分辨率。
 *
 * 创建游离的 <video>（不插入 DOM），仅加载 metadata；无论成功、失败还是超时，
 * 都会通过 done 只结算一次，并清空 src 释放解码资源。10 秒超时用于防止某些
 * 浏览器在损坏文件上既不触发 loadedmetadata 也不触发 error。
 *
 * @param src 视频 data URL
 * @returns 探测结果；失败时 duration=0、尺寸为 1280x720、ok=false
 */
function probeVideo(src: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let settled = false;
    const done = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      // 清空 src 并重新 load，通知浏览器停止解码并释放该视频占用的资源
      video.removeAttribute('src');
      video.load();
      resolve(result);
    };
    // 10 秒兜底：部分损坏文件可能既不触发 loadedmetadata 也不触发 error
    const timer = window.setTimeout(
      () => done({ duration: 0, width: 1280, height: 720, ok: false }),
      10000,
    );
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      done({
        duration: Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0,
        width: video.videoWidth || 1280,
        height: video.videoHeight || 720,
        ok: true,
      });
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      done({ duration: 0, width: 1280, height: 720, ok: false });
    };
    video.src = src;
  });
}

/**
 * 探测音频的时长。
 *
 * 与 probeVideo 相同的单次结算与超时保护；音频没有画面，宽高固定为 0。
 * 结束后同样移除 src，避免浏览器继续持有已解码的媒体资源。
 *
 * @param src 音频 data URL
 * @returns 探测结果；失败时 duration=0、尺寸为 0、ok=false
 */
function probeAudio(src: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const done = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      // 音频没有视觉资源，但仍需移除 src，避免解码器持有整个 data URL
      audio.removeAttribute('src');
      resolve(result);
    };
    const timer = window.setTimeout(() => done({ duration: 0, width: 0, height: 0, ok: false }), 10000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      window.clearTimeout(timer);
      done({
        duration: Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : 0,
        width: 0,
        height: 0,
        ok: true,
      });
    };
    audio.onerror = () => {
      window.clearTimeout(timer);
      done({ duration: 0, width: 0, height: 0, ok: false });
    };
    audio.src = src;
  });
}

/**
 * 读取并校验用户选择的媒体文件。
 *
 * 依次校验类型、体积 -> 读取 data URL -> 探测元数据 -> 补全默认值。
 * 无法识别类型或超过体积上限时抛出异常；探测失败不抛出，而是返回占位尺寸
 * 与 error 文案，让用户仍能把文件放到画布上（以占位卡展示）。
 *
 * @param file 用户选择的视频或音频文件
 * @returns 类型、data URL、时长与尺寸信息
 * @throws 类型不支持或超过体积上限时抛出错误
 */
export async function readMediaFile(file: File): Promise<MediaFileResult> {
  const kind = mediaKindOf(file);
  if (!kind) {
    throw new Error('不支持的文件类型，请选择视频或音频文件');
  }
  if (file.size > LIMITS.mediaBytes) {
    throw new Error(`媒体超过 ${formatBytes(LIMITS.mediaBytes)} 上限（当前 ${formatBytes(file.size)}）`);
  }
  const src = await readAsDataUrl(file);
  const probe = kind === 'video' ? await probeVideo(src) : await probeAudio(src);
  return {
    kind,
    src,
    duration: probe.duration,
    // 探测结果缺少尺寸时退回 16:9 占位尺寸；音频也沿用该默认值，便于统一对象尺寸
    width: probe.width || 1280,
    height: probe.height || 720,
    error: probe.ok ? undefined : '浏览器无法解析该文件，可能缺少对应解码器，已用占位卡显示',
  };
}

/**
 * 把秒数格式化为 "mm:ss"（用于媒体时长展示）。
 *
 * 非有限值或非正数统一显示 "--:--"；分钟不封顶（超过 60 分钟时继续累加）。
 *
 * @param seconds 时长（秒）
 * @returns 形如 "03:25" 的字符串，或 "--:--"
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
