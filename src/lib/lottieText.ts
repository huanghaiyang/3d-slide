/**
 * lottieText.ts —— 把 Lottie 文本图层（ty=5）解析成矢量轮廓
 *
 * 自研 GPU 后端没有字体引擎，文本图层原本只能整份回退 canvas。本模块在渲染前
 * 把文本图层展开成形状图层（ty=4），复用已有的三角化与填充/描边管线：
 * - 字体按「开源字体 + CDN 下载」策略获取（Fontsource / jsDelivr 的 woff 文件），
 *   下载结果缓存进 IndexedDB，二次加载不再走网络；
 * - 用 opentype.js 解析字形轮廓，按字号/字距/行距/对齐做逐字排版，
 *   每个闭合轮廓生成一条 Lottie 路径（`sh`），孔洞依靠 nonzero 填充规则处理；
 * - 只处理静态文本：文本内容逐帧动画（`t.d.a` / 多关键帧）直接跳过，
 *   由上层保持原样并回退 canvas，绝不静默画错。
 *
 * 时序约定：字形解析是异步的，而渲染解析（parseLottieForRender）是同步的。
 * 因此渲染前必须先 await prepareLottieFonts(文档)，把字体下载进内存缓存；
 * expandLottieText 只读取缓存，缺字体时跳过该图层并给出原因。
 */

import { openDB, type IDBPDatabase } from 'idb';
import opentype from 'opentype.js';
import type { Font, PathCommand } from 'opentype.js';
import type { LottieDocument } from './lottie';

/** 宽松 JSON 对象类型：Lottie 结构随导出工具变化，不追求精确建模。 */
type JsonObject = Record<string, unknown>;

/** 二维点 / 相对切线。 */
type Vec2 = [number, number];

/** 一条闭合或开放的轮廓（切线为相对顶点的偏移）。 */
interface Outline {
  /** 顶点 */
  v: Vec2[];
  /** 入切线（进入该顶点时使用的控制点偏移） */
  i: Vec2[];
  /** 出切线（离开该顶点时使用的控制点偏移） */
  o: Vec2[];
  /** 是否闭合 */
  closed: boolean;
}

/** 文本展开报告。 */
export interface TextReport {
  /** 展开后的文档（原文档不会被修改） */
  document: LottieDocument;
  /** 成功展开的文本图层数 */
  expanded: number;
  /** 保持原样的文本图层数 */
  skipped: number;
  /** 跳过原因（前 24 条） */
  messages: string[];
  /** 实际用到的字体描述（便于排查缺字） */
  fonts: string[];
  /** 是否发生了改写 */
  changed: boolean;
}

/**
 * 字体镜像：同一份 Fontsource 文件可以从多个 CDN 取。
 *
 * 实测（2026-11，本机网络）cdn / fastly 域名经常连不通，gcore 与 unpkg 可通；
 * 这里按可用性排序，并在运行期按失败情况动态跳过挂掉的镜像。
 */
const FONT_MIRRORS = [
  { name: 'gcore', base: 'https://gcore.jsdelivr.net/npm' },
  { name: 'unpkg', base: 'https://unpkg.com' },
  { name: 'jsdelivr', base: 'https://cdn.jsdelivr.net/npm' },
];

/** 单次字体请求超时：网络抖动时不要长时间挂住渲染。 */
const FONT_TIMEOUT_MS = 8000;
/** 镜像被判定不可用后的冷却时间。 */
const MIRROR_COOLDOWN_MS = 30_000;
/** 近期判定为不可用的镜像（host → 失败时间）。 */
const mirrorDown = new Map<string, number>();
/** 已确认不存在的相对路径（HTTP 404），避免在多个镜像上重复试探。 */
const missingPaths = new Set<string>();

/**
 * Lottie / AE 里常见的字体名 → 开源等价字体（Fontsource 包名）。
 *
 * AE 导出常带商用字体名（Arial、微软雅黑等），这些字体无法随动画分发；
 * 这里映射到可自由下载的开源替代字体，保证轮廓能拿到。
 */
