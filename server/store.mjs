/**
 * store.mjs —— 后端本地数据存储（按用户隔离）
 *
 * 职责：
 * - 在 `data/users/<userId>/` 下维护该用户的作品、封面、资源元数据、文件夹与文件元数据；
 * - 提供 JSON 原子写入（临时文件 + rename）与串行写队列，避免并发请求互相覆盖；
 * - 提供安全路径计算（id 白名单，杜绝路径穿越），资源与文件的二进制内容不落本地，
 *   统一存放在 MinIO（见 server/minio.mjs）。
 *
 * 目录布局（默认 data/，可用 SLIDE_DATA_DIR 环境变量改写）：
 * - accounts/<userId>.json       账号记录（由 server/users.mjs 维护）
 * - users/<userId>/decks/<id>.json    完整 Deck JSON
 * - users/<userId>/covers/<id>.json   首页封面 { id, dataUrl, deckUpdatedAt, at }
 * - users/<userId>/assets/<id>.json   资源元数据 AssetMeta（不含二进制）
 * - users/<userId>/files/<id>.json    通用文件元数据 { id, name, mime, size, createdAt }
 * - users/<userId>/folders.json       资源文件夹数组
 * - sessions.json                登录会话（由 server/auth.mjs 维护）
 * - tmp/                         上传中转目录
 *
 * 所有读写函数都要求显式传入 userId，调用方（路由层）只能使用当前登录用户 id，
 * 从结构上杜绝跨用户读取。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（server/ 的上一级）。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 数据根目录：优先使用环境变量，便于把数据放到其他磁盘。 */
export const DATA_DIR = process.env.SLIDE_DATA_DIR
  ? resolve(process.env.SLIDE_DATA_DIR)
  : resolve(ROOT, 'data');

/** 各类记录与二进制所在的子目录 / 文件路径。 */
const USERS_DIR = join(DATA_DIR, 'users');
export const ACCOUNTS_DIR = join(DATA_DIR, 'accounts');
export const TMP_DIR = join(DATA_DIR, 'tmp');
export const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');

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

/** 用户数据根目录。 */
export function userDir(userId) {
  return join(USERS_DIR, assertId(userId));
}

/** 账号记录文件的路径。 */
export function accountPath(id) {
  return join(ACCOUNTS_DIR, `${assertId(id)}.json`);
}

/** 确保账号目录存在（users.mjs 写账号前调用）。 */
export function ensureAccountsDir() {
  return mkdir(ACCOUNTS_DIR, { recursive: true });
}

/**
 * 确保全部基础目录存在（服务启动时调用一次）。
 */
export async function ensureDataDirs() {
  for (const dir of [DATA_DIR, USERS_DIR, ACCOUNTS_DIR, TMP_DIR]) {
    await mkdir(dir, { recursive: true });
  }
}

/** 确保指定用户的全部数据子目录存在（注册账号时调用）。 */
export async function ensureUserDirs(userId) {
  const base = userDir(userId);
  for (const dir of [base, join(base, 'decks'), join(base, 'covers'), join(base, 'assets'), join(base, 'files')]) {
    await mkdir(dir, { recursive: true });
  }
}

/** 删除某个用户的全部本地数据（账号删除时级联调用）。 */
export async function removeUserData(userId) {
  await rm(userDir(userId), { recursive: true, force: true });
}

/**
 * 读取 JSON 文件；文件不存在时返回兜底值，内容损坏时同样返回兜底值并告警。
 * @param {string} file 绝对路径
 * @param {*} fallback 兜底值
 */
