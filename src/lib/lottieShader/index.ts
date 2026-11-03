/**
 * lottieShader —— Rust/WASM 版 Lottie 形状动画渲染后端
 *
 * 工作方式：
 * 1. Rust（lottie2shader crate）解析 Lottie JSON，用 lyon 对贝塞尔路径做自适应离散化，
 *    并以扫描线三角化的方式生成填充/描边的三角形；几何一次烘焙到图层局部坐标，
 *    含关键帧的形状/组变换/trim path 等动态层在渲染时逐帧重烘焙；
 * 2. 每帧只做「图层矩阵变换 + 顶点输出」，把结果通过线性内存交给 JS；
 * 3. 本模块把顶点上传到 WebGL2，用着色器完成纯色 / 线性渐变 / 径向渐变的填充，
 *    图片图层用纹理采样，轨道遮罩用离屏 FBO 生成 alpha 遮罩后逐像素合成；
 *    光栅化与抗锯齿交给 GPU（MSAA）。
 * 4. 所有播放器共享同一个隐藏的 WebGL2 上下文（浏览器上下文配额有限，
 *    每个对象单开上下文会挤掉 three.js 自己的上下文），渲染完成后把结果
 *    拷回各对象的 2D 画布，最终作为纹理供 three.js 采样。
 *
 * 数据格式（Rust 输出，单位 u32 / f32 混合，小端）：
 * - word 0 / 1 / 2：批次数量、顶点数量（对）、UV 数量（对）
 * - 每个批次固定 64 个字：
 *   kind、顶点起始、顶点数量、颜色 RGBA、整体 alpha、渐变起点、渐变终点、
 *   色标数量、8 个色标（每个 offset + RGBA 共 5 个字）、UV 起始、
 *   遮罩分组、遮罩模式、遮罩角色（1 遮罩源 / 2 被遮罩）、图片索引
 * - 批次之后是顶点数组，每个顶点 x、y 两个 f32；再之后是图片 UV 数组（u、v）。
 *
 * 未支持的 Lottie 特性（文本/表达式/图层蒙版/图层特效等）由 Rust 侧显式报错，
 * 注册中心据此自动回退到其他后端，本模块只负责能无损编译的动画。
 */

import wasmUrl from './lottie2shader.wasm?url';
import type { LottieBackend, LottieBackendCreateOptions, LottieBackendInstance } from '../lottieBackends';
import type { LottieDocument } from '../lottie';

/** 批次头固定字数，必须与 Rust 侧 BATCH_WORDS 保持一致 */
const BATCH_WORDS = 64;
/** 渐变色标上限，与 Rust 和着色器 uniform 数组长度一致 */
const MAX_STOPS = 8;
/** 图片批次类型，与 Rust 侧一致 */
const KIND_IMAGE = 3;
/** 蒙版覆盖几何 */
const KIND_MASK = 5;
/** 全屏覆盖几何 */
const KIND_FULL = 6;
/** 没有图层 pass 的批次 */
const PASS_NONE = 0xffffffff;
/** 后端 id，注册中心按该值把对象解析到本实现 */
export const SHADER_BACKEND_ID = 'shader';

/** WASM 导出函数签名（裸导出，无 wasm-bindgen） */
interface ShaderExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  l2s_alloc: (len: number) => number;
  l2s_free: (ptr: number, len: number) => void;
  l2s_compile: (ptr: number, len: number, width: number, height: number) => number;
  l2s_set_size: (width: number, height: number) => void;
  l2s_render: (frame: number) => number;
  l2s_result_ptr: () => number;
  l2s_result_len: () => number;
  l2s_error_ptr: () => number;
  l2s_error_len: () => number;
  l2s_fps: () => number;
  l2s_ip: () => number;
  l2s_op: () => number;
  l2s_image_count: () => number;
  l2s_image_src_ptr: (index: number) => number;
  l2s_image_src_len: (index: number) => number;
}

let modulePromise: Promise<WebAssembly.Module> | null = null;

/**
 * 加载并编译 WASM 模块（单例）。
 *
 * 之前缓存的是「实例」：Rust 侧用全局静态变量保存当前编译结果，多个 Lottie 对象
 * 共用同一实例时会互相覆盖编译结果。改为缓存 Module、每个播放器各自实例化，
 * 即可让同一页面的多个对象互不干扰。模块本身只需编译一次，实例化成本很低。
 *
 * 先走流式编译；若服务器 MIME 类型不正确则回退为 ArrayBuffer 编译。
 */
