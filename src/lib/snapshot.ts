import type { AssetFolder, AssetMeta } from './assets';
import type { Deck, SlideObject, ViewState } from '../types';

export const SNAPSHOT_SCHEMA = '3d-slide/workspace@1';

const SENSITIVE_KEY = /(apikey|api_key|token|secret|password|passwd|authorization|cookie|credential|privatekey)/i;

/** 递归剔除敏感字段，避免任何密钥/令牌进入快照 */
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

function shortText(text: string, includeText: boolean): string {
  if (!includeText) return '[文本内容已隐藏]';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 240 ? `${clean.slice(0, 240)}…` : clean;
}

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

function frameView(view: ViewState) {
  return {
    target: { x: view.target.x, y: view.target.y, z: view.target.z },
    distance: view.distance,
    yaw: view.yaw,
    pitch: view.pitch,
  };
}

export interface SnapshotOptions {
  includeText?: boolean;
  includeDeletedAssets?: boolean;
}

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
