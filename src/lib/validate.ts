import type {
  Deck,
  Frame,
  ImageObject,
  ModelFormat,
  ShapeObject,
  SlideObject,
  TextObject,
  ViewState,
} from '../types';
import {
  DEFAULT_BACKGROUND,
  DEFAULT_DURATION,
  DEFAULT_SHAPE_COLOR,
  DEFAULT_TEXT_COLOR,
  DEFAULT_VIEW,
  LIMITS,
} from './constants';
import { layoutText } from './text';

export const PROJECT_VERSION = 1;

export const PROJECT_APP_ID = '3d-slide';

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeView(raw: unknown, fallback: ViewState = DEFAULT_VIEW): ViewState {
  if (!raw || typeof raw !== 'object') return { ...fallback, target: { ...fallback.target } };
  const v = raw as Record<string, unknown>;
  const targetRaw = (v.target as Record<string, unknown>) ?? {};
  const target = {
    x: clamp(num(targetRaw.x, fallback.target.x), -LIMITS.coord, LIMITS.coord),
    y: clamp(num(targetRaw.y, fallback.target.y), -LIMITS.coord, LIMITS.coord),
    z: clamp(num(targetRaw.z, fallback.target.z), -LIMITS.depth, LIMITS.depth),
  };
  return {
    target,
    distance: clamp(num(v.distance, fallback.distance), 20, 60000),
    yaw: num(v.yaw, fallback.yaw),
    pitch: clamp(num(v.pitch, fallback.pitch), -1.45, 1.45),
  };
}

function normalizeBase(raw: Record<string, unknown>): {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  rotation: number;
  rotationX: number;
  rotationY: number;
  opacity: number;
  visible: boolean;
} {
  if (typeof raw.id !== 'string' || !raw.id) throw new Error('对象缺少 id');
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('对象缺少名称');
  return {
    id: raw.id,
    name: raw.name.slice(0, LIMITS.objectNameChars),
    x: clamp(num(raw.x, 0), -LIMITS.coord, LIMITS.coord),
    y: clamp(num(raw.y, 0), -LIMITS.coord, LIMITS.coord),
    z: clamp(num(raw.z, 0), -LIMITS.depth, LIMITS.depth),
    width: clamp(num(raw.width, 400), LIMITS.minSize, LIMITS.maxSize),
    height: clamp(num(raw.height, 300), LIMITS.minSize, LIMITS.maxSize),
    rotation: clamp(num(raw.rotation, 0), LIMITS.minRotation, LIMITS.maxRotation),
    rotationX: clamp(num(raw.rotationX, 0), LIMITS.minRotation, LIMITS.maxRotation),
    rotationY: clamp(num(raw.rotationY, 0), LIMITS.minRotation, LIMITS.maxRotation),
    opacity: clamp(num(raw.opacity, 100), 0, 100),
    visible: bool(raw.visible, true),
  };
}