export function loadShaderModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    modulePromise = WebAssembly.instantiateStreaming(fetch(wasmUrl), {})
      .then((result) => result.module)
      .catch(async () => {
        const buffer = await (await fetch(wasmUrl)).arrayBuffer();
        return WebAssembly.compile(buffer);
      });
    modulePromise.catch(() => {
      modulePromise = null;
    });
  }
  return modulePromise;
}

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;
uniform vec2 u_size;
out vec2 v_pos;
out vec2 v_uv;
void main() {
  v_pos = a_pos;
  v_uv = a_uv;
  // 像素坐标（Y 向下）转裁剪空间
  vec2 clip = vec2(a_pos.x / u_size.x * 2.0 - 1.0, 1.0 - a_pos.y / u_size.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_pos;
in vec2 v_uv;
uniform int u_kind;        // 0 纯色 / 1 线性渐变 / 2 径向渐变 / 3 图片 / 5 蒙版覆盖 / 6 全屏覆盖
uniform vec4 u_color;
uniform float u_alpha;
uniform vec2 u_p0;
uniform vec2 u_p1;
uniform int u_stopCount;
uniform float u_offsets[${MAX_STOPS}];
uniform vec4 u_colors[${MAX_STOPS}];
uniform sampler2D u_tex;
uniform vec2 u_size;
out vec4 outColor;

vec4 sampleGradient(float t) {
  t = clamp(t, 0.0, 1.0);
  vec4 color = u_colors[0];
  // 先定位 t 所在的色标区间（避免 GLSL ES 3.0 对动态下标的限制）
  for (int i = 1; i < ${MAX_STOPS}; i++) {
    if (i >= u_stopCount) break;
    if (t < u_offsets[i]) {
      float span = max(1e-5, u_offsets[i] - u_offsets[i - 1]);
      float f = clamp((t - u_offsets[i - 1]) / span, 0.0, 1.0);
      color = mix(u_colors[i - 1], u_colors[i], f);
      return color;
    }
    color = u_colors[i];
  }
  return color;
}

void main() {
  // 蒙版覆盖几何：输出白色覆盖度，由合成阶段按蒙版运算叠加
  if (u_kind == 5) {
    outColor = vec4(u_alpha);
    return;
  }
  // 反向蒙版「加」模式的铺底：整屏覆盖度为 1
  if (u_kind == 6) {
    outColor = vec4(1.0);
    return;
  }
  vec4 color;
  if (u_kind == 3) {
    color = texture(u_tex, v_uv);
  } else if (u_kind == 0) {
    color = u_color;
  } else if (u_kind == 1) {
    vec2 dir = u_p1 - u_p0;
    float len2 = max(1e-5, dot(dir, dir));
    color = sampleGradient(dot(v_pos - u_p0, dir) / len2);
  } else {
    float radius = max(1e-5, length(u_p1 - u_p0));
    color = sampleGradient(length(v_pos - u_p0) / radius);
  }
  color.a *= u_alpha;
  // 全流程使用预乘 alpha：离屏 FBO 的模糊与合成都按预乘颜色进行
  outColor = vec4(color.rgb * color.a, color.a);
}`;

/** 全屏 quad 的顶点着色器（模糊与合成程序共用） */
const QUAD_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** 可分离高斯模糊：13 tap，采样半径覆盖 ±3σ */
const BLUR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_step;   // 每个 tap 的 uv 偏移（sigma/2）
out vec4 outColor;
void main() {
  vec4 sum = texture(u_tex, v_uv);
  float norm = 1.0;
  for (int i = 1; i <= 6; i++) {
    float w = exp(-0.5 * float(i) * float(i) * 0.25);
    vec2 off = u_step * float(i);
    sum += (texture(u_tex, v_uv + off) + texture(u_tex, v_uv - off)) * w;
    norm += 2.0 * w;
  }
  outColor = sum / norm;
}`;

/**
 * 合成程序：把离屏图层与蒙版 / 轨道遮罩相乘后画到目标。
 * u_mode：0 无遮罩、1 图层蒙版 alpha、2 alpha-in、3 alpha-out、4 亮度-in、5 亮度-out
 */
const COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform int u_mode;
out vec4 outColor;
void main() {
  vec4 src = texture(u_src, v_uv);
  float a = 1.0;
  if (u_mode == 1) {
    a = texture(u_mask, v_uv).a;
  } else if (u_mode >= 2) {
    vec4 m = texture(u_mask, v_uv);
    if (u_mode >= 4) {
      // 亮度遮罩：SVG 滤镜 alpha 行是 0.3*R+0.3*G+0.3*B（输入为预乘颜色），
      // 因此直接对预乘 RGB 取亮度，天然带上遮罩图层自身的 alpha
      float l = clamp(0.3 * (m.r + m.g + m.b), 0.0, 1.0);
      a = u_mode == 4 ? l : 1.0 - l;
    } else {
      a = u_mode == 2 ? m.a : 1.0 - m.a;
    }
  }
  outColor = vec4(src.rgb * a, src.a * a);
}`;

/**
 * 图层混合模式程序：把图层内容按 lottie 的 bm 与背景混合。
 * WebGL2 无法读回当前帧缓冲，因此调用方会先把目标复制到 u_dst 再执行本程序。
 * u_blend 使用 lottie 的 bm 原值：1 multiply、2 screen、3 overlay、4 darken、
 * 5 lighten、6 color-dodge、7 color-burn、8 hard-light、9 soft-light、
 * 10 difference、11 exclusion，0 / 12+ 按正常混合处理。
 */
const BLEND_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_dst;
uniform int u_blend;
out vec4 outColor;

float hardLight(float cb, float cs) {
  return cs <= 0.5 ? 2.0 * cb * cs : 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
}

vec3 blendColor(vec3 cb, vec3 cs, int mode) {
  if (mode == 1) {
    return cb * cs;
  } else if (mode == 2) {
    return cb + cs - cb * cs;
  } else if (mode == 3) {
    return vec3(hardLight(cs.r, cb.r), hardLight(cs.g, cb.g), hardLight(cs.b, cb.b));
  } else if (mode == 4) {
    return min(cb, cs);
  } else if (mode == 5) {
    return max(cb, cs);
  } else if (mode == 6) {
    return min(vec3(1.0), cb / max(vec3(1e-5), 1.0 - cs));
  } else if (mode == 7) {
    return 1.0 - min(vec3(1.0), (1.0 - cb) / max(vec3(1e-5), cs));
  } else if (mode == 8) {
    return vec3(hardLight(cb.r, cs.r), hardLight(cb.g, cs.g), hardLight(cb.b, cs.b));
  } else if (mode == 9) {
    vec3 d = mix(cb * cb * (3.0 - 2.0 * cb), sqrt(cb), cs);
    return vec3(
      cs.r <= 0.5 ? cb.r - (1.0 - 2.0 * cs.r) * cb.r * (1.0 - cb.r) : d.r,
      cs.g <= 0.5 ? cb.g - (1.0 - 2.0 * cs.g) * cb.g * (1.0 - cb.g) : d.g,
      cs.b <= 0.5 ? cb.b - (1.0 - 2.0 * cs.b) * cb.b * (1.0 - cb.b) : d.b);
  } else if (mode == 10) {
    return abs(cb - cs);
  } else if (mode == 11) {
    return cb + cs - 2.0 * cb * cs;
  }
  return cs;
}

void main() {
  // 两侧都是预乘颜色，混合函数需要非预乘分量
  vec4 s = texture(u_src, v_uv);
  vec4 d = texture(u_dst, v_uv);
  vec3 cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 cb = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 b = blendColor(cb, cs, u_blend);
  // 先按混合函数替换交叠区域，再做 source-over
  vec3 co = s.rgb * (1.0 - d.a) + s.a * d.a * b + d.rgb * (1.0 - s.a);
  outColor = vec4(co, s.a + d.a * (1.0 - s.a));
}`;


function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建着色器');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败：${info}`);
  }
  return shader;
}

/** 单个绘制批次的解析结果 */
interface DrawBatch {
  kind: number;
  first: number;
  count: number;
  color: [number, number, number, number];
  alpha: number;
  p0: [number, number];
  p1: [number, number];
  stops: [number, number, number, number, number][];
  /** UV 数组中的起始下标（对）；仅图片批次有效 */
  uvFirst: number;
  /** 轨道遮罩分组 id，0 表示普通批次 */
  group: number;
  /** 轨道遮罩类型 tt：1 alpha-in、2 alpha-out、3 亮度-in、4 亮度-out */
  matteMode: number;
  /** 遮罩角色：0 普通、1 遮罩源、2 被遮罩 */
  role: number;
  /** 图片纹理索引，-1 表示非图片批次 */
  imageIndex: number;
  /** 所属图层 pass（模糊 / 蒙版图层），0xFFFFFFFF 表示直接画到目标 */
  passId: number;
  /** 所属图层的混合模式（lottie bm 原值，0 表示正常） */
  blend: number;
  /** 所属图层下标：同一图层的批次连续存放，混合模式按图层整体生效 */
  layer: number;
}

