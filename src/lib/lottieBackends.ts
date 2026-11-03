/**
 * lottieBackends.ts —— Lottie 渲染后端注册中心
 *
 * Lottie 的“渲染”与“动画求值”是两件事：求值始终由运行时完成，差别在于把矢量
 * 指令栅格化到哪块画布上。本模块把不同栅格化方式抽象成可切换的后端：
 *
 * - `canvas`：lottie-web 的 Canvas2D 渲染器，兼容性最好，是旧存档的默认行为；
 * - `webgl` ：dotLottie 的 WebGL2 渲染器，把栅格化交给 GPU，适合复杂动画与
 *              大画布；仍会输出到一张画布，再由 3D 场景采样为纹理。
 *
 * 后端实例统一暴露“画布 + 帧号 + 播放控制 + 尺寸调整”，SceneManager 只依赖这层
 * 契约；后续要接 WebGPU 或自研渲染器时，在这里追加一个后端即可，核心无需改动。
 *
 * 兼容策略：对象上没有 renderer 字段（旧存档）时解析为默认的 canvas 后端；
 * 请求的后端不支持或初始化失败时，自动回退到 canvas，保证作品始终能打开。
 */

import type { LottieDocument } from './lottie';
import { shaderLottieBackend } from './lottieShader';

/** 默认后端：兼容旧存档，保持原有 Canvas2D 行为。 */
export const LOTTIE_BACKEND_CANVAS = 'canvas';
/** GPU 后端：dotLottie + WebGL2。 */
export const LOTTIE_BACKEND_WEBGL = 'webgl';
/** 自研 GPU 后端：Rust/WASM 三角化 + WebGL2 着色器。 */
export const LOTTIE_BACKEND_SHADER = shaderLottieBackend.id;

/** 后端实例：SceneManager 与具体渲染实现之间的唯一契约。 */
export interface LottieBackendInstance {
  /** 实际使用的后端 id（回退后回填真实值）。 */
  readonly id: string;
  /** 纹理源画布；GPU 后端会在内部挂载到隐藏容器以获得 CSS 尺寸。 */
  readonly canvas: HTMLCanvasElement;
  /** 动画数据是否已经可用；未就绪时不做尺寸调整。 */
  readonly ready: boolean;
  /** 设置循环播放。 */
  setLoop(loop: boolean): void;
  /** 设置播放速度（1 为原速）。 */
  setSpeed(speed: number): void;
  /**
   * 调整画布像素尺寸。
   * @returns 是否成功调整；返回 false 时调用方会稍后重试（例如动画尚未加载完）
   */
  resize(width: number, height: number): boolean;
  /** 当前动画帧号，用于避免同一帧重复上传纹理。 */
  frame(): number;
  /** 销毁实例并释放内部资源（画布、上下文、WASM 动画）。 */
  dispose(): void;
}

/** 创建后端实例的参数。 */
export interface LottieBackendCreateOptions {
  /** 由 SceneManager 创建并持有的画布，后端只能在其上初始化渲染上下文。 */
  canvas: HTMLCanvasElement;
  /** 已解析的 Lottie 动画数据。 */
  data: LottieDocument;
  /** 目标像素宽度 / 高度。 */
  width: number;
  /** 目标像素高度。 */
  height: number;
  /** 是否循环播放。 */
  loop: boolean;
  /** 播放速度倍率。 */
  speed: number;
  /** 隐藏容器：需要 DOM 布局尺寸的后端（WebGL/WebGPU）把画布挂到这里。 */
  host: HTMLElement;
}

/** 后端描述，供属性面板下拉框展示。 */
export interface LottieBackendInfo {
  id: string;
  label: string;
  hint: string;
  /** 当前浏览器是否支持；不支持时下拉框仍展示但禁用，便于说明原因。 */
  supported: boolean;
}

/** 后端定义。 */
export interface LottieBackend {
  id: string;
  label: string;
  hint: string;
  /** 运行时能力检测。 */
  supported(): boolean;
  /** 创建实例；失败时应抛出错误，由调用方回退到 canvas。 */
  create(options: LottieBackendCreateOptions): Promise<LottieBackendInstance>;
}

/** 缓存 WebGL2 能力检测结果：每次创建上下文都有成本与数量上限。 */
let webgl2Support: boolean | null = null;