const FONT_ALIASES: Record<string, string> = {
  arial: 'roboto',
  helvetica: 'inter',
  'helvetica neue': 'inter',
  'times new roman': 'noto-serif',
  times: 'noto-serif',
  georgia: 'noto-serif',
  'courier new': 'noto-sans-mono',
  'microsoft yahei': 'noto-sans-sc',
  '微软雅黑': 'noto-sans-sc',
  'pingfang sc': 'noto-sans-sc',
  'heiti sc': 'noto-sans-sc',
  'source han sans': 'noto-sans-sc',
  '思源黑体': 'noto-sans-sc',
  'noto sans sc': 'noto-sans-sc',
  'noto sans cjk sc': 'noto-sans-sc',
  simsun: 'noto-serif-sc',
  '宋体': 'noto-serif-sc',
  'source han serif': 'noto-serif-sc',
  roboto: 'roboto',
  inter: 'inter',
  'noto sans': 'noto-sans',
  'open sans': 'open-sans',
  lato: 'lato',
  'noto serif': 'noto-serif',
};

/** 文本图层里与排版相关的字段（只声明本模块用到的部分）。 */
interface TextStyle {
  /** 文本内容（多行用 \r 分隔） */
  t?: string;
  /** 字体名（对应 fonts.list[].fName） */
  f?: string;
  /** 字号（像素） */
  s?: number;
  /** 对齐：0 左、1 右、2 居中、3 两端 */
  j?: number;
  /** 字距（千分之一 em） */
  tr?: number;
  /** 行高（像素） */
  lh?: number;
  /** 填充色（0..1 的 rgb） */
  fc?: number[];
  /** 描边色 */
  sc?: number[];
  /** 描边宽度 */
  sw?: number;
  /** 描边是否压在填充之上 */
  of?: boolean;
}

/** 文档里的字体描述项。 */
interface FontDescriptor {
  fName?: string;
  fFamily?: string;
  fStyle?: string;
  ascent?: number;
  descent?: number;
}

/** 内存字体缓存：命中即用，未命中才走网络。 */
const fontCache = new Map<string, Font>();
/** 正在进行的加载，供并发调用合并等待。 */
const fontPending = new Map<string, Promise<Font | null>>();
/** 失败记录与重试间隔：一次网络抖动不应该让字体在本会话内永久不可用。 */
const fontFailures = new Map<string, number>();
const FONT_RETRY_MS = 60_000;

/** IndexedDB 缓存：字体文件较大（中文包约 1.5 MB），不放 localStorage。 */
const FONT_DB = 'lottie-fonts';
const FONT_STORE = 'files';
let dbPromise: Promise<IDBPDatabase | null> | null = null;

/** 延迟打开数据库；不可用（隐私模式、被禁用、非浏览器环境）时返回 null。 */
async function fontDb(): Promise<IDBPDatabase | null> {
  if (dbPromise) return dbPromise;
  // idb 的 openDB 会同步读取全局 indexedDB，必须在调用前判断环境
  if (typeof indexedDB === 'undefined') return null;
  let pending: Promise<IDBPDatabase | null> | null = null;
  try {
    pending = openDB(FONT_DB, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(FONT_STORE)) db.createObjectStore(FONT_STORE);
      },
    }).catch(() => null);
  } catch {
    pending = null;
  }
  dbPromise = pending;
  return pending;
}

/** 读取缓存的字体二进制。 */
async function readCachedFont(url: string): Promise<ArrayBuffer | null> {
  const db = await fontDb();
  if (!db) return null;
  try {
    const value = await db.get(FONT_STORE, url);
    return value instanceof ArrayBuffer ? value : null;
  } catch {
    return null;
  }
}

/** 写入缓存的字体二进制（失败不影响使用）。 */
async function writeCachedFont(url: string, buffer: ArrayBuffer): Promise<void> {
  const db = await fontDb();
  if (!db) return;
  try {
    await db.put(FONT_STORE, buffer, url);
  } catch {
    // 缓存写失败属于可接受降级：下次继续走网络
  }
}

/** 删除损坏的缓存条目，避免解析失败后反复读到同一份坏数据。 */
async function deleteCachedFont(url: string): Promise<void> {
  const db = await fontDb();
  if (!db) return;
  try {
    await db.delete(FONT_STORE, url);
  } catch {
    // 删除失败同样只是缓存问题，不影响重试
  }
}

