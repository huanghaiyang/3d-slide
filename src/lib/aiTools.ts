/**
 * aiTools.ts —— AI 工具调用协议实现
 *
 * 职责：
 * - 定义供模型调用的 function tools（AI_TOOLS 的 JSON Schema）；
 * - 实现每个工具的执行逻辑：解析参数、换算画面位置、调用 deckStore 落到画布；
 * - 提供 executeAiTool 统一入口，以及 applyDeckPlan 批量执行「方案文件」。
 *
 * 工具调用协议：
 * - 模型返回 tool_calls（name + JSON 字符串 arguments），宿主解析后逐一调用 executeAiTool；
 * - 每个工具返回 AiToolOutcome { ok, message, mutated?, data? }：
 *   message 用于回填给模型 / 展示给用户，data 携带新建对象 id 等结构化结果；
 * - 工具执行出错不抛出，而是转成 ok=false 的结果，避免一次失败中断整个多步创作。
 *
 * 参数约定：
 * - 位置通过画面锚点（anchor）+ 百分比偏移（dx / dy）描述，由 placement 换算为世界坐标，
 *   模型无需理解 3D 坐标系；
 * - 所有数值参数先经过 num / str / clampSize 解析与裁剪，再交给 store 统一校验。
 *
 * 与 MCP 的关系：applyDeckPlan 与 MCP 的 write_plan 共用同一套操作集，
 * 因此工具名（op）与参数必须保持一致。
 */

import type { AiToolDef } from './ai';
import { useDeckStore } from '../store/deckStore';
import { getAssetSource, listAssetMetas } from './storage';
import { nextDepth } from './deck';
import { viewCenterAtZ } from './camera';
import { FOV, LIMITS } from './constants';
import type { FontPreset, ImageFit, ModelFormat, ShapeKind, SlideObject, TextAlign, TextObject } from '../types';

/** 角度转弧度的系数：AI 侧使用「度」，内部 ViewState 使用「弧度」。 */
const RAD = Math.PI / 180;

/** 允许的形状种类白名单，用于校验 AI 传入的 shape 参数。 */
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
/** 合法的 3D 模型格式白名单。 */
const MODEL_FORMATS: ModelFormat[] = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'dae', '3mf', 'usdz'];
/** 合法的字体预设白名单。 */
const FONT_PRESETS: FontPreset[] = ['sans', 'serif', 'round', 'mono'];
/** 合法的文本对齐白名单。 */
const TEXT_ALIGNS: TextAlign[] = ['left', 'center', 'right'];
/** 合法的图片填充方式白名单。 */
const IMAGE_FITS: ImageFit[] = ['contain', 'cover'];

/**
 * 画面锚点到世界坐标的比例因子。
 *
 * sx / sy 表示对象中心相对画面中心偏移「多少个半宽 / 半高」：
 * - sx=1 表示向右移动到画面右边缘（世界 x 减小，因为画面右 = 世界 -X）；
 * - sy=-1 表示向上移动到画面上边缘（世界 y 减小）；
 * - 左侧第三个锚点用 0.66，约等于画面宽度的 1/3 处。
 *
 * 这些值是 placement 换算的核心，新增锚点必须同时加入 ANCHOR_NAMES 供 Schema 枚举。
 */
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

/** 锚点名称列表，直接用作工具参数 Schema 的 enum。 */
const ANCHOR_NAMES = Object.keys(ANCHORS);

/**
 * 单个 AI 工具的执行结果。
 * 约定：工具内部不抛出异常，所有失败都通过 ok=false + message 表达。
 */
export interface AiToolOutcome {
  /** 是否执行成功。 */
  ok: boolean;
  /** 给模型 / 用户看的简短说明（已成功或失败原因）。 */
  message: string;
  /** 是否实际改动了画布 / 作品；只读查询类工具为 false。 */
  mutated?: boolean;
  /** 结构化结果，例如新建对象 id、当前作品结构、资源列表。 */
  data?: unknown;
}

/** 方案文件（plan）的 schema 标识，与 MCP write_plan 保持一致。 */
export const PLAN_SCHEMA = '3d-slide/plan@1';

/**
 * 方案中的一步操作：op 为工具名，其余字段原样作为该工具的参数。
 * 例如 { op: 'add_text', text: '标题', anchor: 'center' }。
 */
export interface DeckPlanOperation {
  /** 工具名（add_text / add_shape / add_asset / update_objects 等）。 */
  op: string;
  /** 其余工具参数，键名与 AI_TOOLS 中的 Schema 对应。 */
  [key: string]: unknown;
}

/**
 * AI 生成的创作方案：可先设置作品标题 / 背景，再按顺序执行 operations。
 * 整个方案可以一次生成、批量落地，适合「一键排版」场景。
 */
export interface DeckPlan {
  /** 必须为 PLAN_SCHEMA，用于拒绝格式不明的输入。 */
  schema: string;
  /** 可选：设置作品标题。 */
  title?: string;
  /** 可选：设置作品背景色。 */
  background?: string;
  /** 操作序列，按数组顺序执行（最多 120 步）。 */
  operations: DeckPlanOperation[];
}