function normalizeObject(raw: unknown, warnings: string[]): SlideObject {
  if (!raw || typeof raw !== 'object') throw new Error('存在无效的内容对象');
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (type === 'text') {
    const base = normalizeBase(r);
    const text = str(r.text, '');
    const fontSize = clamp(num(r.fontSize, 48), LIMITS.minFontSize, LIMITS.maxFontSize);
    const lineHeight = clamp(num(r.lineHeight, 1.4), LIMITS.minLineHeight, LIMITS.maxLineHeight);
    const font = (['sans', 'serif', 'round', 'mono'].includes(String(r.font))
      ? r.font
      : 'sans') as TextObject['font'];
    const bold = bool(r.bold, false);
    const layout = layoutText(text, base.width, fontSize, font, bold, lineHeight);
    return {
      ...base,
      type: 'text',
      text,
      fontSize,
      font,
      bold,
      align: (['left', 'center', 'right'].includes(String(r.align)) ? r.align : 'left') as TextObject['align'],
      color: str(r.color, DEFAULT_TEXT_COLOR),
      lineHeight,
      depth3d: clamp(num(r.depth3d, 0), 0, LIMITS.maxTextDepth),
      height: layout.height,
    };
  }
  if (type === 'image') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`图片「${base.name}」缺少素材，已以占位图导入`);
    return {
      ...base,
      type: 'image',
      src,
      fit: r.fit === 'cover' ? 'cover' : 'contain',
      aspectLocked: bool(r.aspectLocked, false),
      naturalWidth: Math.max(1, num(r.naturalWidth, 1600)),
      naturalHeight: Math.max(1, num(r.naturalHeight, 900)),
    };
  }
  if (type === 'svg') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`SVG「${base.name}」缺少素材，已以占位图导入`);
    return {
      ...base,
      type: 'svg',
      src,
      fit: r.fit === 'cover' ? 'cover' : 'contain',
      naturalWidth: Math.max(1, num(r.naturalWidth, 1600)),
      naturalHeight: Math.max(1, num(r.naturalHeight, 900)),
    };
  }
  if (type === 'lottie') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`Lottie「${base.name}」缺少动画数据，已以占位卡导入`);
    return {
      ...base,
      type: 'lottie',
      src,
      fit: r.fit === 'cover' ? 'cover' : 'contain',
      naturalWidth: Math.max(1, num(r.naturalWidth, 800)),
      naturalHeight: Math.max(1, num(r.naturalHeight, 600)),
      duration: Math.max(0, num(r.duration, 0)),
      loop: bool(r.loop, true),
      speed: clamp(num(r.speed, 1), 0.1, 4),
    };
  }
  if (type === 'video') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`视频「${base.name}」缺少素材，已以占位卡导入`);
    return {
      ...base,
      type: 'video',
      src,
      fit: r.fit === 'cover' ? 'cover' : 'contain',
      naturalWidth: Math.max(1, num(r.naturalWidth, 1280)),
      naturalHeight: Math.max(1, num(r.naturalHeight, 720)),
      duration: Math.max(0, num(r.duration, 0)),
      loop: bool(r.loop, true),
      muted: bool(r.muted, false),
      volume: clamp(num(r.volume, 80), 0, 100),
      autoplay: bool(r.autoplay, false),
    };
  }
  if (type === 'audio') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`音频「${base.name}」缺少素材，已以占位卡导入`);
    return {
      ...base,
      type: 'audio',
      src,
      duration: Math.max(0, num(r.duration, 0)),
      loop: bool(r.loop, true),
      volume: clamp(num(r.volume, 80), 0, 100),
      autoplay: bool(r.autoplay, false),
    };
  }
  if (type === 'model') {
    const base = normalizeBase(r);
    const src = str(r.src, '');
    if (!src) warnings.push(`模型「${base.name}」缺少素材，已以占位框导入`);
    return {
      ...base,
      type: 'model',
      src,
      format: (['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'dae', '3mf', 'usdz'].includes(String(r.format))
        ? r.format
        : 'glb') as ModelFormat,
      autoRotate: bool(r.autoRotate, false),
      rotateSpeed: clamp(num(r.rotateSpeed, 45), 0, 360),
    };
  }
  if (type === 'shape') {
    const base = normalizeBase(r);
    return {
      ...base,
      type: 'shape',
      shape: (['rect', 'roundedRect', 'ellipse', 'triangle', 'diamond', 'star', 'arrow', 'line', 'path'].includes(
        String(r.shape),
      )
        ? r.shape
        : 'rect') as ShapeObject['shape'],
      fill: str(r.fill, DEFAULT_SHAPE_COLOR),
      stroke: typeof r.stroke === 'string' ? r.stroke : null,
      strokeWidth: clamp(num(r.strokeWidth, 0), LIMITS.minStroke, LIMITS.maxStroke),
      points: Array.isArray(r.points)
        ? (r.points as unknown[])
            .slice(0, LIMITS.maxPathPoints * 2)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
            .map((value) => clamp(value, 0, 1))
        : undefined,
    };
  }
  throw new Error(`未知的对象类型：${String(type)}`);
}

function normalizeFrame(raw: unknown, index: number): Frame {
  if (!raw || typeof raw !== 'object') throw new Error('存在无效的视点');
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) throw new Error('视点缺少 id');
  return {
    id: r.id,
    name: str(r.name, `视点 ${index + 1}`).slice(0, LIMITS.frameNameChars) || `视点 ${index + 1}`,
    duration: clamp(num(r.duration, DEFAULT_DURATION), LIMITS.minDuration, LIMITS.maxDuration),
    view: normalizeView(r.view),
  };
}

export interface NormalizeOptions {
  newId?: string;
  regenerateIds?: boolean;
}

