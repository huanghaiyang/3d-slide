/**
 * lottieShader —— Rust/WASM 版 Lottie 形状动画渲染后端
 *
 * 工作方式：
 * 1. Rust（lottie2shader crate）解析 Lottie JSON，用 lyon 对贝塞尔路径做自适应离散化，
 *    并以扫描线三角化的方式生成填充/描边的三角形；几何一次烘焙到图层局部坐标；
 * 2. 每帧只做「图层矩阵变换 + 顶点输出」，把结果通过线性内存交给 JS；
 * 3. 本模块把顶点上传到 WebGL2，用着色器完成纯色 / 线性渐变 / 径向渐变的填充，
 *    光栅化与抗锯齿交给 GPU（MSAA），最终画布作为纹理供 three.js 采样。
 *
 * 数据格式（Rust 输出，单位 u32 / f32 混合，小端）：
 * - word 0：批次数量 N
 * - 每个批次固定 53 个字：
 *   kind、顶点起始、顶点数量、颜色 RGBA、整体 alpha、渐变起点、渐变终点、
 *   色标数量、8 个色标（每个 offset + RGBA 共 5 个字）
 * - 批次之后是顶点数组，每个顶点 x、y 两个 f32。
 *
 * 未支持的 Lottie 特性（文本/图片/遮罩/表达式等）由注册中心自动回退到其他后端，
 * 本模块只负责能编译的形状动画。
 */

import wasmUrl from './lottie2shader.wasm?url';
import type { LottieBackend, LottieBackendCreateOptions, LottieBackendInstance } from '../lottieBackends';
import type { LottieDocument } from '../lottie';

