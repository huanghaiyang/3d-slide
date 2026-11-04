/**
 * api.ts —— 后端 HTTP 客户端
 *
 * 职责：把前端对作品、封面、资源库、文件夹的读写统一封装成 `/api/...` 请求，
 * 供 lib/storage.ts 以原有函数签名调用，避免上层组件感知数据来源的变化。
 *
 * 约定：
 * - 所有请求走同源相对路径，开发时由 Vite 代理到后端（生产可直接由后端托管 dist/）；
 * - 服务端错误统一返回 `{ error }`，这里转换成 Error，交给 UI 的 toast 展示；
 * - 连不上后端时给出可操作的提示（先运行 npm run server），而不是裸露的 fetch 异常；
 * - 资源内容不再以 dataURL 存库：上传时转成 Blob，读取时返回 `/api/assets/:id/content` 地址。
 */

import type { AssetFolder, AssetMeta } from './assets';

/** API 根路径（与 Vite 代理、后端路由保持一致）。 */
const BASE = '/api';

/** 登录用户信息（服务端已过滤掉密码哈希等敏感字段）。 */
export interface SessionUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  /** 是否为免注册的临时访客账号。 */
  isGuest: boolean;
  createdAt: number;
}

/** 带 HTTP 状态码的请求错误，便于调用方区分 401 / 403 等场景。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 会话失效（401）时的全局回调，由 App 注册以切回登录页。 */
let unauthorizedHandler: (() => void) | null = null;

/**
 * 注册 401 全局处理。
 * @param handler 传 null 取消注册
 */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

/** fetch 配置扩展：登录 / 注册接口自身返回 401 时不触发全局登出。 */
interface ApiOptions extends RequestInit {
  skipAuthHandler?: boolean;
}

/** 封面记录的线上结构，与 storage.ts 导出的 DeckCover 完全一致。 */
export interface CoverRecord {
  /** 对应作品 id。 */
  id: string;
  /** JPEG dataURL。 */
  dataUrl: string;
  /** 生成封面时的作品 updatedAt。 */
  deckUpdatedAt: number;
  /** 生成时间戳（毫秒）。 */
  at: number;
}

/** 后端资源元数据的响应结构：与 AssetMeta 相同。 */
export type AssetRecord = AssetMeta;

/**
 * 发起请求，并把网络层失败转成统一提示。
 * 401 会触发全局回调（登录失效时自动回到登录页）。
 * @param path 以 `/` 开头的接口路径
 * @param init fetch 配置
 */
async function apiFetch(path: string, init?: ApiOptions): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new Error('无法连接后端服务，请先在项目目录运行 npm run server');
  }
  if (response.status === 401 && !init?.skipAuthHandler) unauthorizedHandler?.();
  return response;
}

/**
 * 从非 2xx 响应里提取错误文案。
 * @param response fetch 响应
 */
async function errorOf(response: Response): Promise<ApiError> {
  let message = `请求失败（${response.status}）`;
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data?.error === 'string' && data.error) message = data.error;
  } catch {
    // 响应不是 JSON 时保留状态码文案
  }
  return new ApiError(message, response.status);
}

/**
 * 读取 JSON 响应。
 * @param path 接口路径
 * @param init fetch 配置
 * @returns 解析后的响应体；HTTP 204 时返回 null
 */
async function requestJson<T>(path: string, init?: ApiOptions): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw await errorOf(response);
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

/**
 * 读取 JSON 响应；404 视为「不存在」返回 null。
 * @param path 接口路径
 */
async function requestJsonOrNull<T>(path: string): Promise<T | null> {
  const response = await apiFetch(path);
  if (response.status === 404) return null;
  if (!response.ok) throw await errorOf(response);
  return (await response.json()) as T;
}

/** 构造 JSON 请求体。 */
function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/* -------------------------------- 账号 -------------------------------- */

/** 读取当前登录用户；未登录时抛出 status=401 的 ApiError。 */
export async function fetchMe(): Promise<SessionUser> {
  const data = await requestJson<{ user: SessionUser }>('/auth/me');
  return data.user;
}

/**
 * 创建（或复用）临时访客会话。
 *
 * 系统不强制注册：首次访问时由前端调用该接口，服务端自动创建一个访客账号；
 * 已有会话时直接返回当前账号，不会重复建号。
 */
export async function createGuest(): Promise<SessionUser> {
  const data = await requestJson<{ user: SessionUser }>('/auth/guest', {
    method: 'POST',
    skipAuthHandler: true,
  });
  return data.user;
}

/**
 * 登录。
 * @param username 用户名
 * @param password 密码
 */
export async function login(username: string, password: string): Promise<SessionUser> {
  const data = await requestJson<{ user: SessionUser }>('/auth/login', {
    ...jsonInit('POST', { username, password }),
    // 登录失败返回 401 属于正常业务结果，不触发全局登出
    skipAuthHandler: true,
  });
  return data.user;
}

/**
 * 注册（首个注册账号自动成为管理员）。
 * @param username 用户名
 * @param password 密码
 */
export async function register(username: string, password: string): Promise<SessionUser> {
  const data = await requestJson<{ user: SessionUser }>('/auth/register', {
    ...jsonInit('POST', { username, password }),
    skipAuthHandler: true,
  });
  return data.user;
}

/** 退出登录（清除服务端会话与 Cookie）。 */
export async function logout(): Promise<void> {
  await requestJson('/auth/logout', { method: 'POST' });
}