/** 检测当前浏览器是否支持 WebGL2（结果缓存）。 */
function supportsWebGL2(): boolean {
  if (webgl2Support !== null) return webgl2Support;
  try {
    const probe = document.createElement('canvas');
    webgl2Support = Boolean(probe.getContext('webgl2'));
  } catch {
    webgl2Support = false;
  }
  return webgl2Support;
}

/**
 * 递归调整 lottie-web 内部离屏画布的像素缓冲。
 *
 * lottie-web 的 canvas 渲染器会为每个图层（尤其是轨道遮罩层）维护私有画布，
 * 只改外层画布会导致放大后内容被裁在旧缓冲尺寸内、显示不完整。
 * 这里只同步元素上的 `buffers` 画布，再沿 `elements` 递归子元素，
 * 不能去改元素自身的 width / height 数值字段（那是图层内容尺寸而非缓冲尺寸）。
 */
function resizeLottieBuffers(elements: unknown[] | undefined, width: number, height: number) {
  if (!elements) return;
  for (const raw of elements) {
    if (!raw || typeof raw !== 'object') continue;
    const element = raw as { buffers?: HTMLCanvasElement[]; elements?: unknown[] };
    if (element.buffers) {
      for (const buffer of element.buffers) {
        if (buffer && (buffer.width !== width || buffer.height !== height)) {
          buffer.width = width;
          buffer.height = height;
        }
      }
    }
    resizeLottieBuffers(element.elements, width, height);
  }
}

/**
 * Canvas2D 后端（lottie-web）。
 *
 * 保持与旧实现完全一致的行为：不挂载到 DOM，直接把动画绘制到传入的 2D context。
 */
const canvasBackend: LottieBackend = {
  id: LOTTIE_BACKEND_CANVAS,
  label: 'Canvas 2D（兼容）',
  hint: 'lottie-web 软件栅格化，兼容性最好，旧作品的默认方案。',
  supported: () => true,
  async create(options) {
    const { data, canvas, loop, speed } = options;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 2D 画布');
    const { default: lottie } = await import('lottie-web');
    // lottie-web 会就地把传入的 animationData 改写成自己的内部结构（例如把路径/关键帧
    // 转成绝对坐标）。同一份解析结果在切换渲染后端时还会交给 shader 后端做三角化，
    // 被改写后会生成错误的几何，因此这里传入深拷贝，保证调用方的数据不被污染。
    const animationData = JSON.parse(JSON.stringify(data)) as typeof data;
    const animation = lottie.loadAnimation({
      renderer: 'canvas',
      loop,
      autoplay: true,
      animationData,
      rendererSettings: {
        context,
        clearCanvas: true,
        preserveAspectRatio: 'xMidYMid meet',
      },
    } as unknown as Parameters<typeof lottie.loadAnimation>[0]);
    animation.setSpeed(speed);

    return {
      id: LOTTIE_BACKEND_CANVAS,
      canvas,
      get ready() {
        return Boolean(animation.isLoaded);
      },
      setLoop(next) {
        animation.setLoop(next);
      },
      setSpeed(next) {
        animation.setSpeed(next);
      },
      resize(nextWidth, nextHeight) {
        // 动画尚未完成解析时无法安全调整内部缓冲，交由调用方稍后重试
        if (!animation.isLoaded) return false;
        const renderer = animation.renderer as unknown as {
          updateContainerSize?: (w: number, h: number) => void;
          update?: (w: number, h: number) => void;
          elements?: unknown[];
        };
        // 轨道遮罩层等私有缓冲按创建时的画布尺寸分配，必须先同步尺寸再放大外层画布，
        // 否则放大后只有一部分内容落在有效区域内，看起来就是「没展示完全」。
        resizeLottieBuffers(renderer.elements, nextWidth, nextHeight);
        renderer.updateContainerSize?.(nextWidth, nextHeight);
        renderer.update?.(nextWidth, nextHeight);
        return true;
      },
      frame() {
        return animation.currentFrame ?? 0;
      },
      dispose() {
        animation.destroy();
      },
    };
  },
};

/**
 * WebGL2 后端（dotLottie）。
 *
 * 关键点：
 * 1. 需要 DOM 布局尺寸：把画布挂到屏幕外的隐藏容器，并显式设置 CSS 宽高；
 * 2. 预创建 WebGL2 上下文并开启 preserveDrawingBuffer，否则画布被合成后内容
 *    会被清空，three.js 采样到的可能是黑帧；
 * 3. 关闭 autoResize 与 freezeOnOffscreen：尺寸完全由我们控制，且画布不在视口内，
 *    冻结会直接停掉动画；
 * 4. WASM 从本地打包资源加载，避免依赖外网 CDN。
 */
