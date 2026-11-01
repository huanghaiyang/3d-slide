export interface VideoFormat {
  id: string;
  label: string;
  mime: string;
  ext: string;
}

/** 按浏览器 MediaRecorder 实际支持能力枚举可导出编码格式 */
export function availableVideoFormats(): VideoFormat[] {
  const candidates: VideoFormat[] = [
    { id: 'mp4-h264', label: 'MP4 · H.264', mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4' },
    { id: 'mp4', label: 'MP4', mime: 'video/mp4', ext: 'mp4' },
    { id: 'webm-vp9', label: 'WebM · VP9', mime: 'video/webm;codecs=vp9', ext: 'webm' },
    { id: 'webm-vp8', label: 'WebM · VP8', mime: 'video/webm;codecs=vp8', ext: 'webm' },
    { id: 'webm', label: 'WebM', mime: 'video/webm', ext: 'webm' },
    { id: 'mkv-h264', label: 'MKV · H.264', mime: 'video/x-matroska;codecs=avc1', ext: 'mkv' },
    { id: 'mkv', label: 'MKV', mime: 'video/x-matroska', ext: 'mkv' },
    { id: 'ogv', label: 'OGG · Theora', mime: 'video/ogg', ext: 'ogv' },
  ];
  if (typeof MediaRecorder === 'undefined') return [];
  const supported = candidates.filter((format) => {
    try {
      return MediaRecorder.isTypeSupported(format.mime);
    } catch {
      return false;
    }
  });
  // 去掉重复扩展名中较弱的候选，保留首个（编码更明确的）
  const seen = new Set<string>();
  return supported.filter((format) => {
    if (seen.has(format.mime)) return false;
    seen.add(format.mime);
    return true;
  });
}

export function supportsPngSequence(): boolean {
  return typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
}

function sanitizeFilename(title: string): string {
  const clean = title.replace(/[/\\:*?"<>|\s]+/g, '_').slice(0, 40);
  return clean || 'deck';
}

export function filenameFor(title: string, ext: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return `${sanitizeFilename(title)}_${stamp}.${ext}`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

interface RecordOptions {
  mime: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
  onFrame?: (elapsed: number) => void;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/** 实时录制画布（MediaRecorder），帧由 onFrame 驱动 */
export async function recordCanvas(canvas: HTMLCanvasElement, options: RecordOptions): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持视频录制');
  const stream = canvas.captureStream(options.fps);
  const bitrate = Math.round(options.width * options.height * options.fps * 0.14);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: options.mime,
      videoBitsPerSecond: Math.max(1_500_000, Math.min(40_000_000, bitrate)),
    });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error instanceof Error ? error : new Error('无法创建视频编码器');
  }
  const chunks: Blob[] = [];
  const stopped = new Promise<Blob>((resolve) => {
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      resolve(new Blob(chunks, { type: recorder.mimeType || options.mime }));
    });
  });
  recorder.start(200);
  const startedAt = performance.now();
  await new Promise<void>((resolve) => {
    const step = () => {
      const elapsed = Math.min(options.duration, (performance.now() - startedAt) / 1000);
      options.onFrame?.(elapsed);
      options.onProgress?.(Math.min(1, elapsed / Math.max(0.01, options.duration)));
      if (options.signal?.aborted || elapsed >= options.duration) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  if (recorder.state !== 'inactive') recorder.stop();
  stream.getTracks().forEach((track) => track.stop());
  return stopped;
}

/* ----------------------------- PNG 序列 ZIP ----------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files: { name: string; data: Uint8Array }[]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.data.length, true);
    view.setUint32(22, file.data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, file.data);

    const entry = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(8, 0, true);
    entryView.setUint16(10, 0, true);
    entryView.setUint16(12, 0, true);
    entryView.setUint16(14, 0, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, file.data.length, true);
    entryView.setUint32(24, file.data.length, true);
    entryView.setUint16(28, nameBytes.length, true);
    entryView.setUint16(30, 0, true);
    entryView.setUint16(32, 0, true);
    entryView.setUint16(34, 0, true);
    entryView.setUint16(36, 0, true);
    entryView.setUint32(38, 0, true);
    entryView.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);
    offset += local.length + file.data.length;
  }
  let centralSize = 0;
  for (const entry of central) centralSize += entry.length;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);
  return new Blob([...parts, ...central, end] as unknown as BlobPart[], { type: 'application/zip' });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('无法读取画布帧'));
        return;
      }
      blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)))
        .catch(reject);
    }, 'image/png');
  });
}

interface SequenceOptions {
  fps: number;
  duration: number;
  onFrame: (time: number) => void;
  onProgress?: (ratio: number, frame: number, total: number) => void;
  signal?: AbortSignal;
}

/** 逐帧渲染 PNG 序列并打包 ZIP（离线、不实时） */
export async function renderPngSequence(
  canvas: HTMLCanvasElement,
  options: SequenceOptions,
): Promise<{ blob: Blob; frames: number; width: number; height: number }> {
  const total = Math.max(1, Math.min(1800, Math.round(options.fps * options.duration)));
  const files: { name: string; data: Uint8Array }[] = [];
  for (let index = 0; index < total; index += 1) {
    if (options.signal?.aborted) break;
    options.onFrame(index / options.fps);
    options.onProgress?.(index / total, index + 1, total);
    const data = await canvasToPng(canvas);
    files.push({ name: `frame_${String(index).padStart(4, '0')}.png`, data });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (files.length === 0) throw new Error('已取消导出');
  const blob = zipStore(files);
  return {
    blob,
    frames: files.length,
    width: canvas.width,
    height: canvas.height,
  };
}
