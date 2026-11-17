/**
 * lottieExpressions.ts —— Lottie 表达式（AE expressions）烘焙
 *
 * 背景：
 * - Lottie 的表达式保存在属性对象的 `x` 字段里（字符串），本质是一段 After Effects
 *   语法的 JavaScript 片段，需要在播放时逐帧求值；
 * - Canvas2D 后端由 lottie-web 自带表达式引擎执行，但自研的 shader 后端（Rust/WASM 三角化）
 *   没有 JS 引擎，遇到 `x` 字段只能整体报错回退，带表达式的动画因此无法走 GPU 管线；
 * - 本模块在「交给渲染后端之前」把表达式逐帧求值，并改写成普通关键帧（`a:1, k:[{t,s}]`），
 *   于是三个后端拿到的都是纯数据动画，表达式不再是回退原因。
 *
 * 覆盖范围（对齐 After Effects 的常用写法）：
 * - 时间与自身属性：`time`、`value`、`valueAtTime`、`velocityAtTime`、`thisProperty`；
 * - 循环：`loopOut(type, num)`、`loopIn(type, num)`，支持 cycle / pingpong / offset；
 * - 抖动与随机：`wiggle(freq, amp, octaves, ampMult, t)`、`random`、`seedRandom`；
 * - 映射：`linear`、`ease`、`easeIn`、`easeOut`（含多点分段写法）、`clamp`；
 * - 工具：`Math`、`framesToTime`、`timeToFrames`、`degToRad`、`radToDeg`、`posterizeTime`；
 * - 同图层引用：`thisLayer.transform.*`、`thisLayer.width/height/index/name/inPoint/outPoint`、
 *   `effect("控件名")("参数名")`（读取图层效果控件，如 Slider Control）。
 *
 * 明确不支持（属性保持原样，渲染时由后端决定是否回退，绝不静默画错）：
 * - 跨图层引用（`comp.layer(...)`、`thisComp.layer(...)`）；
 * - 预合成资源（assets.layers）内部的表达式：其时间轴带 `st` 偏移，烘焙帧号会错位；
 * - 文本图层（ty=5）内部的表达式；
 * - 路径型属性（`sh` 的 ks、蒙版 `pt`）的表达式：结果是点集而不是数值关键帧。
 *
 * 安全性：表达式来自导入文件，这里在执行前做标识符黑名单扫描，
 * 拒绝 window / document / fetch / eval 等宿主能力，只把纯计算作用域交给 `new Function`。
 * 这只能挡住常见写法，导入来源仍应视为不可信；definitely 不放宽到可访问网络与存储。
 */

import type { LottieDocument } from './lottie';

/** 宽松 JSON 对象类型：Lottie 结构随导出工具变化，不追求精确建模。 */
type JsonObject = Record<string, unknown>;

/** 属性值：标量或分量数组。 */
type NumberValue = number | number[];

/** 单个关键帧（只声明本模块用到的字段）。 */
interface Keyframe {
  /** 时间（帧） */
  t: number;
  /** 起始值 */
  s?: NumberValue;
  /** 结束值（部分导出工具把结束值显式写在 e 上） */
  e?: NumberValue;
  /** 进入缓动控制点 */
  i?: { x?: NumberValue; y?: NumberValue };
  /** 离开缓动控制点 */
  o?: { x?: NumberValue; y?: NumberValue };
  /** 1 表示保持（hold） */
  h?: number;
}

/** 可动画属性节点。 */
interface PropertyNode extends JsonObject {
  a?: number;
  k?: unknown;
  x?: unknown;
}

/** 烘焙参数。 */
export interface BakeOptions {
  /** 采样步长（帧），1 表示逐帧；越大越省算力但曲线更折。 */
  frameStep?: number;
  /** 整份文档最多烘焙的属性数，超出部分保持原样。 */
  maxProperties?: number;
  /** 单个属性最多采样的帧数，超出视为不可烘焙。 */
  maxFrames?: number;
  /** 每成功烘焙一个属性回调一次（用于日志 / 测试）。 */
  onBake?: (info: { path: string; frames: number }) => void;
}

/** 烘焙结果报告。 */
export interface BakeReport {
  /** 烘焙后的文档（原文档不会被修改） */
  document: LottieDocument;
  /** 成功烘焙的属性数 */
  baked: number;
  /** 保持原样的表达式属性数 */
  skipped: number;
  /** 跳过原因（只保留前若干条，避免日志爆炸） */
  messages: string[];
  /** 是否发生了改写 */
  changed: boolean;
  /** 采样使用的帧率与 comp 起止帧，便于排查时间轴问题 */
  timeline: { fr: number; ip: number; op: number };
}