/** 判断文本是否包含 CJK 字符（决定是否需要中文字体子集）。 */
function needsCjk(text: string): boolean {
  return /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

/** 把字体名规范成 Fontsource 包名。 */
function fontsourcePackage(family: string, cjk: boolean): string {
  const key = family.trim().toLowerCase();
  if (FONT_ALIASES[key]) return FONT_ALIASES[key];
  if (cjk) return 'noto-sans-sc';
  const slug = key
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'roboto';
}

/** 由样式名推断字重文件名（Fontsource 用 300/400/700 等数字）。 */
function weightOf(style: string): string {
  const value = style.toLowerCase();
  if (value.includes('thin')) return '100';
  if (value.includes('light')) return '300';
  if (value.includes('medium')) return '500';
  if (value.includes('semibold') || value.includes('demibold')) return '600';
  if (value.includes('bold')) return '700';
  if (value.includes('black') || value.includes('heavy')) return '900';
  return '400';
}

/** 判断镜像当前是否可用（刚失败过的先跳过）。 */
function mirrorUsable(base: string): boolean {
  let host = base;
  try {
    host = new URL(base).host;
  } catch {
    return true;
  }
  const failedAt = mirrorDown.get(host);
  return failedAt === undefined || Date.now() - failedAt >= MIRROR_COOLDOWN_MS;
}

/** 取 URL 去掉镜像前缀后的相对路径，用于跨镜像去重与 404 记忆。 */
function relativeOf(url: string): string {
  const match = /^https?:\/\/[^/]+\/(?:npm\/)?(.+)$/.exec(url);
  return match ? match[1] : url;
}

/** 生成候选字体 URL：先按子集命中，再回退到另一个子集，最后回退到 Roboto。 */
function candidateUrls(family: string, style: string, cjk: boolean): string[] {
  const weight = weightOf(style);
  const pkg = fontsourcePackage(family, cjk);
  const subsets = cjk ? ['chinese-simplified', 'latin'] : ['latin'];
  const paths = subsets.map((subset) => `@fontsource/${pkg}/files/${pkg}-${subset}-${weight}-normal.woff`);
  if (pkg !== 'roboto') paths.push(`@fontsource/roboto/files/roboto-latin-${weight}-normal.woff`);
  const usable = FONT_MIRRORS.filter((mirror) => mirrorUsable(mirror.base));
  const mirrors = usable.length ? usable : FONT_MIRRORS;
  const urls: string[] = [];
  for (const path of paths) {
    if (missingPaths.has(path)) continue;
    for (const mirror of mirrors) urls.push(`${mirror.base}/${path}`);
  }
  return urls;
}

/** 下载并解析一个字体 URL（带内存与 IndexedDB 两级缓存）。 */
async function loadFontAt(url: string): Promise<Font | null> {
  const cached = fontCache.get(url);
  if (cached) return cached;
  const pending = fontPending.get(url);
  if (pending) return pending;
  const failedAt = fontFailures.get(url);
  if (failedAt !== undefined && Date.now() - failedAt < FONT_RETRY_MS) return null;
  const task = (async () => {
    let fromCache = false;
    try {
      let buffer = await readCachedFont(url);
      fromCache = !!buffer;
      if (!buffer) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FONT_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (response.status === 404) {
          // 该字体文件不存在：记住相对路径，不必在其它镜像上重复试探
          missingPaths.add(relativeOf(url));
          throw new Error(`HTTP 404 ${relativeOf(url)}`);
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        buffer = await response.arrayBuffer();
        if (buffer.byteLength < 1024) throw new Error('字体文件过小');
        void writeCachedFont(url, buffer);
      }
      const font = opentype.parse(buffer);
      fontCache.set(url, font);
      fontFailures.delete(url);
      return font;
    } catch (error) {
      console.warn('Lottie 文本字体加载失败', url, error);
      // 只记录失败时间，允许稍后重试；永久缓存失败会让网络抖动变成“字体永久缺失”
      fontFailures.set(url, Date.now());
      if (fromCache) void deleteCachedFont(url);
      // 404 是文件不存在，不是镜像故障；只有网络类错误才让镜像进入冷却
      const missing = error instanceof Error && error.message.startsWith('HTTP 404');
      if (!missing) {
        try {
          mirrorDown.set(new URL(url).host, Date.now());
        } catch {
          // URL 解析失败说明地址本身有问题，交给上层继续试下一个候选
        }
      }
      return null;
    } finally {
      fontPending.delete(url);
    }
  })();
  fontPending.set(url, task);
  return task;
}

/** 按字体名加载字体，依次尝试候选 URL。 */
async function loadFontForFamily(family: string, style: string, cjk: boolean): Promise<Font | null> {
  for (const url of candidateUrls(family, style, cjk)) {
    const font = await loadFontAt(url);
    if (font) return font;
  }
  return null;
}

/** 遍历文档里的所有图层（含一层预合成资源），回调文本图层。 */
function forEachLayer(document: LottieDocument, visit: (layer: JsonObject) => void): void {
  const doc = document as JsonObject;
  const walk = (layers: unknown) => {
    if (!Array.isArray(layers)) return;
    for (const item of layers) {
      if (!item || typeof item !== 'object') continue;
      const layer = item as JsonObject;
      if (Number(layer.ty) === 5) visit(layer);
    }
  };
  walk(doc.layers);
  const assets = doc.assets;
  if (Array.isArray(assets)) {
    for (const asset of assets) {
      if (asset && typeof asset === 'object') walk((asset as JsonObject).layers);
    }
  }
}

/** 读取文本图层的静态样式；动画文本返回 null。 */
function staticStyle(layer: JsonObject): TextStyle | null {
  const text = layer.t as JsonObject | undefined;
  if (!text || typeof text !== 'object') return null;
  // 文本动画（range selector）与逐帧文本都超出静态展开能力
  if (Array.isArray(text.a) && text.a.length > 0) return null;
  const data = text.d as JsonObject | undefined;
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.a) && data.a.length > 0) return null;
  const keys = data.k;
  if (!Array.isArray(keys) || keys.length !== 1) return null;
  const first = keys[0] as JsonObject | undefined;
  const style = first?.s as TextStyle | undefined;
  if (!style || typeof style !== 'object') return null;
  return style;
}

