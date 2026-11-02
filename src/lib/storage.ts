/**
 * storage.ts —— 基于 IndexedDB 的本地持久化层
 *
 * 职责：
 * - 打开 / 升级名为 `3d-slide` 的 IndexedDB（版本 3），并隔离打开失败与阻塞场景；
 * - 作品的增删改查（decks）、首页封面（covers）的读写；
 * - 资源库元数据与二进制内容（assets / assetData）、资源文件夹（folders）的读写；
 * - 跨标签页的「编辑锁」：用 localStorage + 心跳判断当前标签页是否拥有写入权。
 *
 * 数据布局：
 * - decks      { keyPath: 'id' }  完整 Deck JSON（读取时统一交给 normalizeDeck 校验）
 * - assets     { keyPath: 'id' }  资源元数据 AssetMeta（不含二进制）
 * - assetData  { keyPath: 'id' }  资源内容 { id, src }（src 为 dataURL / base64）
 * - folders    { keyPath: 'id' }  资源文件夹树（parentId 构成层级）
 * - covers     { keyPath: 'id' }  首页 16:9 封面截图（按作品 updatedAt 失效）
 *
 * 事务约定：涉及多张表的写入都放在同一个 readwrite 事务中，最后 await tx.done，
 * 保证要么全部成功、要么整体回滚；单表操作直接用 database.put/delete 的便捷 API。
 *
 * 异步与错误：本模块多数函数返回 Promise，失败时抛出原始错误（含配额不足等），
 * 由调用方（store / UI）决定如何提示；只有 localStorage 的锁操作会静默失败。
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Deck } from '../types';
import type { AssetFolder, AssetMeta } from './assets';
import { normalizeDeck } from './validate';

/** 资源二进制内容记录：src 为 dataURL 字符串，与 assets 表通过 id 一对一关联。 */
interface AssetDataRecord {
  /** 与 assets 表同 id。 */
  id: string;
  /** 资源内容（dataURL），单独存表避免列表查询时读取大字段。 */
  src: string;
}

/**
 * IndexedDB 数据库结构声明（idb 的 DBSchema）。
 * 每张表都以 id 为主键（keyPath: 'id'）。
 */
interface SlideDB extends DBSchema {
  decks: {
    key: string;
    value: unknown;
  };
  assets: {
    key: string;
    value: AssetMeta;
  };
  assetData: {
    key: string;
    value: AssetDataRecord;
  };
  folders: {
    key: string;
    value: AssetFolder;
  };
  covers: {
    key: string;
    value: DeckCover;
  };
}

/** 数据库连接的懒加载单例；为 null 表示尚未打开或上次打开失败。 */
let dbPromise: Promise<IDBPDatabase<SlideDB>> | null = null;

/**
 * 获取数据库连接（首次调用时打开，之后复用同一个 Promise）。
 *
 * 打开过程中的三种异常都转成可读错误：
 * - blocked：更高版本或其他旧版页面占用了数据库，升级被阻塞；
 * - 超时：6 秒内仍未打开（常见于旧标签页未关闭）；
 * - 其他 IndexedDB 错误原样向上抛出。
 *
 * @returns 已打开的数据库连接
 * @throws 数据库被占用 / 打开超时 / 浏览器不支持 IndexedDB 等错误
 */
function db(): Promise<IDBPDatabase<SlideDB>> {
  if (!dbPromise) {
    let rejectBlocked: ((reason: Error) => void) | null = null;
    // 旧版本标签页仍占用数据库时，升级会一直挂起；这里让它快速失败并给出可读提示
    const blocked = new Promise<never>((_, reject) => {
      rejectBlocked = reject;
    });
    const opened = openDB<SlideDB>('3d-slide', 3, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('decks')) {
          database.createObjectStore('decks', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('assets')) {
          database.createObjectStore('assets', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('assetData')) {
          database.createObjectStore('assetData', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('folders')) {
          database.createObjectStore('folders', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('covers')) {
          database.createObjectStore('covers', { keyPath: 'id' });
        }
      },
      blocking() {
        // 其他标签页请求升级：主动关闭当前连接，避免阻塞对方
        const pending = dbPromise;
        dbPromise = null;
        void pending?.then((database) => database.close()).catch(() => {});
      },
      blocked() {
        dbPromise = null;
        rejectBlocked?.(new Error('数据库正在被其他旧版页面占用，请关闭其他标签页后刷新'));
        rejectBlocked = null;
      },
    });
    dbPromise = Promise.race([
      opened,
      blocked,
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('数据库打开超时，请关闭其他旧版页面后刷新重试')), 6000);
      }),
    ]);
    dbPromise = dbPromise.catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

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
export interface DeckCover {
  /** 对应作品 id（与 decks 表同 key）。 */
  id: string;
  /** 封面图片（JPEG dataURL）。 */
  dataUrl: string;
  /** 生成封面时的作品 updatedAt，用于判断封面是否已过期。 */
  deckUpdatedAt: number;
  /** 封面生成本身的时间戳（毫秒）。 */
  at: number;
}

