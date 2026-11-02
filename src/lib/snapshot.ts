/**
 * snapshot.ts —— 面向 AI / MCP 的只读工作区快照
 *
 * 职责：把当前工作区（作品、资源元数据、文件夹）压缩成一份「只读、脱敏」的结构化
 * JSON，供模型理解画布结构或 MCP 客户端按只读方式访问。
 *
 * 脱敏原则（见 buildWorkspaceSnapshot 的 policy 字段）：
 * - 永不写入 AI 配置与 API Key；
 * - 不写入资源二进制内容（src / dataURL）与缩略图，只保留元数据与结构描述；
 * - 画板文字内容默认隐藏，仅在显式开启 includeText 时输出（并截断长度）；
 * - 任何字段名命中 apikey / token / secret / password 等规则时递归剔除。
 *
 * 数据流：Deck / AssetMeta / AssetFolder -> objectSnapshot / frameView 白名单投影
 * -> stripSensitive 二次过滤 -> 纯 JSON 对象（不包含类实例与函数）。
 */

import type { AssetFolder, AssetMeta } from './assets';
import type { Deck, SlideObject, ViewState } from '../types';

/** 快照 schema 标识，带版本号，便于 MCP 侧识别格式并做兼容处理。 */
export const SNAPSHOT_SCHEMA = '3d-slide/workspace@1';

/**
 * 敏感字段名的匹配规则（大小写不敏感）。
 * 在脱敏阶段按 key 递归过滤，作为白名单投影之外的第二道保险。
 */
const SENSITIVE_KEY = /(apikey|api_key|token|secret|password|passwd|authorization|cookie|credential|privatekey)/i;

/**
 * 递归剔除敏感字段，避免任何密钥/令牌进入快照
 *
 * @param input 任意 JSON-ish 值
 * @returns 深拷贝后的同构值；对象中 key 命中 SENSITIVE_KEY 的条目被直接丢弃
 *
 * 注意：数组逐项递归，原始值原样返回；不会调用 getter 之外的副作用逻辑。
 */
function stripSensitive(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => stripSensitive(item));
  if (!input || typeof input !== 'object') return input;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue;
    output[key] = stripSensitive(value);
  }
  return output;
}

/**
 * 把文本压成适合放入快照的短字符串。
 *
 * @param text        原始文本
 * @param includeText 是否允许输出内容；false 时直接返回占位标记
 * @returns 折叠空白后的文本，超过 240 字符则截断并加省略号
 *
 * 限制长度是为了控制模型上下文体积，同时避免整段演讲稿被意外带出。
 */
function shortText(text: string, includeText: boolean): string {
  if (!includeText) return '[文本内容已隐藏]';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 240 ? `${clean.slice(0, 240)}…` : clean;
}

/**
 * 把单个内容对象投影成快照结构（只保留白名单字段）。
 *
 * @param object      画布对象
 * @param includeText 文本对象是否输出实际文字内容
 * @returns 平面对象记录；资源类对象的 src 一律替换为脱敏占位符，
 *          路径类对象只输出点数（pointCount）而非完整坐标数组
 *
 * 采用 switch 而非展开对象，确保不会无意中把新增字段（例如未来可能加入的
 * 远程 URL、凭据等）直接带进快照。
 */
function objectSnapshot(object: SlideObject, includeText: boolean): Record<string, unknown> {
  const base = {
    id: object.id,
    name: object.name,
    type: object.type,
    x: object.x,
    y: object.y,
    z: object.z,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
    rotationX: object.rotationX ?? 0,
    rotationY: object.rotationY ?? 0,
    opacity: object.opacity,
    visible: object.visible,
  };
  switch (object.type) {
    case 'text':
      return {
        ...base,
        text: shortText(object.text, includeText),
        fontSize: object.fontSize,
        font: object.font,
        bold: object.bold,
        align: object.align,
        color: object.color,
        depth3d: object.depth3d ?? 0,
      };
    case 'shape':
      return {
        ...base,
        shape: object.shape,
        fill: object.fill,
        stroke: object.stroke,
        strokeWidth: object.strokeWidth,
        pointCount: object.points ? Math.floor(object.points.length / 2) : 0,
      };
    case 'image':
    case 'svg':
      return {
        ...base,
        fit: object.fit,
        naturalWidth: object.naturalWidth,
        naturalHeight: object.naturalHeight,
        src: '[资源内容已脱敏]',
      };
    case 'video':
      return {
        ...base,
        fit: object.fit,
        duration: object.duration,
        loop: object.loop,
        muted: object.muted,
        autoplay: object.autoplay,
        src: '[资源内容已脱敏]',
      };
    case 'audio':
      return {
        ...base,
        duration: object.duration,
        loop: object.loop,
        autoplay: object.autoplay,
        src: '[资源内容已脱敏]',
      };
    case 'model':
      return {
        ...base,
        format: object.format,
        autoRotate: object.autoRotate,
        rotateSpeed: object.rotateSpeed,
        src: '[资源内容已脱敏]',
      };
    default:
      return base;
  }
}

