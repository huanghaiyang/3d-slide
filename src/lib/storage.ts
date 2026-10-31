import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Deck } from '../types';
import type { AssetFolder, AssetMeta } from './assets';
import { normalizeDeck } from './validate';

interface AssetDataRecord {
  id: string;
  src: string;
}

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
}

let dbPromise: Promise<IDBPDatabase<SlideDB>> | null = null;

function db(): Promise<IDBPDatabase<SlideDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SlideDB>('3d-slide', 2, {
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
      },
    });
  }
  return dbPromise;
}

export interface DeckSummary {
  id: string;
  title: string;
  updatedAt: number;
  objectCount: number;
  frameCount: number;
  background: string;
  broken?: string;
  objects: import('../types').SlideObject[];
}

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

export async function getDeck(id: string): Promise<Deck | null> {
  const database = await db();
  const raw = await database.get('decks', id);
  if (!raw) return null;
  return normalizeDeck(raw);
}

export async function putDeck(deck: Deck): Promise<void> {
  const database = await db();
  await database.put('decks', deck);
}

export async function deleteDeck(id: string): Promise<void> {
  const database = await db();
  await database.delete('decks', id);
}

/* ----------------------------- 资源库存储 ----------------------------- */

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

export async function getAssetSource(id: string): Promise<string | null> {
  const database = await db();
  const row = await database.get('assetData', id);
  return row?.src ?? null;
}

export async function putAssetMeta(meta: AssetMeta, src: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['assets', 'assetData'], 'readwrite');
  await tx.objectStore('assets').put(meta);
  await tx.objectStore('assetData').put({ id: meta.id, src });
  await tx.done;
}

export async function updateAssetMeta(id: string, patch: Partial<AssetMeta>): Promise<void> {
  const database = await db();
  const existing = await database.get('assets', id);
  if (!existing) return;
  await database.put('assets', { ...existing, ...patch, id });
}

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

export async function restoreAssets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await db();
  const folderIds = new Set((await database.getAll('folders')).map((folder) => folder.id));
  const tx = database.transaction('assets', 'readwrite');
  for (const id of ids) {
    const row = await tx.store.get(id);
    if (!row) continue;
    const folderId = row.folderId && folderIds.has(row.folderId) ? row.folderId : null;
    tx.store.put({ ...row, deletedAt: null, folderId, updatedAt: Date.now() });
  }
  await tx.done;
}

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

export async function emptyAssetTrash(): Promise<number> {
  const database = await db();
  const metas = await database.getAll('assets');
  const ids = metas.filter((meta) => meta.deletedAt !== null).map((meta) => meta.id);
  await deleteAssetsPermanently(ids);
  return ids.length;
}

export async function listFolders(): Promise<AssetFolder[]> {
  const database = await db();
  const rows = await database.getAll('folders');
  return rows.map((row) => ({ ...row, parentId: row.parentId ?? null }));
}

export async function putFolder(folder: AssetFolder): Promise<void> {
  const database = await db();
  await database.put('folders', folder);
}

export async function deleteFolderRecords(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await db();
  const tx = database.transaction('folders', 'readwrite');
  for (const id of ids) tx.store.delete(id);
  await tx.done;
}

/* ---------------------------- 多标签只读锁 ---------------------------- */

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

const LOCK_PREFIX = '3d-slide:lock:';
const LOCK_TTL = 20000;

interface LockRecord {
  tabId: string;
  at: number;
}

let heartbeat: number | undefined;
let heldDeckId: string | null = null;

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

function writeLock(deckId: string) {
  try {
    localStorage.setItem(LOCK_PREFIX + deckId, JSON.stringify({ tabId: TAB_ID, at: Date.now() }));
  } catch {
    // 本地存储不可用时不影响编辑
  }
}

/** 返回 true 表示当前标签页拥有写入权 */
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