/** 构造成功结果。 */
function ok(message: string, mutated = false, data?: unknown): AiToolOutcome {
  return { ok: true, message, mutated, data };
}

/** 构造失败结果（只有 message，没有 data）。 */
function fail(message: string): AiToolOutcome {
  return { ok: false, message };
}

/**
 * 宽松解析数字参数。
 *
 * 模型经常把数字写成字符串（"480"），因此同时接受有限数字与非空数字字符串；
 * 其余情况返回 undefined，由调用方决定是否使用默认值。
 */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 解析字符串参数：非字符串返回空串，字符串会 trim。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 解析并裁剪尺寸参数。
 * @returns 裁剪到 [LIMITS.minSize, LIMITS.maxSize] 的数字；无法解析时 undefined
 */
function clampSize(value: unknown): number | undefined {
  const parsed = num(value);
  if (parsed === undefined) return undefined;
  return Math.max(LIMITS.minSize, Math.min(LIMITS.maxSize, parsed));
}

/**
 * 把画面锚点 + 百分比偏移换算成世界坐标（画面右 = 世界 -X，画面下 = 世界 +Y）
 *
 * 步骤：
 * 1. 取当前编辑视角，计算对象所在深度 z 的视口半高 / 半宽（forward 为相机到该平面的距离，
 *    至少 40 防止为负或过小）；
 * 2. 用 anchor 的 sx / sy 把对象移到对应边缘；
 * 3. 叠加 dx / dy 百分比偏移（100% 对应一整个画面宽 / 高）。
 *
 * @param args 包含 anchor / dx / dy 的工具参数
 * @param z    目标对象的层级（决定投影平面的深度）
 * @returns 世界坐标 { x, y }
 */
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

/**
 * 提取所有工具共享的可选字段（name / rotation / rotationX / rotationY / opacity / visible）。
 *
 * @param args 工具参数
 * @returns 仅包含实际传入的字段（数值类先解析，visible 只接受布尔）
 *
 * 名称会按 LIMITS.objectNameChars 截断；数值范围最终由 store 的 normalizeEditedObject 统一裁剪。
 */
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

/**
 * 工具 add_text：在画面上添加文本。
 *
 * @param args text 必填；fontSize / font / align / bold / color / lineHeight /
 *             depth3d / width 可选；anchor / dx / dy 控制位置；公共字段见 extraCommonPatch
 * @returns 成功时 data 携带 { id, type: 'text' }
 *
 * 实现分两步：先用 store.addText() 走统一的新增流程（层级、命名、计数器、历史、保存），
 * 再用 updateObject 一次性补丁写入内容与位置，并通过 historyKey 把两步合并为一条历史。
 */
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

/**
 * 工具 add_shape：添加几何形状。
 *
 * @param args shape 必填（白名单校验）；width / height / fill / stroke / strokeWidth 可选；
 *             anchor / dx / dy 控制位置
 * @returns 成功时 data 携带 { id, type: 'shape', shape }
 *
 * 宽度 / 高度会裁剪到 LIMITS 允许范围；未传尺寸时沿用工厂默认值。
 */
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

/**
 * 工具 add_asset：把资源库中的素材放到画布。
 *
 * @param args asset（资源 id 或名称，可模糊匹配）必填；kind 可限定种类；
 *             width / height / fit 可选（音频与模型有特殊处理）
 * @returns 成功时 data 携带 { id, type, assetId }
 *
 * 匹配顺序：id 精确 -> 名称精确 -> 名称包含（忽略大小写）；只在未删除资源中查找。
 * 根据资源种类选择 addImage / addSvg / addMedia / addModel / addLottie，
 * 普通文件（file）无法直接放置，返回失败说明。
 *
 * 异步：需要读取资源元数据与内容（IndexedDB）。
 */
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
      { width: meta.width, height: meta.height, duration: meta.duration, poster: meta.thumb || undefined },
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
    id = store.addLottie(src, meta.width, meta.height, meta.duration, point, meta.thumb || undefined);
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

/**
 * 工具 update_objects：批量修改对象属性。
 *
 * @param args ids（字符串或字符串数组）与 patch（对象）必填
 * @returns 成功时 data 携带实际被更新的对象 id 列表
 *
 * 安全约束：只允许 allowed 白名单中的字段（位置 / 尺寸 / 旋转 / 透明度 / 文本 /
 * 形状样式 / 媒体参数），避免模型改写 id、type、src 等结构性字段。
 * 所有对象共享同一个 historyKey，使一次批量修改只占一步撤销。
 */
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
  // 可修改字段白名单：只暴露表现层属性，禁止改写 id / type / src 等结构字段
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

/**
 * 工具 delete_objects：删除画布对象。
 *
 * @param args ids（字符串或字符串数组）必填
 * @returns 成功时 data 携带实际被删除的对象 id 列表
 *
 * 只删除当前画布上确实存在的 id，并通过 store.removeObjects 统一处理选中状态、
 * 撤销历史与自动保存。
 */
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