/** 批次头固定字数，必须与 Rust 侧 BATCH_WORDS 保持一致 */
const BATCH_WORDS = 53;
/** 渐变色标上限，与 Rust 和着色器 uniform 数组长度一致 */
const MAX_STOPS = 8;
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
uniform vec2 u_size;
out vec2 v_pos;
void main() {
  v_pos = a_pos;
  // 像素坐标（Y 向下）转裁剪空间
  vec2 clip = vec2(a_pos.x / u_size.x * 2.0 - 1.0, 1.0 - a_pos.y / u_size.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_pos;
uniform int u_kind;        // 0 纯色 / 1 线性渐变 / 2 径向渐变
uniform vec4 u_color;
uniform float u_alpha;
uniform vec2 u_p0;
uniform vec2 u_p1;
uniform int u_stopCount;
uniform float u_offsets[${MAX_STOPS}];
uniform vec4 u_colors[${MAX_STOPS}];
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
  if (u_kind == 0) {
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
}

/**
 * 把 WASM 输出的二进制渲染计划解析成绘制批次。
 *
 * @param ints   以小端 u32 视图读取的渲染计划（长度 = result_len / 4）
 * @param floats 与 ints 共享同一块内存的 f32 视图，用于读取颜色/坐标/透明度
 */
function parseBatches(ints: Uint32Array, floats: Float32Array): DrawBatch[] {
  const count = ints[0] ?? 0;
  const batches: DrawBatch[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = 1 + i * BATCH_WORDS;
    const stops: [number, number, number, number, number][] = [];
    const stopCount = ints[base + 12] ?? 0;
    for (let s = 0; s < Math.min(MAX_STOPS, stopCount); s += 1) {
      const off = base + 13 + s * 5;
      stops.push([floats[off], floats[off + 1], floats[off + 2], floats[off + 3], floats[off + 4]]);
    }
    batches.push({
      kind: ints[base] ?? 0,
      first: ints[base + 1] ?? 0,
      count: ints[base + 2] ?? 0,
      color: [floats[base + 3], floats[base + 4], floats[base + 5], floats[base + 6]],
      alpha: floats[base + 7],
      p0: [floats[base + 8], floats[base + 9]],
      p1: [floats[base + 10], floats[base + 11]],
      stops,
    });
  }
  return batches;
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
  };
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

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, instance: WebAssembly.Instance) {
    this.canvas = canvas;
    this.gl = gl;
    this.instance = instance;
    this.exports = instance.exports as ShaderExports;
    this.width = canvas.width;
    this.height = canvas.height;
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
    this.program = program;
    this.uniforms = {
      size: gl.getUniformLocation(program, 'u_size') as WebGLUniformLocation,
      kind: gl.getUniformLocation(program, 'u_kind') as WebGLUniformLocation,
      color: gl.getUniformLocation(program, 'u_color') as WebGLUniformLocation,
      alpha: gl.getUniformLocation(program, 'u_alpha') as WebGLUniformLocation,
      p0: gl.getUniformLocation(program, 'u_p0') as WebGLUniformLocation,
      p1: gl.getUniformLocation(program, 'u_p1') as WebGLUniformLocation,
      stopCount: gl.getUniformLocation(program, 'u_stopCount') as WebGLUniformLocation,
      offsets: gl.getUniformLocation(program, `u_offsets[0]`) as WebGLUniformLocation,
      colors: gl.getUniformLocation(program, `u_colors[0]`) as WebGLUniformLocation,
    };
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('无法创建 WebGL 缓冲');
    this.vao = vao;
    this.vbo = vbo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

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
  }

  private readError(): string {
    const len = this.exports.l2s_error_len();
    if (!len) return '';
    const ptr = this.exports.l2s_error_ptr();
    const bytes = new Uint8Array(this.exports.memory.buffer, ptr, len);
    return new TextDecoder().decode(bytes);
  }

  /** 生成一帧并绘制到画布；帧号未变化时跳过重绘 */
  private drawFrame(frame: number): void {
    if (this.disposed) return;
    if (Math.abs(frame - this.frameValue) < 0.01) return;
    const gl = this.gl;
    if (!this.exports.l2s_render(frame)) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const totalWords = this.exports.l2s_result_len() / 4;
    const ptr = this.exports.l2s_result_ptr();
    const ints = new Uint32Array(this.exports.memory.buffer, ptr, totalWords);
    const floats = new Float32Array(this.exports.memory.buffer, ptr, totalWords);
    const batches = parseBatches(ints, floats);
    const headerWords = 1 + batches.length * BATCH_WORDS;
    const vertexCount = Math.max(0, (totalWords - headerWords) / 2);
    if (vertexCount <= 0) {
      this.frameValue = frame;
      this.frameCounter += 1;
      return;
    }
    const vertexPtr = ptr + headerWords * 4;
    const vertices = new Float32Array(this.exports.memory.buffer, vertexPtr, vertexCount * 2);

    if (!batches.length) {
      this.frameValue = frame;
      this.frameCounter += 1;
      return;
    }
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.uniform2f(this.uniforms.size, this.canvas.width, this.canvas.height);
    for (const batch of batches) {
      if (batch.count <= 0) continue;
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
      gl.drawArrays(gl.TRIANGLES, batch.first, batch.count);
    }
    gl.bindVertexArray(null);
    this.frameValue = frame;
    this.frameCounter += 1;
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
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}

/** 创建 shader 后端实例；WASM 加载与文档编译失败时由 SceneManager 回退 */
async function createShaderBackend(options: LottieBackendCreateOptions): Promise<LottieBackendInstance> {
  const { canvas, data, width, height } = options;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('浏览器不支持 WebGL2');
  canvas.width = width;
  canvas.height = height;
  const module = await loadShaderModule();
  // 每个播放器独立实例：Rust 侧的编译结果是实例级全局状态，共享实例会被互相覆盖
  const instance = await WebAssembly.instantiate(module, {});
  const player = new ShaderLottiePlayer(canvas, gl, instance);
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
  hint: 'Rust 解析并三角化形状动画，WebGL2 着色器绘制；暂不支持文本/图片/遮罩。',
  supported: supportsShaderBackend,
  create: createShaderBackend,
};