/** 数字容差：关键帧时间与常量判定都用它。 */
const EPSILON = 1e-4;

/** 把标量 / 数组 / 可转数值统一成数组。 */
function toNumbers(value: unknown): number[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [value] : [0];
  if (Array.isArray(value)) {
    return value.map((item) => {
      const n = typeof item === 'number' ? item : Number(item);
      return Number.isFinite(n) ? n : 0;
    });
  }
  const n = Number(value);
  return Number.isFinite(n) ? [n] : [0];
}

/** 取第 index 个分量；控制点是标量时退回同一值，避免多维属性丢失缓动。 */
function component(value: NumberValue | undefined, index: number, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (Array.isArray(value)) {
    const n = value[index] ?? value[0];
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/**
 * 解三次贝塞尔曲线 y(x)：Lottie 的缓动由 (o.x, o.y) 与 (i.x, i.y) 描述，
 * 先按 x 反解参数 t，再取 y，与 lottie-web 的 BezierEaser 行为一致。
 */
function cubicBezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const cx = clamp01(x);
  // 合法控制点下 x(t) 单调，二分 24 次精度已远超像素级需求，且不会像牛顿法那样发散
  let low = 0;
  let high = 1;
  let t = cx;
  for (let i = 0; i < 24; i += 1) {
    t = (low + high) / 2;
    const mt = 1 - t;
    const xt = 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t;
    if (xt < cx) low = t;
    else high = t;
  }
  const mt = 1 - t;
  return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t;
}

/** 判断属性是否按关键帧动画（a=1，或旧数据里用对象数组表示关键帧）。 */
function isAnimatedProperty(property: PropertyNode): boolean {
  if (property.a === 1) return true;
  if (property.a === 0) return false;
  const k = property.k;
  if (!Array.isArray(k) || k.length === 0) return false;
  const first = k[0];
  return Boolean(first && typeof first === 'object' && !Array.isArray(first) && 't' in (first as JsonObject));
}

/**
 * 读取属性在指定帧的原始值（表达式属性也按关键帧求值，不执行其表达式）。
 *
 * @param property 属性节点
 * @param frame    属性所属时间轴上的帧号
 * @returns 分量数组；静态复杂结构（渐变 / 路径）返回 null
 */
function propertyValueAt(property: PropertyNode, frame: number): number[] | null {
  const k = property.k;
  if (!isAnimatedProperty(property)) {
    if (typeof k === 'number') return [k];
    if (Array.isArray(k) && k.every((item) => typeof item === 'number')) return k as number[];
    return null;
  }
  if (!Array.isArray(k) || k.length === 0) return null;
  const frames = k as Keyframe[];
  const first = frames[0];
  if (!first || typeof first !== 'object') return null;
  if (frame <= first.t + EPSILON) return toNumbers(first.s ?? first.e);
  const last = frames[frames.length - 1];
  if (!last || frame >= last.t - EPSILON) return toNumbers(last.s ?? last.e);

  let index = 0;
  for (let i = 0; i < frames.length - 1; i += 1) {
    if (frame >= frames[i].t && frame < frames[i + 1].t) {
      index = i;
      break;
    }
  }
  const start = frames[index];
  const end = frames[index + 1] ?? start;
  if (!start || !end) return null;
  const startValue = toNumbers(start.s ?? start.e);
  const endValue = toNumbers(start.e ?? end.s ?? start.s);
  if (start.h || frame - start.t <= EPSILON) return startValue;
  const span = Math.max(EPSILON, end.t - start.t);
  const raw = Math.min(1, Math.max(0, (frame - start.t) / span));
  const length = Math.max(startValue.length, endValue.length);
  const result: number[] = [];
  for (let d = 0; d < length; d += 1) {
    const from = startValue[d] ?? startValue[0] ?? 0;
    const to = endValue[d] ?? endValue[0] ?? 0;
    let ratio = raw;
    if (start.i || start.o) {
      // 控制点缺省值取 lottie-web 的默认缓动（0.33 / 0.33 → 0.66 / 0.66）
      const x1 = component(start.o?.x, d, 0.333);
      const y1 = component(start.o?.y, d, 0.333);
      const x2 = component(start.i?.x, d, 0.667);
      const y2 = component(start.i?.y, d, 0.667);
      ratio = cubicBezierY(x1, y1, x2, y2, raw);
    }
    result.push(from + (to - from) * ratio);
  }
  return result;
}

/** 判断属性是否为路径型（`sh` 的 ks / 蒙版 pt）：关键帧里是点数组对象而不是数字。 */
function isPathProperty(property: PropertyNode): boolean {
  const k = property.k;
  if (!Array.isArray(k)) return false;
  const sample = k[0];
  if (!sample || typeof sample !== 'object') return false;
  if (Array.isArray(sample)) {
    const inner = (sample as unknown[])[0];
    return Boolean(inner && typeof inner === 'object' && 'v' in (inner as JsonObject));
  }
  if ('v' in (sample as JsonObject)) return true;
  const s = (sample as JsonObject).s;
  if (Array.isArray(s) && s.length > 0) {
    const point = s[0];
    return Boolean(point && typeof point === 'object' && 'v' in (point as JsonObject));
  }
  return false;
}

/** 表达式里禁止出现的能力名（宿主对象、网络、存储、模块系统）。 */
const FORBIDDEN_IDENTIFIER =
  /\b(window|globalThis|self|top|parent|opener|document|navigator|location|history|fetch|XMLHttpRequest|WebSocket|Worker|SharedWorker|importScripts|localStorage|sessionStorage|indexedDB|caches|crypto|eval|Function|require|module|exports|process|postMessage|alert|prompt|confirm|WebAssembly|Atomics|Reflect|Proxy)\b/;

/** 表达式是否触碰宿主能力。 */
function isUnsafeExpression(source: string): boolean {
  return FORBIDDEN_IDENTIFIER.test(source);
}

/**
 * 确定性伪随机（mulberry32）。
 * 表达式里的 random / wiggle 必须可复现：同一份作品在编辑、演示与导出时轨迹要一致。
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 一维平滑噪声：整数时间点取随机值，中间 smoothstep 插值，保证跨帧连续。 */
function smoothNoise(seed: number, x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  const a = makeRandom(seed + floor * 7919)() * 2 - 1;
  const b = makeRandom(seed + (floor + 1) * 7919)() * 2 - 1;
  const smooth = frac * frac * (3 - 2 * frac);
  return a + (b - a) * smooth;
}

/** 稳定字符串哈希（FNV-1a），给属性分配确定性随机种子。 */
function hashString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 把分量数组包装成 AE 习惯形态：一维返回数字，多维返回数组。 */
function shapeValue(value: number[] | null): number | number[] {
  if (!value) return 0;
  return value.length === 1 ? (value[0] ?? 0) : value.slice();
}

/** 按名称查找效果控件参数；`paramName` 缺省时取第一个带 v 的参数。 */
function findEffectValue(
  layer: JsonObject,
  effectName: string,
  paramName: string | undefined,
  frame: number,
): number[] | null {
  const effects = layer.ef;
  if (!Array.isArray(effects)) return null;
  for (const raw of effects) {
    if (!raw || typeof raw !== 'object') continue;
    const effect = raw as JsonObject;
    if (String(effect.nm ?? '') !== effectName) continue;
    const params = effect.ef;
    if (!Array.isArray(params)) return null;
    const picked = paramName
      ? params.find(
          (item) => item && typeof item === 'object' && String((item as JsonObject).nm ?? '') === paramName,
        )
      : params.find((item) => item && typeof item === 'object' && 'v' in (item as JsonObject));
    if (!picked || typeof picked !== 'object') continue;
    const value = (picked as JsonObject).v;
    if (!value || typeof value !== 'object') continue;
    return propertyValueAt(value as PropertyNode, frame);
  }
  return null;
}

/** 读取图层 ks 下变换属性的当前值（同图层引用用）。 */
function readTransformValue(layer: JsonObject, key: string, frame: number): number[] | null {
  const ks = layer.ks;
  if (!ks || typeof ks !== 'object') return null;
  const node = (ks as JsonObject)[key];
  if (!node || typeof node !== 'object') return null;
  return propertyValueAt(node as PropertyNode, frame);
}

/** 构造 thisLayer 代理：只读字段，写入会抛错并让该属性跳过烘焙。 */
function makeLayerProxy(layer: JsonObject, frame: number): JsonObject {
  const read = (key: string) => shapeValue(readTransformValue(layer, key, frame));
  return {
    name: String(layer.nm ?? ''),
    index: Number(layer.ind ?? 0),
    inPoint: Number(layer.ip ?? 0),
    outPoint: Number(layer.op ?? 0),
    width: Number(layer.w ?? 0),
    height: Number(layer.h ?? 0),
    transform: {
      get position() {
        return read('p');
      },
      get anchorPoint() {
        return read('a');
      },
      get scale() {
        return read('s');
      },
      get rotation() {
        return read('r');
      },
      get opacity() {
        return read('o');
      },
      get positionX() {
        const p = readTransformValue(layer, 'p', frame);
        return p ? p[0] ?? 0 : 0;
      },
      get positionY() {
        const p = readTransformValue(layer, 'p', frame);
        return p ? p[1] ?? 0 : 0;
      },
    },
    get position() {
      return read('p');
    },
    get opacity() {
      return read('o');
    },
    get rotation() {
      return read('r');
    },
    effect: (name: string, param?: string) => shapeValue(findEffectValue(layer, name, param, frame)),
  };
}

/** 多点分段映射：AE 的 linear / ease 支持 `t, t1, v1, t2, v2, ...`。 */
function piecewiseMap(
  args: number[],
  smooth: 'linear' | 'ease' | 'easeIn' | 'easeOut',
  fallback: { t: number; tMin: number; tMax: number; vMin: number; vMax: number },
): number {
  if (args.length < 5) {
    // 少于 3 对时按单段处理（调用方已按 5 参数签名兜底）
    const { t, tMin, tMax, vMin, vMax } = fallback;
    const span = tMax - tMin || EPSILON;
    const raw = Math.min(1, Math.max(0, (t - tMin) / span));
    const ratio = smooth === 'ease' ? raw * raw * (3 - 2 * raw) : smooth === 'easeIn' ? raw * raw : smooth === 'easeOut' ? 1 - (1 - raw) * (1 - raw) : raw;
    return vMin + (vMax - vMin) * ratio;
  }
  const t = args[0];
  const segments: { t: number; v: number }[] = [];
  for (let i = 1; i + 1 < args.length; i += 2) {
    segments.push({ t: args[i], v: args[i + 1] });
  }
  if (segments.length === 0) return 0;
  if (t <= segments[0].t) return segments[0].v;
  const last = segments[segments.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const a = segments[i];
    const b = segments[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t || EPSILON;
      const raw = Math.min(1, Math.max(0, (t - a.t) / span));
      const ratio = smooth === 'ease' ? raw * raw * (3 - 2 * raw) : smooth === 'easeIn' ? raw * raw : smooth === 'easeOut' ? 1 - (1 - raw) * (1 - raw) : raw;
      return a.v + (b.v - a.v) * ratio;
    }
  }
  return last.v;
}

/** 一次表达式求值所需的上下文。 */
interface EvalContext {
  layer: JsonObject;
  /** 属性所属时间轴上的帧号 */
  frame: number;
  /** comp 起始帧 */
  ip: number;
  /** 帧率 */
  fr: number;
  /** 属性自身（value / valueAtTime / loopOut 读原始关键帧） */
  property: PropertyNode;
  /** 当前帧原始属性值 */
  currentValue: number[];
  /** 随机种子基值 */
  seedBase: number;
}

/**
 * 构造表达式作用域。
 * 所有名字通过 with(scope) 注入；未提供的标识符会落到全局作用域，
 * 因此前面必须做黑名单扫描，这里只补数学与时间工具。
 */
function buildScope(ctx: EvalContext): Record<string, unknown> {
  const { property, frame, fr, ip, layer } = ctx;
  const seconds = (frame - ip) / fr;
  const toFrame = (time: number) => ip + time * fr;

  /** 属性自身关键帧的时间范围（用于 loop） */
  const span = (() => {
    const k = property.k;
    if (Array.isArray(k) && k.length > 0 && typeof (k[0] as Keyframe)?.t === 'number') {
      const firstFrame = (k[0] as Keyframe).t;
      const lastFrame = (k[k.length - 1] as Keyframe).t;
      return { start: firstFrame, end: lastFrame, length: Math.max(EPSILON, lastFrame - firstFrame) };
    }
    return { start: frame, end: frame, length: EPSILON };
  })();

  /** 循环取值：AE 的 loopOut 在末关键帧之后循环，loopIn 在首关键帧之前循环 */
  const loopedValue = (out: boolean, mode: unknown, count: unknown): number[] => {
    const modeName = String(mode ?? 'cycle');
    const repeat = Math.max(0, Number(count) || 0);
    const length = span.length;
    if (out) {
      if (frame <= span.end) return propertyValueAt(property, frame) ?? ctx.currentValue;
      const overflow = frame - span.end;
      const cycles = Math.floor(overflow / length);
      const phase = overflow - cycles * length;
      // num 参数限制循环次数：超出后停在末关键帧的值（0 表示无限循环）
      if (repeat > 0 && cycles >= repeat) return propertyValueAt(property, span.end) ?? ctx.currentValue;
      if (modeName === 'pingpong') {
        const period = length * 2;
        const trip = overflow % period;
        const target = span.end - (trip <= length ? trip : period - trip);
        return propertyValueAt(property, target) ?? ctx.currentValue;
      }
      if (modeName === 'offset') {
        const base = propertyValueAt(property, span.start + phase) ?? ctx.currentValue;
        const head = propertyValueAt(property, span.start) ?? ctx.currentValue;
        const tail = propertyValueAt(property, span.end) ?? ctx.currentValue;
        const lengthOf = Math.max(base.length, head.length, tail.length);
        const result: number[] = [];
        for (let d = 0; d < lengthOf; d += 1) {
          const delta = (tail[d] ?? 0) - (head[d] ?? 0);
          result.push((base[d] ?? 0) + delta * Math.max(0, cycles));
        }
        return result;
      }
      // cycle（默认）：把溢出时间折回属性自身区间
      return propertyValueAt(property, span.start + phase) ?? ctx.currentValue;
    }
    if (frame >= span.start) return propertyValueAt(property, frame) ?? ctx.currentValue;
    const under = span.start - frame;
    const cycles = Math.floor(under / length);
    const phase = under - cycles * length;
    // num 参数限制循环次数，与 loopOut 对称
    if (repeat > 0 && cycles >= repeat) return propertyValueAt(property, span.start) ?? ctx.currentValue;
    if (modeName === 'pingpong') {
      const period = length * 2;
      const trip = under % period;
      return propertyValueAt(property, span.start + (trip <= length ? trip : period - trip)) ?? ctx.currentValue;
    }
    // cycle：首关键帧之前按周期向末关键帧方向折回；phase 为 0 时应落在首关键帧
    return propertyValueAt(property, span.start + ((length - phase) % length)) ?? ctx.currentValue;
  };

  /** 每帧独立的随机序列：同一帧内多次调用推进，跨帧以帧号重新播种 */
  let randomState = makeRandom((ctx.seedBase ^ Math.imul(frame + 1, 2654435761)) >>> 0);

  /** 把任意参数表转成 number[]，供多点映射使用 */
  const numberArgs = (args: unknown[]): number[] =>
    args.map((item) => (typeof item === 'number' ? item : Number(item) || 0));

  const scope: Record<string, unknown> = {
    time: seconds,
    value: shapeValue(ctx.currentValue),
    valueAtTime: (time: number) => shapeValue(propertyValueAt(property, toFrame(time))),
    velocityAtTime: (time: number) => {
      const delta = 1 / fr;
      const before = propertyValueAt(property, toFrame(time - delta));
      const after = propertyValueAt(property, toFrame(time + delta));
      if (!before || !after) return 0;
      const length = Math.max(before.length, after.length);
      const diff: number[] = [];
      for (let d = 0; d < length; d += 1) {
        diff.push(((after[d] ?? 0) - (before[d] ?? 0)) / (2 * delta));
      }
      return shapeValue(diff);
    },
    loopOut: (mode?: unknown, num?: unknown) => shapeValue(loopedValue(true, mode, num)),
    loopIn: (mode?: unknown, num?: unknown) => shapeValue(loopedValue(false, mode, num)),
    wiggle: (freq: number, amp: number, octaves = 1, ampMult = 0.5, atTime?: number) => {
      const at = typeof atTime === 'number' ? atTime : seconds;
      const length = Math.max(1, ctx.currentValue.length);
      const value: number[] = [];
      for (let d = 0; d < length; d += 1) {
        let noise = 0;
        let weight = 1;
        let weightSum = 0;
        let octaveAmp = amp;
        for (let o = 0; o < Math.max(1, Math.round(octaves)); o += 1) {
          noise += smoothNoise(ctx.seedBase + d * 131 + o * 17, at * freq * Math.pow(2, o)) * octaveAmp;
          weightSum += weight;
          weight *= ampMult;
          octaveAmp *= ampMult;
        }
        value.push((ctx.currentValue[d] ?? 0) + noise / Math.max(EPSILON, weightSum));
      }
      return shapeValue(value);
    },
    random: (min?: unknown, max?: unknown) => {
      const roll = randomState();
      if (typeof min === 'number' && typeof max === 'number') return min + roll * (max - min);
      return roll;
    },
    seedRandom: (seed: unknown) => {
      randomState = makeRandom((Number(seed) || 0) >>> 0);
      return 0;
    },
    linear: (...args: unknown[]) => {
      const values = numberArgs(args);
      return piecewiseMap(values, 'linear', {
        t: values[0] ?? 0,
        tMin: values[1] ?? 0,
        tMax: values[2] ?? 0,
        vMin: values[3] ?? 0,
        vMax: values[4] ?? 0,
      });
    },
    ease: (...args: unknown[]) => {
      const values = numberArgs(args);
      return piecewiseMap(values, 'ease', {
        t: values[0] ?? 0,
        tMin: values[1] ?? 0,
        tMax: values[2] ?? 0,
        vMin: values[3] ?? 0,
        vMax: values[4] ?? 0,
      });
    },
    easeIn: (...args: unknown[]) => {
      const values = numberArgs(args);
      return piecewiseMap(values, 'easeIn', {
        t: values[0] ?? 0,
        tMin: values[1] ?? 0,
        tMax: values[2] ?? 0,
        vMin: values[3] ?? 0,
        vMax: values[4] ?? 0,
      });
    },
    easeOut: (...args: unknown[]) => {
      const values = numberArgs(args);
      return piecewiseMap(values, 'easeOut', {
        t: values[0] ?? 0,
        tMin: values[1] ?? 0,
        tMax: values[2] ?? 0,
        vMin: values[3] ?? 0,
        vMax: values[4] ?? 0,
      });
    },
    clamp: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)),
    framesToTime: (frames: number) => frames / fr,
    timeToFrames: (time: number) => time * fr,
    degToRad: (degrees: number) => (degrees * Math.PI) / 180,
    radToDeg: (radians: number) => (radians * 180) / Math.PI,
    // AE 的 posterizeTime 是「设置采样帧率」的副作用函数，返回值不参与运算，这里原样返回入参
    posterizeTime: (fps: number) => fps,
    Math,
    thisProperty: {
      value: shapeValue(ctx.currentValue),
      name: '',
      index: 0,
      propertyValueType: 0,
    },
    thisLayer: makeLayerProxy(layer, frame),
    effect: (name: string, param?: string) => shapeValue(findEffectValue(layer, name, param, frame)),
  };
  return scope;
}

