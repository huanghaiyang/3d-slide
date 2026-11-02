/**
 * exportVideo.ts —— 视频与 PNG 序列导出
 *
 * 职责：
 * - 枚举浏览器实际支持的视频编码格式（基于 MediaRecorder 能力探测）；
 * - 通过 canvas.captureStream + MediaRecorder 实时录制画布，产出视频 Blob；
 * - 提供 PNG 序列的离线逐帧渲染，并手写 ZIP（store 方式，不压缩）打包；
 * - 提供文件名清洗、时间戳命名与 Blob 下载等通用工具。
 *
 * 两条导出路径：
 * 1) 实时录制（recordCanvas）：按真实时间推进动画，帧由 onFrame 回调驱动，
 *    适合需要保持真实播放节奏的场景；
 * 2) 离线序列（renderPngSequence）：按 fps 逐帧推进，不受真实时间限制，
 *    可导出高帧率、播放稳定的素材，耗时与动画时长无关。
 *
 * 关键概念：
 * - MediaRecorder 支持的编码因浏览器/平台而异，必须用 isTypeSupported 探测；
 * - captureStream 的帧来自画布实际绘制，录制期间需持续重绘；
 * - ZIP 采用 store 方式（method=0），因为 PNG 本身已是压缩格式；
 * - 导出操作均支持 AbortSignal 取消。
 */

/**
 * 一种可用的视频编码格式描述。
 */
export interface VideoFormat {
  /** 内部标识，例如 mp4-h264。 */
  id: string;
  /** 展示给用户的名称，例如 "MP4 · H.264"。 */
  label: string;
  /** 传给 MediaRecorder 的 MIME 类型（可能带 codecs 参数）。 */
  mime: string;
  /** 文件扩展名，不含点。 */
  ext: string;
}

/**
 * 按浏览器 MediaRecorder 实际支持能力枚举可导出编码格式
 *
 * 候选列表按「编码明确度」排序：带具体 codecs 的格式排在通用容器格式之前，
 * 上层可直接取第一个作为默认选项。
 *
 * @returns 当前环境支持的格式；MediaRecorder 不存在（如 SSR 环境）时返回空数组
 *
 * 每个候选单独 try/catch：部分浏览器对畸形 MIME 会抛异常而不是返回 false。
 */
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

/**
 * 判断当前环境能否导出 PNG 序列（依赖 canvas.toBlob）。
 *
 * @returns 存在 document 与 HTMLCanvasElement 时返回 true；非浏览器环境返回 false
 */
export function supportsPngSequence(): boolean {
  return typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
}

/**
 * 清洗作品标题，得到可安全用作文件名的字符串。
 *
 * @param title 原始标题
 * @returns 路径分隔符、Windows 保留字符与各类空白替换为下划线，并截断到 40 字符；
 *          清洗后为空时回退为 'deck'
 */
