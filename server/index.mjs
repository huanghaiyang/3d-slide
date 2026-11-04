/**
 * index.mjs —— 3d-slide 后端服务（Express）
 *
 * 职责：
 * - 账号体系：注册 / 登录 / 退出 / 当前用户，基于 HttpOnly Cookie 会话；
 * - 数据隔离：作品、封面、资源、文件夹、文件全部按 `req.user.id` 分区存储，
 *   任何跨用户按 id 访问都会被归属校验拦下；
 * - 文件存储：二进制内容统一放 MinIO（开源 S3 兼容），本地只存元数据；
 * - 管理员接口：用户列表与删除（级联清理数据与对象存储）；
 * - 构建产物存在时顺带托管 dist/，可用单进程部署（前端使用 hash 路由）。
 *
 * 启动：`npm run minio`（启动 MinIO）→ `npm run server`（默认端口 8787，可用 PORT 覆盖；
 * 数据目录用 SLIDE_DATA_DIR 覆盖）。开发时 Vite 会把 `/api` 代理到本服务。
 */

import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR,
  TMP_DIR,
  assertId,
  ensureDataDirs,
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
import {
  authenticate,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  publicAccount,
} from './users.mjs';
import {
  authUser,
  createSession,
  destroySession,
  dropUserSessions,
  initAuth,
  requireAdmin,
  requireAuth,
} from './auth.mjs';
import {
  assetObjectKey,
  ensureBucket,
  fileObjectKey,
  minioStatus,
  putObjectFromFile,
  removeObject,
  removeUserObjects,
  serveObject,
} from './minio.mjs';

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
// 作品 JSON 可能包含大量对象，需要放宽体积限制
app.use(express.json({ limit: MAX_BYTES }));

/** 上传先落到 tmp/，再直接推送到 MinIO，避免依赖 multipart 字段顺序。 */
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
 * 永久删除当前用户的资源：先删 MinIO 对象，再删元数据。
 * 对象删除失败时元数据会保留，避免产生「记录没了但文件还在」的孤儿对象。
 */
async function purgeUserAssets(userId, ids) {
  const targets = [];
  for (const id of ids) {
    if (await getAsset(userId, id)) targets.push(id);
  }
  for (const id of targets) await removeObject(assetObjectKey(userId, id));
  return purgeAssets(userId, targets);
}

/* -------------------------------- 账号 -------------------------------- */

app.post(
  '/api/auth/register',
  wrap(async (req, res) => {
    const body = asRecord(req.body, '注册信息');
    const account = await createAccount(body.username, body.password);
    await createSession(res, account.id);
    res.status(201).json({ user: publicAccount(account) });
  }),
);

app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    const body = asRecord(req.body, '登录信息');
    const account = await authenticate(body.username, body.password);
    if (!account) throw httpError(401, '用户名或密码不正确');
    await createSession(res, account.id);
    res.json({ user: publicAccount(account) });
  }),
);

app.post(
  '/api/auth/logout',
  wrap(async (req, res) => {
    await destroySession(req, res);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/auth/me',
  wrap(async (req, res) => {
    const account = await authUser(req);
    if (!account) throw httpError(401, '请先登录');
    res.json({ user: publicAccount(account) });
  }),
);

/* ------------------------------ 管理员 ------------------------------- */

app.get(
  '/api/admin/users',
  requireAuth,
  requireAdmin,
  wrap(async (_req, res) => {
    const accounts = await listAccounts();
    res.json(accounts.map(publicAccount));
  }),
);

app.delete(
  '/api/admin/users/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    if (id === req.user.id) throw httpError(400, '不能删除当前登录账号');
    const account = await getAccount(id);
    if (!account) throw httpError(404, '用户不存在');
    if (account.role === 'admin') {
      const admins = (await listAccounts()).filter((item) => item.role === 'admin');
      if (admins.length <= 1) throw httpError(400, '至少需要保留一个管理员');
    }
    // 对象存储清理失败不应阻断账号删除（数据目录仍会被移除）
    await removeUserObjects(id).catch((error) => {
      console.warn(`[admin] 清理用户 ${id} 的 MinIO 对象失败：`, error?.message ?? error);
    });
    await dropUserSessions(id);
    await deleteAccount(id);
    res.json({ ok: true });
  }),
);