/** 图层离屏 pass（模糊或蒙版） */
interface LayerPass {
  /** 图层索引（= pass id） */
  id: number;
  firstBatch: number;
  batchCount: number;
  wrap: boolean;
  sigmaX: number;
  sigmaY: number;
  /** 图层蒙版在 masks 数组中的区间 */
  maskFirst: number;
  maskCount: number;
}

/** 一条图层蒙版 */
interface LayerMask {
  op: number;
  inv: boolean;
  /** 蒙版覆盖几何的批次 */
  batch: number;
  pass: number;
  opacity: number;
  /** 反向「加」蒙版的铺底批次，无则 -1 */
  quad: number;
}

/** 解析后的整帧渲染计划 */
interface RenderPlan {
  batches: DrawBatch[];
  vertexCount: number;
  uvCount: number;
  /** 模糊 / 蒙版图层（按渲染顺序） */
  passes: LayerPass[];
  masks: LayerMask[];
}

/**
 * 把 WASM 输出的二进制渲染计划解析成绘制批次。
 *
 * @param ints   以小端 u32 视图读取的渲染计划（长度 = result_len / 4）
 * @param floats 与 ints 共享同一块内存的 f32 视图，用于读取颜色/坐标/透明度
 */
function parsePlan(ints: Uint32Array, floats: Float32Array): RenderPlan {
  const count = ints[0] ?? 0;
  const vertexCount = ints[1] ?? 0;
  const uvCount = ints[2] ?? 0;
  const batches: DrawBatch[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = 3 + i * BATCH_WORDS;
    const stops: [number, number, number, number, number][] = [];
    const stopCount = ints[base + 12] ?? 0;
    for (let s = 0; s < Math.min(MAX_STOPS, stopCount); s += 1) {
      const off = base + 13 + s * 5;
      stops.push([floats[off], floats[off + 1], floats[off + 2], floats[off + 3], floats[off + 4]]);
    }
    const imageWord = ints[base + 57] ?? 0xffffffff;
    batches.push({
      kind: ints[base] ?? 0,
      first: ints[base + 1] ?? 0,
      count: ints[base + 2] ?? 0,
      color: [floats[base + 3], floats[base + 4], floats[base + 5], floats[base + 6]],
      alpha: floats[base + 7],
      p0: [floats[base + 8], floats[base + 9]],
      p1: [floats[base + 10], floats[base + 11]],
      stops,
      uvFirst: ints[base + 53] ?? 0,
      group: ints[base + 54] ?? 0,
      matteMode: ints[base + 55] ?? 0,
      role: ints[base + 56] ?? 0,
      imageIndex: imageWord === 0xffffffff ? -1 : imageWord,
      passId: ints[base + 58] ?? 0xffffffff,
      blend: ints[base + 59] ?? 0,
      layer: ints[base + 60] ?? 0,
    });
  }
  // 尾部：pass 与蒙版记录
  const afterBatches = 3 + count * BATCH_WORDS + vertexCount * 2 + uvCount * 2;
  const passCount = ints[afterBatches] ?? 0;
  const passes: LayerPass[] = [];
  for (let i = 0; i < passCount; i += 1) {
    const o = afterBatches + 1 + i * 10;
    passes.push({
      id: ints[o] ?? 0,
      firstBatch: ints[o + 1] ?? 0,
      batchCount: ints[o + 2] ?? 0,
      wrap: (ints[o + 3] ?? 0) === 1,
      sigmaX: floats[o + 4],
      sigmaY: floats[o + 5],
      maskFirst: ints[o + 7] ?? 0xffffffff,
      maskCount: ints[o + 8] ?? 0,
    });
  }
  const maskCount = ints[afterBatches + 1 + passCount * 10] ?? 0;
  const masks: LayerMask[] = [];
  for (let i = 0; i < maskCount; i += 1) {
    const o = afterBatches + 2 + passCount * 10 + i * 6;
    const quad = ints[o + 5] ?? 0xffffffff;
    masks.push({
      op: ints[o] ?? 0,
      inv: (ints[o + 1] ?? 0) === 1,
      batch: ints[o + 2] ?? 0,
      pass: ints[o + 3] ?? 0,
      opacity: floats[o + 4],
      quad: quad === 0xffffffff ? -1 : quad,
    });
  }
  return { batches, vertexCount, uvCount, passes, masks };
}

/** 主着色器 uniform 位置集合（同一上下文内的所有播放器共享） */
interface UniformSet {
  size: WebGLUniformLocation;
  kind: WebGLUniformLocation;
  color: WebGLUniformLocation;
  alpha: WebGLUniformLocation;
  p0: WebGLUniformLocation;
  p1: WebGLUniformLocation;
  stopCount: WebGLUniformLocation;
  offsets: WebGLUniformLocation;
  colors: WebGLUniformLocation;
  tex: WebGLUniformLocation;
}

/** 模糊程序 uniform 位置 */
interface BlurUniformSet {
  tex: WebGLUniformLocation;
  step: WebGLUniformLocation;
}

/** 合成程序 uniform 位置 */
interface CompositeUniformSet {
  src: WebGLUniformLocation;
  mask: WebGLUniformLocation;
  mode: WebGLUniformLocation;
}

/** 混合模式程序 uniform 位置 */
interface BlendUniformSet {
  src: WebGLUniformLocation;
  dst: WebGLUniformLocation;
  mode: WebGLUniformLocation;
}

/**
 * 全局共享的 WebGL2 上下文。
 *
 * 浏览器对同时存活的 WebGL 上下文有硬上限（常见为 16 个），超限时最旧的上下文
 * 会被强制回收。若每个 Lottie 对象各建一个上下文，页面上的动画一多，就会先回收
 * three.js 自己的上下文，表现为整场景渲染时程序链接日志读取空指针。
 *
 * 因此这里只建立一个隐藏画布与上下文：各播放器按自身尺寸渲染到它的默认帧缓冲，
 * 再把结果拷回自己的 2D 画布（SceneManager 仍按画布取纹理），上下文数量恒为 1。
 */
interface SharedGL {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  blurProgram: WebGLProgram;
  compositeProgram: WebGLProgram;
  /** 图层混合模式合成程序 */
  blendProgram: WebGLProgram;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  uvbo: WebGLBuffer;
  /** 覆盖整个视口的 quad（模糊 / 合成共用） */
  quadVao: WebGLVertexArrayObject;
  quadVbo: WebGLBuffer;
  blankTex: WebGLTexture;
  uniforms: UniformSet;
  blurUniforms: BlurUniformSet;
  compositeUniforms: CompositeUniformSet;
  blendUniforms: BlendUniformSet;
}

let sharedGL: SharedGL | null = null;

/** 多采样场景目标：fbo 用于绘制，resolveFbo/resolveTex 用于解析后的单采样结果 */
interface SceneTarget {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  resolveFbo: WebGLFramebuffer;
  samples: number;
  width: number;
  height: number;
}