/**
 * 复制一份视角结构，保证快照与运行时对象不共享引用。
 *
 * @param view 相机视角
 * @returns 仅含 target / distance / yaw / pitch 的纯数据对象
 */
function frameView(view: ViewState) {
  return {
    target: { x: view.target.x, y: view.target.y, z: view.target.z },
    distance: view.distance,
    yaw: view.yaw,
    pitch: view.pitch,
  };
}

/** 快照生成选项。 */
export interface SnapshotOptions {
  /** 是否输出画板文字内容；默认 false（只输出「内容已隐藏」占位）。 */
  includeText?: boolean;
  /** 是否包含回收站中的资源；默认 false，只输出未删除资源。 */
  includeDeletedAssets?: boolean;
}

/**
 * 构建工作区只读快照。
 *
 * @param decks   作品列表（可只传当前作品）
 * @param assets  资源元数据列表（不含二进制）
 * @param folders 资源文件夹列表
 * @param options 脱敏与内容开关
 * @returns 纯 JSON 快照：schema、生成时间、脱敏策略说明、统计信息、
 *          文件夹 / 作品 / 资源的结构化投影
 *
 * 说明：
 * - 帧备注最多输出 400 字符，避免演讲备注占用过多上下文；
 * - 资源缩略图统一替换为「已脱敏」标记，不输出 dataURL；
 * - 最后统一经过 stripSensitive 再过滤一遍字段名，防止未来新增字段遗漏。
 *   因此返回类型用 `as typeof snapshot` 断言，运行时结构可能与字面量略有差异
 *   （敏感字段被删除），调用方应按可选字段处理。
 */
export function buildWorkspaceSnapshot(
  decks: Deck[],
  assets: AssetMeta[],
  folders: AssetFolder[],
  options: SnapshotOptions = {},
) {
  const includeText = options.includeText === true;
  const includeDeleted = options.includeDeletedAssets === true;
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: new Date().toISOString(),
    policy: {
      secrets: false,
      assetBinaries: false,
      assetThumbs: false,
      textContent: includeText,
      rules: [
        'AI 配置与 API Key 永不写入快照',
        '资源文件内容（src / dataURL）与缩略图不写入快照',
        '仅暴露资源元数据与结构描述，MCP 侧按只读方式访问',
        '字段名命中 apikey/token/secret/password 等规则时自动剔除',
      ],
    },
    workspace: {
      deckCount: decks.length,
      assetCount: assets.length,
      folderCount: folders.length,
    },
    folders: folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      createdAt: folder.createdAt,
    })),
    decks: decks.map((deck) => ({
      id: deck.id,
      title: deck.title,
      background: deck.background,
      defaultDuration: deck.defaultDuration,
      showProgress: deck.showProgress,
      createdAt: deck.createdAt,
      updatedAt: deck.updatedAt,
      objectCount: deck.objects.length,
      frameCount: deck.frames.length,
      frames: deck.frames.map((frame) => ({
        id: frame.id,
        name: frame.name,
        duration: frame.duration,
        hold: frame.hold,
        notes: frame.notes ? frame.notes.slice(0, 400) : undefined,
        view: frameView(frame.view),
      })),
      lastView: frameView(deck.lastView),
      objects: deck.objects.map((object) => objectSnapshot(object, includeText)),
    })),
    assets: assets
      .filter((asset) => includeDeleted || asset.deletedAt === null)
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        mime: asset.mime,
        ext: asset.ext,
        size: asset.size,
        folderId: asset.folderId,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        width: asset.width,
        height: asset.height,
        duration: asset.duration,
        format: asset.format ?? null,
        deleted: asset.deletedAt !== null,
        thumb: '[缩略图已脱敏]',
      })),
  };
  return stripSensitive(snapshot) as typeof snapshot;
}
