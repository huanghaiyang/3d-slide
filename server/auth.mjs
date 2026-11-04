/**
 * auth.mjs —— 登录会话与鉴权中间件
 *
 * 职责：
 * - 基于服务端会话 + HttpOnly Cookie（`slide_sid`）实现登录态，刷新页面后仍然有效；
 * - 会话表持久化到 `data/sessions.json`，服务重启后已登录用户不会掉线；
 * - 提供 requireAuth / requireAdmin 中间件，路由层据此拿到当前账号。
 *
 * 安全约定：
 * - sid 为 32 字节随机数，仅通过 HttpOnly Cookie 传递，前端脚本读不到；
 * - SameSite=Lax 防止跨站请求携带会话；本地开发走 http，因此不设置 Secure；
 * - 会话有效期 7 天，过期后自动失效并从会话表移除。
 */

import { randomBytes } from 'node:crypto';
import { httpError, readJson, SESSIONS_FILE, writeJson, exclusive } from './store.mjs';
import { getAccount } from './users.mjs';

/** 会话 Cookie 名。 */
const COOKIE_NAME = 'slide_sid';
/** 会话有效期：7 天（毫秒）。 */
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

/** sid → { userId, createdAt, expiresAt }。 */
const sessions = new Map();

/** 解析 Cookie 请求头为对象。 */
function parseCookies(header) {
  const result = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      result[key] = part.slice(index + 1).trim();
    }
  }
  return result;
}

/** 把内存中的会话表原子写回磁盘。 */
function persistSessions() {
  const rows = [...sessions.entries()].map(([sid, value]) => ({ sid, ...value }));
  return exclusive(() => writeJson(SESSIONS_FILE, rows)).catch((error) => {
    console.warn('[auth] 会话持久化失败：', error?.message ?? error);
  });
}

/** 服务启动时加载会话表，并清理已过期的记录。 */
export async function initAuth() {
  const rows = await readJson(SESSIONS_FILE, []);
  if (Array.isArray(rows)) {
    const now = Date.now();
    for (const row of rows) {
      if (!row?.sid || !row.userId) continue;
      if (typeof row.expiresAt !== 'number' || row.expiresAt <= now) continue;
      sessions.set(row.sid, { userId: row.userId, createdAt: row.createdAt ?? now, expiresAt: row.expiresAt });
    }
  }
  // 有记录被清理时才回写，避免每次启动都产生无意义的写盘
  if (Array.isArray(rows) && rows.length !== sessions.size) await persistSessions();
}

/** 读取请求携带的会话 id。 */
export function sessionIdOf(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] ?? null;
}

/** 设置登录 Cookie。 */
function setSessionCookie(res, sid, maxAgeSeconds) {
  res.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`,
  );
}

/**
 * 创建会话并写入 Cookie。
 * @returns {Promise<string>} 新会话 id
 */
export async function createSession(res, userId) {
  const sid = randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(sid, { userId, createdAt: now, expiresAt: now + SESSION_TTL });
  setSessionCookie(res, sid, Math.floor(SESSION_TTL / 1000));
  await persistSessions();
  return sid;
}

/**
 * 销毁当前请求的会话并清除 Cookie。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function destroySession(req, res) {
  const sid = sessionIdOf(req);
  if (sid && sessions.delete(sid)) await persistSessions();
  setSessionCookie(res, '', 0);
}

/**
 * 读取当前请求对应的账号。
 * @param {import('express').Request} req
 * @returns {Promise<object | null>} 未登录 / 已过期 / 账号已删除时返回 null
 */
export async function authUser(req) {
  const sid = sessionIdOf(req);
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sid);
    await persistSessions();
    return null;
  }
  const account = await getAccount(session.userId);
  if (!account) {
    // 账号已被删除：顺手清掉残留会话
    sessions.delete(sid);
    await persistSessions();
    return null;
  }
  return account;
}

/** 删除某个用户的全部会话（管理员删除用户时调用）。 */
export async function dropUserSessions(userId) {
  let changed = false;
  for (const [sid, session] of sessions) {
    if (session.userId === userId) {
      sessions.delete(sid);
      changed = true;
    }
  }
  if (changed) await persistSessions();
}

/**
 * 鉴权中间件：通过后把账号挂到 req.user。
 */
export function requireAuth(req, res, next) {
  authUser(req)
    .then((account) => {
      if (!account) {
        res.status(401).json({ error: '请先登录' });
        return;
      }
      req.user = account;
      next();
    })
    .catch(next);
}

/** 管理员权限校验，需放在 requireAuth 之后。 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}

/** 登录 / 注册接口可复用的账号不存在错误。 */
export function invalidCredentials() {
  return httpError(401, '用户名或密码不正确');
}
