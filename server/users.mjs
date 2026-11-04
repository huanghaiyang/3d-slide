/**
 * users.mjs —— 账号存储与密码校验
 *
 * 职责：
 * - 账号记录落盘在 `data/accounts/<id>.json`，包含用户名、角色与 scrypt 密码哈希；
 * - 支持免注册的临时访客账号（isGuest），以及访客原地升级为正式账号
 *   （账号 id 不变，作品 / 素材 / 文件夹等数据无需迁移）；
 * - 注册时校验用户名 / 密码格式、防止重名，并把首个正式账号设为管理员；
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
    isGuest: Boolean(account.isGuest),
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
 * 校验并归一化注册凭据。
 * @returns {{ username: string, password: string }}
 */
function readCredentials(rawUsername, rawPassword) {
  const username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  if (!USERNAME_PATTERN.test(username)) {
    throw httpError(400, '用户名需为 2–24 个中英文、数字、下划线或短横线');
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw httpError(400, `密码长度需为 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符`);
  }
  return { username, password };
}

/** 用户名是否已被其他账号占用。 */
function usernameTaken(accounts, username, exceptId) {
  const target = username.toLowerCase();
  return accounts.some(
    (account) => account.id !== exceptId && String(account.username).toLowerCase() === target,
  );
}

/**
 * 注册账号。
 *
 * 首个正式（非访客）账号自动成为管理员；后续账号均为普通成员。
 * 列表与写入放在同一串行队列中，避免并发注册绕过重名检查或产生两个管理员。
 *
 * @param {unknown} rawUsername
 * @param {unknown} rawPassword
 * @returns {Promise<object>} 完整账号记录（路由层需用 publicAccount 过滤后再返回）
 */
export function createAccount(rawUsername, rawPassword) {
  const { username, password } = readCredentials(rawUsername, rawPassword);
  return exclusiveAccount(async () => {
    await ensureAccountsDir();
    const accounts = await listAccounts();
    if (usernameTaken(accounts, username)) throw httpError(409, '用户名已被占用');
    const id = randomUUID();
    const account = {
      id,
      username,
      // 访客账号不参与管理员判定：第一个正式注册的账号才是管理员
      role: accounts.some((item) => !item.isGuest) ? 'user' : 'admin',
      passwordHash: await hashPassword(password),
      isGuest: false,
      createdAt: Date.now(),
    };
    await writeJson(accountPath(id), account);
    await ensureUserDirs(id);
    return account;
  });
}

/**
 * 创建临时访客账号（无需用户名密码，由服务端自动命名）。
 */
export function createGuestAccount() {
  return exclusiveAccount(async () => {
    await ensureAccountsDir();
    const accounts = await listAccounts();
    const id = randomUUID();
    const account = {
      id,
      username: nextGuestName(accounts),
      role: 'user',
      passwordHash: null,
      isGuest: true,
      createdAt: Date.now(),
    };
    await writeJson(accountPath(id), account);
    await ensureUserDirs(id);
    return account;
  });
}

/** 生成未被占用的访客昵称，如「访客-3F8A2C」。 */
function nextGuestName(accounts) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const username = `访客-${randomBytes(3).toString('hex').toUpperCase()}`;
    if (!usernameTaken(accounts, username)) return username;
  }
  return `访客-${randomUUID().slice(0, 8)}`;
}

/**
 * 把当前访客账号原地升级为正式账号。
 *
 * 账号 id 保持不变，因此该用户已有的作品、素材、文件夹与文件记录都自然保留，
 * 不需要复制或迁移任何数据。
 *
 * @param {string} id 当前访客账号 id
 * @param {unknown} rawUsername 新用户名
 * @param {unknown} rawPassword 新密码
 * @returns {Promise<object>} 升级后的账号记录
 */
export function upgradeGuestAccount(id, rawUsername, rawPassword) {
  const { username, password } = readCredentials(rawUsername, rawPassword);
  return exclusiveAccount(async () => {
    const account = await getAccount(id);
    if (!account) throw httpError(404, '账号不存在');
    if (!account.isGuest) throw httpError(409, '当前账号已是注册用户');
    const accounts = await listAccounts();
    if (usernameTaken(accounts, username, id)) throw httpError(409, '用户名已被占用');
    const next = {
      ...account,
      username,
      passwordHash: await hashPassword(password),
      isGuest: false,
      // 若此前还没有任何正式账号，则本次升级产生第一个管理员
      role: accounts.some((item) => !item.isGuest && item.id !== id) ? 'user' : 'admin',
    };
    await writeJson(accountPath(id), next);
    return next;
  });
}

/** 账号写队列：注册、访客创建与升级都串行执行，避免重名检查失效。 */
let accountChain = Promise.resolve();
function exclusiveAccount(task) {
  const run = accountChain.then(task);
  accountChain = run.catch(() => {});
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
  // 访客账号没有密码哈希，不能通过登录接口进入
  if (!account || account.isGuest) return null;
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
