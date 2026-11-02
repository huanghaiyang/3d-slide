/**
 * lottie.ts —— Lottie 动画文件的解析、尺寸计算与封面渲染
 *
 * Lottie 文件本质是一段描述矢量动画的 JSON（.json / .lottie）。本模块负责：
 * - 识别 Lottie 文件（按扩展名）；
 * - 解析 JSON 或 data URL 中的动画数据，并校验 layers 等必要字段；
 * - 由画布尺寸 w/h、帧率 fr、起止帧 ip/op 推导宽高与时长（秒）；
 * - 生成带 MIME 的 data URL，使动画可随作品持久化；
 * - 用离屏 canvas + lottie-web 渲染第一帧作为封面（poster），供未播放时展示。
 *
 * 依赖说明：lottie-web 体积较大，只在真正需要渲染封面时动态 import，
 * 避免影响编辑器主包加载速度。
 */

import type { AnimationConfigWithData, AnimationItem } from 'lottie-web';
import { LIMITS } from './constants';
import { formatBytes } from './image';

/**
 * 按文件名扩展名判断是否为 Lottie 文件。
 *
 * 仅检查最后一个扩展名，不区分大小写；.json 也视为 Lottie（可能是普通 JSON，
 * 后续解析时会校验 layers 字段）。
 *
 * @param name 文件名或路径
 * @returns 扩展名为 json / lottie 时为 true
 */
export function isLottieName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'json' || ext === 'lottie';
}

/**
 * 判断文件是否为 Lottie 文件（基于文件名扩展名）。
 *
 * @param file 待检查的文件
 * @returns 是否为 json / lottie 文件
 */
export function isLottieFile(file: File): boolean {
  return isLottieName(file.name);
}

/** 读取 Lottie 文件后的结果：src 为 data URL，duration 单位为秒。 */
export interface LottiePayload {
  /** 编码后的 data:application/json data URL */
  src: string;
  /** 动画画布宽度（像素） */
  naturalWidth: number;
  /** 动画画布高度（像素） */
  naturalHeight: number;
  /** 动画总时长（秒），由帧数与帧率换算 */
  duration: number;
}

/**
 * Lottie 动画 JSON 中本模块关心的字段。
 * 其余图层、资源等数据保持原样，交由 lottie-web 解析。
 */
export interface LottieDocument {
  /** 画布宽度 */
  w?: number;
  /** 画布高度 */
  h?: number;
  /** 起始帧（in point） */
  ip?: number;
  /** 结束帧（out point） */
  op?: number;
  /** 帧率（frames per second） */
  fr?: number;
  /** 图层数组；存在该字段是判断是否为 Lottie 的关键 */
  layers?: unknown[];
}

/**
 * 解析 Lottie JSON 文本并校验必要字段。
 *
 * JSON.parse 失败、结果不是对象、或缺少 layers 数组时返回 null。
 * 这里只做结构性校验，不深入校验图层内容，具体错误由 lottie-web 报告。
 *
 * @param text JSON 文本
 * @returns 解析后的文档；无效时返回 null
 */
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

/**
 * 从 data URL 或纯 JSON 文本中解析 Lottie 数据。
 *
 * 支持两种 data URL 编码：
 * - base64（如 data:application/json;base64,...）：用 atob 解码；
 * - 百分号编码（如 data:application/json;charset=utf-8,%7B...）：用 decodeURIComponent。
 * 也接受直接传入的 JSON 文本（例如从存储中读出的原始内容）。
 *
 * @param src data URL 或 JSON 文本
 * @returns 解析后的文档；空串、格式错误或无效 Lottie 时返回 null
 */
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

/**
 * 由 Lottie 文档推导画布尺寸与时长。
 *
 * 尺寸缺失时按 1 处理，避免出现 0；帧率默认 30，起止帧缺失时按 ip=0、
 * op=ip+fr（即 1 秒）兜底。时长 = (op - ip) / fr，单位为秒且不小于 0。
 *
 * @param document 已解析的 Lottie 文档
 * @returns width / height / duration（秒）
 */
export function lottieSize(document: LottieDocument): { width: number; height: number; duration: number } {
  const width = Math.max(1, Math.round(Number(document.w) || 0));
  const height = Math.max(1, Math.round(Number(document.h) || 0));
  const fr = Number(document.fr) || 30;
  const start = Number(document.ip) || 0;
  const end = Number(document.op) || start + fr;
  return { width, height, duration: Math.max(0, (end - start) / fr) };
}

/**
 * 读取并校验用户选择的 Lottie 文件。
 *
 * 依次校验体积、解析 JSON、校验 layers 与画布尺寸 w/h，然后重新编码为
 * application/json 的 data URL（使用 URL 百分号编码而非 base64，
 * 体积更小且内容可读性更好）。
 *
 * @param file 用户选择的 .json / .lottie 文件
 * @returns data URL、画布尺寸与时长
 * @throws 超过体积上限、不是有效 Lottie JSON 或缺少画布尺寸时抛出错误
 */
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

/**
 * 用离屏 canvas 渲染 Lottie 第一帧，返回 PNG dataURL（失败时返回空串）。
 *
 * 流程：
 * 1. 解析动画数据；按最大边 max 计算缩放比，避免生成过大的 canvas；
 * 2. 动态加载 lottie-web，以 canvas 渲染器、非循环、不自动播放的方式创建动画，
 *    并直接绘制到已传入的 2D context（不创建额外 container）；
 * 3. 等待 DOMLoaded / data_failed / error 事件，最多 1200ms，确保只结算一次；
 * 4. 定位到第 0 帧并等待约 40ms 让 canvas 完成绘制，再导出 PNG；
 * 5. finally 中调用 destroy 释放动画实例，防止内存泄漏与后台任务残留。
 *
 * 注意：data_failed / error 发生时返回空串而非抛异常，封面属于可选功能，
 * 失败时由调用方回退到其他缩略图方案。
 *
 * @param src Lottie 的 data URL 或 JSON 文本
 * @param max 生成图片的最大边长（像素），用于控制 canvas 尺寸
 * @returns PNG data URL；任何失败场景返回空串
 */
export async function renderLottieThumbnail(src: string, max = 480): Promise<string> {
  const data = parseLottieSource(src);
  if (!data) return '';
  const width = Math.max(1, Number(data.w) || 0);
  const height = Math.max(1, Number(data.h) || 0);
  // 只缩小不放大：max 大于原始尺寸时保持 1，避免无意义地放大 canvas
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
    // lottie-web 的加载与解析是异步的，这里用 settled 标志保证多个事件只结算一次
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
    // 定位到第 0 帧并停止播放；随后等待一个短延时，让 canvas 完成实际绘制
    animation.goToAndStop(0, true);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  } finally {
    animation?.destroy();
  }
}