/** 查找字体描述（fName → fFamily / fStyle）。 */
function fontDescriptor(document: LottieDocument, name: string | undefined): FontDescriptor {
  const fonts = (document as JsonObject).fonts as JsonObject | undefined;
  const list = fonts?.list;
  if (Array.isArray(list)) {
    for (const item of list) {
      const descriptor = item as FontDescriptor;
      if (descriptor?.fName === name) return descriptor;
    }
  }
  return { fName: name, fFamily: name ?? 'Roboto', fStyle: 'Regular' };
}

/** 把 opentype 的路径命令转成 Lottie 轮廓（三次贝塞尔 + 相对切线）。 */
function commandsToOutlines(commands: PathCommand[]): Outline[] {
  const outlines: Outline[] = [];
  let current: Outline | null = null;
  const flush = () => {
    if (current && current.v.length > 0) {
      if (current.closed) {
        // 闭合且末点与首点重合时，末点只是路径终点，去掉它但保留其入切线
        const last = current.v.length - 1;
        if (last > 0) {
          const first = current.v[0];
          const tail = current.v[last];
          if (Math.abs(tail[0] - first[0]) < 0.01 && Math.abs(tail[1] - first[1]) < 0.01) {
            current.i[0] = current.i[last];
            current.v.pop();
            current.i.pop();
            current.o.pop();
          }
        }
      }
      if (current.v.length >= 2) outlines.push(current);
    }
    current = null;
  };
  const push = (x: number, y: number): Outline => {
    const outline: Outline = { v: [], i: [], o: [], closed: false };
    outline.v.push([x, y]);
    outline.i.push([0, 0]);
    outline.o.push([0, 0]);
    return outline;
  };

  for (const command of commands) {
    if (command.type === 'M') {
      flush();
      current = push(command.x!, command.y!);
      continue;
    }
    if (!current) continue;
    const lastIndex = current.v.length - 1;
    if (command.type === 'L') {
      current.v.push([command.x!, command.y!]);
      current.i.push([0, 0]);
      current.o.push([0, 0]);
      continue;
    }
    if (command.type === 'C') {
      const from = current.v[lastIndex];
      current.o[lastIndex] = [command.x1! - from[0], command.y1! - from[1]];
      current.v.push([command.x!, command.y!]);
      current.i.push([command.x2! - command.x!, command.y2! - command.y!]);
      current.o.push([0, 0]);
      continue;
    }
    if (command.type === 'Q') {
      // 二次贝塞尔升阶成三次：控制点取 2/3 处
      const from = current.v[lastIndex];
      const end: Vec2 = [command.x!, command.y!];
      const qx = command.x1!;
      const qy = command.y1!;
      const c1: Vec2 = [from[0] + (2 / 3) * (qx - from[0]), from[1] + (2 / 3) * (qy - from[1])];
      const c2: Vec2 = [end[0] + (2 / 3) * (qx - end[0]), end[1] + (2 / 3) * (qy - end[1])];
      current.o[lastIndex] = [c1[0] - from[0], c1[1] - from[1]];
      current.v.push(end);
      current.i.push([c2[0] - end[0], c2[1] - end[1]]);
      current.o.push([0, 0]);
      continue;
    }
    if (command.type === 'Z') {
      current.closed = true;
      continue;
    }
  }
  flush();
  return outlines;
}