/** 编译并链接一个着色器程序 */
function linkProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建着色器程序');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? '';
    gl.deleteProgram(program);
    throw new Error(`着色器链接失败：${info}`);
  }
  return program;
}

/** 获取（或惰性创建）全局共享上下文 */
function getSharedGL(): SharedGL {
  if (sharedGL) return sharedGL;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('浏览器不支持 WebGL2');
  const program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
  const blurProgram = linkProgram(gl, QUAD_VERTEX_SHADER, BLUR_FRAGMENT_SHADER);
  const compositeProgram = linkProgram(gl, QUAD_VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER);
  const blendProgram = linkProgram(gl, QUAD_VERTEX_SHADER, BLEND_FRAGMENT_SHADER);
  const uniforms: UniformSet = {
    size: gl.getUniformLocation(program, 'u_size') as WebGLUniformLocation,
    kind: gl.getUniformLocation(program, 'u_kind') as WebGLUniformLocation,
    color: gl.getUniformLocation(program, 'u_color') as WebGLUniformLocation,
    alpha: gl.getUniformLocation(program, 'u_alpha') as WebGLUniformLocation,
    p0: gl.getUniformLocation(program, 'u_p0') as WebGLUniformLocation,
    p1: gl.getUniformLocation(program, 'u_p1') as WebGLUniformLocation,
    stopCount: gl.getUniformLocation(program, 'u_stopCount') as WebGLUniformLocation,
    offsets: gl.getUniformLocation(program, `u_offsets[0]`) as WebGLUniformLocation,
    colors: gl.getUniformLocation(program, `u_colors[0]`) as WebGLUniformLocation,
    tex: gl.getUniformLocation(program, 'u_tex') as WebGLUniformLocation,
  };
  const blurUniforms: BlurUniformSet = {
    tex: gl.getUniformLocation(blurProgram, 'u_tex') as WebGLUniformLocation,
    step: gl.getUniformLocation(blurProgram, 'u_step') as WebGLUniformLocation,
  };
  const compositeUniforms: CompositeUniformSet = {
    src: gl.getUniformLocation(compositeProgram, 'u_src') as WebGLUniformLocation,
    mask: gl.getUniformLocation(compositeProgram, 'u_mask') as WebGLUniformLocation,
    mode: gl.getUniformLocation(compositeProgram, 'u_mode') as WebGLUniformLocation,
  };
  const blendUniforms: BlendUniformSet = {
    src: gl.getUniformLocation(blendProgram, 'u_src') as WebGLUniformLocation,
    dst: gl.getUniformLocation(blendProgram, 'u_dst') as WebGLUniformLocation,
    mode: gl.getUniformLocation(blendProgram, 'u_blend') as WebGLUniformLocation,
  };
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  const uvbo = gl.createBuffer();
  if (!vao || !vbo || !uvbo) throw new Error('无法创建 WebGL 缓冲');
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, uvbo);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  // 全屏 quad：两个三角形，裁剪空间坐标
  const quadVao = gl.createVertexArray();
  const quadVbo = gl.createBuffer();
  if (!quadVao || !quadVbo) throw new Error('无法创建全屏 quad 缓冲');
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  // 1×1 全透明纹理：图片未解码完成时绘制“空”，而不是被当成不完整纹理的黑色
  const blankTex = gl.createTexture();
  if (!blankTex) throw new Error('无法创建 WebGL 纹理');
  gl.bindTexture(gl.TEXTURE_2D, blankTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  // 预乘 alpha 合成：所有程序都输出预乘颜色
  // 必须先 enable(BLEND)：否则 blendFunc 不生效，半透明批次会直接覆盖目标
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);
  sharedGL = {
    canvas,
    gl,
    program,
    blurProgram,
    compositeProgram,
    blendProgram,
    vao,
    vbo,
    uvbo,
    quadVao,
    quadVbo,
    blankTex,
    uniforms,
    blurUniforms,
    compositeUniforms,
    blendUniforms,
  };
  return sharedGL;
}

/**
 * 一个 Lottie 对象的 GPU 播放器。
 * 自身驱动 requestAnimationFrame，帧号只在真正重绘时递增，
 * SceneManager 据此决定是否把画布重新上传为纹理。
 */
