/**
 * dev.mjs —— 一键启动全部开发服务
 *
 * 使用：`npm run dev`
 * 启动内容：
 * - 后端 server/index.mjs（账号 / 数据隔离 / 文件服务；会自动拉起 MinIO 容器）
 * - Vite 开发服务器（端口 5176，代理 /api 到后端）
 *
 * 其他命令：
 * - `npm run dev:web` 仅启动前端；
 * - `npm run restart` 停止旧进程并重新运行本脚本（一键重启全部服务）。
 *
 * 本脚本会把自身与子进程的 PID 写入 `.run/dev.json`，供 restart.mjs 精准结束进程。
 */

import { execFile, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 项目根目录（scripts/ 的上一级）。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** 运行期状态目录（已在 .gitignore 中忽略）。 */
const RUN_DIR = join(ROOT, '.run');
const PID_FILE = join(RUN_DIR, 'dev.json');

/** 已启动的子服务：{ name, child }。 */
const services = [];
/** 是否正在退出，避免多个退出事件重复触发。 */
let stopping = false;

/**
 * 给子进程输出加统一前缀，便于在同一终端区分来源。
 * @param {import('node:stream').Readable} stream
 * @param {string} prefix
 */
function pipeLines(stream, prefix) {
  const reader = createInterface({ input: stream });
  reader.on('line', (line) => console.log(`${prefix} ${line}`));
}

/**
 * 启动一个子服务。
 * @param {string} name 日志前缀
 * @param {string} entry 入口脚本绝对路径
 */
function startService(name, entry) {
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const prefix = `[${name}]`.padEnd(9);
  if (child.stdout) pipeLines(child.stdout, prefix);
  if (child.stderr) pipeLines(child.stderr, prefix);

  child.on('error', (error) => {
    console.error(`${prefix} 无法启动：${error?.message ?? error}`);
    void shutdown(1);
  });
  child.on('exit', (code, signal) => {
    console.log(`${prefix} 已退出（${signal ?? code}）`);
    // 任一服务意外退出时整体退出，避免留下半套服务
    if (!stopping) void shutdown(typeof code === 'number' ? code : 1);
  });

  services.push({ name, child });
  console.log(`${prefix} 启动中…`);
  return child;
}

/**
 * 结束一个子服务。
 * Windows 下用 taskkill /T 连同其子进程（如 Vite 拉起的 esbuild）一起结束，
 * 避免 Ctrl+C 后残留进程继续占用端口。
 * @param {import('node:child_process').ChildProcess} child
 */
async function killChild(child) {
  if (child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32' && child.pid) {
    await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
    return;
  }
  try {
    child.kill();
  } catch {
    // 进程已退出
  }
}

/**
 * 停止全部子服务并清理 PID 文件。
 * @param {number} code 退出码
 */
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all(services.map(({ child }) => killChild(child)));
  await rm(PID_FILE, { force: true }).catch(() => {});
  // 给子进程一点时间收尾；Windows 下 kill 基本立即生效
  setTimeout(() => process.exit(code), 300);
}

/** 把当前进程与子进程 PID 写入文件，供 restart 脚本使用。 */
async function writePidFile() {
  await mkdir(RUN_DIR, { recursive: true });
  const payload = {
    supervisor: process.pid,
    startedAt: Date.now(),
    services: services.map(({ name, child }) => ({ name, pid: child.pid })),
  };
  await writeFile(PID_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

console.log('启动全部服务：后端 + Vite（MinIO 会随后端自动拉起）…');
startService('server', join(ROOT, 'server', 'index.mjs'));
startService('web', join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'));
await writePidFile();
console.log('全部服务已启动：前端 http://localhost:5176 ，后端 http://127.0.0.1:8787');
