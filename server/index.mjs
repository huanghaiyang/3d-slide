/**
 * index.mjs —— 3d-slide 后端服务（Express）
 *
 * 职责：
 * - 作品存储：GET/PUT/DELETE `/api/decks`，与封面 `/api/covers`；
 * - 资源库：元数据 CRUD、回收站 / 还原 / 清空、二进制内容按需读取；
 * - 通用文件服务：上传、列表、下载（支持 Range）、删除；
 * - 资源文件夹的读写；
 * - 构建产物存在时顺带托管 dist/，可用单进程部署（前端使用 hash 路由）。
 *
 * 启动：`npm run server`（默认端口 8787，可用 PORT 覆盖；数据目录用 SLIDE_DATA_DIR 覆盖）。
 * 开发时 Vite 会把 `/api` 代理到本服务，因此前端只需请求同源 `/api/...`。
 */

import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TMP_DIR,
  DATA_DIR,
  assertId,
  assetBlobPath,
  blobExists,
  emptyAssetTrash,
  ensureDataDirs,
  fileBlobPath,
  getAsset,
  getCover,
  getDeck,
  getFile,
  httpError,
  listAssets,
  listCovers,
  listDecks,
  listFiles,
  listFolders,
  moveIntoPlace,
  newId,
  patchAssets,
  purgeAssets,
  removeCover,
  removeDeck,
  removeFileRecord,
  removeFolders,
  saveAsset,
  saveAssetMeta,
  saveCover,
  saveDeck,
  saveFile,
  saveFolder,
} from './store.mjs';

/** 服务端口。 */
const PORT = Number(process.env.PORT ?? 8787);
/** 单文件上传上限：与前端 LIMITS.projectBytes（200 MB）保持一致。 */
const MAX_BYTES = 200 * 1024 * 1024;
/** 服务端自身的根目录与构建产物目录。 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(dirname(HERE), 'dist');

/** Express 4 不会自动捕获异步错误，这里统一包一层转交给错误中间件。 */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const app = express();
app.disable('x-powered-by');
// 作品 JSON 可能包含大量对象（导入的旧作品甚至带内联 dataURL），需要放宽体积限制
app.use(express.json({ limit: MAX_BYTES }));

/** 上传先落到 tmp/，确定 id 后再移动到最终路径，避免依赖 multipart 字段顺序。 */
const upload = multer({ dest: TMP_DIR, limits: { fileSize: MAX_BYTES, files: 1 } });

/** 丢弃 multer 留下的中转文件（校验失败时调用）。 */
async function discardTemp(file) {
  if (!file?.path) return;
  await unlink(file.path).catch(() => {});
}

/** 校验请求体是普通对象；不是则返回 400。 */
function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, `${label} 必须是对象`);
  }
  return value;
}

/** 从请求体读取 id 数组；缺省或为空时返回空数组。 */
function idList(body) {
  const value = body?.ids;
  if (!Array.isArray(value)) throw httpError(400, 'ids 必须是数组');
  return value.map((id) => assertId(id));
}

/**
 * 流式返回二进制文件，支持 Range（视频拖动进度条需要）。
 * @param {import('express').Response} res
 * @param {string} path 绝对路径
 * @param {object | null} meta 元数据（用于 Content-Type）
 * @param {boolean} withFilename 是否附加原始文件名
 */
async function serveBlob(res, path, meta, withFilename = false) {
  if (!(await blobExists(path))) throw httpError(404, '文件不存在');
  res.setHeader('Content-Type', (meta?.mime || '') || 'application/octet-stream');
  // id 不变即内容不变，允许浏览器长时间缓存，避免重复下载大素材
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  if (withFilename && typeof meta?.name === 'string' && meta.name) {
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  }
  res.sendFile(path);
}

/* -------------------------------- 作品 -------------------------------- */

app.get(
  '/api/decks',
  wrap(async (_req, res) => {
    res.json(await listDecks());
  }),
);