class ShaderLottiePlayer implements LottieBackendInstance {
  readonly id = SHADER_BACKEND_ID;
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly instance: WebAssembly.Instance;
  readonly exports: ShaderExports;
  readonly width: number;
  readonly height: number;
  readonly program: WebGLProgram;
  readonly vao: WebGLVertexArrayObject;
  readonly vbo: WebGLBuffer;
  readonly uvbo: WebGLBuffer;
  private readonly blurProgram: WebGLProgram;
  private readonly compositeProgram: WebGLProgram;
  private readonly blendProgram: WebGLProgram;
  private readonly quadVao: WebGLVertexArrayObject;
  readonly uniforms: UniformSet;
  private readonly blurUniforms: BlurUniformSet;
  private readonly compositeUniforms: CompositeUniformSet;
  private readonly blendUniforms: BlendUniformSet;
  /** 未加载 / 缺失图片时使用的 1×1 透明纹理，避免采样不完整纹理得到黑块 */
  private readonly blankTex: WebGLTexture;
  /** 共享上下文画布：所有播放器轮流渲染到它，再拷贝到各自的 2D 画布 */
  private readonly sharedCanvas: HTMLCanvasElement;
  /** 把共享上下文的结果拷回对象画布（SceneManager 以此画布作为纹理源） */
  private readonly ctx: CanvasRenderingContext2D;
  private textures: (WebGLTexture | null)[] = [];
  /** 与画布等尺寸的离屏渲染目标池（图层 pass、模糊 ping-pong、蒙版、轨道遮罩） */
  private targets: { tex: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
  /** 整帧场景的多采样目标：先 MSAA 渲染再解析到单采样纹理，避免图标/文字边缘锯齿 */
  private sceneTarget: SceneTarget | null = null;
  /** 当前帧已占用的目标数量（渲染 pass 时按嵌套深度租用 / 归还） */
  private targetLease = 0;
  /** 正在把混合模式图层渲染到离屏目标时的嵌套深度（避免递归重复分发） */
  private blendDepth = 0;
  // 时间轴参数必须在 compile 之后才能从 WASM 读取，因此不能是构造期常量
  private fr = 30;
  private ip = 0;
  private op = 0;
  private raf = 0;
  private lastTime = 0;
  private elapsed = 0;
  private speed = 1;
  private loop = true;
  private frameValue = -1;
  private frameCounter = 0;
  private disposed = false;
  private readonly offsetBuf = new Float32Array(MAX_STOPS);
  private readonly colorBuf = new Float32Array(MAX_STOPS * 4);

  constructor(canvas: HTMLCanvasElement, instance: WebAssembly.Instance) {
    this.canvas = canvas;
    this.instance = instance;
    this.exports = instance.exports as ShaderExports;
    this.width = canvas.width;
    this.height = canvas.height;
    // 对象画布只作为“显示表面”：渲染在共享上下文里完成，再拷回这块 2D 画布，
    // 从而避免每个 Lottie 对象各占一个 WebGL 上下文而触发浏览器的上下文回收
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 画布');
    this.ctx = ctx;
    const shared = getSharedGL();
    this.gl = shared.gl;
    this.program = shared.program;
    this.blurProgram = shared.blurProgram;
    this.compositeProgram = shared.compositeProgram;
    this.blendProgram = shared.blendProgram;
    this.vao = shared.vao;
    this.vbo = shared.vbo;
    this.uvbo = shared.uvbo;
    this.quadVao = shared.quadVao;
    this.blankTex = shared.blankTex;
    this.uniforms = shared.uniforms;
    this.blurUniforms = shared.blurUniforms;
    this.compositeUniforms = shared.compositeUniforms;
    this.blendUniforms = shared.blendUniforms;
    this.sharedCanvas = shared.canvas;

    this.start();
  }

  get ready(): boolean {
    return this.fr > 0 && this.frameValue >= 0;
  }

  /** 编译 Lottie 文档；失败时抛出异常，由上层回退到 canvas 后端 */
  compile(data: LottieDocument): void {
    const json = JSON.stringify(data);
    const bytes = new TextEncoder().encode(json);
    const ptr = this.exports.l2s_alloc(bytes.length);
    new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
    let ok = 0;
    try {
      ok = this.exports.l2s_compile(ptr, bytes.length, this.width, this.height);
    } finally {
      this.exports.l2s_free(ptr, bytes.length);
    }
    if (!ok) throw new Error(this.readError() || 'Lottie 形状动画编译失败');
    // 编译成功后 WASM 才有时间轴信息；此前读到的 ip/op 都是 0，会导致动画停在首帧
    this.fr = Math.max(1, this.exports.l2s_fps());
    this.ip = this.exports.l2s_ip();
    this.op = this.exports.l2s_op();
    this.elapsed = 0;
    this.lastTime = 0;
    this.frameValue = -1;
    this.exports.l2s_set_size(this.width, this.height);
    this.loadImages();
  }

  private readError(): string {
    const len = this.exports.l2s_error_len();
    if (!len) return '';
    const ptr = this.exports.l2s_error_ptr();
    const bytes = new Uint8Array(this.exports.memory.buffer, ptr, len);
    return new TextDecoder().decode(bytes);
  }

  /** 读取编译期收集的图片源并异步解码为 WebGL 纹理 */
  private loadImages(): void {
    const gl = this.gl;
    const count = this.exports.l2s_image_count();
    this.textures = new Array(count).fill(null);
    for (let i = 0; i < count; i += 1) {
      const len = this.exports.l2s_image_src_len(i);
      const ptr = this.exports.l2s_image_src_ptr(i);
      if (!len || !ptr) continue;
      const src = new TextDecoder().decode(new Uint8Array(this.exports.memory.buffer, ptr, len));
      const texture = gl.createTexture();
      if (!texture) continue;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      this.textures[i] = texture;
      const image = new Image();
      // 允许跨域图片上传为纹理（服务端需返回 CORS 头；失败时保持透明占位）
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        if (this.disposed) return;
        try {
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
          // 纹理已就绪：强制重绘当前帧
          this.frameValue = -1;
        } catch (error) {
          console.warn('Lottie 图片纹理上传失败', src, error);
        }
      };
      image.onerror = () => {
        console.warn('Lottie 图片加载失败', src);
      };
      image.src = src;
    }
  }