/** 归一化表达式结果；维度不匹配时按属性维度裁剪或取首值。 */
function normalizeResult(result: unknown, dimension: number): number[] | null {
  if (typeof result === 'number') return Number.isFinite(result) ? [result] : null;
  if (Array.isArray(result)) {
    if (result.length === 0) return null;
    const values: number[] = [];
    for (let i = 0; i < result.length; i += 1) {
      const n = Number(result[i]);
      if (!Number.isFinite(n)) return null;
      values.push(n);
    }
    return dimension === 1 ? [values[0] ?? 0] : values;
  }
  return null;
}

/** 文档时间轴参数。 */
interface Timeline {
  fr: number;
  ip: number;
  op: number;
}

/** 单个属性的烘焙任务。 */
interface BakeTarget {
  property: PropertyNode;
  layer: JsonObject;
  path: string;
  seedBase: number;
  timeline: Timeline;
  frameStep: number;
  maxFrames: number;
}

/** 烘焙一个表达式属性；成功返回 true（node 已被改写）。 */
function bakeProperty(target: BakeTarget, reserveMessage: (text: string) => void): boolean {
  const { property, timeline } = target;
  const source = property.x;
  if (typeof source !== 'string') return false;
  if (isPathProperty(property)) {
    reserveMessage(`${target.path}：路径属性不支持表达式烘焙`);
    return false;
  }
  if (isUnsafeExpression(source)) {
    reserveMessage(`${target.path}：表达式包含宿主能力调用，已跳过`);
    return false;
  }
  let evaluator: (scope: Record<string, unknown>) => unknown;
  try {
    // 非严格函数：with 把 scope 名字注入作用域，等价于 AE 的表达式变量表
    evaluator = new Function('scope', `with (scope) { return (${source}); }`) as (
      scope: Record<string, unknown>,
    ) => unknown;
  } catch (error) {
    reserveMessage(
      `${target.path}：表达式语法错误（${error instanceof Error ? error.message : String(error)}）`,
    );
    return false;
  }

  const start = timeline.ip;
  const end = timeline.op;
  const sampledFrames = Math.floor((end - start) / target.frameStep) + 1;
  if (sampledFrames > target.maxFrames) {
    reserveMessage(`${target.path}：采样帧数 ${sampledFrames} 超过上限 ${target.maxFrames}，已跳过`);
    return false;
  }
  const baseValue = propertyValueAt(property, start);
  if (!baseValue) {
    reserveMessage(`${target.path}：属性原始值不是数值，已跳过`);
    return false;
  }
  const dimension = Math.max(1, baseValue.length);

  const samples: { t: number; v: number[] }[] = [];
  for (let frame = start; frame <= end; frame += target.frameStep) {
    const currentValue = propertyValueAt(property, frame);
    if (!currentValue) {
      reserveMessage(`${target.path}：属性原始值不是数值，已跳过`);
      return false;
    }
    const ctx: EvalContext = {
      layer: target.layer,
      frame,
      ip: timeline.ip,
      fr: timeline.fr,
      property,
      currentValue,
      seedBase: target.seedBase,
    };
    let raw: unknown;
    try {
      raw = evaluator(buildScope(ctx));
    } catch (error) {
      reserveMessage(
        `${target.path}：表达式求值失败（${error instanceof Error ? error.message : String(error)}）`,
      );
      return false;
    }
    const value = normalizeResult(raw, dimension);
    if (!value) {
      // 一维之外最常见的失败原因是 AE 的向量算术（`value + [x, y]`）：
      // 在 JS 里数组相加会变成字符串拼接，无法逐分量还原，只能明确提示改写方式。
      reserveMessage(
        dimension > 1
          ? `${target.path}：结果不是数值数组（多维属性需写成 value[0] + 10 这类逐分量形式，不支持 value + [x, y]）`
          : `${target.path}：表达式返回了非数值结果`,
      );
      return false;
    }
    samples.push({ t: frame, v: value.length > dimension ? value.slice(0, dimension) : value });
  }
  if (samples.length === 0) return false;

  // 恒定结果写成静态属性，避免给每个属性都塞一串关键帧（也会影响 shader 侧的脏检查成本）
  const constant = samples.every((sample) =>
    sample.v.every((v, i) => Math.abs(v - (samples[0].v[i] ?? v)) < EPSILON),
  );
  if (constant) {
    property.a = 0;
    property.k = dimension === 1 ? samples[0].v[0] ?? 0 : samples[0].v.slice();
  } else {
    property.a = 1;
    property.k = samples.map((sample) => ({
      t: Math.round(sample.t * 1000) / 1000,
      s: dimension === 1 ? [sample.v[0] ?? 0] : sample.v.slice(),
      // 逐帧采样结果之间必须线性连接：缺省控制点在自研后端会被当成 (0,0)-(0,0) 的三次曲线，
      // 显式写出 (0,0)/(1,1) 让 lottie-web（下一关键帧的 i + 当前关键帧的 o）与 Rust 侧
      // 都判定为直线插值，避免采样点之间出现额外的缓动鼓包。
      o: { x: 0, y: 0 },
      i: { x: 1, y: 1 },
    }));
  }
  delete property.x;
  return true;
}