export async function readJson(file, fallback) {
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
export async function writeJson(file, value) {
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

/** 用户数据下的某个子目录。 */
function userSubDir(userId, name) {
  return join(userDir(userId), name);
}

/* -------------------------------- 作品 -------------------------------- */

/** 列出当前用户全部作品原始 JSON（顺序由文件系统决定，前端自行排序）。 */
export function listDecks(userId) {
  return listRecords(userSubDir(userId, 'decks'));
}

/** 读取当前用户的单个作品；不存在返回 null。 */
export function getDeck(userId, id) {
  return readJson(recordPath(userSubDir(userId, 'decks'), id), null);
}

/** 覆盖写入当前用户的作品。 */
export function saveDeck(userId, deck) {
  return exclusive(() => writeJson(recordPath(userSubDir(userId, 'decks'), deck.id), deck));
}

/**
 * 删除作品，并级联删除其首页封面。
 * @param {string} userId
 * @param {string} id
 */
export async function removeDeck(userId, id) {
  const base = userDir(userId);
  await exclusive(async () => {
    await removeFile(recordPath(join(base, 'decks'), id));
    await removeFile(recordPath(join(base, 'covers'), id));
  });
}

/* ------------------------------ 首页封面 ------------------------------ */

/** 列出当前用户全部封面记录。 */
export function listCovers(userId) {
  return listRecords(userSubDir(userId, 'covers'));
}

/** 读取当前用户的单个作品封面；不存在返回 null。 */
export function getCover(userId, id) {
  return readJson(recordPath(userSubDir(userId, 'covers'), id), null);
}

/** 写入（覆盖）封面记录。 */
export function saveCover(userId, cover) {
  return exclusive(() => writeJson(recordPath(userSubDir(userId, 'covers'), cover.id), cover));
}

/** 删除封面记录。 */
export async function removeCover(userId, id) {
  await exclusive(() => removeFile(recordPath(userSubDir(userId, 'covers'), id)));
}

/* -------------------------------- 资源 -------------------------------- */

/** 资源元数据文件路径。 */
function assetMetaPath(userId, id) {
  return recordPath(userSubDir(userId, 'assets'), id);
}

/** 列出当前用户全部资源元数据。 */
export function listAssets(userId) {
  return listRecords(userSubDir(userId, 'assets'));
}

/** 读取当前用户的单个资源元数据；不存在返回 null。 */
export function getAsset(userId, id) {
  return readJson(assetMetaPath(userId, id), null);
}

/**
 * 保存资源元数据。
 * @param {string} userId
 * @param {object} meta
 */
export function saveAsset(userId, meta) {
  return exclusive(() => writeJson(assetMetaPath(userId, meta.id), meta));
}

/** 仅更新资源元数据（覆盖写入）。 */
export function saveAssetMeta(userId, meta) {
  return exclusive(() => writeJson(assetMetaPath(userId, meta.id), meta));
}

/**
 * 在串行队列中批量更新当前用户的资源元数据。
 * @param {string} userId
 * @param {string[]} ids
 * @param {(meta: object, now: number) => object | null} patch 返回新元数据或 null（跳过）
 * @returns {Promise<number>} 实际更新数量
 */
export function patchAssets(userId, ids, patch) {
  return exclusive(async () => {
    let changed = 0;
    const now = Date.now();
    for (const id of ids) {
      const meta = await getAsset(userId, id);
      if (!meta) continue;
      const next = patch(meta, now);
      if (!next) continue;
      await writeJson(assetMetaPath(userId, id), { ...next, id });
      changed += 1;
    }
    return changed;
  });
}

/**
 * 永久删除当前用户的资源元数据（二进制由路由层同步从 MinIO 删除）。
 * @param {string} userId
 * @param {string[]} ids
 * @returns {Promise<number>} 实际删除数量
 */
export function purgeAssets(userId, ids) {
  return exclusive(async () => {
    let removed = 0;
    for (const id of ids) {
      const meta = await getAsset(userId, id);
      if (!meta) continue;
      await removeFile(assetMetaPath(userId, id));
      removed += 1;
    }
    return removed;
  });
}

/* ------------------------------ 通用文件 ------------------------------ */

function fileMetaPath(userId, id) {
  return recordPath(userSubDir(userId, 'files'), id);
}

/** 列出当前用户全部通用文件元数据。 */
export function listFiles(userId) {
  return listRecords(userSubDir(userId, 'files'));
}

/** 读取当前用户的单个通用文件元数据。 */
export function getFile(userId, id) {
  return readJson(fileMetaPath(userId, id), null);
}

/** 保存通用文件元数据。 */
export function saveFile(userId, meta) {
  return exclusive(() => writeJson(fileMetaPath(userId, meta.id), meta));
}

/** 删除通用文件元数据（二进制由路由层同步从 MinIO 删除）。 */
export async function removeFileRecord(userId, id) {
  await exclusive(() => removeFile(fileMetaPath(userId, id)));
}

/* ------------------------------- 文件夹 ------------------------------- */

/** 当前用户的文件夹记录文件。 */
function foldersFile(userId) {
  return join(userDir(userId), 'folders.json');
}

/** 读取当前用户全部资源文件夹（旧数据缺字段时由前端补齐）。 */
export function listFolders(userId) {
  return readJson(foldersFile(userId), []).then((value) => (Array.isArray(value) ? value : []));
}

/**
 * 写入（覆盖）一个文件夹。
 * @param {string} userId
 * @param {object} folder
 */
export function saveFolder(userId, folder) {
  return exclusive(async () => {
    const folders = await readJson(foldersFile(userId), []);
    const list = Array.isArray(folders) ? folders.filter((item) => item.id !== folder.id) : [];
    list.push(folder);
    await writeJson(foldersFile(userId), list);
  });
}

/**
 * 批量删除文件夹记录（不处理其中的资源，资源归属由调用方调整）。
 * @param {string} userId
 * @param {string[]} ids
 */
export function removeFolders(userId, ids) {
  return exclusive(async () => {
    const folders = await readJson(foldersFile(userId), []);
    const set = new Set(ids);
    await writeJson(foldersFile(userId), (Array.isArray(folders) ? folders : []).filter((item) => !set.has(item.id)));
  });
}