  /** 确保离屏目标池中第 index 个目标可用（与画布等尺寸） */
  private ensureTarget(index: number): { tex: WebGLTexture; fbo: WebGLFramebuffer } | null {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    while (this.targets.length <= index) {
      const tex = gl.createTexture();
      const fbo = gl.createFramebuffer();
      if (!tex || !fbo) return null;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      // 线性过滤：合成是 1:1 采样不受影响，模糊的大步长采样靠插值避免块状边缘
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!complete) {
        gl.deleteTexture(tex);
        gl.deleteFramebuffer(fbo);
        return null;
      }
      this.targets.push({ tex, fbo });
    }
    return this.targets[index] ?? null;
  }

  /** 租用一个离屏目标（渲染 pass 时按嵌套深度分配，帧结束后归还） */
  private leaseTarget(): { tex: WebGLTexture; fbo: WebGLFramebuffer } | null {
    const target = this.ensureTarget(this.targetLease);
    this.targetLease += 1;
    return target;
  }

  /**
   * 确保整帧场景的多采样目标可用。
   *
   * 场景曾经直接画在单采样离屏目标上，几何边缘只有逐像素取舍，图标与文字会明显锯齿；
   * 这里改为「多采样颜色缓冲 + 解析纹理」：场景正常绘制后 blit 解析到单采样纹理，
   * 再合成到画布。采样数取硬件上限与 4 的较小值，兼顾质量与显存带宽。
   */
  private ensureSceneTarget(): SceneTarget | null {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
    const samples = Math.max(1, Math.min(4, maxSamples || 1));
    const current = this.sceneTarget;
    if (current && current.samples === samples && current.width === width && current.height === height) {
      return current;
    }
    this.disposeSceneTarget();
    const color = gl.createRenderbuffer();
    const fbo = gl.createFramebuffer();
    const resolveTex = gl.createTexture();
    const resolveFbo = gl.createFramebuffer();
    if (!color || !fbo || !resolveTex || !resolveFbo) return null;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    const multisampleComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindTexture(gl.TEXTURE_2D, resolveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resolveTex, 0);
    const resolveComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    if (!multisampleComplete || !resolveComplete) {
      gl.deleteRenderbuffer(color);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(resolveTex);
      gl.deleteFramebuffer(resolveFbo);
      return null;
    }
    this.sceneTarget = { tex: resolveTex, fbo, color, resolveFbo, samples, width, height };
    return this.sceneTarget;
  }

  /** 把多采样场景解析（resolve）到单采样纹理，供最终合成采样 */
  private resolveScene(scene: SceneTarget): void {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, scene.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, scene.resolveFbo);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private disposeSceneTarget(): void {
    const scene = this.sceneTarget;
    if (!scene) return;
    const gl = this.gl;
    gl.deleteFramebuffer(scene.fbo);
    gl.deleteFramebuffer(scene.resolveFbo);
    gl.deleteRenderbuffer(scene.color);
    gl.deleteTexture(scene.tex);
    this.sceneTarget = null;
  }

  /**
   * 绑定渲染目标，并把纹理单元 0/1 换回空白纹理。
   * 目标纹理可能仍绑定在采样单元上；WebGL 会把它与当前 FBO 判定为反馈回路。
   */
  private bindTarget(target: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (target) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.blankTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.blankTex);
    }
  }

  private disposeTargets(): void {
    const gl = this.gl;
    for (const target of this.targets) {
      gl.deleteFramebuffer(target.fbo);
      gl.deleteTexture(target.tex);
    }
    this.targets = [];
    this.targetLease = 0;
  }

  /** 模糊 / 合成程序用完后恢复主着色器与主 VAO */
  private restoreMain(): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
  }

  /** 绘制单个批次（主着色器、当前绑定目标） */
  private drawBatch(batch: DrawBatch): void {
    if (batch.count <= 0) return;
    const gl = this.gl;
    gl.uniform1i(this.uniforms.kind, batch.kind);
    gl.uniform4f(this.uniforms.color, batch.color[0], batch.color[1], batch.color[2], batch.color[3]);
    gl.uniform1f(this.uniforms.alpha, batch.alpha);
    gl.uniform2f(this.uniforms.p0, batch.p0[0], batch.p0[1]);
    gl.uniform2f(this.uniforms.p1, batch.p1[0], batch.p1[1]);
    gl.uniform1i(this.uniforms.stopCount, batch.stops.length);
    this.offsetBuf.fill(0);
    this.colorBuf.fill(0);
    batch.stops.forEach((stop, index) => {
      this.offsetBuf[index] = stop[0];
      this.colorBuf[index * 4] = stop[1];
      this.colorBuf[index * 4 + 1] = stop[2];
      this.colorBuf[index * 4 + 2] = stop[3];
      this.colorBuf[index * 4 + 3] = stop[4];
    });
    gl.uniform1fv(this.uniforms.offsets, this.offsetBuf);
    gl.uniform4fv(this.uniforms.colors, this.colorBuf);
    if (batch.kind === KIND_IMAGE) {
      const texture = (batch.imageIndex >= 0 ? this.textures[batch.imageIndex] : null) ?? this.blankTex;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(this.uniforms.tex, 0);
      // 图片批次共用一张 UV 缓冲，按 uvFirst 调整属性偏移
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvbo);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, batch.uvFirst * 8);
    }
    gl.drawArrays(gl.TRIANGLES, batch.first, batch.count);
  }

  /** 蒙版覆盖度写入时的混合模式 */
  private setMaskBlend(op: 'add' | 'subtract' | 'intersect'): void {
    const gl = this.gl;
    if (op === 'add') {
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else if (op === 'subtract') {
      // alpha -= dstAlpha * srcAlpha（颜色保持不变）
      gl.blendFuncSeparate(gl.ZERO, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      // alpha *= srcAlpha
      gl.blendFuncSeparate(gl.ZERO, gl.ONE, gl.ZERO, gl.SRC_ALPHA);
    }
  }

  /** 把一条图层蒙版的覆盖度累加到蒙版目标 */
  private buildMask(plan: RenderPlan, pass: LayerPass, target: { tex: WebGLTexture; fbo: WebGLFramebuffer }): void {
    const gl = this.gl;
    this.bindTarget(target);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.restoreMain();
    for (let k = 0; k < pass.maskCount; k += 1) {
      const mask = plan.masks[pass.maskFirst + k];
      if (!mask) continue;
      if (mask.inv) {
        if (mask.op === 0) {
          // 补集 = 全屏 1 - 路径覆盖度
          if (mask.quad >= 0) {
            this.setMaskBlend('add');
            this.drawBatch(plan.batches[mask.quad]);
          }
          this.setMaskBlend('subtract');
          this.drawBatch(plan.batches[mask.batch]);
        } else if (mask.op === 1) {
          this.setMaskBlend('intersect');
          this.drawBatch(plan.batches[mask.batch]);
        } else {
          this.setMaskBlend('subtract');
          this.drawBatch(plan.batches[mask.batch]);
        }
      } else if (mask.op === 0) {
        this.setMaskBlend('add');
        this.drawBatch(plan.batches[mask.batch]);
      } else if (mask.op === 1) {
        this.setMaskBlend('subtract');
        this.drawBatch(plan.batches[mask.batch]);
      } else {
        this.setMaskBlend('intersect');
        this.drawBatch(plan.batches[mask.batch]);
      }
    }
    // 恢复正常合成
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** 可分离高斯模糊：src → dst（sigma 为画布像素） */
  private blurTarget(
    src: { tex: WebGLTexture; fbo: WebGLFramebuffer },
    dst: { tex: WebGLTexture; fbo: WebGLFramebuffer },
    sigma: number,
    wrap: boolean,
    horizontal: boolean,
  ): void {
    const gl = this.gl;
    this.bindTarget(dst);
    // 目标可能在上一帧留有内容：模糊结果需要整屏替换，先清空再绘制
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.blurProgram);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    const wrapMode = wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode);
    gl.uniform1i(this.blurUniforms.tex, 0);
    // 6 个 tap 覆盖 ±3σ：每个 tap 步进 σ/2
    const step = sigma / 2;
    gl.uniform2f(
      this.blurUniforms.step,
      horizontal ? step / this.canvas.width : 0,
      horizontal ? 0 : step / this.canvas.height,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** 把离屏结果（可带蒙版 / 轨道遮罩）合成到目标 */
  private composite(
    src: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null,
    mask: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null,
    mode: number,
    target: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null,
  ): void {
    const gl = this.gl;
    this.bindTarget(target);
    gl.useProgram(this.compositeProgram);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src ? src.tex : this.blankTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mask ? mask.tex : this.blankTex);
    gl.uniform1i(this.compositeUniforms.src, 0);
    gl.uniform1i(this.compositeUniforms.mask, 1);
    gl.uniform1i(this.compositeUniforms.mode, mask ? mode : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * 把图层内容按混合模式合成到目标。
   *
   * WebGL2 不能在同一个帧缓冲里同时读 dst 与写结果，因此先把目标 blit 到一张
   * 离屏纹理，再运行混合程序：结果已包含背景，写入时必须关闭固定混合。
   */
  private blendComposite(
    src: { tex: WebGLTexture; fbo: WebGLFramebuffer },
    target: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null,
    blend: number,
  ): void {
    const gl = this.gl;
    if (!target) {
      this.composite(src, null, 0, target);
      return;
    }
    const saved = this.targetLease;
    const dst = this.leaseTarget();
    if (!dst) {
      this.targetLease = saved;
      this.composite(src, null, 0, target);
      return;
    }
    const width = this.canvas.width;
    const height = this.canvas.height;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.bindTarget(target);
    gl.useProgram(this.blendProgram);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, dst.tex);
    gl.uniform1i(this.blendUniforms.src, 0);
    gl.uniform1i(this.blendUniforms.dst, 1);
    gl.uniform1i(this.blendUniforms.mode, blend);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.BLEND);
    this.targetLease = saved;
  }

  /**
   * 绘制一个图层 pass：内容先画到离屏目标，再按需做高斯模糊 / 蒙版合成。
   * 嵌套 pass（预合成里的模糊图层）会被 renderRange 递归处理。
   */
  private renderPass(
    plan: RenderPlan,
    pass: LayerPass,
    target: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null,
    from = pass.firstBatch,
    to = pass.firstBatch + pass.batchCount,
  ): void {
    const saved = this.targetLease;
    const content = this.leaseTarget();
    if (!content) {
      this.targetLease = saved;
      return;
    }
    this.bindTarget(content);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.restoreMain();
    // 预合成图层本身若属于某个轨道遮罩分组，该分组由外层统一处理，
    // 这里的子批次不要再次按分组分发（否则组内没有遮罩源，内容会被整组丢弃）。
    const contentGroup = plan.batches[from]?.group ?? 0;
    this.renderRange(plan, from, to, content, pass.id, false, contentGroup);
    let src = content;
    if (pass.sigmaX > 0.4) {
      const horizontal = this.leaseTarget();
      if (horizontal) {
        this.blurTarget(src, horizontal, pass.sigmaX, pass.wrap, true);
        src = horizontal;
      }
    }
    if (pass.sigmaY > 0.4) {
      const vertical = this.leaseTarget();
      if (vertical) {
        this.blurTarget(src, vertical, pass.sigmaY, pass.wrap, false);
        src = vertical;
      }
    }
    if (pass.maskCount > 0 && pass.maskFirst !== 0xffffffff) {
      const maskTarget = this.leaseTarget();
      if (maskTarget) {
        this.buildMask(plan, pass, maskTarget);
        this.composite(src, maskTarget, 1, target);
      } else {
        this.composite(src, null, 0, target);
      }
    } else {
      this.composite(src, null, 0, target);
    }
    this.restoreMain();
    this.targetLease = saved;
  }

  /**
   * 绘制一个轨道遮罩分组：遮罩源画到离屏目标作为 alpha / 亮度蒙版，
   * 被遮罩内容画到另一个目标后与蒙版相乘，再合成到父目标。
   */
  private renderMatteGroup(
    plan: RenderPlan,
    start: number,
    end: number,
    target: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null,
    ownerPass: number,
  ): void {
    let split = start;
    while (split < end && plan.batches[split].role === 1) split += 1;
    if (split >= end) {
      // 没有可见的被遮罩图层
      return;
    }
    if (split === start) {
      // 遮罩源在本帧不可见（超出 ip/op 或完全透明），蒙版为空：
      // 正向遮罩（tt=1 alpha-in / tt=3 luma-in）结果全透明，什么都不画；
      // 反向遮罩（tt=2 / tt=4）等价于蒙版处处不透明，内容照常绘制。
      const tt = plan.batches[split]?.matteMode || 1;
      if (tt === 2 || tt === 4) {
        this.renderRange(plan, split, end, target, ownerPass, true);
      }
      return;
    }
    const saved = this.targetLease;
    const matte = this.leaseTarget();
    const temp = matte ? this.leaseTarget() : null;
    if (!matte || !temp) {
      this.renderRange(plan, start, end, target, ownerPass, true);
      this.targetLease = saved;
      return;
    }
    this.bindTarget(matte);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.restoreMain();
    this.renderRange(plan, start, split, matte, ownerPass, true);
    this.bindTarget(temp);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.restoreMain();
    this.renderRange(plan, split, end, temp, ownerPass, true);
    // Rust 写入的是 lottie 的 tt 原值，这里翻译成合成程序的模式：
    // 1 alpha-in、2 alpha-out、3 亮度-in、4 亮度-out
    const tt = plan.batches[split]?.matteMode || 1;
    const mode = tt === 1 ? 2 : tt === 2 ? 3 : tt === 3 ? 4 : 5;
    // 被遮罩图层的混合模式作用在「遮罩后的整层」上
    const blend = plan.batches[split]?.blend ?? 0;
    if (blend !== 0) {
      const composed = this.leaseTarget();
      if (composed) {
        this.bindTarget(composed);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.restoreMain();
        this.composite(temp, matte, mode, composed);
        this.blendComposite(composed, target, blend);
      } else {
        this.composite(temp, matte, mode, target);
      }
    } else {
      this.composite(temp, matte, mode, target);
    }
    this.restoreMain();
    this.targetLease = saved;
  }

  /**
   * 按渲染顺序遍历批次区间：
   * - 普通批次直接画到 target；
   * - 遇到子 pass 起点时递归渲染整个 pass 并跳过其区间；
   * - 轨道遮罩分组整体交给 renderMatteGroup。
   *
   * @param skipGroups 为 true 时不再按分组递归：renderMatteGroup 内部拆分出的
   *   子区间仍然是同一分组，若再次分发会无限递归直到栈溢出。
   * @param skipGroup 只在 pass 内部生效：该分组已由外层区间统一处理（遮罩源已画到
   *   matte 目标），pass 里同一分组的批次直接绘制，不再重复分组。
   */
  private renderRange(
    plan: RenderPlan,
    start: number,
    end: number,
    target: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null,
    ownerPass: number,
    skipGroups = false,
    skipGroup = 0,
  ): void {
    const passesById = new Map<number, LayerPass>();
    for (const pass of plan.passes) passesById.set(pass.id, pass);
    let index = start;
    while (index < end) {
      const batch = plan.batches[index];
      if (!batch) break;
      if (batch.kind === KIND_MASK || batch.kind === KIND_FULL) {
        index += 1;
        continue;
      }
      if (!skipGroups && batch.group !== 0 && batch.group !== skipGroup) {
        let next = index;
        while (next < end && plan.batches[next].group === batch.group) next += 1;
        this.renderMatteGroup(plan, index, next, target, ownerPass);
        index = next;
        continue;
      }
      // 混合模式按图层整体生效：同图层（同 group=0）的连续批次先渲染到离屏目标，
      // 再与背景混合。轨道遮罩内部的混合由 renderMatteGroup 在遮罩合成后处理。
      if (!skipGroups && this.blendDepth === 0 && batch.blend !== 0 && batch.group === 0) {
        let next = index + 1;
        while (
          next < end &&
          plan.batches[next].group === 0 &&
          plan.batches[next].layer === batch.layer &&
          plan.batches[next].blend === batch.blend
        ) {
          next += 1;
        }
        const saved = this.targetLease;
        const layer = this.leaseTarget();
        if (layer) {
          this.bindTarget(layer);
          this.gl.clear(this.gl.COLOR_BUFFER_BIT);
          this.restoreMain();
          this.blendDepth += 1;
          this.renderRange(plan, index, next, layer, ownerPass, false, 0);
          this.blendDepth -= 1;
          this.blendComposite(layer, target, batch.blend);
          this.restoreMain();
          this.targetLease = saved;
          index = next;
          continue;
        }
        this.targetLease = saved;
      }
      if (batch.passId === PASS_NONE || batch.passId === ownerPass) {
        this.drawBatch(batch);
        index += 1;
        continue;
      }
      const pass = passesById.get(batch.passId);
      if (!pass) {
        this.drawBatch(batch);
        index += 1;
        continue;
      }
      // 只渲染落在当前区间内的部分，避免 pass 区间跨越当前区间时重复/越界渲染
      this.renderPass(plan, pass, target, Math.max(index, pass.firstBatch), Math.min(end, pass.firstBatch + pass.batchCount));
      index = Math.max(index + 1, pass.firstBatch + pass.batchCount);
    }
  }

  /** 生成一帧并绘制到画布；帧号未变化时跳过重绘 */
  private drawFrame(frame: number): void {
    if (this.disposed) return;
    if (Math.abs(frame - this.frameValue) < 0.01) return;
    const gl = this.gl;
    if (!this.exports.l2s_render(frame)) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    // 共享上下文按当前对象的像素尺寸渲染，随后拷贝回对象画布
    const target = this.sharedCanvas;
    if (target.width !== width) target.width = width;
    if (target.height !== height) target.height = height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const totalWords = this.exports.l2s_result_len() / 4;
    const ptr = this.exports.l2s_result_ptr();
    const ints = new Uint32Array(this.exports.memory.buffer, ptr, totalWords);
    const floats = new Float32Array(this.exports.memory.buffer, ptr, totalWords);
    const plan = parsePlan(ints, floats);
    const { batches, vertexCount, uvCount } = plan;
    if (vertexCount <= 0 || !batches.length) {
      this.present(width, height);
      this.frameValue = frame;
      this.frameCounter += 1;
      return;
    }
    const headerWords = 3 + batches.length * BATCH_WORDS;
    const vertexPtr = ptr + headerWords * 4;
    const vertices = new Float32Array(this.exports.memory.buffer, vertexPtr, vertexCount * 2);
    const uvPtr = vertexPtr + vertexCount * 2 * 4;
    const uvs = uvCount > 0 ? new Float32Array(this.exports.memory.buffer, uvPtr, uvCount * 2) : null;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvbo);
    gl.bufferData(gl.ARRAY_BUFFER, uvs ?? new Float32Array(0), gl.DYNAMIC_DRAW);
    // 无 UV（无图片批次）时禁用属性 1：缓冲长度为 0 时若仍启用，
    // 整次 drawArrays 会因数组越界触发 INVALID_OPERATION 而丢弃绘制
    if (uvCount > 0) {
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    } else {
      gl.disableVertexAttribArray(1);
    }
    gl.uniform2f(this.uniforms.size, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.blankTex);
    gl.uniform1i(this.uniforms.tex, 0);

    // 先按图层 pass（模糊 / 蒙版 / 混合模式）做离屏合成，最后整帧拷贝到默认帧缓冲
    this.targetLease = 0;
    this.blendDepth = 0;
    const scene = this.ensureSceneTarget();
    if (scene) {
      this.bindTarget(scene);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.restoreMain();
      this.renderRange(plan, 0, batches.length, scene, PASS_NONE);
      gl.bindVertexArray(null);
      // 多采样结果先解析到单采样纹理，再按预乘 alpha 合成到画布
      this.resolveScene(scene);
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.composite(scene, null, 0, null);
    } else {
      // 目标池分配失败时退化为直接画到默认帧缓冲（混合模式不生效）
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.renderRange(plan, 0, batches.length, null, PASS_NONE);
    }

    gl.bindVertexArray(null);
    this.present(width, height);
    this.frameValue = frame;
    this.frameCounter += 1;
  }

  /** 把共享上下文的渲染结果拷贝到本对象的 2D 画布 */
  private present(width: number, height: number): void {
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.drawImage(this.sharedCanvas, 0, 0, width, height);
  }

  /** 推进时间并按需重绘；非循环播放到结尾后保持最后一帧 */
  private tick = (now: number): void => {
    if (this.disposed) return;
    const dt = Math.min(64, this.lastTime ? now - this.lastTime : 16);
    this.lastTime = now;
    this.elapsed += dt * this.speed;
    const durationMs = ((this.op - this.ip) / this.fr) * 1000;
    let t = this.elapsed;
    if (this.loop) {
      t = durationMs > 0 ? t % durationMs : 0;
    } else if (t > durationMs) {
      t = durationMs;
    }
    this.drawFrame(this.ip + (t / 1000) * this.fr);
    this.raf = requestAnimationFrame(this.tick);
  };

  private start(): void {
    if (this.disposed || this.raf) return;
    this.lastTime = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, speed || 1);
  }

  resize(width: number, height: number): boolean {
    if (this.disposed) return false;
    this.canvas.width = Math.max(1, Math.round(width));
    this.canvas.height = Math.max(1, Math.round(height));
    this.exports.l2s_set_size(this.canvas.width, this.canvas.height);
    // 离屏目标与画布等尺寸，尺寸变化后必须重建
    this.disposeTargets();
    this.frameValue = -1;
    this.drawFrame(this.ip + (this.elapsed / 1000) * this.fr);
    return true;
  }

  frame(): number {
    return this.frameCounter;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    const gl = this.gl;
    this.disposeTargets();
    this.disposeSceneTarget();
    for (const texture of this.textures) {
      if (texture) gl.deleteTexture(texture);
    }
    this.textures = [];
    // blankTex / program / VAO / 顶点缓冲属于全局共享上下文，不能随单个对象释放
    this.canvas.remove();
  }
}