/**
 * 列出所有作品摘要，按最后修改时间倒序。
 *
 * 逐条调用 normalizeDeck：校验通过的作品返回摘要；校验失败时若仍有可用 id，
 * 则以「无法读取的作品」形式返回并带上 broken 错误信息，保证首页不中断。
 *
 * @returns 作品摘要数组（可能包含损坏条目）
 * @throws 数据库打开失败时抛出（列表整体不可用）
 */
export async function listDecks(): Promise<DeckSummary[]> {
  const database = await db();
  const rows = await database.getAll('decks');
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
  const database = await db();
  const raw = await database.get('decks', id);
  if (!raw) return null;
  return normalizeDeck(raw);
}

/**
 * 写入（或覆盖）作品。
 *
 * @param deck 要保存的完整作品；原样存入 decks 表，不做额外校验
 * @throws 存储配额不足 / 数据库不可用时抛出，调用方需捕获并提示保存失败
 *
 * 注意：这里保存的是调用方传入的引用快照，之后若继续修改同一对象需自行保证不可变。
 */
export async function putDeck(deck: Deck): Promise<void> {
  const database = await db();
  await database.put('decks', deck);
}

/**
 * 删除作品，并级联删除其首页封面。
 *
 * 使用一个同时覆盖 decks 与 covers 的 readwrite 事务，最后 await tx.done，
 * 保证作品与封面不会出现「只删掉一半」的状态。
 *
 * @param id 作品 id
 */
export async function deleteDeck(id: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['decks', 'covers'], 'readwrite');
  await tx.objectStore('decks').delete(id);
  await tx.objectStore('covers').delete(id);
  await tx.done;
}

/* ------------------------------ 首页封面 ------------------------------ */

/**
 * 读取全部首页封面。
 * @returns 封面数组（顺序由 IndexedDB 主键决定，调用方自行按 deck id 匹配）
 */
export async function listDeckCovers(): Promise<DeckCover[]> {
  const database = await db();
  return database.getAll('covers');
}

/**
 * 读取指定作品的封面。
 * @param id 作品 id
 * @returns 封面；不存在时返回 null
 */
export async function getDeckCover(id: string): Promise<DeckCover | null> {
  const database = await db();
  return (await database.get('covers', id)) ?? null;
}

/**
 * 写入（或覆盖）作品封面。以 cover.id（作品 id）为主键。
 * @throws 存储配额不足时抛出（封面为 dataURL，体积可能较大）
 */
export async function putDeckCover(cover: DeckCover): Promise<void> {
  const database = await db();
  await database.put('covers', cover);
}

/**
 * 删除指定作品的封面。
 * @param id 作品 id
 */
export async function deleteDeckCover(id: string): Promise<void> {
  const database = await db();
  await database.delete('covers', id);
}

/* ----------------------------- 资源库存储 ----------------------------- */

/**
 * 读取资源库全部元数据（不读取 assetData，因此开销较小）。
 *
 * 对历史数据做兼容性补齐：thumb / deletedAt / folderId / duration / width / height
 * 缺失时填入空值，保证旧版本写入的资源仍能被新代码正常消费。
 *
 * @returns 资源元数据数组；是否过滤回收站由调用方决定
 */
export async function listAssetMetas(): Promise<AssetMeta[]> {
  const database = await db();
  const rows = await database.getAll('assets');
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
 */
export async function getAssetSource(id: string): Promise<string | null> {
  const database = await db();
  const row = await database.get('assetData', id);
  return row?.src ?? null;
}

/**
 * 新增资源：元数据与二进制内容同时写入。
 *
 * 两张表放在同一个 readwrite 事务中，最后 await tx.done；任何一张写入失败都会整体回滚，
 * 避免出现「有元数据但取不到内容」的坏资源。
 *
 * @param meta 资源元数据（id 由调用方预先分配）
 * @param src  资源内容（dataURL）
 * @throws 配额不足时抛出
 */
export async function putAssetMeta(meta: AssetMeta, src: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['assets', 'assetData'], 'readwrite');
  await tx.objectStore('assets').put(meta);
  await tx.objectStore('assetData').put({ id: meta.id, src });
  await tx.done;
}

