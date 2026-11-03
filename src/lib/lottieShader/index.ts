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
uniform int u_kind;        // 0 纯色 / 1 线性渐变 / 2 径向渐变 / 3 图片
uniform vec4 u_color;
uniform float u_alpha;
uniform vec2 u_p0;
uniform vec2 u_p1;
uniform int u_stopCount;
uniform float u_offsets[${MAX_STOPS}];
uniform vec4 u_colors[${MAX_STOPS}];
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform int u_maskMode;    // 0 无遮罩 / 1 alpha / 2 alpha 反相
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
  if (u_maskMode != 0) {
    // 遮罩 FBO 与画布同尺寸、同一屏幕坐标系，直接按像素取 alpha
    float m = texelFetch(u_mask, ivec2(gl_FragCoord.xy), 0).a;
    color.a *= ((u_maskMode == 2) ? (1.0 - m) : m);
  }
  color.a *= u_alpha;
  outColor = color;
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
  /** 遮罩模式：1 alpha、2 alpha 反相 */
  matteMode: number;
  /** 遮罩角色：0 普通、1 遮罩源、2 被遮罩 */
  role: number;
  /** 图片纹理索引，-1 表示非图片批次 */
  imageIndex: number;
}

/** 解析后的整帧渲染计划 */
interface RenderPlan {
  batches: DrawBatch[];
  vertexCount: number;
  uvCount: number;
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
    });
  }
  return { batches, vertexCount, uvCount };
}

/** 着色器 uniform 位置集合（同一上下文内的所有播放器共享） */
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
  mask: WebGLUniformLocation;
  maskMode: WebGLUniformLocation;
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
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  uvbo: WebGLBuffer;
  blankTex: WebGLTexture;
  uniforms: UniformSet;
}

let sharedGL: SharedGL | null = null;

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
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
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
    mask: gl.getUniformLocation(program, 'u_mask') as WebGLUniformLocation,
    maskMode: gl.getUniformLocation(program, 'u_maskMode') as WebGLUniformLocation,
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
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);
  sharedGL = { canvas, gl, program, vao, vbo, uvbo, blankTex, uniforms };
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
  readonly uniforms: {
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
    mask: WebGLUniformLocation;
    maskMode: WebGLUniformLocation;
  };
  /** 未加载 / 缺失图片时使用的 1×1 透明纹理，避免采样不完整纹理得到黑块 */
  private readonly blankTex: WebGLTexture;
  /** 共享上下文画布：所有播放器轮流渲染到它，再拷贝到各自的 2D 画布 */
  private readonly sharedCanvas: HTMLCanvasElement;
  /** 把共享上下文的结果拷回对象画布（SceneManager 以此画布作为纹理源） */
  private readonly ctx: CanvasRenderingContext2D;
  private textures: (WebGLTexture | null)[] = [];
  private maskTex: WebGLTexture | null = null;
  private maskFbo: WebGLFramebuffer | null = null;
  private maskW = 0;
  private maskH = 0;
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
    this.vao = shared.vao;
    this.vbo = shared.vbo;
    this.uvbo = shared.uvbo;
    this.blankTex = shared.blankTex;
    this.uniforms = shared.uniforms;
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

  /** 创建（或复用）与画布等尺寸的遮罩 FBO */
  private ensureMaskTarget(): boolean {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.maskFbo && this.maskTex && this.maskW === w && this.maskH === h) return true;
    this.disposeMaskTarget();
    const texture = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!texture || !fbo) return false;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(fbo);
      return false;
    }
    this.maskTex = texture;
    this.maskFbo = fbo;
    this.maskW = w;
    this.maskH = h;
    return true;
  }

  private disposeMaskTarget(): void {
    const gl = this.gl;
    if (this.maskFbo) gl.deleteFramebuffer(this.maskFbo);
    if (this.maskTex) gl.deleteTexture(this.maskTex);
    this.maskFbo = null;
    this.maskTex = null;
    this.maskW = 0;
    this.maskH = 0;
  }

  /** 绘制单个批次；maskMode 为 0 时不采样遮罩 */
  private drawBatch(batch: DrawBatch, maskMode: number): void {
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
    gl.uniform1i(this.uniforms.maskMode, maskMode);
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

  /**
   * 绘制一个轨道遮罩分组：
   * 1. 遮罩源（role 1）先画到离屏 FBO，得到 alpha 蒙版；
   * 2. 被遮罩批次（role 2）按蒙版逐像素调制 alpha 后画到画布。
   */
  private drawMaskedGroup(batches: DrawBatch[]): void {
    const gl = this.gl;
    const sources = batches.filter((batch) => batch.role === 1);
    const masked = batches.filter((batch) => batch.role === 2 && batch.count > 0);
    if (!masked.length) return;
    if (!sources.length || !this.ensureMaskTarget()) {
      // 遮罩目标不可用时退化为普通绘制，至少保证图层可见
      for (const batch of masked) this.drawBatch(batch, 0);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // 遮罩纹理此时仍绑定在单元 1 上，而它正是当前 FBO 的颜色附件：
    // 即便着色器分支不采样，WebGL 也会判定为反馈回路并抛出 INVALID_OPERATION
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blankTex);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const batch of sources) this.drawBatch(batch, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.uniforms.mask, 1);
    const mode = masked[0].matteMode || 1;
    for (const batch of masked) this.drawBatch(batch, mode);
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
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blankTex);
    gl.uniform1i(this.uniforms.mask, 1);

    let index = 0;
    while (index < batches.length) {
      const batch = batches[index];
      if (batch.role !== 0 && batch.group !== 0) {
        // 同一分组的遮罩源与被遮罩批次在计划中连续排列
        const group: DrawBatch[] = [];
        while (index < batches.length && batches[index].group === batch.group) {
          group.push(batches[index]);
          index += 1;
        }
        this.drawMaskedGroup(group);
      } else {
        this.drawBatch(batch, 0);
        index += 1;
      }
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
    // 遮罩 FBO 与画布等尺寸，尺寸变化后必须重建
    this.disposeMaskTarget();
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
    this.disposeMaskTarget();
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
