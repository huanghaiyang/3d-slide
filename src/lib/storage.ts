/**
 * storage.ts —— 持久化门面（后端 HTTP 存储）
 *
 * 职责：
 * - 对上层暴露与旧版 IndexedDB 实现完全一致的函数签名，组件无需关心数据存放位置；
 * - 作品的增删改查（decks）、首页封面（covers）的读写；
 * - 资源库元数据（assets）、资源文件夹（folders）的读写与回收站操作；
 * - 跨标签页的「编辑锁」：用 localStorage + 心跳判断当前标签页是否拥有写入权。
 *
 * 数据布局（由 server/ 落盘到 data/ 目录）：
 * - decks/<id>.json   完整 Deck JSON（读取时统一交给 normalizeDeck 校验）
 * - covers/<id>.json  首页 16:9 封面截图（按作品 updatedAt 失效）
 * - assets/<id>.json  资源元数据 AssetMeta（不含二进制）
 * - assets/blobs/<id> 资源内容本体（通过 /api/assets/:id/content 读取）
 * - folders.json      资源文件夹数组
 *
 * 与旧实现的差异：
 * - 资源内容由后端文件服务保存为二进制（/api/assets/:id/content），不再与元数据一起
 *   塞进 IndexedDB；读取时再按需下载为 dataURL，保持渲染层契约不变；
 * - 首次读取列表时会先执行 migrate.ts 的一次性旧数据迁移。
 *
 * 异步与错误：请求失败时抛出可读错误（连不上后端 / 服务端校验失败等），
 * 由调用方（store / UI）决定如何提示；只有 localStorage 的锁操作会静默失败。
 */

import type { Deck } from '../types';
import type { AssetFolder, AssetMeta } from './assets';
import type { CoverRecord } from './api';
import * as api from './api';
import { ensureLegacyMigration } from './migrate';
import { normalizeDeck } from './validate';

/**
 * 首页 / 作品选择器使用的作品摘要。
 * 只包含卡片展示所需字段，但保留 objects 供缩略预览渲染；
 * 解析失败的作品也会以 broken 形式返回，避免整页列表因单条坏数据而失败。
 */
export interface DeckSummary {
  /** 作品 id（主键）。 */
  id: string;
  /** 标题。 */
  title: string;
  /** 最后修改时间（毫秒），列表排序依据。 */
  updatedAt: number;
  /** 内容对象数量。 */
  objectCount: number;
  /** 视点数量。 */
  frameCount: number;
  /** 背景色，用于卡片底色。 */
  background: string;
  /** 数据无法解析时的错误提示；此时其他统计字段为 0。 */
  broken?: string;
  /** 完整对象列表（用于预览渲染）；损坏作品为空数组。 */
  objects: import('../types').SlideObject[];
}

/** 首页封面：离屏渲染的 16:9 截图，按作品 updatedAt 失效 */
export type DeckCover = CoverRecord;

/**
 * 列出所有作品摘要，按最后修改时间倒序。
 *
 * 先从后端读取原始作品 JSON，再逐条调用 normalizeDeck：校验通过的作品返回摘要；
 * 校验失败时若仍有可用 id，则以「无法读取的作品」形式返回并带上 broken 错误信息，
 * 保证首页不中断。首次调用会先完成旧 IndexedDB 数据迁移。
 *
 * @returns 作品摘要数组（可能包含损坏条目）
 * @throws 后端不可用 / 迁移失败时抛出（列表整体不可用）
 */
