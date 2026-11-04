/**
 * restart.mjs —— 一键重启全部服务
 *
 * 使用：`npm run restart`
 * 流程：
 * 1. 读取 `.run/dev.json`，结束上一次 `npm run dev` 的监督进程与子进程；
 * 2. 兜底清理监听 8787（后端）与 5176（Vite）的残留进程（例如手动启动的服务）；
 * 3. 等待端口释放后，启动 scripts/dev.mjs，并接管其输出。
 */

import { execFile, spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
/** 项目根目录。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PID_FILE = join(ROOT, '.run', 'dev.json');

/** 需要释放的端口：后端（可用 PORT 覆盖）与 Vite 固定端口。 */
const PORTS = [Number(process.env.PORT ?? 8787), Number(process.env.SLIDE_DEV_PORT ?? 5176)];
/** 等待端口释放的最长时间。 */
const FREE_TIMEOUT = 10_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 结束指定进程（Windows 下连同子进程树一起结束）。
 * @param {number} pid
 */
async function killPid(pid) {
  if (!pid || pid === process.pid) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {});
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 进程已退出
  }
}

/** 结束上一次 dev 监督进程记录的全部 PID。 */
async function stopRecordedServices() {
  let payload;
  try {
    payload = JSON.parse(await readFile(PID_FILE, 'utf8'));
  } catch {
    return;
  }
  const pids = [payload.supervisor, ...(Array.isArray(payload.services) ? payload.services.map((item) => item.pid) : [])];
  for (const pid of pids) await killPid(Number(pid));
  await rm(PID_FILE, { force: true }).catch(() => {});
}

/**
 * 查询端口上的监听进程。
 * @param {number} port
 * @returns {Promise<number[]>}
 */
async function pidsOnPort(port) {
  if (process.platform === 'win32') {
    const command = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command]);
      return stdout
        .split(/\r?\n/)
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
    } catch {
      return [];
    }
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`]);
    return stdout
      .split(/\r?\n/)
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

/** 兜底：清理占用目标端口的残留进程。 */
async function freePorts() {
  for (const port of PORTS) {
    for (const pid of await pidsOnPort(port)) {
      console.log(`清理端口 ${port} 上的进程 ${pid}`);
      await killPid(pid);
    }
  }
}

/**
 * 等待全部端口释放。
 * @returns {Promise<boolean>}
 */
async function waitPortsFree() {
  const deadline = Date.now() + FREE_TIMEOUT;
  while (Date.now() < deadline) {
    let busy = false;
    for (const port of PORTS) {
      if ((await pidsOnPort(port)).length > 0) {
        busy = true;
        break;
      }
    }
    if (!busy) return true;
    await delay(500);
  }
  return false;
}

console.log('正在重启全部服务…');
await stopRecordedServices();
await freePorts();
if (!(await waitPortsFree())) {
  console.warn('部分端口仍被占用，仍尝试启动新服务…');
}

console.log('旧服务已停止，启动新服务…');
const child = spawn(process.execPath, [join(ROOT, 'scripts', 'dev.mjs')], {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