/** 一条轮廓转成 Lottie 的 `sh` item。 */
function outlineShape(outline: Outline): JsonObject {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    ty: 'sh',
    ks: {
      a: 0,
      k: {
        i: outline.i.map(([x, y]) => [round(x), round(y)]),
        o: outline.o.map(([x, y]) => [round(x), round(y)]),
        v: outline.v.map(([x, y]) => [round(x), round(y)]),
        c: outline.closed,
      },
    },
  };
}

/** 单行文本的轮廓数量与宽度（用于对齐计算）。 */
function measureLine(font: Font, text: string, size: number, tracking: number): number {
  let width = 0;
  for (const char of text) {
    const glyph = font.charToGlyph(char);
    width += (glyph.advanceWidth ?? 0) * (size / font.unitsPerEm) + tracking;
  }
  return width;
}

/** 把字号、颜色等规范成安全数值。 */
function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 颜色数组补齐成 [r,g,b,1]，并按 0..1 归一化。 */
function colorOf(value: unknown, fallback: [number, number, number]): number[] {
  const raw = Array.isArray(value) ? value.map((v) => numberOr(v, 0)) : [];
  if (raw.length < 3) return [...fallback, 1];
  const scale = raw.some((v) => v > 1.5) ? 255 : 1;
  return [raw[0] / scale, raw[1] / scale, raw[2] / scale, 1];
}

/** 复制一份文档：展开会改写图层结构，不能污染调用方手里的原始数据。 */
function cloneDocument(document: LottieDocument): LottieDocument {
  if (typeof structuredClone === 'function') return structuredClone(document);
  return JSON.parse(JSON.stringify(document)) as LottieDocument;
}

/**
 * 展开文档中的文本图层。
 *
 * 只读取字体内存缓存，不发起网络请求；缺字体的图层保持 ty=5，
 * 上层据此回退 canvas（Rust 后端会因文本图层显式报错）。
 * 返回的文档是新对象，传入的 document 不会被修改。
 *
 * @param document 已解析的 Lottie 文档
 * @returns 展开后的文档与统计信息
 */
