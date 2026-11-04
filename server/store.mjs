/**
 * store.mjs —— 后端本地数据存储
 *
 * 职责：
 * - 在 `data/` 目录下维护作品、封面、资源元数据、文件夹与文件二进制；
 * - 提供 JSON 原子写入（临时文件 + rename）与串行写队列，避免并发请求互相覆盖；
 * - 提供文件 blob 的落盘 / 删除与安全路径计算（id 白名单，杜绝路径穿越）。
 *
 * 目录布局（默认 data/，可用 SLIDE_DATA_DIR 环境变量改写）：
 * - decks/<id>.json    完整 Deck JSON
 * - covers/<id>.json   首页封面 { id, dataUrl, deckUpdatedAt, at }
 * - assets/<id>.json   资源元数据 AssetMeta（不含二进制）
 * - assets/blobs/<id>  资源二进制内容
 * - files/<id>.json    通用文件元数据 { id, name, mime, size, createdAt }
 * - files/blobs/<id>   通用文件二进制内容
 * - folders.json       资源文件夹数组
 * - tmp/               multer 上传中转目录
 *
 * 设计取舍：本服务面向单机单用户，JSON 记录按 id 分文件存放，
 * 单条写入不会重写整库；所有写操作进入同一串行队列，保证请求顺序一致。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（server/ 的上一级）。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 数据根目录：优先使用环境变量，便于把数据放到其他磁盘。 */
export const DATA_DIR = process.env.SLIDE_DATA_DIR
  ? resolve(process.env.SLIDE_DATA_DIR)
  : resolve(ROOT, 'data');

/** 各类记录与二进制所在的子目录 / 文件路径。 */
const DECKS_DIR = join(DATA_DIR, 'decks');
const COVERS_DIR = join(DATA_DIR, 'covers');
const ASSETS_DIR = join(DATA_DIR, 'assets');
const ASSET_BLOBS_DIR = join(ASSETS_DIR, 'blobs');
const FILES_DIR = join(DATA_DIR, 'files');
const FILE_BLOBS_DIR = join(FILES_DIR, 'blobs');
const FOLDERS_FILE = join(DATA_DIR, 'folders.json');
export const TMP_DIR = join(DATA_DIR, 'tmp');

/** id 只允许字母、数字、下划线与短横线，且长度受限，避免拼接出越界路径。 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 校验并返回 id。
 * @param {unknown} id
 * @returns {string}
 * @throws 结构不合法时抛出带 status=400 的错误
 */
export function assertId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    const error = new Error('无效的 id');
    error.status = 400;
    throw error;
  }
  return id;
}

/** 生成随机 id（uuid）。 */
export function newId() {
  return randomUUID();
}

/**
 * 创建带 HTTP 状态码的错误，供路由层统一转成 JSON 响应。
 * @param {number} status
 * @param {string} message
 */
export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * 确保所有数据目录存在（服务启动时调用一次）。
 */