const webglBackend: LottieBackend = {
  id: LOTTIE_BACKEND_WEBGL,
  label: 'WebGL2（GPU）',
  hint: 'dotLottie + ThorVG WebGL2，把栅格化交给 GPU，适合复杂动画与大画布。',
  supported: supportsWebGL2,
  async create(options) {
    const { canvas, data, width, height, loop, speed, host } = options;
    // 先以保留绘制缓冲的方式占用上下文；播放器随后 getContext('webgl2') 会复用它
    const context = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    if (!context) throw new Error('浏览器不支持 WebGL2');

    // GPU 后端按 CSS 尺寸计算后备缓冲，挂到隐藏容器并显式给尺寸
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = width;
    canvas.height = height;
    host.appendChild(canvas);

    const [{ DotLottie }, wasm] = await Promise.all([
      import('@lottiefiles/dotlottie-web/webgl'),
      import('@lottiefiles/dotlottie-web/webgl/dotlottie-player.wasm?url'),
    ]);
    DotLottie.setWasmUrl(wasm.default);

    const player = new DotLottie({
      canvas,
      data: data as Record<string, unknown>,
      autoplay: true,
      loop,
      speed,
      renderConfig: {
        autoResize: false,
        devicePixelRatio: 1,
        // 画布位于屏幕外，必须关闭“离屏冻结”，否则动画会停住
        freezeOnOffscreen: false,
      },
    });

    // 等待首帧可用；同时监听错误与超时，避免加载失败时一直卡在 loading
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      const onLoad = () => finish();
      const onError = () => finish(new Error('Lottie WebGL 动画加载失败'));
      player.addEventListener('load', onLoad);
      player.addEventListener('ready', onLoad);
      player.addEventListener('loadError', onError);
      player.addEventListener('renderError', onError);
      if (player.isLoaded) finish();
      window.setTimeout(() => finish(new Error('Lottie WebGL 初始化超时')), 5000);
    });

    return {
      id: LOTTIE_BACKEND_WEBGL,
      canvas,
      get ready() {
        return player.isLoaded;
      },
      setLoop(next) {
        player.setLoop(next);
      },
      setSpeed(next) {
        player.setSpeed(next);
      },
      resize(nextWidth, nextHeight) {
        if (!player.isLoaded) return false;
        if (canvas.width === nextWidth && canvas.height === nextHeight) return false;
        canvas.style.width = `${nextWidth}px`;
        canvas.style.height = `${nextHeight}px`;
        canvas.width = nextWidth;
        canvas.height = nextHeight;
        // autoResize 关闭时，resize() 会按当前 canvas 后备缓冲重建 GL target
        player.resize();
        return true;
      },
      frame() {
        return player.currentFrame ?? 0;
      },
      dispose() {
        player.destroy();
        canvas.remove();
      },
    };
  },
};

/** 全部后端（顺序即下拉框展示顺序）。 */
const BACKENDS: LottieBackend[] = [canvasBackend, webglBackend, shaderLottieBackend];
const BACKEND_MAP = new Map(BACKENDS.map((backend) => [backend.id, backend]));

/**
 * 列出全部后端及其当前可用性。
 * 不支持的项也会返回，属性面板可以禁用并给出说明。
 */
export function listLottieBackends(): LottieBackendInfo[] {
  return BACKENDS.map((backend) => ({
    id: backend.id,
    label: backend.label,
    hint: backend.hint,
    supported: backend.supported(),
  }));
}

/**
 * 解析对象应使用的后端。
 *
 * @param id 对象上的 renderer 字段；缺省（旧存档）或未知 id 时使用默认后端
 * @returns 可用的后端实现；请求的 GPU 后端不受支持时回退到 canvas
 */
export function resolveLottieBackend(id?: string): LottieBackend {
  const requested = id ? BACKEND_MAP.get(id) : undefined;
  if (requested && requested.supported()) return requested;
  return canvasBackend;
}

/** 解析并返回后端 id，便于写入运行时状态与脏检查键。 */
export function resolveLottieBackendId(id?: string): string {
  return resolveLottieBackend(id).id;
}

/** 默认后端 id（旧存档与新建对象的初始值）。 */
export function defaultLottieBackendId(): string {
  return LOTTIE_BACKEND_CANVAS;
}