export function expandLottieText(document: LottieDocument): TextReport {
  const messages: string[] = [];
  const fonts: string[] = [];
  let expanded = 0;
  let skipped = 0;
  let changed = false;
  const note = (message: string) => {
    if (messages.length < 24) messages.push(message);
  };

  let textLayers = 0;
  forEachLayer(document, () => {
    textLayers += 1;
  });
  if (!textLayers) {
    return { document, expanded: 0, skipped: 0, messages, fonts, changed: false };
  }

  const working = cloneDocument(document);
  forEachLayer(working, (layer) => {
    const name = typeof layer.nm === 'string' ? layer.nm : '文本层';
    const style = staticStyle(layer);
    if (!style) {
      skipped += 1;
      note(`${name}：文本动画或逐帧文本暂不支持`);
      return;
    }
    const text = typeof style.t === 'string' ? style.t : '';
    if (!text.trim()) {
      skipped += 1;
      note(`${name}：文本为空`);
      return;
    }
    const descriptor = fontDescriptor(document, style.f);
    const family = typeof descriptor.fFamily === 'string' ? descriptor.fFamily : descriptor.fName ?? 'Roboto';
    const italicStyle = typeof descriptor.fStyle === 'string' ? descriptor.fStyle : 'Regular';
    const cjk = needsCjk(text);
    const sample = `${family}|${italicStyle}|${cjk ? 'cjk' : 'latin'}`;
    if (!fonts.includes(sample)) fonts.push(sample);
    let font: Font | null = null;
    for (const url of candidateUrls(family, italicStyle, cjk)) {
      const cached = fontCache.get(url);
      if (cached) {
        font = cached;
        break;
      }
    }
    if (!font) {
      skipped += 1;
      note(`${name}：字体未加载（${family}）`);
      return;
    }
    const size = Math.max(1, numberOr(style.s, 48));
    const tracking = numberOr(style.tr, 0) / 1000 * size;
    const lineHeight = Math.max(size, numberOr(style.lh, size * 1.2));
    const align = numberOr(style.j, 0);
    const lines = text.split(/\r\n|\r|\n/);
    const items: JsonObject[] = [];

    lines.forEach((line, index) => {
      const width = measureLine(font, line, size, tracking);
      let x = 0;
      if (align === 1) x = -width;
      else if (align === 2) x = -width / 2;
      const baseline = index * lineHeight;
      for (const char of line) {
        const glyph = font.charToGlyph(char);
        if (glyph && char.trim()) {
          const path = glyph.getPath(x, baseline, size);
          for (const outline of commandsToOutlines(path.commands)) items.push(outlineShape(outline));
        }
        x += (glyph.advanceWidth ?? 0) * (size / font.unitsPerEm) + tracking;
      }
    });

    if (!items.length) {
      skipped += 1;
      note(`${name}：字形轮廓为空（可能全部缺字）`);
      return;
    }

    const fill = colorOf(style.fc, [0, 0, 0]);
    const strokeWidth = numberOr(style.sw, 0);
    const hasStroke = strokeWidth > 0 && Array.isArray(style.sc);
    const fillItem: JsonObject = { ty: 'fl', c: { a: 0, k: fill }, o: { a: 0, k: 100 } };
    const strokeItem: JsonObject = {
      ty: 'st',
      c: { a: 0, k: colorOf(style.sc, [0, 0, 0]) },
      o: { a: 0, k: 100 },
      w: { a: 0, k: strokeWidth },
      lc: 1,
      lj: 1,
    };
    const styleItems: JsonObject[] = [];
    if (hasStroke && style.of) styleItems.push(strokeItem, fillItem);
    else if (hasStroke) styleItems.push(fillItem, strokeItem);
    else styleItems.push(fillItem);
    styleItems.push({
      ty: 'tr',
      p: { a: 0, k: [0, 0] },
      a: { a: 0, k: [0, 0] },
      s: { a: 0, k: [100, 100] },
      r: { a: 0, k: 0 },
      o: { a: 0, k: 100 },
    });

    layer.shapes = [{ ty: 'gr', nm: name, it: [...items, ...styleItems] }];
    layer.ty = 4;
    delete layer.t;
    expanded += 1;
    changed = true;
  });

  return { document: working, expanded, skipped, messages, fonts, changed };
}

/**
 * 预取文本图层需要的字体（渲染前 await 一次）。
 *
 * 只下载缺失的字体；全部命中缓存时几乎无开销。返回值仅用于日志/调试。
 *
 * @param document 已解析的 Lottie 文档
 * @returns 实际请求过的字体描述列表
 */
export async function prepareLottieFonts(document: LottieDocument): Promise<string[]> {
  const requests: Array<{ family: string; style: string; cjk: boolean }> = [];
  forEachLayer(document, (layer) => {
    const style = staticStyle(layer);
    if (!style) return;
    const text = typeof style.t === 'string' ? style.t : '';
    if (!text.trim()) return;
    const descriptor = fontDescriptor(document, style.f);
    const family = typeof descriptor.fFamily === 'string' ? descriptor.fFamily : descriptor.fName ?? 'Roboto';
    const fontStyle = typeof descriptor.fStyle === 'string' ? descriptor.fStyle : 'Regular';
    requests.push({ family, style: fontStyle, cjk: needsCjk(text) });
  });
  const results = await Promise.all(
    requests.map(({ family, style, cjk }) => loadFontForFamily(family, style, cjk)),
  );
  return requests
    .map(({ family, style, cjk }, index) => `${family} ${style}${cjk ? ' (CJK)' : ''}: ${results[index] ? 'ok' : 'miss'}`)
    .filter((value, index, array) => array.indexOf(value) === index);
}

/** 文档里是否存在还未展开的文本图层（供上层判断是否需要回退 canvas）。 */
export function hasLottieTextLayers(document: LottieDocument): boolean {
  let found = false;
  forEachLayer(document, () => {
    found = true;
  });
  return found;
}