/* -------------------------------- 作品 -------------------------------- */

app.get(
  '/api/decks',
  requireAuth,
  wrap(async (req, res) => {
    res.json(await listDecks(req.user.id));
  }),
);

app.get(
  '/api/decks/:id',
  requireAuth,
  wrap(async (req, res) => {
    const deck = await getDeck(req.user.id, assertId(req.params.id));
    if (!deck) throw httpError(404, '作品不存在');
    res.json(deck);
  }),
);

app.put(
  '/api/decks/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const deck = asRecord(req.body, '作品');
    if (deck.id !== id) throw httpError(400, '作品 id 与路径不一致');
    await saveDeck(req.user.id, deck);
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/decks/:id',
  requireAuth,
  wrap(async (req, res) => {
    await removeDeck(req.user.id, assertId(req.params.id));
    res.json({ ok: true });
  }),
);

/* ------------------------------ 首页封面 ------------------------------ */

app.get(
  '/api/covers',
  requireAuth,
  wrap(async (req, res) => {
    res.json(await listCovers(req.user.id));
  }),
);

app.get(
  '/api/covers/:id',
  requireAuth,
  wrap(async (req, res) => {
    const cover = await getCover(req.user.id, assertId(req.params.id));
    if (!cover) throw httpError(404, '封面不存在');
    res.json(cover);
  }),
);

app.put(
  '/api/covers/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const cover = asRecord(req.body, '封面');
    if (typeof cover.dataUrl !== 'string' || !cover.dataUrl) throw httpError(400, '封面缺少 dataUrl');
    await saveCover(req.user.id, { ...cover, id });
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/covers/:id',
  requireAuth,
  wrap(async (req, res) => {
    await removeCover(req.user.id, assertId(req.params.id));
    res.json({ ok: true });
  }),
);

/* -------------------------------- 资源 -------------------------------- */

/**
 * 新增资源：multipart 表单包含 `meta`（JSON 字符串）与 `file`（二进制）。
 * 前端已完成类型判断与缩略图生成，服务端只负责上传对象存储与元数据持久化。
 */
app.post(
  '/api/assets',
  requireAuth,
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
    try {
      await putObjectFromFile(req.file.path, assetObjectKey(req.user.id, id), req.file.mimetype);
    } finally {
      await discardTemp(req.file);
    }
    await saveAsset(req.user.id, record);
    res.json({ meta: record, url: `/api/assets/${id}/content` });
  }),
);

app.get(
  '/api/assets',
  requireAuth,
  wrap(async (req, res) => {
    res.json(await listAssets(req.user.id));
  }),
);

/** 资源内容：从 MinIO 流式返回，Content-Type 取自元数据。 */
app.get(
  '/api/assets/:id/content',
  requireAuth,
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const meta = await getAsset(req.user.id, id);
    if (!meta) throw httpError(404, '资源不存在');
    await serveObject(req, res, assetObjectKey(req.user.id, id), meta, '资源');
  }),
);

/** 局部更新资源元数据（重命名 / 移动 / 回填缩略图等）。 */
app.put(
  '/api/assets/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const existing = await getAsset(req.user.id, id);
    if (!existing) throw httpError(404, '资源不存在');
    const patch = asRecord(req.body, '资源补丁');
    await saveAssetMeta(req.user.id, { ...existing, ...patch, id, size: existing.size });
    res.json({ ok: true });
  }),
);

