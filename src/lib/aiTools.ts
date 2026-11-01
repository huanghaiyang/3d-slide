import type { AiToolDef } from './ai';
import { useDeckStore } from '../store/deckStore';
import { getAssetSource, listAssetMetas } from './storage';
import { nextDepth } from './deck';
import { viewCenterAtZ } from './camera';
import { FOV, LIMITS } from './constants';
import type { FontPreset, ImageFit, ModelFormat, ShapeKind, SlideObject, TextAlign, TextObject } from '../types';

const RAD = Math.PI / 180;

const SHAPE_KINDS: ShapeKind[] = [
  'rect',
  'roundedRect',
  'ellipse',
  'triangle',
  'diamond',
  'star',
  'arrow',
  'line',
  'path',
];
const MODEL_FORMATS: ModelFormat[] = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'dae', '3mf', 'usdz'];
const FONT_PRESETS: FontPreset[] = ['sans', 'serif', 'round', 'mono'];
const TEXT_ALIGNS: TextAlign[] = ['left', 'center', 'right'];
const IMAGE_FITS: ImageFit[] = ['contain', 'cover'];

const ANCHORS: Record<string, { sx: number; sy: number }> = {
  center: { sx: 0, sy: 0 },
  top: { sx: 0, sy: -1 },
  bottom: { sx: 0, sy: 1 },
  left: { sx: 1, sy: 0 },
  right: { sx: -1, sy: 0 },
  'top-left': { sx: 1, sy: -1 },
  'top-right': { sx: -1, sy: -1 },
  'bottom-left': { sx: 1, sy: 1 },
  'bottom-right': { sx: -1, sy: 1 },
  'left-third': { sx: 0.66, sy: 0 },
  'right-third': { sx: -0.66, sy: 0 },
};

const ANCHOR_NAMES = Object.keys(ANCHORS);

export interface AiToolOutcome {
  ok: boolean;
  message: string;
  mutated?: boolean;
  data?: unknown;
}

export const PLAN_SCHEMA = '3d-slide/plan@1';

export interface DeckPlanOperation {
  op: string;
  [key: string]: unknown;
}

export interface DeckPlan {
  schema: string;
  title?: string;
  background?: string;
  operations: DeckPlanOperation[];
}

function ok(message: string, mutated = false, data?: unknown): AiToolOutcome {
  return { ok: true, message, mutated, data };
}