function sanitizeFilename(title: string): string {
  const clean = title.replace(/[/\\:*?"<>|\s]+/g, '_').slice(0, 40);
  return clean || 'deck';
}

/**
 * 生成带时间戳的导出文件名，避免多次导出互相覆盖。
 *
 * @param title 作品标题（会先经过 sanitizeFilename 清洗）
 * @param ext   扩展名，不含点
 * @returns 形如 `我的作品_20260101-0930.mp4`；时间戳取本地时间的 YYYYMMDD-HHmm
 */
export function filenameFor(title: string, ext: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return `${sanitizeFilename(title)}_${stamp}.${ext}`;
}

/**
 * 触发浏览器下载一个 Blob。
 *
 * 通过临时创建 <a download> 元素并模拟点击实现；对象 URL 延后回收，
 * 因为过早 revoke 可能导致部分浏览器下载被中断。
 *
 * @param blob     要下载的数据
 * @param filename 建议的文件名
 */
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

/**
 * 实时录制的参数。
 */
interface RecordOptions {
  /** 编码 MIME（来自 availableVideoFormats 的返回值）。 */
  mime: string;
  /** 采集帧率，传给 captureStream。 */
  fps: number;
  /** 录制总时长（秒）。 */
  duration: number;
  /** 画布宽度（像素），仅用于估算比特率。 */
  width: number;
  /** 画布高度（像素），仅用于估算比特率。 */
  height: number;
  /** 每帧回调，参数为已播放的秒数；调用方在此更新场景并重绘画布。 */
  onFrame?: (elapsed: number) => void;
  /** 进度回调，参数为 0–1 的比例。 */
  onProgress?: (ratio: number) => void;
  /** 取消信号；中止后会提前停止录制并正常返回已录制的数据。 */
  signal?: AbortSignal;
}

/**
 * 实时录制画布（MediaRecorder），帧由 onFrame 驱动
 *
 * @param canvas  需要录制的画布；录制期间必须持续重绘，否则画面会静止
 * @param options 编码 MIME、帧率、时长、画布尺寸与回调
 * @returns 录制完成后的视频 Blob
 * @throws 浏览器不支持 MediaRecorder，或编码器创建失败时抛出
 *
 * 流程：captureStream 采集画布 -> 创建 MediaRecorder -> 逐帧按真实耗时推进动画 ->
 * stop 后合并数据块。比特率按像素面积与帧率估算，并限制在合理区间。
 */
export async function recordCanvas(canvas: HTMLCanvasElement, options: RecordOptions): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持视频录制');
  const stream = canvas.captureStream(options.fps);
  // 比特率经验估算：像素总数 × 帧率 × 0.14（即每像素每帧约 0.14 bit），先算出目标值，稍后再裁剪区间
  const bitrate = Math.round(options.width * options.height * options.fps * 0.14);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: options.mime,
      // 限制在 1.5 Mbps（防止低分辨率画质过差）到 40 Mbps（防止高分辨率文件过大）
      videoBitsPerSecond: Math.max(1_500_000, Math.min(40_000_000, bitrate)),
    });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error instanceof Error ? error : new Error('无法创建视频编码器');
  }
  // 编码器会按时间片产出数据，这里先收集所有分片，等 stop 事件后再合并成一个 Blob
  const chunks: Blob[] = [];
  const stopped = new Promise<Blob>((resolve) => {
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      resolve(new Blob(chunks, { type: recorder.mimeType || options.mime }));
    });
  });
  // 参数 200 表示每 200ms 触发一次 dataavailable（间隔太小增加开销，太大则内存峰值更高）
  recorder.start(200);
  const startedAt = performance.now();
  // 用 requestAnimationFrame 驱动动画：每帧按真实流逝时间计算进度，保证录制节奏与播放一致
  await new Promise<void>((resolve) => {
    const step = () => {
      // elapsed 以秒计，并夹到 duration 以内，避免最后一帧超过总时长
      const elapsed = Math.min(options.duration, (performance.now() - startedAt) / 1000);
      options.onFrame?.(elapsed);
      // 分母取 0.01 兜底，避免 duration 为 0 时出现 Infinity / NaN
      options.onProgress?.(Math.min(1, elapsed / Math.max(0.01, options.duration)));
      // 到达终点或用户取消时结束驱动循环
      if (options.signal?.aborted || elapsed >= options.duration) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  // stop 会触发最后一次 dataavailable 与 stop 事件，因此必须等 stopped 完成后再返回
  if (recorder.state !== 'inactive') recorder.stop();
  // 释放采集轨道，避免画布持续被占用
  stream.getTracks().forEach((track) => track.stop());
  return stopped;
}

/* ----------------------------- PNG 序列 ZIP ----------------------------- */

/**
 * ZIP 所需的 CRC32 查表（256 项），模块加载时一次性生成。
 *
 * 多项式 0xedb88320 是 CRC-32/ISO-HDLC（ZIP、PNG 等格式通用）的反转表示；
 * 查表法把逐位计算简化为一次查表加异或，适合大块二进制数据。
 */
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

/**
 * 计算 CRC32 校验值（ZIP 每个条目都必须携带）。
 *
 * @param data 原始字节
 * @returns 32 位无符号校验值
 *
 * 初值与最终结果都做 0xffffffff 异或，这是 CRC-32/ISO-HDLC 的标准处理。
 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 用 store（不压缩）方式把多个文件打包成 ZIP Blob。
 *
 * @param files 文件名与字节内容列表
 * @returns application/zip 类型的 Blob
 *
 * ZIP 结构：每个文件 -> 本地文件头 + 数据；末尾依次写中央目录与结束记录。
 * 所有数值字段均按小端序写入（DataView 第三个参数 true）。
 */
function zipStore(files: { name: string; data: Uint8Array }[]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);
    // 本地文件头固定 30 字节，后面紧跟文件名
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); // 本地文件头签名（PK\x03\x04）
    view.setUint16(4, 20, true); // 需要解压的版本 2.0
    view.setUint16(6, 0, true); // 通用标志位：无加密、无数据描述符
    view.setUint16(8, 0, true); // 压缩方法 0 = store（不压缩）
    view.setUint16(10, 0, true); // 最后修改时间（未填写，保持 0）
    view.setUint16(12, 0, true); // 最后修改日期（未填写，保持 0）
    view.setUint32(14, crc, true); // CRC32 校验值
    view.setUint32(18, file.data.length, true); // 压缩后大小
    view.setUint32(22, file.data.length, true); // 原始大小（store 方式两者相同）
    view.setUint16(26, nameBytes.length, true); // 文件名长度
    view.setUint16(28, 0, true); // 扩展字段长度
    local.set(nameBytes, 30);
    parts.push(local, file.data);

    // 中央目录项固定 46 字节 + 文件名，供解压工具快速定位所有条目
    const entry = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true); // 中央目录项签名（PK\x01\x02）
    entryView.setUint16(4, 20, true); // 创建者版本 2.0
    entryView.setUint16(6, 20, true); // 解压所需版本 2.0
    entryView.setUint16(8, 0, true); // 通用标志位
    entryView.setUint16(10, 0, true); // 压缩方法 0 = store
    entryView.setUint16(12, 0, true); // 最后修改时间
    entryView.setUint16(14, 0, true); // 最后修改日期
    entryView.setUint32(16, crc, true); // CRC32 校验值
    entryView.setUint32(20, file.data.length, true); // 压缩后大小
    entryView.setUint32(24, file.data.length, true); // 原始大小
    entryView.setUint16(28, nameBytes.length, true); // 文件名长度
    entryView.setUint16(30, 0, true); // 扩展字段长度
    entryView.setUint16(32, 0, true); // 注释长度
    entryView.setUint16(34, 0, true); // 起始磁盘编号
    entryView.setUint16(36, 0, true); // 内部文件属性
    entryView.setUint32(38, 0, true); // 外部文件属性
    entryView.setUint32(42, offset, true); // 本地文件头在包内的偏移
    entry.set(nameBytes, 46);
    central.push(entry);
    // 累计已写入的字节数，作为下一个条目的本地头偏移
    offset += local.length + file.data.length;
  }
  let centralSize = 0;
  for (const entry of central) centralSize += entry.length;
  // 结束记录固定 22 字节，标明中央目录的位置与大小
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // 结束记录签名（PK\x05\x06）
  endView.setUint16(4, 0, true); // 当前磁盘编号
  endView.setUint16(6, 0, true); // 中央目录起始磁盘编号
  endView.setUint16(8, files.length, true); // 本磁盘上的条目数
  endView.setUint16(10, files.length, true); // 总条目数
  endView.setUint32(12, centralSize, true); // 中央目录总字节数
  endView.setUint32(16, offset, true); // 中央目录相对包起始的偏移
  endView.setUint16(20, 0, true); // 注释长度
  return new Blob([...parts, ...central, end] as unknown as BlobPart[], { type: 'application/zip' });
}