app.get(
  '/api/decks/:id',
  wrap(async (req, res) => {
    const deck = await getDeck(assertId(req.params.id));
    if (!deck) throw httpError(404, '作品不存在');
    res.json(deck);
  }),
);

app.put(
  '/api/decks/:id',
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const deck = asRecord(req.body, '作品');
    if (deck.id !== id) throw httpError(400, '作品 id 与路径不一致');
    await saveDeck(deck);
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/decks/:id',
  wrap(async (req, res) => {
    await removeDeck(assertId(req.params.id));
    res.json({ ok: true });
  }),
);

/* ------------------------------ 首页封面 ------------------------------ */

app.get(
  '/api/covers',
  wrap(async (_req, res) => {
    res.json(await listCovers());
  }),
);

app.get(
  '/api/covers/:id',
  wrap(async (req, res) => {
    const cover = await getCover(assertId(req.params.id));
    if (!cover) throw httpError(404, '封面不存在');
    res.json(cover);
  }),
);

app.put(
  '/api/covers/:id',
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const cover = asRecord(req.body, '封面');
    if (typeof cover.dataUrl !== 'string' || !cover.dataUrl) throw httpError(400, '封面缺少 dataUrl');
    await saveCover({ ...cover, id });
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/covers/:id',
  wrap(async (req, res) => {
    await removeCover(assertId(req.params.id));
    res.json({ ok: true });
  }),
);

/* -------------------------------- 资源 -------------------------------- */

/**
 * 新增资源：multipart 表单包含 `meta`（JSON 字符串）与 `file`（二进制）。
 * 前端已完成类型判断与缩略图生成，服务端只负责落盘与元数据持久化。
 */
app.post(
  '/api/assets',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw httpError(400, '缺少文件内容');
    let meta;
    try {
      meta = asRecord(JSON.parse(String(req.body?.meta ?? '')), '资源元数据');
    } catch (error) {
      await discardTemp(req.file);
      throw error instanceof SyntaxError ? httpError(400, 'meta 不是合法 JSON') : error;
    }
    if (meta.id) assertId(String(meta.id));
    const id = meta.id ? String(meta.id) : newId();
    const record = { ...meta, id, size: req.file.size };
    await moveIntoPlace(req.file.path, assetBlobPath(id));
    await saveAsset(record);
    res.json({ meta: record, url: `/api/assets/${id}/content` });
  }),
);

app.get(
  '/api/assets',
  wrap(async (_req, res) => {
    res.json(await listAssets());
  }),
);

/** 资源内容：按 id 流式返回，Content-Type 取自元数据。 */
app.get(
  '/api/assets/:id/content',
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const meta = await getAsset(id);
    if (!meta) throw httpError(404, '资源不存在');
    await serveBlob(res, assetBlobPath(id), meta);
  }),
);

/** 局部更新资源元数据（重命名 / 移动 / 回填缩略图等）。 */
app.put(
  '/api/assets/:id',
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const existing = await getAsset(id);
    if (!existing) throw httpError(404, '资源不存在');
    const patch = asRecord(req.body, '资源补丁');
    await saveAssetMeta({ ...existing, ...patch, id, size: existing.size });
    res.json({ ok: true });
  }),
);

/** 移入回收站：只标记 deletedAt，二进制内容保留。 */
app.post(
  '/api/assets/trash',
  wrap(async (req, res) => {
    const ids = idList(req.body);
    const count = await patchAssets(ids, (meta, now) => ({
      ...meta,
      deletedAt: now,
      updatedAt: now,
    }));
    res.json({ count });
  }),
);

/** 从回收站还原：原文件夹已不存在时回退到根目录。 */
app.post(
  '/api/assets/restore',
  wrap(async (req, res) => {
    const ids = idList(req.body);
    const folders = new Set((await listFolders()).map((folder) => folder.id));
    const count = await patchAssets(ids, (meta, now) => ({
      ...meta,
      deletedAt: null,
      folderId: meta.folderId && folders.has(meta.folderId) ? meta.folderId : null,
      updatedAt: now,
    }));
    res.json({ count });
  }),
);