export async function listDecks(): Promise<DeckSummary[]> {
  await ensureLegacyMigration();
  const rows = await api.fetchDecks();
  const result: DeckSummary[] = [];
  for (const raw of rows) {
    const base = raw as Record<string, unknown>;
    try {
      const deck = normalizeDeck(raw);
      result.push({
        id: deck.id,
        title: deck.title,
        updatedAt: deck.updatedAt,
        objectCount: deck.objects.length,
        frameCount: deck.frames.length,
        background: deck.background,
        objects: deck.objects,
      });
    } catch (error) {
      if (typeof base.id === 'string') {
        result.push({
          id: base.id,
          title: typeof base.title === 'string' && base.title ? base.title : '无法读取的作品',
          updatedAt: typeof base.updatedAt === 'number' ? base.updatedAt : 0,
          objectCount: 0,
          frameCount: 0,
          background: '#DED8CC',
          objects: [],
          broken: error instanceof Error ? error.message : '作品数据无法读取',
        });
      }
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 按 id 读取单个作品，并做完整校验与字段裁剪。
 *
 * @param id 作品 id
 * @returns 作品对象；不存在时返回 null
 * @throws normalizeDeck 抛出的数据损坏错误（例如缺少标题 / 对象缺少 id）
 */
export async function getDeck(id: string): Promise<Deck | null> {
  const raw = await api.fetchDeck(id);
  if (!raw) return null;
  return normalizeDeck(raw);
}

/**
 * 写入（或覆盖）作品。
 *
 * @param deck 要保存的完整作品
 * @throws 后端不可用 / 写入失败时抛出，调用方需捕获并提示保存失败
 */
export async function putDeck(deck: Deck): Promise<void> {
  await api.putDeck(deck);
}

/**
 * 删除作品，服务端会同时删除其首页封面。
 *
 * @param id 作品 id
 */
export async function deleteDeck(id: string): Promise<void> {
  await api.deleteDeck(id);
}

/* ------------------------------ 首页封面 ------------------------------ */

/**
 * 读取全部首页封面。
 * @returns 封面数组（调用方自行按 deck id 匹配）
 */
export async function listDeckCovers(): Promise<DeckCover[]> {
  return api.fetchCovers();
}

/**
 * 读取指定作品的封面。
 * @param id 作品 id
 * @returns 封面；不存在时返回 null
 */
export async function getDeckCover(id: string): Promise<DeckCover | null> {
  return api.fetchCover(id);
}

/**
 * 写入（或覆盖）作品封面。以 cover.id（作品 id）为主键。
 * @throws 后端不可用 / 写入失败时抛出
 */
export async function putDeckCover(cover: DeckCover): Promise<void> {
  await api.putCover(cover);
}

/**
 * 删除指定作品的封面。
 * @param id 作品 id
 */
export async function deleteDeckCover(id: string): Promise<void> {
  await api.deleteCover(id);
}

/* ----------------------------- 资源库存储 ----------------------------- */

/**
 * 读取资源库全部元数据（不读取资源内容，因此开销较小）。
 *
 * 对历史数据做兼容性补齐：thumb / deletedAt / folderId / duration / width / height
 * 缺失时填入空值，保证旧版本写入的资源仍能被新代码正常消费。
 *
 * @returns 资源元数据数组；是否过滤回收站由调用方决定
 */
export async function listAssetMetas(): Promise<AssetMeta[]> {
  await ensureLegacyMigration();
  const rows = await api.fetchAssets();
  return rows.map((row) => ({
    ...row,
    thumb: row.thumb ?? '',
    deletedAt: row.deletedAt ?? null,
    folderId: row.folderId ?? null,
    duration: row.duration ?? 0,
    width: row.width ?? 0,
    height: row.height ?? 0,
  }));
}

/**
 * 读取资源内容。
 * @param id 资源 id
 * @returns dataURL 字符串；资源不存在时返回 null
 *
 * 内容本身由后端文件服务保存（二进制），这里按需下载并还原为 dataURL，
 * 以保持对象 src、Lottie 解析与 3D 模型加载对 dataURL 的既有约定。
 */
export async function getAssetSource(id: string): Promise<string | null> {
  return api.fetchAssetSource(id);
}

/**
 * 新增资源：元数据与二进制内容一起上传到后端。
 *
 * @param meta 资源元数据（id 由调用方预先分配）
 * @param src  资源内容（dataURL，客户端解析文件时生成）
 * @throws 后端不可用 / 上传失败时抛出
 */
export async function putAssetMeta(meta: AssetMeta, src: string): Promise<void> {
  await api.uploadAsset(meta, src);
}

/**
 * 局部更新资源元数据（不改动资源内容）。
 *
 * 服务端读取现有记录后合并 patch，并强制保留原 id；资源不存在时返回 404。
 *
 * @param id    资源 id
 * @param patch 需要更新的字段
 */
export async function updateAssetMeta(id: string, patch: Partial<AssetMeta>): Promise<void> {
  await api.updateAsset(id, patch);
}

/**
 * 把资源移入回收站（软删除）：只设置 deletedAt / updatedAt，不删除内容。
 *
 * @param ids 要移入回收站的资源 id；空数组直接返回
 */
export async function trashAssets(ids: string[]): Promise<void> {
  await api.trashAssets(ids);
}

/**
 * 从回收站恢复资源。
 *
 * 服务端会先检查原文件夹是否仍然存在：已被删除时把 folderId 重置为 null（回到根目录）。
 *
 * @param ids 要恢复的资源 id；空数组直接返回
 */
export async function restoreAssets(ids: string[]): Promise<void> {
  await api.restoreAssets(ids);
}

/**
 * 永久删除资源：同时删除元数据与内容。
 *
 * @param ids 要删除的资源 id；空数组直接返回
 */
export async function deleteAssetsPermanently(ids: string[]): Promise<void> {
  await api.purgeAssets(ids);
}

/**
 * 清空回收站：永久删除所有 deletedAt 非空的资源。
 *
 * @returns 被删除的资源数量（用于 UI 提示）
 */
export async function emptyAssetTrash(): Promise<number> {
  return api.emptyAssetTrash();
}

/**
 * 读取全部资源文件夹。
 * 对旧数据把缺失的 parentId 补为 null（表示根目录）。
 */
export async function listFolders(): Promise<AssetFolder[]> {
  const rows = await api.fetchFolders();
  return rows.map((row) => ({ ...row, parentId: row.parentId ?? null }));
}

/**
 * 写入（或覆盖）资源文件夹。
 * @param folder 文件夹记录（id 由调用方生成）
 */
export async function putFolder(folder: AssetFolder): Promise<void> {
  await api.putFolder(folder);
}

/**
 * 批量删除文件夹记录（只删目录，不删除其中资源；资源的 folderId 由调用方另行处理）。
 *
 * @param ids 要删除的文件夹 id；空数组直接返回
 */
export async function deleteFolderRecords(ids: string[]): Promise<void> {
  await api.deleteFolders(ids);
}

/* ---------------------------- 多标签只读锁 ---------------------------- */

/**
 * 读取或生成当前标签页的标识。
 *
 * 存放在 sessionStorage：同一标签页刷新后保持不变，不同标签页天然隔离。
 * sessionStorage 不可用（隐私模式 / 被禁用）时退化为内存中随机生成的 id。
 *
 * @returns 标签页 id 字符串
 */
function loadTabId(): string {
  const key = '3d-slide:tab-id';
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) return stored;
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  }
}

/** 同一标签页刷新后保持不变，不同标签页互不相同 */
export const TAB_ID = loadTabId();

/** localStorage 中编辑锁的 key 前缀，完整 key 为 LOCK_PREFIX + deckId。 */
const LOCK_PREFIX = '3d-slide:lock:';
/** 锁的过期时间（毫秒）：超过 20 秒未续期即视为持有者已退出 / 崩溃。 */
const LOCK_TTL = 20000;

/** 锁记录：持有者标签页 id 与最后一次续期时间戳。 */
interface LockRecord {
  /** 持有锁的标签页 id。 */
  tabId: string;
  /** 最后一次写入（心跳）的时间戳（毫秒）。 */
  at: number;
}

/** 心跳定时器句柄；持有锁期间每 4 秒续期一次。 */
let heartbeat: number | undefined;
/** 当前标签页持有的作品 id；为 null 表示未持有任何锁。 */
let heldDeckId: string | null = null;

/**
 * 读取指定作品的锁记录。
 *
 * 解析失败（JSON 损坏、结构异常）一律视为无锁，避免坏数据永久阻塞编辑；
 * localStorage 不可用时同样返回 null。
 *
 * @param deckId 作品 id
 * @returns 锁记录或 null
 */
function readLock(deckId: string): LockRecord | null {
  try {
    const raw = localStorage.getItem(LOCK_PREFIX + deckId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LockRecord;
    if (!parsed?.tabId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 写入（续期）当前标签页对指定作品的锁。
 *
 * localStorage 写入失败（配额满 / 隐私模式）时静默忽略：
 * 锁只是协作优化，失败不应阻断本地编辑。
 *
 * @param deckId 作品 id
 */
function writeLock(deckId: string) {
  try {
    localStorage.setItem(LOCK_PREFIX + deckId, JSON.stringify({ tabId: TAB_ID, at: Date.now() }));
  } catch {
    // 本地存储不可用时不影响编辑
  }
}

/**
 * 尝试获取指定作品的编辑锁。
 *
 * 逻辑：先释放当前标签页已持有的锁；若发现锁被其他标签页持有且未过期（心跳仍在
 * LOCK_TTL 内），返回 false（调用方据此进入只读）；否则写入自己的锁并启动心跳续期。
 *
 * @param deckId 作品 id
 * @returns true 表示当前标签页拥有写入权
 *
 * 副作用：写入 localStorage、启动 4 秒间隔的 setInterval（每次续期都会刷新时间戳）。
 * 采用 4 秒心跳对 20 秒 TTL，可容忍短暂卡顿 / 后台节流，同时较快回收崩溃标签页的锁。
 */
export function acquireDeckLock(deckId: string): boolean {
  releaseDeckLock();
  const existing = readLock(deckId);
  if (existing && existing.tabId !== TAB_ID && Date.now() - existing.at < LOCK_TTL) {
    return false;
  }
  heldDeckId = deckId;
  writeLock(deckId);
  heartbeat = window.setInterval(() => {
    if (heldDeckId === deckId) writeLock(deckId);
  }, 4000);
  return true;
}

/**
 * 释放当前标签页持有的编辑锁。
 *
 * 先清除心跳定时器，再确认锁仍属于自己后删除 localStorage 记录（避免误删
 * 其他标签页在 TTL 过期后新获取的锁）。关闭作品、打开新作品或页面卸载时调用。
 *
 * 无锁时调用是安全的空操作。
 */
export function releaseDeckLock(): void {
  if (heartbeat !== undefined) {
    window.clearInterval(heartbeat);
    heartbeat = undefined;
  }
  if (heldDeckId) {
    const existing = readLock(heldDeckId);
    if (existing?.tabId === TAB_ID) {
      try {
        localStorage.removeItem(LOCK_PREFIX + heldDeckId);
      } catch {
        // ignore
      }
    }
    heldDeckId = null;
  }
}
