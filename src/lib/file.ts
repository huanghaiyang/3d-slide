/**
 * file.ts —— 作品导出与时间格式化
 *
 * 负责把当前 Deck 序列化为 .slide 工程文件并触发浏览器下载，同时提供
 * 编辑器界面中常见的两种时间显示格式：
 * - formatStamp：完整日期 + 时分（"2026/11/02 14:30"），用于作品列表；
 * - formatClock：仅时分（"14:30"），用于保存状态等紧凑场景。
 *
 * 导出流程：createSlideFile 组装带版本号的工程结构 -> JSON.stringify 美化缩进
 * -> 体积校验 -> 通过临时 <a download> 触发下载 -> 延迟释放 Blob URL。
 * 整个模块不修改 deck，也不依赖 React 状态。
 */

import type { Deck } from '../types';
import { LIMITS } from './constants';
import { formatBytes } from './image';
import { createSlideFile, sanitizeFileName } from './validate';

/**
 * 把时间戳格式化为 "YYYY/MM/DD HH:mm"。
 *
 * 使用本地时区；月、日、时、分不足两位时补零。时间戳为 0（未保存过）时返回空串，
 * 便于界面直接显示而不出现 1970 年日期。
 *
 * @param timestamp 毫秒时间戳；0 表示无记录
 * @returns 格式化后的日期时间字符串，或空串
 */
export function formatStamp(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 把时间戳格式化为 "HH:mm"（本地时区，24 小时制）。
 *
 * 用于保存时间等只关心当天时刻的场景，不包含日期信息。
 *
 * @param timestamp 毫秒时间戳
 * @returns 补零后的时:分字符串
 */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 生成用于文件名的日期戳 "YYYY-MM-DD"（本地时区）。
 *
 * 使用短横线而非斜杠，避免文件名中出现路径分隔符。
 *
 * @returns 当前日期的文件名安全字符串
 */
function dateStamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 导出结果：成功时带文件名与实际字节数，失败时只带提示文案。
 * 调用方可用 ok 字段做类型收窄。
 */
export type ExportResult =
  | { ok: true; filename: string; size: number }
  | { ok: false; message: string };

/**
 * 把作品导出为 .slide 工程文件并触发浏览器下载。
 *
 * 关键点：
 * - 使用 createSlideFile 包裹版本信息，便于后续导入时做兼容校验；
 * - JSON 带 2 空格缩进，方便用户直接查看或手工处理；
 * - 超过工程体积上限时拒绝导出，避免生成浏览器难以处理的超大 Blob；
 * - 文件名由「净化后的标题 + 日期」组成，避免非法字符；
 * - 下载通过临时 anchor 完成，2 秒后释放 Blob URL 以回收内存。
 *
 * 副作用：向 DOM 临时插入并移除 <a>，触发一次文件保存对话框 / 下载。
 *
 * @param deck 要导出的作品数据
 * @returns 成功时返回文件名与字节数；超限时返回失败原因
 */
export function exportDeckFile(deck: Deck): ExportResult {
  const payload = JSON.stringify(createSlideFile(deck), null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  if (blob.size > LIMITS.projectBytes) {
    return {
      ok: false,
      message: `工程文件 ${formatBytes(blob.size)}，超过 ${formatBytes(LIMITS.projectBytes)} 上限。请压缩图片后重试。`,
    };
  }
  const filename = `${sanitizeFileName(deck.title)}-${dateStamp()}.slide`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // 部分浏览器要求 anchor 位于文档中才会响应 click，因此临时挂载后再移除
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 延迟释放：立即 revoke 可能让下载被取消，留出足够的触发时间
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { ok: true, filename, size: blob.size };
}