/**
 * 工具 set_deck：修改作品级设置。
 *
 * @param args title / background / defaultDuration / showProgress 均可选
 * @returns 成功表示至少有一个字段被更新
 *
 * 标题通过 renameDeck（会 trim 并截断），其余字段通过 updateDeckSettings 一次性写入；
 * 使用带时间戳的 historyKey，避免不同批次的设置修改被合并。
 */
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

/**
 * 工具 create_view：创建一个演示视点。
 *
 * @param args name / duration / hold / notes 可选；target / distance / yaw / pitch
 *             可选，用于显式指定取景；不传 target 时记录当前编辑器视角
 * @returns 成功时 data 携带 { id }
 *
 * 角度换算：参数中的 yaw / pitch 以「度」传入，这里乘以 RAD 转成弧度。
 * 创建通过 store.captureFrame 完成（自动命名、深拷贝视角、选中新帧），
 * 随后按需补丁名称 / 时长 / 停留 / 备注。
 */
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

/**
 * 把对象压缩成适合回传给模型的精简结构。
 *
 * @param object 画布对象
 * @returns 仅含关键字段的平面记录：
 *          - 坐标 / 尺寸四舍五入到整数，减少 token 消耗；
 *          - 文本最多 60 字符；
 *          - 不同对象类型只保留该类型有意义的附加字段。
 */
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

/**
 * 工具 get_deck_state：读取当前作品结构（只读，不改动画布）。
 *
 * @returns data 包含作品基础信息、当前视角、压缩后的对象列表与视点列表；
 *          角度以「度」输出，便于模型理解。
 *
 * 这是模型规划构图的主要依据，也是 probeToolSupport 用来检测 function calling 的工具。
 */
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

/**
 * 工具 list_assets：列出资源库可用素材。
 *
 * @param args kind 可选，用于按资源种类筛选
 * @returns data 为精简的资源数组（id / 名称 / 种类 / 尺寸 / 时长 / 格式），
 *          最多 80 项；列表为空时返回空数组与提示文案
 *
 * 只统计未删除资源；限制条数是为了控制上下文长度。
 */
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

/**
 * AI 工具统一执行入口。
 *
 * @param name    工具名（与 AI_TOOLS 中的 function.name 对应）
 * @param rawArgs 模型给出的参数（通常是 JSON.parse 后的对象，也可能格式异常）
 * @returns 统一的 AiToolOutcome；未知工具与异常都转成 ok=false，不向外抛出
 *
 * 参数先规整为非数组对象，避免模型传 null / 数组 / 原始值导致各工具内部报错。
 * 同步工具直接返回，异步工具（add_asset / list_assets）通过 await 等待完成。
 */
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

/**
 * 解析并执行 3d-slide/plan@1 方案（AI 工具调用与 MCP write_plan 共用同一操作集）
 *
 * @param input 方案对象（已 JSON.parse）
 * @returns applied 成功步数；failed 失败说明列表（按执行顺序累积）
 * @throws 方案整体结构非法时抛出（非对象、schema 不符、operations 缺失 / 超过 120 步），
 *         单步失败不会抛错，而是记录到 failed 并继续执行后续操作
 *
 * 执行顺序：先应用 title / background（各算一步），再按数组顺序执行 operations。
 * 这种「尽力而为」的策略适合 AI 生成的长方案：个别步骤失败不应让整份方案作废。
 */
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
  // 逐步执行：非法步骤只记录失败，不中断整个方案
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

/** 位置相关工具参数的 Schema 片段（锚点 + 百分比偏移）。 */
const anchorProps = {
  anchor: {
    type: 'string',
    enum: ANCHOR_NAMES,
    description: '对象在画面中的锚点位置，默认 center',
  },
  dx: { type: 'number', description: '在锚点基础上水平偏移，单位是画面宽度的百分比，正数向右' },
  dy: { type: 'number', description: '在锚点基础上垂直偏移，单位是画面高度的百分比，正数向下' },
};

/** 文本 / 形状 / 资源工具共用的外观参数 Schema 片段。 */
const commonProps = {
  name: { type: 'string', description: '对象名称，便于后续引用' },
  rotation: { type: 'number', description: '绕 Z 轴旋转角度（度）' },
  rotationX: { type: 'number', description: '绕 X 轴倾斜角度（度）' },
  rotationY: { type: 'number', description: '绕 Y 轴倾斜角度（度）' },
  opacity: { type: 'number', description: '不透明度 0–100' },
};

/**
 * 提供给模型的工具定义列表（OpenAI function calling 格式）。
 *
 * 设计原则：
 * - description 写明「什么时候用」，required 只放真正必需的业务字段；
 * - 位置统一用 anchor / dx / dy，避免让模型直接计算世界坐标；
 * - 枚举值来自运行时白名单常量，保证 Schema 与实际校验逻辑不会漂移；
 * - 查询类工具（list_assets / get_deck_state）没有副作用，方便模型先观察再动手。
 */
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
