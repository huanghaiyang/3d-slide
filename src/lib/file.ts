import type { Deck } from '../types';
import { LIMITS } from './constants';
import { formatBytes } from './image';
import { createSlideFile, sanitizeFileName } from './validate';

export function formatStamp(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateStamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type ExportResult =
  | { ok: true; filename: string; size: number }
  | { ok: false; message: string };

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
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { ok: true, filename, size: blob.size };
}
