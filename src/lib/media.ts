import type { MediaKind } from '../types';
import { LIMITS } from './constants';
import { formatBytes } from './image';

export interface MediaFileResult {
  kind: MediaKind;
  src: string;
  /** 秒 */
  duration: number;
  width: number;
  height: number;
  error?: string;
}

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', 'ogg', 'flv', 'wmv', 'mpeg', 'mpg', '3gp'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'oga', 'ogg', 'opus', 'weba', 'wma'];

export function isAcceptedMedia(file: File): boolean {
  return mediaKindOf(file) !== null;
}

export function mediaKindOf(file: File): MediaKind | null {
  const type = file.type.toLowerCase();
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  return null;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  ok: boolean;
}

function probeVideo(src: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let settled = false;
    const done = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      video.removeAttribute('src');
      video.load();
      resolve(result);
    };
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

function probeAudio(src: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const done = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
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
    width: probe.width || 1280,
    height: probe.height || 720,
    error: probe.ok ? undefined : '浏览器无法解析该文件，可能缺少对应解码器，已用占位卡显示',
  };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