/**
 * 把画布当前内容编码为 PNG 字节。
 *
 * @param canvas 待读取的画布
 * @returns PNG 文件的原始字节
 * @throws 画布内容无法导出（toBlob 返回 null，例如画布被污染）时抛出「无法读取画布帧」
 */
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

/**
 * PNG 序列导出的参数。
 */
interface SequenceOptions {
  /** 目标帧率，决定总帧数与相邻帧的时间间隔。 */
  fps: number;
  /** 动画总时长（秒）。 */
  duration: number;
  /** 每帧回调，参数为该帧对应的时间点（秒）；调用方在此更新场景并重绘画布。 */
  onFrame: (time: number) => void;
  /** 进度回调：ratio 为 0–1 的完成比例，frame 为当前第几帧（从 1 起），total 为总帧数。 */
  onProgress?: (ratio: number, frame: number, total: number) => void;
  /** 取消信号；中止后停止渲染，丢弃已渲染的帧并抛出「已取消导出」。 */
  signal?: AbortSignal;
}

/**
 * 逐帧渲染 PNG 序列并打包 ZIP（离线、不实时）
 *
 * @param canvas  用于渲染的画布；每帧由 onFrame 更新内容后再读取
 * @param options 帧率、时长、帧回调与进度回调
 * @returns ZIP Blob、实际生成的帧数以及画布宽高
 * @throws 一帧都没生成（用户取消）时抛出「已取消导出」
 *
 * 与实时录制不同，这里按固定时间步长推进动画，不受真实时间影响，
 * 因此可以稳定输出高帧率素材。
 */
export async function renderPngSequence(
  canvas: HTMLCanvasElement,
  options: SequenceOptions,
): Promise<{ blob: Blob; frames: number; width: number; height: number }> {
  // 总帧数 = fps × 时长；至少 1 帧，且最多 1800 帧，避免 PNG 数据把内存撑爆
  const total = Math.max(1, Math.min(1800, Math.round(options.fps * options.duration)));
  const files: { name: string; data: Uint8Array }[] = [];
  for (let index = 0; index < total; index += 1) {
    // 用户取消后立即停止循环，已渲染的帧不再打包
    if (options.signal?.aborted) break;
    // 第 index 帧对应的时间点：index / fps（例如 30fps 时第 1 帧为 1/30 秒）
    options.onFrame(index / options.fps);
    options.onProgress?.(index / total, index + 1, total);
    const data = await canvasToPng(canvas);
    // 帧名补零到 4 位，保证文件按名称排序时顺序正确
    files.push({ name: `frame_${String(index).padStart(4, '0')}.png`, data });
    // 每帧后让出一帧，避免长时间同步渲染阻塞界面
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
