/**
 * minio-bootstrap.mjs —— MinIO 随应用启动
 *
 * 职责：
 * - 后端启动时检查 MinIO 是否可用；不可用则自动执行 `docker compose up -d minio`；
 * - 容器启动后轮询等待服务就绪，并创建桶（由 minioStatus → ensureBucket 完成）；
 * - 启动过程不阻塞 HTTP 服务：服务先对外提供账号与作品功能，文件上传在 MinIO 就绪后恢复。
 *
 * 开关：`MINIO_AUTO_START=false` 可关闭自动启动（生产环境由外部编排托管时使用）。
 */

import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minioStatus } from './minio.mjs';

/** 项目根目录（docker-compose.yml 所在位置）。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** compose 启动命令：只拉起 minio 服务。 */
const COMPOSE_ARGS = ['compose', 'up', '-d', 'minio'];

/** 等待容器命令返回的最长时间（首次拉取镜像可能较慢）。 */
const COMPOSE_TIMEOUT = 5 * 60 * 1000;
/** compose 返回后等待 MinIO 服务就绪的最长时间。 */
const READY_TIMEOUT = 2 * 60 * 1000;

/** 简单延时。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行 docker compose up -d minio。
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
function runCompose() {
  return new Promise((finish) => {
    const child = spawn('docker', COMPOSE_ARGS, {
      cwd: ROOT,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      finish({ ok: false, message: '启动超时，请检查 Docker 镜像拉取状态' });
    }, COMPOSE_TIMEOUT);

    const collect = (chunk) => {
      output += String(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({ ok: false, message: error?.message ?? '无法执行 docker 命令' });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const summary = output.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      finish({
        ok: code === 0,
        message: code === 0 ? undefined : summary,
      });
    });
  });
}

/**
 * 确保 MinIO 随应用启动。
 *
 * @returns {Promise<boolean>} 是否已就绪
 */
export async function ensureMinioWithApp() {
  if (String(process.env.MINIO_AUTO_START ?? 'true') === 'false') return false;

  const current = await minioStatus();
  if (current.ok) {
    console.log(`[minio] 已连接：${current.endpoint}/${current.bucket}`);
    return true;
  }

  console.log('[minio] 未检测到 MinIO，正在随应用自动启动（docker compose up -d minio）…');
  const started = await runCompose();
  if (!started.ok) {
    console.warn(`[minio] 自动启动失败：${started.message ?? '未知错误'}`);
    console.warn('[minio] 请确认 Docker Desktop 已运行；也可手动执行 npm run minio');
    return false;
  }

  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    await delay(1500);
    const status = await minioStatus();
    if (status.ok) {
      console.log(`[minio] 已就绪：${status.endpoint}/${status.bucket}`);
      return true;
    }
  }
  console.warn('[minio] 容器已启动，但服务尚未就绪；文件上传会在就绪后自动恢复');
  return false;
}