/** 彻底删除：元数据与二进制一并清除。 */
app.post(
  '/api/assets/purge',
  wrap(async (req, res) => {
    const count = await purgeAssets(idList(req.body));
    res.json({ count });
  }),
);

/** 清空回收站。 */
app.post(
  '/api/assets/empty-trash',
  wrap(async (_req, res) => {
    res.json({ count: await emptyAssetTrash() });
  }),
);

/** 永久删除单个资源。 */
app.delete(
  '/api/assets/:id',
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    if (!(await getAsset(id))) throw httpError(404, '资源不存在');
    await purgeAssets([id]);
    res.json({ ok: true });
  }),
);

/* ------------------------------- 文件夹 ------------------------------- */

app.get(
  '/api/folders',
  wrap(async (_req, res) => {
    res.json(await listFolders());
  }),
);

app.put(
  '/api/folders/:id',
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const folder = asRecord(req.body, '文件夹');
    if (typeof folder.name !== 'string' || !folder.name.trim()) throw httpError(400, '文件夹缺少名称');
    await saveFolder({ ...folder, id, parentId: folder.parentId ?? null });
    res.json({ ok: true });
  }),
);

app.post(
  '/api/folders/delete',
  wrap(async (req, res) => {
    await removeFolders(idList(req.body));
    res.json({ ok: true });
  }),
);

/* ------------------------------ 通用文件 ------------------------------ */

/**
 * 通用文件服务：上传任意文件并返回可访问的 URL。
 * 与资源库不同，这里不生成缩略图 / 尺寸等媒体元数据，仅做通用存取。
 */
app.post(
  '/api/files',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw httpError(400, '缺少文件内容');
    const id = newId();
    const name = String(req.body?.name || req.file.originalname || '未命名文件');
    const meta = {
      id,
      name,
      mime: String(req.body?.mime || req.file.mimetype || ''),
      size: req.file.size,
      createdAt: Date.now(),
    };
    await moveIntoPlace(req.file.path, fileBlobPath(id));
    await saveFile(meta);
    res.json({ ...meta, url: `/api/files/${id}` });
  }),
);

app.get(
  '/api/files',
  wrap(async (_req, res) => {
    const files = await listFiles();
    res.json(files.map((file) => ({ ...file, url: `/api/files/${file.id}` })));
  }),
);

app.get(
  '/api/files/:id',
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const meta = await getFile(id);
    if (!meta) throw httpError(404, '文件不存在');
    await serveBlob(res, fileBlobPath(id), meta, true);
  }),
);

app.delete(
  '/api/files/:id',
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    if (!(await getFile(id))) throw httpError(404, '文件不存在');
    await removeFileRecord(id);
    res.json({ ok: true });
  }),
);

/* ------------------------------- 其他 -------------------------------- */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: '3d-slide-server', dataDir: DATA_DIR });
});

/** 未匹配的 /api 请求统一返回 JSON，避免前端把 HTML 404 当成功解析。 */
app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

/** 有构建产物时顺带托管前端（hash 路由只需要静态文件，无需回退规则）。 */
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
}

/** 统一错误响应：multer 体积超限转 413，其余按 error.status 输出。 */
app.use((error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  let status = error?.status ?? 500;
  let message = error?.message ?? '服务器内部错误';
  if (error instanceof multer.MulterError) {
    status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = error.code === 'LIMIT_FILE_SIZE' ? '文件超过 200 MB 上限' : `上传失败：${error.code}`;
  }
  if (status >= 500) console.error('[server]', error);
  res.status(status).json({ error: message });
});

await ensureDataDirs();
app.listen(PORT, () => {
  console.log(`3d-slide 后端已启动：http://127.0.0.1:${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
});
