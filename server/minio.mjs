/**
 * minio.mjs —— MinIO 对象存储访问层
 *
 * 职责：
 * - 把资源库与通用文件的二进制内容保存到 MinIO（S3 兼容），本地只保留元数据 JSON；
 * - 提供上传、存在性检查、流式下载（支持 HTTP Range）、删除与按用户前缀清理；
 * - 启动时确保桶存在；MinIO 不可用时给出可操作的 503 提示。
 *
 * 对象 key 约定：
 * - 资源：`users/<userId>/assets/<id>`
 * - 文件：`users/<userId>/files/<id>`
 *
 * 配置（环境变量，默认值与 docker-compose.yml 一致）：
 * - MINIO_ENDPOINT（默认 127.0.0.1）
 * - MINIO_PORT（默认 9000）
 * - MINIO_USE_SSL（默认 false）
 * - MINIO_ACCESS_KEY / MINIO_SECRET_KEY（默认 minioadmin / minioadmin）
 * - MINIO_BUCKET（默认 3d-slide）
 */

import { Client } from 'minio';
import { assertId, httpError } from './store.mjs';

/** 连接配置。 */
const ENDPOINT = process.env.MINIO_ENDPOINT ?? '127.0.0.1';
const PORT = Number(process.env.MINIO_PORT ?? 9000);
const USE_SSL = String(process.env.MINIO_USE_SSL ?? 'false') === 'true';
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? 'minioadmin';
const SECRET_KEY = process.env.MINIO_SECRET_KEY ?? 'minioadmin';
/** 存放全部内容的桶名。 */
export const MINIO_BUCKET = process.env.MINIO_BUCKET ?? '3d-slide';

const client = new Client({
  endPoint: ENDPOINT,
  port: PORT,
  useSSL: USE_SSL,
  accessKey: ACCESS_KEY,
  secretKey: SECRET_KEY,
});

/** 桶是否已确认存在（成功检查后缓存，避免每次请求都访问 MinIO）。 */
let bucketReady = false;

/** 对象不存在时的错误码集合。 */
function isNotFound(error) {
  return (
    error?.code === 'NotFound' ||
    error?.code === 'NoSuchKey' ||
    error?.code === 'NoSuchBucket' ||
    error?.code === 'NoSuchObject' ||
    error?.statusCode === 404
  );
}

/** 把 MinIO 的底层错误转成带可操作提示的 503。 */
function storageError(error) {
  if (error?.status) return error;
  return httpError(
    503,
    `MinIO 对象存储不可用（${error?.message ?? '连接失败'}），请先在项目目录运行 npm run minio`,
  );
}

/** 确保桶存在（服务启动时调用；失败只告警，请求时再给出 503）。 */
export async function ensureBucket() {
  if (bucketReady) return;
  try {
    const exists = await client.bucketExists(MINIO_BUCKET);
    if (!exists) await client.makeBucket(MINIO_BUCKET);
    bucketReady = true;
  } catch (error) {
    throw storageError(error);
  }
}

/** 资源对象的 key。 */
export function assetObjectKey(userId, id) {
  return `users/${assertId(userId)}/assets/${assertId(id)}`;
}

/** 通用文件对象的 key。 */
export function fileObjectKey(userId, id) {
  return `users/${assertId(userId)}/files/${assertId(id)}`;
}

/**
 * 上传本地中转文件到 MinIO。
 * @param {string} filePath 本地临时文件路径
 * @param {string} objectKey 对象 key
 * @param {string} mime Content-Type（空值时由 MinIO 使用默认类型）
 */
export async function putObjectFromFile(filePath, objectKey, mime) {
  await ensureBucket();
  try {
    await client.fPutObject(MINIO_BUCKET, objectKey, filePath, mime ? { 'Content-Type': mime } : {});
  } catch (error) {
    throw storageError(error);
  }
}

/**
 * 读取对象元信息。
 * @returns {Promise<{ size: number, etag: string } | null>} 不存在时返回 null
 */
export async function statObject(objectKey) {
  await ensureBucket();
  try {
    const stat = await client.statObject(MINIO_BUCKET, objectKey);
    return { size: Number(stat.size), etag: stat.etag };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw storageError(error);
  }
}

/** 打开对象读取流。 */
export async function openObject(objectKey, options) {
  await ensureBucket();
  try {
    return await client.getObject(MINIO_BUCKET, objectKey, options);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw storageError(error);
  }
}

/** 删除单个对象；对象不存在时静默返回。 */
export async function removeObject(objectKey) {
  await ensureBucket();
  try {
    await client.removeObject(MINIO_BUCKET, objectKey);
  } catch (error) {
    if (isNotFound(error)) return;
    throw storageError(error);
  }
}

/**
 * 清理某个用户前缀下的全部对象（删除账号时调用）。
 * @param {string} userId
 */
export async function removeUserObjects(userId) {
  await ensureBucket();
  try {
    const keys = [];
    await new Promise((resolve, reject) => {
      const stream = client.listObjectsV2(MINIO_BUCKET, `users/${assertId(userId)}/`, true);
      stream.on('data', (item) => {
        if (item?.name) keys.push(item.name);
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    // 每批 1000 个，避免单次请求体过大
    for (let index = 0; index < keys.length; index += 1000) {
      await client.removeObjects(MINIO_BUCKET, keys.slice(index, index + 1000));
    }
  } catch (error) {
    if (isNotFound(error)) return;
    throw storageError(error);
  }
}

/** 解析 Range 请求头。 */
function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null && end === null) return { invalid: true };
  if (start === null) {
    // `bytes=-N`：取最后 N 个字节
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (end === null || end >= size) end = size - 1;
  }
  if (start >= size || start > end) return { invalid: true };
  return { start, end, offset: start, length: end - start + 1 };
}

/**
 * 把对象流式写入响应，支持 Range（视频拖动进度条需要）。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} objectKey 对象 key
 * @param {object | null} meta 元数据（用于 Content-Type / 文件名）
 * @param {string} label 错误文案中的主体（如「资源」「文件」）
 * @param {boolean} withFilename 是否附加原始文件名
 */
export async function serveObject(req, res, objectKey, meta, label = '文件', withFilename = false) {
  const stat = await statObject(objectKey);
  if (!stat) throw httpError(404, `${label}不存在`);

  res.setHeader('Content-Type', meta?.mime || 'application/octet-stream');
  // id 不变即内容不变，允许浏览器长时间缓存，避免重复下载大素材
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  if (withFilename && typeof meta?.name === 'string' && meta.name) {
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  }

  const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
  if (range?.invalid) {
    res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
    res.end();
    return;
  }

  let stream;
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader('Content-Length', String(range.length));
    stream = await openObject(objectKey, { offset: range.offset, length: range.length });
  } else {
    res.setHeader('Content-Length', String(stat.size));
    stream = await openObject(objectKey);
  }
  if (!stream) throw httpError(404, `${label}不存在`);

  stream.on('error', (error) => {
    console.error(`[minio] 读取 ${objectKey} 失败：`, error?.message ?? error);
    if (!res.headersSent) {
      res.status(502).json({ error: '对象存储读取失败' });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

/** 健康检查：返回 MinIO 是否可用（供 /api/health 使用）。 */
export async function minioStatus() {
  try {
    await ensureBucket();
    return { ok: true, bucket: MINIO_BUCKET, endpoint: `${ENDPOINT}:${PORT}` };
  } catch (error) {
    return {
      ok: false,
      bucket: MINIO_BUCKET,
      endpoint: `${ENDPOINT}:${PORT}`,
      error: error?.message ?? '连接失败',
    };
  }
}