/* ------------------------------ 管理员 ------------------------------- */

/** 读取全部账号（仅管理员可调用）。 */
export function fetchUsers(): Promise<SessionUser[]> {
  return requestJson<SessionUser[]>('/admin/users');
}

/** 删除账号及其全部数据（仅管理员可调用）。 */
export async function deleteUser(id: string): Promise<void> {
  await requestJson(`/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* -------------------------------- 作品 -------------------------------- */

/** 读取全部作品的原始 JSON（校验与摘要由 storage.ts 负责）。 */
export function fetchDecks(): Promise<unknown[]> {
  return requestJson<unknown[]>('/decks');
}

/**
 * 读取单个作品的原始 JSON。
 * @param id 作品 id
 * @returns 不存在时返回 null
 */
export function fetchDeck(id: string): Promise<unknown | null> {
  return requestJsonOrNull<unknown>(`/decks/${encodeURIComponent(id)}`);
}

/** 写入（覆盖）作品。 */
export function putDeck(deck: unknown): Promise<void> {
  const id = (deck as { id?: unknown }).id;
  return requestJson(`/decks/${encodeURIComponent(String(id))}`, jsonInit('PUT', deck)).then(() => undefined);
}

/** 删除作品（服务端同时清理其封面）。 */
export async function deleteDeck(id: string): Promise<void> {
  await requestJson(`/decks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* ------------------------------ 首页封面 ------------------------------ */

/** 读取全部封面。 */
export function fetchCovers(): Promise<CoverRecord[]> {
  return requestJson<CoverRecord[]>('/covers');
}

/**
 * 读取指定作品的封面。
 * @param id 作品 id
 */
export function fetchCover(id: string): Promise<CoverRecord | null> {
  return requestJsonOrNull<CoverRecord>(`/covers/${encodeURIComponent(id)}`);
}

/** 写入（覆盖）封面。 */
export async function putCover(cover: CoverRecord): Promise<void> {
  await requestJson(`/covers/${encodeURIComponent(cover.id)}`, jsonInit('PUT', cover));
}

/** 删除封面。 */
export async function deleteCover(id: string): Promise<void> {
  await requestJson(`/covers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* -------------------------------- 资源 -------------------------------- */

/** 读取全部资源元数据。 */
export function fetchAssets(): Promise<AssetRecord[]> {
  return requestJson<AssetRecord[]>('/assets');
}

/** 把 Blob 读成 dataURL（保留原有渲染管线对 dataURL 的约定）。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('资源内容读取失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 读取资源内容。
 *
 * 后端只保存二进制，这里按需下载并还原为 dataURL：解析 Lottie、加载 3D 模型等
 * 现有渲染逻辑均假定 src 是 dataURL，因此门面层保持该契约。
 *
 * @param id 资源 id
 * @returns dataURL；资源不存在时返回 null
 */
export async function fetchAssetSource(id: string): Promise<string | null> {
  const response = await apiFetch(`/assets/${encodeURIComponent(id)}/content`);
  if (response.status === 404) return null;
  if (!response.ok) throw await errorOf(response);
  return blobToDataUrl(await response.blob());
}

/** 把 dataURL 还原成 Blob，用于 multipart 上传。 */
function dataUrlToBlob(src: string): Promise<Blob> {
  return fetch(src).then((response) => response.blob());
}

/**
 * 新增资源：元数据以 JSON 字段、内容以文件字段一起上传。
 * @param meta 资源元数据（id 由调用方分配）
 * @param src  资源内容（dataURL）
 */
export async function uploadAsset(meta: AssetRecord, src: string): Promise<void> {
  const blob = await dataUrlToBlob(src);
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  // 文件名只用于服务端 multipart 解析，实际落盘名由 id 决定
  form.append('file', blob, meta.name || meta.id);
  await requestJson('/assets', { method: 'POST', body: form });
}

/** 局部更新资源元数据（服务端做合并，无需回传整条记录）。 */
export async function updateAsset(id: string, patch: Partial<AssetMeta>): Promise<void> {
  await requestJson(`/assets/${encodeURIComponent(id)}`, jsonInit('PUT', patch));
}

/** 批量移入回收站。 */
export async function trashAssets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await requestJson('/assets/trash', jsonInit('POST', { ids }));
}

/** 批量从回收站还原。 */
export async function restoreAssets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await requestJson('/assets/restore', jsonInit('POST', { ids }));
}

/** 批量彻底删除（元数据与文件内容）。 */
export async function purgeAssets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await requestJson('/assets/purge', jsonInit('POST', { ids }));
}

/**
 * 清空回收站。
 * @returns 实际删除数量
 */
export async function emptyAssetTrash(): Promise<number> {
  const result = await requestJson<{ count: number }>('/assets/empty-trash', { method: 'POST' });
  return result?.count ?? 0;
}

/* ------------------------------- 文件夹 ------------------------------- */

/** 读取全部资源文件夹。 */
export function fetchFolders(): Promise<AssetFolder[]> {
  return requestJson<AssetFolder[]>('/folders');
}

/** 写入（覆盖）文件夹。 */
export async function putFolder(folder: AssetFolder): Promise<void> {
  await requestJson(`/folders/${encodeURIComponent(folder.id)}`, jsonInit('PUT', folder));
}

/** 批量删除文件夹记录。 */
export async function deleteFolders(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await requestJson('/folders/delete', jsonInit('POST', { ids }));
}