export function normalizeDeck(raw: unknown, options: NormalizeOptions = {}): Deck {
  if (!raw || typeof raw !== 'object') throw new Error('作品数据不是有效对象');
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || !r.title.trim()) throw new Error('作品缺少标题');
  if (!Array.isArray(r.objects)) throw new Error('作品缺少内容对象列表');
  if (r.objects.length > LIMITS.objects) throw new Error('内容对象数量超过上限');
  if (!Array.isArray(r.frames)) throw new Error('作品缺少视点路径');
  if (r.frames.length > LIMITS.frames) throw new Error('视点数量超过上限');

  const warnings: string[] = [];
  let objects = r.objects.map((o) => normalizeObject(o, warnings));
  let frames = r.frames.map((f, i) => normalizeFrame(f, i));

  if (options.regenerateIds) {
    const seen = new Set<string>();
    objects = objects.map((o, i) => {
      const id = seen.has(o.id) ? `${o.id}-${i}` : o.id;
      seen.add(id);
      return { ...o, id };
    });
    const seenFrames = new Set<string>();
    frames = frames.map((f, i) => {
      const id = seenFrames.has(f.id) ? `${f.id}-${i}` : f.id;
      seenFrames.add(id);
      return { ...f, id };
    });
  }

  const counters = typeof r.counters === 'object' && r.counters ? (r.counters as Record<string, number>) : {};
  const now = Date.now();
  return {
    id: options.newId ?? (typeof r.id === 'string' && r.id ? r.id : crypto.randomUUID()),
    title: r.title.slice(0, LIMITS.titleChars),
    background: typeof r.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.background)
      ? r.background
      : DEFAULT_BACKGROUND,
    defaultDuration: clamp(num(r.defaultDuration, DEFAULT_DURATION), LIMITS.minDuration, LIMITS.maxDuration),
    showProgress: bool(r.showProgress, true),
    objects,
    frames,
    lastView: normalizeView(r.lastView),
    counters: Object.fromEntries(Object.entries(counters).filter(([, v]) => typeof v === 'number')),
    createdAt: num(r.createdAt, now),
    updatedAt: num(r.updatedAt, now),
  };
  // warnings 由调用方通过 normalizeDeckWithWarnings 获取
}

export function normalizeDeckWithWarnings(
  raw: unknown,
  options: NormalizeOptions = {},
): { deck: Deck; warnings: string[] } {
  const deck = normalizeDeck(raw, options);
  const warnings: string[] = [];
  for (const o of deck.objects) {
    if ((o.type === 'image' || o.type === 'svg') && !o.src) {
      warnings.push(`图片「${o.name}」缺少素材，已以占位图显示`);
    }
    if ((o.type === 'video' || o.type === 'audio') && !o.src) {
      warnings.push(`媒体「${o.name}」缺少素材，已以占位卡显示`);
    }
    if (o.type === 'lottie' && !o.src) {
      warnings.push(`Lottie「${o.name}」缺少动画数据，已以占位卡显示`);
    }
  }
  return { deck, warnings };
}

export interface SlideProjectFile {
  app: typeof PROJECT_APP_ID;
  version: number;
  exportedAt: string;
  title: string;
  deck: Deck;
}

export function createSlideFile(deck: Deck): SlideProjectFile {
  return {
    app: PROJECT_APP_ID,
    version: PROJECT_VERSION,
    exportedAt: new Date().toISOString(),
    title: deck.title,
    deck,
  };
}

export function parseSlideFile(text: string): { deck: Deck; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 .slide 工程文件');
  }
  if (!raw || typeof raw !== 'object') throw new Error('不是有效的 .slide 工程文件');
  const file = raw as Record<string, unknown>;
  if (file.app !== PROJECT_APP_ID) throw new Error('不是有效的 .slide 工程文件');
  const version = num(file.version, 0);
  if (version > PROJECT_VERSION) throw new Error('该文件版本高于当前应用，请升级后再打开');
  if (!file.deck || typeof file.deck !== 'object') throw new Error('工程文件缺少作品数据');
  const { deck, warnings } = normalizeDeckWithWarnings(file.deck, { regenerateIds: true });
  return { deck: { ...deck, id: crypto.randomUUID(), updatedAt: Date.now() }, warnings };
}

export function sanitizeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80) || '未命名演示';
}

export function uniqueTitle(title: string, existing: string[]): string {
  if (!existing.includes(title)) return title;
  let index = 2;
  while (existing.includes(`${title}（${index}）`)) index += 1;
  return `${title}（${index}）`;
}

export function defaultImageObject(
  id: string,
  name: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  x: number,
  y: number,
  z: number,
): ImageObject {
  const maxDim = 900;
  const ratio = naturalWidth / naturalHeight || 4 / 3;
  let width = maxDim;
  let height = width / ratio;
  if (height > maxDim) {
    height = maxDim;
    width = height * ratio;
  }
  return {
    id,
    type: 'image',
    name,
    x,
    y,
    z,
    width,
    height,
    rotation: 0,
    opacity: 100,
    visible: true,
    src,
    fit: 'contain',
    aspectLocked: false,
    naturalWidth,
    naturalHeight,
  };
}