/** 遍历图层内所有带表达式的属性对象；命中后不再深入该节点。 */
function collectProperties(value: unknown, visit: (property: PropertyNode, path: string) => void, path: string) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectProperties(item, visit, `${path}[${index}]`));
    return;
  }
  const object = value as JsonObject;
  if (typeof object.x === 'string' && (object.k !== undefined || object.a !== undefined)) {
    visit(object as PropertyNode, path);
    return;
  }
  for (const key of Object.keys(object)) {
    if (key === 'x' && typeof object[key] === 'string') continue;
    collectProperties(object[key], visit, `${path}.${key}`);
  }
}

/**
 * 烘焙 Lottie 表达式。
 *
 * 在所有渲染后端之前统一调用：表达式被逐帧求值并改写成普通关键帧，
 * 自研 shader 后端因此可以编译带表达式的动画；无法安全烘焙的属性保持原样，
 * 由后端按既有策略处理（shader 会显式报错并回退 canvas，不会画出错误结果）。
 *
 * @param document 已解析的 Lottie 文档
 * @param options  采样步长与上限
 * @returns 新文档与统计报告；原对象不会被修改
 */
export function bakeLottieExpressions(document: LottieDocument, options: BakeOptions = {}): BakeReport {
  const doc = document as JsonObject;
  const timeline: Timeline = {
    fr: Math.max(1, Number(doc.fr) || 30),
    ip: Number(doc.ip) || 0,
    op: Number(doc.op) || (Number(doc.ip) || 0) + Math.max(1, Number(doc.fr) || 30) * 2,
  };
  const report: BakeReport = {
    document,
    baked: 0,
    skipped: 0,
    messages: [],
    changed: false,
    timeline,
  };
  const rawLayers = Array.isArray(doc.layers) ? (doc.layers as unknown[]) : null;
  if (!rawLayers) return report;

  const frameStep = Math.max(1, Math.round(options.frameStep ?? 1));
  const maxProperties = Math.max(0, Math.round(options.maxProperties ?? 4096));
  const maxFrames = Math.max(2, Math.round(options.maxFrames ?? 3000));
  const messageLimit = 24;
  const reserveMessage = (text: string) => {
    if (report.messages.length < messageLimit) report.messages.push(text);
  };

  const clone = JSON.parse(JSON.stringify(document)) as LottieDocument;
  const layers = clone.layers as unknown[];
  let propertyCount = 0;

  layers.forEach((rawLayer, layerIndex) => {
    if (!rawLayer || typeof rawLayer !== 'object') return;
    const layer = rawLayer as JsonObject;
    // 隐藏图层不绘制，烘焙没有意义
    if (layer.hd === true) return;
    const ty = Number(layer.ty) || 0;
    if (ty === 5) {
      // 文本图层：文字内容与字形轮廓由 canvas 后端负责
      reserveMessage(`layers[${layerIndex}]：文本图层暂不烘焙表达式`);
      return;
    }

    // 预合成图层：本层变换属性在当前时间轴上，可以烘焙；内部图层涉及 st 偏移，留给 canvas
    const roots =
      ty === 0
        ? [{ value: layer.ks, path: '.ks' }]
        : [
            { value: layer.ks, path: '.ks' },
            { value: layer.shapes, path: '.shapes' },
            { value: layer.masksProperties, path: '.masksProperties' },
            { value: layer.ef, path: '.ef' },
          ];

    for (const root of roots) {
      collectProperties(root.value, (property, path) => {
        if (propertyCount >= maxProperties) return;
        propertyCount += 1;
        const fullPath = `layers[${layerIndex}]${root.path}${path}`;
        const target: BakeTarget = {
          property,
          layer,
          path: fullPath,
          seedBase: hashString(fullPath),
          timeline,
          frameStep,
          maxFrames,
        };
        if (bakeProperty(target, reserveMessage)) {
          report.baked += 1;
          report.changed = true;
          options.onBake?.({ path: fullPath, frames: sampledLength(target) });
        } else {
          report.skipped += 1;
        }
      }, '');
    }
  });

  report.document = clone;
  return report;
}

/** 统计属性烘焙后的关键帧数量（仅用于日志）。 */
function sampledLength(target: BakeTarget): number {
  const k = target.property.k;
  return Array.isArray(k) ? k.length : 0;
}

/**
 * 文档（含预合成资源）是否仍含表达式。
 *
 * 烘焙只扫顶层图层，预合成内部因为时间轴偏移被刻意跳过；因此判断「能否安全交给没有
 * JS 引擎的后端」时必须扫全文档，否则会出现顶层已烘焙、内部仍带 x 却被放行的情况。
 */
export function hasLottieExpressions(document: LottieDocument): boolean {
  let found = false;
  const scan = (value: unknown): void => {
    if (found || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    const object = value as JsonObject;
    if (typeof object.x === 'string' && (object.k !== undefined || object.a !== undefined)) {
      found = true;
      return;
    }
    Object.keys(object).forEach((key) => scan(object[key]));
  };
  scan(document);
  return found;
}