function fail(message: string): AiToolOutcome {
  return { ok: false, message };
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampSize(value: unknown): number | undefined {
  const parsed = num(value);
  if (parsed === undefined) return undefined;
  return Math.max(LIMITS.minSize, Math.min(LIMITS.maxSize, parsed));
}

/** 把画面锚点 + 百分比偏移换算成世界坐标（画面右 = 世界 -X，画面下 = 世界 +Y） */
function placement(args: Record<string, unknown>, z: number): { x: number; y: number } {
  const state = useDeckStore.getState();
  const view = state.view;
  const anchor = ANCHORS[str(args.anchor) || 'center'] ?? ANCHORS.center;
  const forward = Math.max(40, view.distance - (z - view.target.z));
  const halfHeight = forward * Math.tan((FOV / 2) * RAD);
  const halfWidth = halfHeight * 16 / 9;
  const center = viewCenterAtZ(view, z);
  const dx = num(args.dx) ?? 0;
  const dy = num(args.dy) ?? 0;
  return {
    x: center.x + anchor.sx * halfWidth - (dx / 100) * halfWidth * 2,
    y: center.y + anchor.sy * halfHeight + (dy / 100) * halfHeight * 2,
  };
}

function extraCommonPatch(args: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const name = str(args.name);
  if (name) patch.name = name.slice(0, LIMITS.objectNameChars);
  for (const key of ['rotation', 'rotationX', 'rotationY', 'opacity', 'visible'] as const) {
    if (key === 'visible') {
      if (typeof args.visible === 'boolean') patch.visible = args.visible;
      continue;
    }
    const value = num(args[key]);
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

function addText(args: Record<string, unknown>): AiToolOutcome {
  const store = useDeckStore.getState();
  if (!store.deck) return fail('当前没有打开的作品');
  const text = str(args.text);
  if (!text) return fail('add_text 需要 text');
  const z = nextDepth(store.deck.objects);
  const point = placement(args, z);
  const id = store.addText();
  if (!id) return fail('无法添加文本：已达到对象上限或作品只读');
  const patch: Record<string, unknown> = {
    ...extraCommonPatch(args),
    x: point.x,
    y: point.y,
    text,
  };
  const fontSize = num(args.fontSize);
  if (fontSize !== undefined) patch.fontSize = fontSize;
  if (FONT_PRESETS.includes(str(args.font) as FontPreset)) patch.font = str(args.font) as FontPreset;
  if (TEXT_ALIGNS.includes(str(args.align) as TextAlign)) patch.align = str(args.align) as TextAlign;
  if (typeof args.bold === 'boolean') patch.bold = args.bold;
  if (str(args.color)) patch.color = str(args.color);
  const lineHeight = num(args.lineHeight);
  if (lineHeight !== undefined) patch.lineHeight = lineHeight;
  const depth3d = num(args.depth3d);
  if (depth3d !== undefined) patch.depth3d = depth3d;
  const width = clampSize(args.width);
  if (width !== undefined) patch.width = width;
  useDeckStore.getState().updateObject(id, patch as Partial<TextObject>, `ai-text-${id}`);
  return ok(`已添加文本「${text.slice(0, 18)}」`, true, { id, type: 'text' });
}

function addShape(args: Record<string, unknown>): AiToolOutcome {
  const store = useDeckStore.getState();
  if (!store.deck) return fail('当前没有打开的作品');
  const shape = str(args.shape) as ShapeKind;
  if (!SHAPE_KINDS.includes(shape)) return fail(`不支持的形状：${str(args.shape) || '空'}`);
  const z = nextDepth(store.deck.objects);
  const point = placement(args, z);
  const id = store.addShape(shape);
  if (!id) return fail('无法添加形状：已达到对象上限或作品只读');
  const patch: Record<string, unknown> = {
    ...extraCommonPatch(args),
    x: point.x,
    y: point.y,
  };
  const width = clampSize(args.width);
  const height = clampSize(args.height);
  if (width !== undefined) patch.width = width;
  if (height !== undefined) patch.height = height;
  if (str(args.fill)) patch.fill = str(args.fill);
  if (str(args.stroke)) patch.stroke = str(args.stroke);
  if (num(args.strokeWidth) !== undefined) patch.strokeWidth = num(args.strokeWidth);
  useDeckStore.getState().updateObject(id, patch as Partial<SlideObject>, `ai-shape-${id}`);
  return ok(`已添加${shape}形状`, true, { id, type: 'shape', shape });
}

async function addAsset(args: Record<string, unknown>): Promise<AiToolOutcome> {
  const store = useDeckStore.getState();
  if (!store.deck) return fail('当前没有打开的作品');
  const query = str(args.asset) || str(args.assetId) || str(args.assetName);
  if (!query) return fail('add_asset 需要 asset（资源 id 或名称）');
  const kindFilter = str(args.kind);
  const metas = (await listAssetMetas())
    .filter((meta) => !meta.deletedAt)
    .filter((meta) => (kindFilter ? meta.kind === kindFilter : true));
  const lower = query.toLowerCase();
  const meta =
    metas.find((item) => item.id === query) ??
    metas.find((item) => item.name === query) ??
    metas.find((item) => item.name.toLowerCase().includes(lower));
  if (!meta) return fail(`资源库中找不到「${query}」，请先调用 list_assets 查看可用资源`);
  const src = await getAssetSource(meta.id);
  if (!src) return fail(`资源「${meta.name}」的内容读取失败`);
  const z = nextDepth(store.deck.objects);
  const point = placement(args, z);
  const width = clampSize(args.width);
  const height = clampSize(args.height);
  let id: string | null = null;
  if (meta.kind === 'image') {
    const isSvg = meta.ext === 'svg' || meta.mime.includes('svg');
    id = isSvg
      ? store.addSvg(src, meta.width, meta.height, point)
      : store.addImage(src, meta.width, meta.height, point);
  } else if (meta.kind === 'video' || meta.kind === 'audio') {
    id = store.addMedia(
      meta.kind,
      src,
      { width: meta.width, height: meta.height, duration: meta.duration },
      point,
    );
  } else if (meta.kind === 'model') {
    const format = MODEL_FORMATS.includes(meta.format as ModelFormat)
      ? (meta.format as ModelFormat)
      : MODEL_FORMATS.includes(meta.ext as ModelFormat)
        ? (meta.ext as ModelFormat)
        : 'glb';
    id = store.addModel(src, format, point);
  } else if (meta.kind === 'lottie') {
    id = store.addLottie(src, meta.width, meta.height, meta.duration, point);
  } else {
    return fail(`资源「${meta.name}」是普通文件，无法直接放到画布`);
  }
  if (!id) return fail('无法添加资源：已达到对象上限或作品只读');
  const patch: Record<string, unknown> = { ...extraCommonPatch(args) };
  if (meta.kind === 'model') {
    patch.width = width ?? height ?? 760;
    patch.height = height ?? width ?? 760;
  } else if (meta.kind !== 'audio') {
    if (width !== undefined) patch.width = width;
    if (height !== undefined) patch.height = height;
    if (IMAGE_FITS.includes(str(args.fit) as ImageFit)) patch.fit = str(args.fit) as ImageFit;
  }
  useDeckStore.getState().updateObject(id, patch as Partial<SlideObject>, `ai-asset-${id}`);
  return ok(`已添加资源「${meta.name}」`, true, { id, type: meta.kind, assetId: meta.id });
}

function updateObjects(args: Record<string, unknown>): AiToolOutcome {
  const store = useDeckStore.getState();
  if (!store.deck) return fail('当前没有打开的作品');
  const ids = Array.isArray(args.ids)
    ? args.ids.map((item) => str(item)).filter(Boolean)
    : str(args.ids)
      ? [str(args.ids)]
      : [];
  if (ids.length === 0) return fail('update_objects 需要 ids');
  const rawPatch = args.patch;
  if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    return fail('update_objects 需要 patch 对象');
  }
  const allowed = [
    'name', 'x', 'y', 'z', 'width', 'height', 'rotation', 'rotationX', 'rotationY',
    'opacity', 'visible', 'text', 'fontSize', 'font', 'bold', 'align', 'color',
    'lineHeight', 'depth3d', 'fill', 'stroke', 'strokeWidth', 'fit', 'loop',
    'volume', 'muted', 'speed', 'autoRotate', 'rotateSpeed',
  ];
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = (rawPatch as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) patch[key] = value;
  }
  if (Object.keys(patch).length === 0) return fail('patch 中没有可修改的字段');
  const existing = store.deck.objects.map((object) => object.id);
  const targets = ids.filter((id) => existing.includes(id));
  if (targets.length === 0) return fail('ids 中没有当前画布上的对象');
  const historyKey = `ai-update-${Date.now()}`;
  for (const id of targets) {
    useDeckStore.getState().updateObject(id, patch as Partial<SlideObject>, historyKey);
  }
  return ok(`已更新 ${targets.length} 个对象`, true, { ids: targets });
}

function deleteObjects(args: Record<string, unknown>): AiToolOutcome {
  const store = useDeckStore.getState();
  if (!store.deck) return fail('当前没有打开的作品');
  const ids = Array.isArray(args.ids)
    ? args.ids.map((item) => str(item)).filter(Boolean)
    : str(args.ids)
      ? [str(args.ids)]
      : [];
  if (ids.length === 0) return fail('delete_objects 需要 ids');
  const existing = store.deck.objects.map((object) => object.id);
  const targets = ids.filter((id) => existing.includes(id));
  if (targets.length === 0) return fail('ids 中没有当前画布上的对象');
  useDeckStore.getState().removeObjects(targets);
  return ok(`已删除 ${targets.length} 个对象`, true, { ids: targets });
}

function setDeck(args: Record<string, unknown>): AiToolOutcome {
  const store = useDeckStore.getState();
  if (!store.deck) return fail('当前没有打开的作品');
  const patch: Record<string, unknown> = {};
  if (str(args.background)) patch.background = str(args.background);
  if (num(args.defaultDuration) !== undefined) patch.defaultDuration = num(args.defaultDuration);
  if (typeof args.showProgress === 'boolean') patch.showProgress = args.showProgress;
  const title = str(args.title);
  if (title) useDeckStore.getState().renameDeck(title);
  if (Object.keys(patch).length > 0) {
    useDeckStore.getState().updateDeckSettings(patch, `ai-deck-${Date.now()}`);
  }
  if (!title && Object.keys(patch).length === 0) return fail('set_deck 没有可修改的字段');
  return ok('作品设置已更新', true);
}

function createView(args: Record<string, unknown>): AiToolOutcome {
  const store = useDeckStore.getState();
  if (!store.deck) return fail('当前没有打开的作品');
  if (store.deck.frames.length >= LIMITS.frames) return fail('视点数量已达上限');
  const target = args.target && typeof args.target === 'object' ? (args.target as Record<string, unknown>) : null;
  const view = target
    ? {
        target: {
          x: num(target.x) ?? 0,
          y: num(target.y) ?? 0,
          z: num(target.z) ?? 0,
        },
        distance: num(args.distance) ?? store.view.distance,
        yaw: (num(args.yaw) ?? 0) * RAD,
        pitch: (num(args.pitch) ?? 0) * RAD,
      }
    : { ...store.view, target: { ...store.view.target } };
  useDeckStore.getState().captureFrame(view);
  const frames = useDeckStore.getState().deck?.frames ?? [];
  const captured = frames[frames.length - 1];
  if (!captured) return fail('视点创建失败');
  const name = str(args.name);
  if (name) useDeckStore.getState().renameFrame(captured.id, name);
  const duration = num(args.duration);
  if (duration !== undefined) useDeckStore.getState().setFrameDuration(captured.id, duration);
  const hold = num(args.hold);
  if (hold !== undefined) useDeckStore.getState().setFrameHold(captured.id, hold);
  const notes = str(args.notes);
  if (notes) useDeckStore.getState().setFrameNotes(captured.id, notes.slice(0, LIMITS.frameNotesChars));
  return ok(`已创建视点${name ? `「${name}」` : ''}`, true, { id: captured.id });
}

function compactObject(object: SlideObject): Record<string, unknown> {
  const base = {
    id: object.id,
    type: object.type,
    name: object.name,
    x: Math.round(object.x),
    y: Math.round(object.y),
    z: Math.round(object.z),
    width: Math.round(object.width),
    height: Math.round(object.height),
    rotation: object.rotation,
    opacity: object.opacity,
    visible: object.visible,
  };
  if (object.type === 'text') {
    return {
      ...base,
      text: object.text.slice(0, 60),
      fontSize: object.fontSize,
      bold: object.bold,
      align: object.align,
      color: object.color,
    };
  }
  if (object.type === 'shape') {
    return { ...base, shape: object.shape, fill: object.fill, stroke: object.stroke, strokeWidth: object.strokeWidth };
  }
  if (object.type === 'model') return { ...base, format: object.format };
  return base;
}

function getDeckState(): AiToolOutcome {
  const { deck, view } = useDeckStore.getState();
  if (!deck) return fail('当前没有打开的作品');
  return ok('当前作品结构', false, {
    id: deck.id,
    title: deck.title,
    background: deck.background,
    defaultDuration: deck.defaultDuration,
    view: {
      target: view.target,
      distance: Math.round(view.distance),
      yaw: Math.round(view.yaw / RAD),
      pitch: Math.round(view.pitch / RAD),
    },
    objects: deck.objects.map(compactObject),
    frames: deck.frames.map((frame) => ({
      id: frame.id,
      name: frame.name,
      duration: frame.duration,
      hold: frame.hold,
      notes: frame.notes ? frame.notes.slice(0, 200) : undefined,
      view: {
        target: frame.view.target,
        distance: Math.round(frame.view.distance),
        yaw: Math.round(frame.view.yaw / RAD),
        pitch: Math.round(frame.view.pitch / RAD),
      },
    })),
  });
}

async function listAssetsTool(args: Record<string, unknown>): Promise<AiToolOutcome> {
  const kind = str(args.kind);
  const metas = (await listAssetMetas())
    .filter((meta) => !meta.deletedAt)
    .filter((meta) => (kind ? meta.kind === kind : true))
    .slice(0, 80)
    .map((meta) => ({
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      width: meta.width,
      height: meta.height,
      duration: Math.round(meta.duration * 10) / 10,
      format: meta.format,
    }));
  if (metas.length === 0) return ok('资源库中还没有可用资源', false, []);
  return ok(`资源库共 ${metas.length} 项`, false, metas);
}

export async function executeAiTool(name: string, rawArgs: unknown): Promise<AiToolOutcome> {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>)
    : {};
  try {
    switch (name) {
      case 'add_text':
        return addText(args);
      case 'add_shape':
        return addShape(args);
      case 'add_asset':
        return await addAsset(args);
      case 'update_objects':
        return updateObjects(args);
      case 'delete_objects':
        return deleteObjects(args);
      case 'set_deck':
        return setDeck(args);
      case 'create_view':
        return createView(args);
      case 'get_deck_state':
        return getDeckState();
      case 'list_assets':
        return await listAssetsTool(args);
      default:
        return fail(`未知工具：${name}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '工具执行失败');
  }
}

/** 解析并执行 3d-slide/plan@1 方案（AI 工具调用与 MCP write_plan 共用同一操作集） */
export async function applyDeckPlan(input: unknown): Promise<{ applied: number; failed: string[] }> {
  if (!input || typeof input !== 'object') throw new Error('方案文件不是有效的 JSON 对象');
  const plan = input as Partial<DeckPlan>;
  if (plan.schema !== PLAN_SCHEMA) throw new Error(`方案 schema 必须是 ${PLAN_SCHEMA}`);
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) {
    throw new Error('方案中没有 operations');
  }
  if (plan.operations.length > 120) throw new Error('方案操作过多（最多 120 步）');
  const failed: string[] = [];
  let applied = 0;
  if (typeof plan.title === 'string' && plan.title.trim()) {
    const result = await executeAiTool('set_deck', { title: plan.title });
    if (result.ok) applied += 1;
    else failed.push(result.message);
  }
  if (typeof plan.background === 'string' && plan.background.trim()) {
    const result = await executeAiTool('set_deck', { background: plan.background });
    if (result.ok) applied += 1;
    else failed.push(result.message);
  }
  for (const operation of plan.operations) {
    if (!operation || typeof operation !== 'object' || typeof operation.op !== 'string') {
      failed.push('存在无效的操作');
      continue;
    }
    const { op, ...args } = operation;
    const result = await executeAiTool(op, args);
    if (result.ok) applied += 1;
    else failed.push(`${op}：${result.message}`);
  }
  return { applied, failed };
}

const anchorProps = {
  anchor: {
    type: 'string',
    enum: ANCHOR_NAMES,
    description: '对象在画面中的锚点位置，默认 center',
  },
  dx: { type: 'number', description: '在锚点基础上水平偏移，单位是画面宽度的百分比，正数向右' },
  dy: { type: 'number', description: '在锚点基础上垂直偏移，单位是画面高度的百分比，正数向下' },
};

const commonProps = {
  name: { type: 'string', description: '对象名称，便于后续引用' },
  rotation: { type: 'number', description: '绕 Z 轴旋转角度（度）' },
  rotationX: { type: 'number', description: '绕 X 轴倾斜角度（度）' },
  rotationY: { type: 'number', description: '绕 Y 轴倾斜角度（度）' },
  opacity: { type: 'number', description: '不透明度 0–100' },
};

export const AI_TOOLS: AiToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_assets',
      description: '列出资源库中可用的图片、视频、音频、3D 模型、Lottie 资源。添加素材前先调用它。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['image', 'video', 'audio', 'model', 'lottie', 'file'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_deck_state',
      description: '读取当前作品的背景、对象位置、文字、视点等结构。用于规划构图或检查改动结果。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_text',
      description: '在画面上添加文字。支持字号、字体、颜色、对齐、3D 挤出厚度。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '文字内容，可用 \\n 换行' },
          ...anchorProps,
          width: { type: 'number', description: '文本行宽（世界单位，常用 300–1600）' },
          fontSize: { type: 'number', description: '字号，常用 24–160' },
          font: { type: 'string', enum: FONT_PRESETS },
          bold: { type: 'boolean' },
          align: { type: 'string', enum: TEXT_ALIGNS },
          color: { type: 'string', description: '十六进制颜色，例如 #F3EEE4' },
          lineHeight: { type: 'number', description: '行高倍率 0.8–3' },
          depth3d: { type: 'number', description: '3D 挤出厚度，0 表示平面文字' },
          ...commonProps,
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_shape',
      description: '添加几何形状，可用于背景色块、装饰线、箭头等。',
      parameters: {
        type: 'object',
        properties: {
          shape: { type: 'string', enum: SHAPE_KINDS },
          ...anchorProps,
          width: { type: 'number' },
          height: { type: 'number' },
          fill: { type: 'string' },
          stroke: { type: 'string' },
          strokeWidth: { type: 'number' },
          ...commonProps,
        },
        required: ['shape'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_asset',
      description: '把资源库中的图片、SVG、视频、音频、3D 模型或 Lottie 放到画面上。',
      parameters: {
        type: 'object',
        properties: {
          asset: { type: 'string', description: '资源 id 或名称（可模糊匹配）' },
          kind: { type: 'string', enum: ['image', 'video', 'audio', 'model', 'lottie'] },
          ...anchorProps,
          width: { type: 'number' },
          height: { type: 'number' },
          fit: { type: 'string', enum: IMAGE_FITS },
          ...commonProps,
        },
        required: ['asset'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_objects',
      description: '批量修改对象的位置、尺寸、旋转、透明度、文字内容、颜色等属性。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '对象 id 列表' },
          patch: {
            type: 'object',
            description: '要修改的字段；可用 name/x/y/z/width/height/rotation/rotationX/rotationY/opacity/visible/text/fontSize/font/bold/align/color/lineHeight/depth3d/fill/stroke/strokeWidth/fit/loop/volume/muted/speed/autoRotate/rotateSpeed',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              z: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              rotation: { type: 'number' },
              rotationX: { type: 'number' },
              rotationY: { type: 'number' },
              opacity: { type: 'number' },
              visible: { type: 'boolean' },
              text: { type: 'string' },
              fontSize: { type: 'number' },
              color: { type: 'string' },
              fill: { type: 'string' },
              stroke: { type: 'string' },
              strokeWidth: { type: 'number' },
              volume: { type: 'number' },
              muted: { type: 'boolean' },
              loop: { type: 'boolean' },
              name: { type: 'string' },
            },
          },
        },
        required: ['ids', 'patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_objects',
      description: '删除画布上的对象。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_deck',
      description: '修改作品标题、背景色、默认过渡时长或是否显示进度。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          background: { type: 'string', description: '十六进制背景色' },
          defaultDuration: { type: 'number', description: '视点过渡时长（秒，0.2–5）' },
          showProgress: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_view',
      description: '创建一个演示视点。不传 target 时记录当前编辑器视角；也可以指定相机目标点、距离与角度编排运镜。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '视点名称' },
          duration: { type: 'number', description: '进入该视点的过渡时长（秒）' },
          hold: { type: 'number', description: '自动播放时在该视点停留的秒数（0.5–120）' },
          notes: { type: 'string', description: '演讲者备注，仅演示端可见' },
          target: {
            type: 'object',
            description: '相机看向的世界坐标点',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          },
          distance: { type: 'number', description: '相机到目标点的距离' },
          yaw: { type: 'number', description: '水平旋转角度（度）' },
          pitch: { type: 'number', description: '俯仰角度（度）' },
        },
      },
    },
  },
];