/**
 * 局部更新资源元数据（不改动 assetData）。
 *
 * 采用「读-改-写」：先读取现有行，合并 patch 后再写回，并强制保留原 id。
 * 资源不存在时静默返回（可能已被其他标签页删除）。
 *
 * @param id    资源 id
 * @param patch 需要更新的字段
 */
export async function updateAssetMeta(id: string, patch: Partial<AssetMeta>): Promise<void> {
  const database = await db();
  const existing = await database.get('assets', id);
  if (!existing) return;
  await database.put('assets', { ...existing, ...patch, id });
}

/**
 * 把资源移入回收站（软删除）：只设置 deletedAt / updatedAt，不删除内容。
 *
 * 所有 id 在同一个事务内处理，避免部分成功；资源已不存在时跳过。
 * 内容仍保留在 assetData 中，等待 emptyAssetTrash 或永久删除。
 *
 * @param ids 要移入回收站的资源 id；空数组直接返回
 */
export async function trashAssets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await db();
  const tx = database.transaction('assets', 'readwrite');
  const now = Date.now();
  for (const id of ids) {
    const row = await tx.store.get(id);
    if (row) tx.store.put({ ...row, deletedAt: now, updatedAt: now });
  }
  await tx.done;
}

/**
 * 从回收站恢复资源。
 *
 * 恢复前先读取现有文件夹 id 集合：若资源原来所属文件夹已被删除，则把 folderId
 * 重置为 null（回到根目录），避免恢复后指向不存在的目录。
 *
 * @param ids 要恢复的资源 id；空数组直接返回
 */
export async function restoreAssets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await db();
  const folderIds = new Set((await database.getAll('folders')).map((folder) => folder.id));
  const tx = database.transaction('assets', 'readwrite');
  for (const id of ids) {
    const row = await tx.store.get(id);
    if (!row) continue;
    // 原文件夹已不存在时回退到根目录
    const folderId = row.folderId && folderIds.has(row.folderId) ? row.folderId : null;
    tx.store.put({ ...row, deletedAt: null, folderId, updatedAt: Date.now() });
  }
  await tx.done;
}

/**
 * 永久删除资源：同时删除元数据与内容。
 *
 * 两张表的删除放在同一个事务中，最后 await tx.done，保证不会留下孤儿内容。
 *
 * @param ids 要删除的资源 id；空数组直接返回
 */
export async function deleteAssetsPermanently(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await db();
  const tx = database.transaction(['assets', 'assetData'], 'readwrite');
  for (const id of ids) {
    tx.objectStore('assets').delete(id);
    tx.objectStore('assetData').delete(id);
  }
  await tx.done;
}

/**
 * 清空回收站：永久删除所有 deletedAt 非空的资源。
 *
 * @returns 被删除的资源数量（用于 UI 提示）
 */
export async function emptyAssetTrash(): Promise<number> {
  const database = await db();
  const metas = await database.getAll('assets');
  const ids = metas.filter((meta) => meta.deletedAt !== null).map((meta) => meta.id);
  await deleteAssetsPermanently(ids);
  return ids.length;
}

/**
 * 读取全部资源文件夹。
 * 对旧数据把缺失的 parentId 补为 null（表示根目录）。
 */
export async function listFolders(): Promise<AssetFolder[]> {
  const database = await db();
  const rows = await database.getAll('folders');
  return rows.map((row) => ({ ...row, parentId: row.parentId ?? null }));
}

/**
 * 写入（或覆盖）资源文件夹。
 * @param folder 文件夹记录（id 由调用方生成）
 */
export async function putFolder(folder: AssetFolder): Promise<void> {
  const database = await db();
  await database.put('folders', folder);
}

/**
 * 批量删除文件夹记录（只删目录，不删除其中资源；资源的 folderId 由调用方另行处理）。
 *
 * @param ids 要删除的文件夹 id；空数组直接返回
 */
export async function deleteFolderRecords(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await db();
  const tx = database.transaction('folders', 'readwrite');
  for (const id of ids) tx.store.delete(id);
  await tx.done;
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
