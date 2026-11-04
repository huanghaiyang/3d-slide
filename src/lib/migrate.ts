/**
 * migrate.ts —— 旧版 IndexedDB 数据的一次性迁移
 *
 * 背景：数据层从浏览器 IndexedDB 迁移到后端后，老用户的作品、资源库与封面仍留在
 * 名为 `3d-slide` 的 IndexedDB 中。本模块在首次读取列表时把这些数据一次性上传到
 * 后端，避免出现「升级后首页空白」。
 *
 * 规则：
 * - 只执行一次：成功后写入 localStorage 标记，之后直接短路返回；
 * - 后端已有数据时跳过（不覆盖用户在新版本里新建的内容），并写入标记；
 * - 旧数据库不存在或没有任何记录时直接写入标记；
 * - 单条记录迁移失败只告警并继续，全部处理完才写入标记；
 * - 旧数据本身不做删除，保留在原地作为兜底。
 *
 * 注意：迁移导出的是原始 JSON，不做 normalizeDeck 校验，校验仍由 storage.ts 负责。
 */

import type { AssetFolder, AssetMeta } from './assets';
import type { CoverRecord } from './api';
import { fetchAssets, fetchDecks, putCover, putDeck, putFolder, uploadAsset } from './api';

/** 旧版数据库名与迁移标记（标记写在 localStorage，按浏览器生效）。 */
const LEGACY_DB = '3d-slide';
const FLAG = '3d-slide:migrated-to-server:v1';

/** 旧版资源内容记录结构。 */
interface LegacyAssetData {
  id: string;
  src: string;
}

/** 迁移任务单例：同一会话内只跑一次。 */
let task: Promise<void> | null = null;

/**
 * 执行旧数据迁移（幂等）。
 * @returns 迁移完成后 resolve；失败时 reject（调用方会收到读列表失败的错误）
 */
export function ensureLegacyMigration(): Promise<void> {
  if (!task) {
    task = migrate().catch((error: unknown) => {
      // 失败不写入标记，下次刷新会重试
      task = null;
      throw error;
    });
  }
  return task;
}

/** 读取 localStorage 标记；存储不可用时按「未迁移」处理。 */
function hasFlag(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

/** 写入迁移标记。 */
function setFlag() {
  try {
    localStorage.setItem(FLAG, '1');
  } catch {
    // 隐私模式下无法持久化，忽略即可
  }
}

/** 判断浏览器是否支持枚举数据库（不支持时无法安全探测旧库，直接跳过迁移）。 */
async function legacyDbExists(): Promise<boolean> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return false;
  try {
    const databases = await indexedDB.databases();
    return databases.some((item) => item.name === LEGACY_DB);
  } catch {
    return false;
  }
}

/** 打开旧数据库（不指定版本，沿用浏览器中已有的版本，避免误建空库）。 */
function openLegacyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DB);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('旧版本地数据库打开失败'));
    request.onblocked = () => reject(new Error('旧版本地数据库被其他标签页占用'));
  });
}

/** 读取一张表的全部记录；表不存在或读取失败时返回空数组。 */
function readStore<T>(db: IDBDatabase, name: string): Promise<T[]> {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains(name)) {
      resolve([]);
      return;
    }
    try {
      const request = db.transaction(name, 'readonly').objectStore(name).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as T[]);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** 实际迁移流程。 */
async function migrate(): Promise<void> {
  if (hasFlag()) return;
  if (!(await legacyDbExists())) {
    setFlag();
    return;
  }

  // 新旧数据并存时以服务端为准，避免覆盖用户已在新版本里创建的内容
  const [serverDecks, serverAssets] = await Promise.all([fetchDecks(), fetchAssets()]);
  if (serverDecks.length > 0 || serverAssets.length > 0) {
    setFlag();
    return;
  }

  const database = await openLegacyDb();
  let decks: Record<string, unknown>[];
  let assets: AssetMeta[];
  let assetData: LegacyAssetData[];
  let folders: AssetFolder[];
  let covers: CoverRecord[];
  try {
    [decks, assets, assetData, folders, covers] = await Promise.all([
      readStore<Record<string, unknown>>(database, 'decks'),
      readStore<AssetMeta>(database, 'assets'),
      readStore<LegacyAssetData>(database, 'assetData'),
      readStore<AssetFolder>(database, 'folders'),
      readStore<CoverRecord>(database, 'covers'),
    ]);
  } finally {
    database.close();
  }

  const empty = decks.length + assets.length + folders.length + covers.length === 0;
  if (empty) {
    setFlag();
    return;
  }

  console.info(
    `[migrate] 开始迁移旧数据：${decks.length} 份作品、${assets.length} 个资源、${folders.length} 个文件夹`,
  );

  /** 单条失败只记录日志，不影响其余数据。 */
  const attempt = async (label: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      console.warn(`[migrate] ${label} 迁移失败：`, error);
    }
  };

  for (const deck of decks) {
    if (typeof deck?.id !== 'string') continue;
    await attempt(`作品 ${deck.id}`, () => putDeck(deck));
  }

  const contentById = new Map(assetData.map((row) => [row.id, row.src]));
  for (const meta of assets) {
    const src = contentById.get(meta.id);
    if (!src) continue;
    await attempt(`资源 ${meta.id}`, () => uploadAsset(meta, src));
  }

  for (const folder of folders) {
    await attempt(`文件夹 ${folder.id}`, () => putFolder(folder));
  }

  for (const cover of covers) {
    if (!cover?.id || !cover.dataUrl) continue;
    await attempt(`封面 ${cover.id}`, () => putCover(cover));
  }

  setFlag();
  console.info('[migrate] 旧数据迁移完成');
}
