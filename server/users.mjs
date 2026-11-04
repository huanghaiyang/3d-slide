/**
 * users.mjs —— 账号存储与密码校验
 *
 * 职责：
 * - 账号记录落盘在 `data/accounts/<id>.json`，包含用户名、角色与 scrypt 密码哈希；
 * - 注册时校验用户名 / 密码格式、防止重名，并把首个注册账号设为管理员；
 * - 提供账号查询、列表与删除（删除时级联清理该用户的全部数据目录）。
 *
 * 密码哈希使用 Node 内置 scrypt（不引入 bcrypt 等原生依赖）：
 * 存储格式为 `scrypt:<salt hex>:<derived key hex>`，校验时用 timingSafeEqual 比较。
 */

import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readdir, unlink } from 'node:fs/promises';
import {
  ACCOUNTS_DIR,
  accountPath,
  ensureAccountsDir,
  ensureUserDirs,
  httpError,
  readJson,
  removeUserData,
  writeJson,
} from './store.mjs';

const scrypt = promisify(scryptCallback);

/** 用户名：2–24 个字符，允许中英文、数字、下划线与短横线。 */
const USERNAME_PATTERN = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{2,24}$/;
/** 密码长度范围（字符数）。 */
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;

/** 对外的账号视图（绝不包含 passwordHash）。 */
export function publicAccount(account) {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    createdAt: account.createdAt,
  };
}

/**
 * 生成密码哈希。
 * @param {string} password
 * @returns {Promise<string>} `scrypt:<salt>:<hash>`
 */
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

/**
 * 校验密码是否匹配账号记录。
 * @param {string} passwordHash 存储的哈希
 * @param {string} password 待校验密码
 */
async function verifyPassword(passwordHash, password) {
  const parts = String(passwordHash ?? '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(await scrypt(password, salt, expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 读取单个账号；不存在返回 null。 */
export function getAccount(id) {
  return readJson(accountPath(id), null);
}

/** 列出全部账号（按创建时间升序）。 */
export async function listAccounts() {
  let names;
  try {
    names = await readdir(ACCOUNTS_DIR);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const accounts = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const account = await readJson(accountPath(name.slice(0, -'.json'.length)), null);
    if (account && typeof account === 'object' && account.id) accounts.push(account);
  }
  return accounts.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** 按用户名查找账号（不区分大小写）。 */
export async function findAccountByUsername(username) {
  const target = username.toLowerCase();
  const accounts = await listAccounts();
  return accounts.find((account) => String(account.username).toLowerCase() === target) ?? null;
}

/**
 * 注册账号。
 *
 * 首个注册的账号自动成为管理员；后续账号均为普通成员。
 * 列表与写入放在同一串行队列中，避免并发注册绕过重名检查或产生两个管理员。
 *
 * @param {unknown} rawUsername
 * @param {unknown} rawPassword
 * @returns {Promise<object>} 完整账号记录（路由层需用 publicAccount 过滤后再返回）
 */
export function createAccount(rawUsername, rawPassword) {
  const username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  if (!USERNAME_PATTERN.test(username)) {
    throw httpError(400, '用户名需为 2–24 个中英文、数字、下划线或短横线');
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw httpError(400, `密码长度需为 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符`);
  }
  return exclusiveCreate(username, password);
}

/** 在写队列中完成「查重 → 哈希 → 落盘 → 建用户目录」。 */
let createChain = Promise.resolve();
function exclusiveCreate(username, password) {
  const run = createChain.then(async () => {
    await ensureAccountsDir();
    const accounts = await listAccounts();
    if (accounts.some((account) => String(account.username).toLowerCase() === username.toLowerCase())) {
      throw httpError(409, '用户名已被占用');
    }
    const id = randomUUID();
    const account = {
      id,
      username,
      role: accounts.length === 0 ? 'admin' : 'user',
      passwordHash: await hashPassword(password),
      createdAt: Date.now(),
    };
    await writeJson(accountPath(id), account);
    await ensureUserDirs(id);
    return account;
  });
  createChain = run.catch(() => {});
  return run;
}

/**
 * 校验用户名密码，成功返回账号记录。
 * @returns {Promise<object | null>} 失败返回 null（不区分「用户不存在」与「密码错误」）
 */
export async function authenticate(rawUsername, rawPassword) {
  const username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  if (!username || !password) return null;
  const account = await findAccountByUsername(username);
  if (!account) return null;
  return (await verifyPassword(account.passwordHash, password)) ? account : null;
}

/**
 * 删除账号及其全部数据。
 * @param {string} id
 */
export async function deleteAccount(id) {
  await unlink(accountPath(id)).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await removeUserData(id);
}