export async function ensureDataDirs() {
  for (const dir of [
    DATA_DIR,
    DECKS_DIR,
    COVERS_DIR,
    ASSETS_DIR,
    ASSET_BLOBS_DIR,
    FILES_DIR,
    FILE_BLOBS_DIR,
    TMP_DIR,
  ]) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * 读取 JSON 文件；文件不存在时返回兜底值，内容损坏时同样返回兜底值并告警。
 * @param {string} file 绝对路径
 * @param {*} fallback 兜底值
 */
async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[store] 读取 ${file} 失败：`, error?.message ?? error);
    }
    return fallback;
  }
}

/**
 * 原子写入 JSON：先写同目录临时文件，再 rename 覆盖目标。
 * 这样读取方永远只能看到完整的旧文件或完整的新文件。
 * @param {string} file 绝对路径
 * @param {*} value 可被 JSON 序列化的值
 */
async function writeJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  await rename(tmp, file);
}

/**
 * 串行写队列：所有写操作按调用顺序执行，避免同一记录被并发覆盖。
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
let writeChain = Promise.resolve();
export function exclusive(task) {
  const run = writeChain.then(() => task());
  writeChain = run.catch(() => {});
  return run;
}

/**
 * 列出目录下全部 .json 记录（跳过损坏文件，保证单条坏数据不拖垮列表）。
 * @param {string} dir
 */
async function listRecords(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const value = await readJson(join(dir, name), null);
    if (value && typeof value === 'object') records.push(value);
  }
  return records;
}

/** 删除文件；不存在时静默返回。 */
async function removeFile(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/** 记录 id 对应的 JSON 路径。 */
function recordPath(dir, id) {
  return join(dir, `${assertId(id)}.json`);
}

/** 把上传中转文件移动到最终位置（同一磁盘上 rename 是原子操作）。 */
export async function moveIntoPlace(from, to) {
  await rename(from, to);
}

/* -------------------------------- 作品 -------------------------------- */

/** 列出全部作品原始 JSON（顺序由文件系统决定，前端自行排序）。 */
export function listDecks() {
  return listRecords(DECKS_DIR);
}

/** 读取单个作品；不存在返回 null。 */
export function getDeck(id) {
  return readJson(recordPath(DECKS_DIR, id), null);
}

/** 覆盖写入作品。 */
export function saveDeck(deck) {
  return exclusive(() => writeJson(recordPath(DECKS_DIR, deck.id), deck));
}

/**
 * 删除作品，并级联删除其首页封面。
 * @param {string} id
 */
export async function removeDeck(id) {
  await exclusive(async () => {
    await removeFile(recordPath(DECKS_DIR, id));
    await removeFile(recordPath(COVERS_DIR, id));
  });
}

/* ------------------------------ 首页封面 ------------------------------ */

/** 列出全部封面记录。 */
export function listCovers() {
  return listRecords(COVERS_DIR);
}

/** 读取单个作品封面；不存在返回 null。 */
export function getCover(id) {
  return readJson(recordPath(COVERS_DIR, id), null);
}

/** 写入（覆盖）封面记录。 */
export function saveCover(cover) {
  return exclusive(() => writeJson(recordPath(COVERS_DIR, cover.id), cover));
}

/** 删除封面记录。 */
export async function removeCover(id) {
  await exclusive(() => removeFile(recordPath(COVERS_DIR, id)));
}

/* -------------------------------- 资源 -------------------------------- */

/** 资源元数据文件路径。 */
function assetMetaPath(id) {
  return recordPath(ASSETS_DIR, id);
}

/** 资源二进制路径（与元数据同 id，无后缀；Content-Type 由元数据决定）。 */
export function assetBlobPath(id) {
  return join(ASSET_BLOBS_DIR, assertId(id));
}

/** 列出全部资源元数据。 */
export function listAssets() {
  return listRecords(ASSETS_DIR);
}

/** 读取单个资源元数据；不存在返回 null。 */
export function getAsset(id) {
  return readJson(assetMetaPath(id), null);
}

/**
 * 保存资源元数据与二进制（调用方需先把二进制放到 assetBlobPath）。
 * 元数据写入失败时回滚已落盘的二进制，避免产生无主文件。
 * @param {object} meta
 */
export async function saveAsset(meta) {
  try {
    await exclusive(() => writeJson(assetMetaPath(meta.id), meta));
  } catch (error) {
    await removeFile(assetBlobPath(meta.id)).catch(() => {});
    throw error;
  }
}

/** 仅更新资源元数据（覆盖写入）。 */
export function saveAssetMeta(meta) {
  return exclusive(() => writeJson(assetMetaPath(meta.id), meta));
}

/**
 * 在串行队列中批量更新资源元数据。
 * @param {string[]} ids
 * @param {(meta: object, now: number) => object | null} patch 返回新元数据或 null（跳过）
 * @returns {Promise<number>} 实际更新数量
 */
export function patchAssets(ids, patch) {
  return exclusive(async () => {
    let changed = 0;
    const now = Date.now();
    for (const id of ids) {
      const meta = await getAsset(id);
      if (!meta) continue;
      const next = patch(meta, now);
      if (!next) continue;
      await writeJson(assetMetaPath(id), { ...next, id });
      changed += 1;
    }
    return changed;
  });
}

/**
 * 永久删除资源：元数据 + 二进制。
 * @param {string[]} ids
 * @returns {Promise<number>} 实际删除数量
 */
export function purgeAssets(ids) {
  return exclusive(async () => {
    let removed = 0;
    for (const id of ids) {
      const meta = await getAsset(id);
      if (!meta) continue;
      await removeFile(assetMetaPath(id));
      await removeFile(assetBlobPath(id));
      removed += 1;
    }
    return removed;
  });
}

/** 清空回收站：删除所有 deletedAt 非空的资源。 */
export async function emptyAssetTrash() {
  const metas = await listAssets();
  const ids = metas.filter((meta) => meta.deletedAt).map((meta) => String(meta.id));
  return purgeAssets(ids);
}

/* ------------------------------ 通用文件 ------------------------------ */

function fileMetaPath(id) {
  return recordPath(FILES_DIR, id);
}

/** 通用文件二进制路径。 */
export function fileBlobPath(id) {
  return join(FILE_BLOBS_DIR, assertId(id));
}

/** 列出全部通用文件元数据。 */
export function listFiles() {
  return listRecords(FILES_DIR);
}

/** 读取单个通用文件元数据。 */
export function getFile(id) {
  return readJson(fileMetaPath(id), null);
}

/** 保存通用文件元数据。 */
export function saveFile(meta) {
  return exclusive(() => writeJson(fileMetaPath(meta.id), meta));
}

/** 删除通用文件（元数据 + 二进制）。 */
export async function removeFileRecord(id) {
  await exclusive(async () => {
    await removeFile(fileMetaPath(id));
    await removeFile(fileBlobPath(id));
  });
}

/* ------------------------------- 文件夹 ------------------------------- */

/** 读取全部资源文件夹（旧数据缺字段时由前端补齐）。 */
export function listFolders() {
  return readJson(FOLDERS_FILE, []).then((value) => (Array.isArray(value) ? value : []));
}

/**
 * 写入（覆盖）一个文件夹。
 * @param {object} folder
 */
export function saveFolder(folder) {
  return exclusive(async () => {
    const folders = await readJson(FOLDERS_FILE, []);
    const list = Array.isArray(folders) ? folders.filter((item) => item.id !== folder.id) : [];
    list.push(folder);
    await writeJson(FOLDERS_FILE, list);
  });
}

/**
 * 批量删除文件夹记录（不处理其中的资源，资源归属由调用方调整）。
 * @param {string[]} ids
 */
export function removeFolders(ids) {
  return exclusive(async () => {
    const folders = await readJson(FOLDERS_FILE, []);
    const set = new Set(ids);
    await writeJson(FOLDERS_FILE, (Array.isArray(folders) ? folders : []).filter((item) => !set.has(item.id)));
  });
}

/** 判断二进制文件是否存在（用于源地址存在性检查）。 */
export async function blobExists(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