/** 创建 shader 后端实例；WASM 加载与文档编译失败时由 SceneManager 回退 */
async function createShaderBackend(options: LottieBackendCreateOptions): Promise<LottieBackendInstance> {
  const { canvas, data, width, height } = options;
  canvas.width = width;
  canvas.height = height;
  const module = await loadShaderModule();
  // 每个播放器独立实例：Rust 侧的编译结果是实例级全局状态，共享实例会被互相覆盖
  const instance = await WebAssembly.instantiate(module, {});
  const player = new ShaderLottiePlayer(canvas, instance);
  player.setLoop(options.loop);
  player.setSpeed(options.speed);
  player.compile(data as LottieDocument);
  return player;
}

/** WebGL2 能力检测结果（只探测一次，避免频繁创建上下文耗尽配额） */
let webgl2Supported: boolean | null = null;

function supportsShaderBackend(): boolean {
  if (webgl2Supported !== null) return webgl2Supported;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    webgl2Supported = gl !== null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2Supported = false;
  }
  return webgl2Supported;
}

/** shader 后端的注册描述，由 lib/lottieBackends 汇总 */
export const shaderLottieBackend: LottieBackend = {
  id: SHADER_BACKEND_ID,
  label: 'Rust Shader（WASM）',
  hint: 'Rust 解析并三角化形状动画，WebGL2 着色器绘制；含预合成、轨道遮罩、trim path、渐变与图片，文本/表达式会回退。',
  supported: supportsShaderBackend,
  create: createShaderBackend,
};