/** 移入回收站：只标记 deletedAt，二进制内容保留。 */
app.post(
  '/api/assets/trash',
  requireAuth,
  wrap(async (req, res) => {
    const ids = idList(req.body);
    const count = await patchAssets(req.user.id, ids, (meta, now) => ({
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
  requireAuth,
  wrap(async (req, res) => {
    const ids = idList(req.body);
    const folders = new Set((await listFolders(req.user.id)).map((folder) => folder.id));
    const count = await patchAssets(req.user.id, ids, (meta, now) => ({
      ...meta,
      deletedAt: null,
      folderId: meta.folderId && folders.has(meta.folderId) ? meta.folderId : null,
      updatedAt: now,
    }));
    res.json({ count });
  }),
);

/** 彻底删除：MinIO 对象与元数据一并清除。 */
app.post(
  '/api/assets/purge',
  requireAuth,
  wrap(async (req, res) => {
    const count = await purgeUserAssets(req.user.id, idList(req.body));
    res.json({ count });
  }),
);

/** 清空回收站。 */
app.post(
  '/api/assets/empty-trash',
  requireAuth,
  wrap(async (req, res) => {
    const ids = (await listAssets(req.user.id)).filter((meta) => meta.deletedAt).map((meta) => String(meta.id));
    res.json({ count: await purgeUserAssets(req.user.id, ids) });
  }),
);

/** 永久删除单个资源。 */
app.delete(
  '/api/assets/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    if (!(await getAsset(req.user.id, id))) throw httpError(404, '资源不存在');
    await purgeUserAssets(req.user.id, [id]);
    res.json({ ok: true });
  }),
);

/* ------------------------------- 文件夹 ------------------------------- */

app.get(
  '/api/folders',
  requireAuth,
  wrap(async (req, res) => {
    res.json(await listFolders(req.user.id));
  }),
);

app.put(
  '/api/folders/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const folder = asRecord(req.body, '文件夹');
    if (typeof folder.name !== 'string' || !folder.name.trim()) throw httpError(400, '文件夹缺少名称');
    await saveFolder(req.user.id, { ...folder, id, parentId: folder.parentId ?? null });
    res.json({ ok: true });
  }),
);

app.post(
  '/api/folders/delete',
  requireAuth,
  wrap(async (req, res) => {
    await removeFolders(req.user.id, idList(req.body));
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
  requireAuth,
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
    try {
      await putObjectFromFile(req.file.path, fileObjectKey(req.user.id, id), meta.mime);
    } finally {
      await discardTemp(req.file);
    }
    await saveFile(req.user.id, meta);
    res.json({ ...meta, url: `/api/files/${id}` });
  }),
);

app.get(
  '/api/files',
  requireAuth,
  wrap(async (req, res) => {
    const files = await listFiles(req.user.id);
    res.json(files.map((file) => ({ ...file, url: `/api/files/${file.id}` })));
  }),
);

app.get(
  '/api/files/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    const meta = await getFile(req.user.id, id);
    if (!meta) throw httpError(404, '文件不存在');
    await serveObject(req, res, fileObjectKey(req.user.id, id), meta, '文件', true);
  }),
);

app.delete(
  '/api/files/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = assertId(req.params.id);
    if (!(await getFile(req.user.id, id))) throw httpError(404, '文件不存在');
    await removeObject(fileObjectKey(req.user.id, id));
    await removeFileRecord(req.user.id, id);
    res.json({ ok: true });
  }),
);

/* ------------------------------- 其他 -------------------------------- */

app.get(
  '/api/health',
  wrap(async (_req, res) => {
    res.json({
      ok: true,
      service: '3d-slide-server',
      dataDir: DATA_DIR,
      minio: await minioStatus(),
    });
  }),
);

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
await initAuth();
const storage = await minioStatus();
if (!storage.ok) {
  console.warn(`[minio] ${storage.error}`);
  console.warn('[minio] 请先运行 npm run minio 启动对象存储（docker compose up -d）');
}

app.listen(PORT, () => {
  console.log(`3d-slide 后端已启动：http://127.0.0.1:${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
});
