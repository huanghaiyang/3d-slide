/**
 * SceneManager.ts —— 3D 幻灯片场景管理器
 *
 * 职责：
 * - 创建并持有 Three.js 渲染器、场景、透视相机与全部对象节点；
 * - 把 store 中的 Deck / 选中状态同步为场景节点（增删改、层级、可见性）；
 * - 管理相机视角（含补间飞行 / 平移 / 环绕 / 锚点缩放 / VR 漫游）；
 * - 提供射线拾取、四角缩放点命中、框选等编辑交互能力；
 * - 加载与释放图片、视频、音频、3D 模型、Lottie、SVG 等素材；
 * - 驱动渲染循环，并负责网格、坐标轴、星空、鱼眼后处理与 WebXR 画面效果。
 *
 * 渲染管线：
 * 1. store 变更后由上层调用 sync()，按对象 id 复用或新建 ObjectNode；
 * 2. 通过 visualKey 做脏检查，只有影响外观的字段变化时才 rebuildContent；
 * 3. tick() 每帧推进模型动画、上传 Lottie 纹理、同步媒体可见性与网格，
 *    最后调用 renderFrame() 输出画面；
 * 4. renderFrame() 默认前向渲染；鱼眼效果先渲染到离屏 RenderTarget，
 *    再用全屏四边形做一次后处理；XR 激活时交由 WebXR 接管立体渲染。
 *
 * 坐标系约定：
 * - 世界坐标单位与幻灯片设计单位一致（约等于 CSS 像素），X 向右、Y 向下、Z 向外；
 * - 因此相机 up 设为 (0, -1, 0)，保证 Y 轴向下时画面不上下颠倒；
 * - 对象节点 group 承载 x / y / z 与旋转，内容子组再同时翻转 X/Y，
 *   以抵消相机 up 翻转造成的镜像，使文字与图片在画面上正向显示；
 * - 帧动画的视角用 ViewState（yaw / pitch / distance / target）描述。
 *
 * 与 store 的数据交互：
 * - SceneManager 本身不直接读写 zustand，只接收上层传入的 Deck 与选中 id；
 * - 需要回写状态的事件（素材加载失败、XR 状态变化）通过构造时的 callbacks 上报；
 * - 视角由上层调用 setView / flyTo 推送，渲染器不回写 store，避免双向循环。
 */

import * as THREE from 'three';
import type {
  AudioObject,
  Deck,
  ImageObject,
  LottieObject,
  MediaKind,
  ModelFormat,
  ModelObject,
  ShapeKind,
  ShapeObject,
  SlideObject,
  SvgObject,
  TextObject,
  VideoObject,
  ViewState,
} from '../types';
import { ACCENT, ASPECT, FOV } from '../lib/constants';
import { cameraPosition, clampPitch, lerpView } from '../lib/camera';
import { disposeObject3D, loadModelGroup } from '../lib/model3d';
import { parseLottieSource } from '../lib/lottie';
import type { AnimationConfigWithData, AnimationItem } from 'lottie-web';
import { sampleBezierPath } from '../lib/curve';
import { buildTextExtrudeGeometry } from './text3d';
import { fontCss, layoutText } from '../lib/text';

/** 舞台模式：edit 可编辑 / view 只读浏览 / present 演示播放 */
export type StageMode = 'edit' | 'view' | 'present';

/** 对象四角缩放点的方位：nw 左上 / ne 右上 / se 右下 / sw 左下 */
export type HandleCorner = 'nw' | 'ne' | 'se' | 'sw';

/**
 * 场景对外回调。
 * SceneManager 不直接依赖 store，素材失败等事件由上层在此接住并写回状态。
 */
interface SceneCallbacks {
  /** 素材（图片 / 视频 / 音频 / 模型 / Lottie）加载失败时上报对象 id 与提示文案 */
  onImageError: (id: string, message: string) => void;
  /** XR 会话进入 / 退出时通知上层，用于切换 UI 状态 */
  onXRChange?: (active: boolean) => void;
}

/** 镜头特效：none 不做处理 / fisheye 鱼眼畸变 */
export type LensEffect = 'none' | 'fisheye';
/** 空间背景：none 使用作品背景色 / stars 显示星空 */
export type SpaceMode = 'none' | 'stars';

/**
 * WebXR 会话的最小接口，只声明本项目用到的成员。
 * 浏览器原生 XRSession 类型未必在所有运行环境都存在，这里做结构兼容。
 */
interface XRSessionLike {
  /** 结束当前 XR 会话 */
  end: () => Promise<void>;
  /** 监听会话事件（本项目只关心 end） */
  addEventListener: (type: string, listener: () => void) => void;
}

/**
 * 图片类素材的加载状态。
 * 纹理本身存放在节点或全局缓存里，这里只记录当前节点该用哪一份。
 */
interface ImageState {
  /** 素材地址，用于判断对象换图后是否需要重新加载 */
  src: string;
  /** pending 加载中 / loaded 可用 / error 失败 */
  status: 'pending' | 'loaded' | 'error';
  /** 加载完成后的共享纹理（来自缓存，节点不负责释放） */
  texture?: THREE.Texture;
}

/**
 * 视频 / 音频运行时。
 * 浏览器原生媒体元素是真正的播放源，视频还会额外包装成 VideoTexture 供材质采样。
 */
interface MediaRuntime {
  /** 媒体类型：video / audio */
  kind: MediaKind;
  /** 素材地址 */
  src: string;
  /** 原生 video / audio 元素，负责解码与播放控制 */
  element: HTMLVideoElement | HTMLAudioElement | null;
  /** 视频纹理；音频没有纹理，恒为 null */
  texture: THREE.VideoTexture | null;
  /** 是否加载失败 */
  error: boolean;
  /** 视频是否已解码出可渲染的帧 */
  ready: boolean;
}

/**
 * 3D 模型运行时。
 * 加载是异步的，group 就绪前先用占位纹理显示；自带动画用 AnimationMixer 播放。
 */
interface ModelRuntime {
  /** 模型素材地址 */
  src: string;
  /** 模型格式（glb / gltf 等），与 src 一起判断是否需要重新加载 */
  format: ModelFormat;
  /** loading 加载中 / ready 可用 / error 失败 */
  status: 'loading' | 'ready' | 'error';
  /** 解析后的模型对象组；加载前为 null */
  group: THREE.Group | null;
  /** 模型自带的动画片段 */
  animations: THREE.AnimationClip[];
  /** 动画混合器；无动画片段时为 null，每帧由 tick 推进 */
  mixer: THREE.AnimationMixer | null;
  /** 失败原因，供错误提示展示 */
  error?: string;
}

/**
 * Lottie 动画运行时。
 * lottie-web 以 canvas 渲染器逐帧画到离屏画布，再包装为 CanvasTexture 供材质使用。
 */
interface LottieRuntime {
  /** 动画素材地址（可能是 URL 或内联 JSON） */
  src: string;
  /** loading 加载中 / ready 可用 / error 失败 */
  status: 'loading' | 'ready' | 'error';
  /** lottie 绘制使用的离屏画布 */
  canvas: HTMLCanvasElement | null;
  /** 由 canvas 生成的纹理，每帧按需标记 needsUpdate 上传 */
  texture: THREE.CanvasTexture | null;
  /** lottie-web 动画实例，负责播放与帧推进 */
  animation: AnimationItem | null;
  /** 画布长边像素，用于判断是否需要按当前缩放重新栅格化 */
  rasterSide: number;
  /** 上次上传到 GPU 时的动画帧号，避免同一帧重复上传整幅画布 */
  lastFrame: number;
  /** 失败原因 */
  error?: string;
}

/** 媒体播放状态快照，供播放器 UI 轮询展示（时间单位与原生元素一致，为秒） */
export interface MediaPlaybackState {
  /** 媒体类型 */
  kind: MediaKind;
  /** 是否正在播放 */
  playing: boolean;
  /** 当前播放时间（秒） */
  time: number;
  /** 总时长（秒），未知时为 0 */
  duration: number;
  /** 音量百分比 0 ~ 100 */
  volume: number;
  /** 是否静音 */
  muted: boolean;
  /** 是否循环播放 */
  loop: boolean;
  /** 是否加载失败 */
  error: boolean;
}

/**
 * 单个幻灯片对象在场景中的运行时节点。
 * group 负责世界变换，content 承载具体内容与选中框；节点随对象 id 复用。
 */
interface ObjectNode {
  /** 节点根组：位置 / 旋转 / 层级（renderOrder）都作用在它上面 */
  group: THREE.Group;
  /** 内容组；每次重建都会整体替换，旧内容在 clearContent 中释放 */
  content: THREE.Group | null;
  /** 选中框线段；几何随对象尺寸变化重建 */
  outline: THREE.LineSegments;
  /** 四角缩放点；只有主选中对象显示 */
  handles: THREE.Points;
  /** 本节点创建的全部材质，用于统一设置透明度 / 双面等外观属性 */
  materials: THREE.Material[];
  /** 本节点独占、需要随重建释放的纹理（如平铺裁剪的纹理克隆） */
  ownedTextures: THREE.Texture[];
  /** 外观脏检查键；字段拼接结果变化时才重建内容 */
  visualKey: string;
  /** 当前选中框几何对应的宽度，用于避免重复重建 */
  outlineWidth: number;
  /** 当前选中框几何对应的高度（最小 8，保证细线对象仍可选中） */
  outlineHeight: number;
  /** 图片素材加载状态 */
  imageState: ImageState | null;
  /** SVG 按屏幕像素重绘后独占的矢量纹理，随节点销毁 */
  svgTexture: THREE.CanvasTexture | null;
  /** 视频 / Lottie 封面（首帧截图）加载状态 */
  posterState: ImageState | null;
  /** 视频 / 音频运行时 */
  media: MediaRuntime | null;
  /** 3D 模型运行时 */
  model: ModelRuntime | null;
  /** Lottie 动画运行时 */
  lottie: LottieRuntime | null;
  /** 最近一次同步过来的对象数据快照（store 数据的只读投影） */
  data: SlideObject;
  /** 对象 id，与 nodes 的键保持一致 */
  objectId: string;
  /** 射线拾取的根节点；为 null 表示该节点暂不参与拾取 */
  pickRoot: THREE.Group | null;
}

/** 纹理缓存条目：已加载的纹理，或加载中 / 失败两种状态标记 */
type CacheEntry = THREE.Texture | 'loading' | 'error';

/** 释放单个材质；单独抽出来便于数组材质逐个处理 */
function disposeMaterial(material: THREE.Material) {
  material.dispose();
}

/**
 * 3D 幻灯片场景管理器。
 *
 * 一个实例对应一个画布容器，生命周期内持有 WebGL 渲染器与全部对象节点。
 * 上层通过 sync() 单向推送数据，通过 hitTest / panBy / orbitBy 等方法
 * 获取交互结果；素材加载失败等事件通过 callbacks 回调上报。
 *
 * 使用约定：
 * - 构造后默认启动动画循环，可通过 options.autoStart = false 关闭；
 * - 组件卸载时必须调用 dispose()，否则 WebGL 上下文、纹理与视频元素会泄漏；
 * - 同一作品内对象 id 唯一，节点以 id 为键存储，便于增量同步。
 */
export class SceneManager {
  /** WebGL 渲染器，负责画布尺寸、像素比与最终绘制 */
  private renderer: THREE.WebGLRenderer;
  /** 根场景，包含对象根组、灯光、网格、星空与坐标轴等 */
  private scene: THREE.Scene;
  /** 透视相机；up 为 (0, -1, 0)，与幻灯片 Y 轴向下的坐标约定匹配 */
  private camera: THREE.PerspectiveCamera;
  /** 当前视角状态（距离、朝向、目标点），是相机位置的唯一描述来源 */
  private view: ViewState;
  /** 当前舞台模式，决定对象可见性、选中框与媒体行为 */
  private mode: StageMode;
  /** 对外回调集合，用于把素材错误与 XR 状态变化回写到上层 */
  private callbacks: SceneCallbacks;
  /** 所有对象节点的统一父节点；进入 VR 时会被挂到 XR rig 下 */
  private objectsRoot = new THREE.Group();
  /** 对象 id -> 节点运行时；sync 时按 id 增量增删，避免整场景重建 */
  private nodes = new Map<string, ObjectNode>();
  /** 当前选中的对象 id 列表，第 0 个为主选中对象（决定缩放点） */
  private selectedIds: string[] = [];
  /** 是否显示参考网格（仅编辑模式可见） */
  private showGrid = false;
  /** 网格线段对象；内容变化时整体重建，否则只调整可见性 */
  private grid: THREE.LineSegments | null = null;
  /** 网格缓存键：步长 + 中心 + z，用于判断是否需要重新构建网格几何 */
  private gridKey = '';
  /** 画布 CSS 尺寸（宽） */
  private width = 960;
  /** 画布 CSS 尺寸（高） */
  private height = 540;
  /** 是否已销毁：所有异步回调与渲染循环在销毁后都应直接返回 */
  private disposed = false;
  /** 正在进行的相机补间动画；同一时刻只允许一个，新动画会先结算旧的 Promise */
  private animation: {
    /** 起始视角快照 */
    from: ViewState;
    /** 目标视角快照 */
    to: ViewState;
    /** 动画开始时间（performance.now 毫秒） */
    start: number;
    /** 动画时长（毫秒） */
    duration: number;
    /** 动画结束（或被中断）时调用的 Promise resolve */
    resolve: () => void;
  } | null = null;
  /** 图片纹理缓存：url -> 纹理 / 加载中 / 失败；多个节点共享同一 src 时只加载一次 */
  private imageCache = new Map<string, CacheEntry>();
  /** 视频 / Lottie 封面（首帧截图）纹理缓存，机制与 imageCache 相同 */
  private posterCache = new Map<string, CacheEntry>();
  /** 正在加载中的图片 url 集合，用于 waitForAssets 判断是否还需等待 */
  private imagePending = new Set<string>();
  /** 正在异步重绘中的 SVG 节点，供预热等待 */
  private vectorPending = new Set<string>();
  /** 矢量纹理延迟重绘的定时器句柄；0 表示当前没有待执行的刷新 */
  private vectorTimer = 0;
  /** 上次触发矢量刷新时的相机距离，用于判断视图是否仍在变化 */
  private lastVectorDistance = -1;
  /** 上次相机距离变化的时间戳，用于等缩放稳定后再重绘 */
  private lastVectorChangeAt = 0;
  /** SVG 原图 Promise 缓存：同一 src 只创建一次 Image，避免重复解码 */
  private svgImageCache = new Map<string, Promise<HTMLImageElement | null>>();
  /** 演示模式下的媒体自动播放是否已触发，避免每次 sync 重复播放 */
  private mediaAutoplayArmed = false;
  /** 因离开视野被自动暂停的媒体 id，回到视野时只恢复这些对象 */
  private mediaAutoPaused = new Set<string>();
  /** 上次媒体可见性检测的时间戳，用于 140ms 节流 */
  private mediaVisibilityAt = 0;
  /** 通用素材占位纹理：图片加载失败时显示 */
  private placeholderTexture: THREE.Texture;
  /** 3D 模型加载中的占位纹理 */
  private modelLoadingTexture: THREE.Texture;
  /** 3D 模型加载失败的占位纹理 */
  private modelErrorTexture: THREE.Texture;
  /** Lottie 加载失败的占位纹理 */
  private lottieErrorTexture: THREE.Texture;
  /** 上一帧时间戳，用于计算帧间隔 dt */
  private lastTickAt = performance.now();
  /** 选中框实线材质（所有节点共享，避免为每个对象各建一份） */
  private solidAccent: THREE.LineBasicMaterial;
  /** 选中框虚线材质（非主选中对象使用） */
  private dashedAccent: THREE.LineDashedMaterial;
  /** 隐藏对象在编辑模式下的灰色虚线轮廓材质 */
  private dashedGray: THREE.LineDashedMaterial;
  /** 四角缩放点材质（所有节点共享） */
  private handleMaterial: THREE.PointsMaterial;
  /** 显卡支持的最大各向异性过滤等级，创建纹理时统一使用 */
  private maxAnisotropy = 4;
  /** 作品背景色缓存；星空模式关闭时用它恢复场景背景 */
  private deckBackground = '#10161F';
  /** 空间模式：none 纯色背景 / stars 星空背景 */
  private spaceMode: SpaceMode = 'none';
  /** 星空点云；懒创建，切换空间模式时复用 */
  private stars: THREE.Points | null = null;
  /** 坐标轴辅助组；懒创建，随 showAxes 显示或隐藏 */
  private axes: THREE.Group | null = null;
  /** 是否显示世界坐标轴 */
  private showAxes = false;
  /** 当前镜头特效：none 原图 / fisheye 鱼眼 */
  private lensEffect: LensEffect = 'none';
  /** 鱼眼强度，0 ~ 1，越大畸变越明显 */
  private lensStrength = 0.45;
  /** 鱼眼后处理的离屏渲染目标，尺寸跟随绘图缓冲 */
  private lensTarget: THREE.WebGLRenderTarget | null = null;
  /** 后处理场景：只包含一个覆盖屏幕的四边形 */
  private lensScene: THREE.Scene | null = null;
  /** 后处理正交相机，坐标范围 -1 ~ 1，与全屏四边形匹配 */
  private lensCamera: THREE.OrthographicCamera | null = null;
  /** 鱼眼着色器材质，持有原图纹理与强度 uniform */
  private lensMaterial: THREE.ShaderMaterial | null = null;
  /** VR 内容承载组；进入 XR 时 objectsRoot 会临时挂到它下面 */
  private xrRig: THREE.Group | null = null;
  /** 是否处于 XR 会话中，渲染循环据此切换立体渲染分支 */
  private xrActive = false;

  /**
   * 创建场景管理器并挂载渲染画布。
   *
   * @param container 画布容器，renderer.domElement 会作为其子节点插入
   * @param background 初始背景色（十六进制字符串）
   * @param initialView 初始相机视角
   * @param mode 初始舞台模式：edit 编辑 / view 浏览 / present 演示
   * @param callbacks 素材加载失败、XR 状态变化等外部回调
   * @param options.autoStart 是否立即启动渲染循环，默认 true
   * @param options.preserveDrawingBuffer 是否保留绘图缓冲（离屏截图需要）
   */
  constructor(
    container: HTMLElement,
    background: string,
    initialView: ViewState,
    mode: StageMode,
    callbacks: SceneCallbacks,
    options: { autoStart?: boolean; preserveDrawingBuffer?: boolean } = {},
  ) {
    this.mode = mode;
    this.callbacks = callbacks;
    // 深拷贝视角，避免外部 store 之后修改 target 对象时影响内部状态
    this.view = { ...initialView, target: { ...initialView.target } };

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: options.preserveDrawingBuffer === true,
    });
    // 输出使用 sRGB 色彩空间，保证 canvas 上的颜色与 CSS 颜色一致
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // 像素比上限 2：高分屏上限制渲染分辨率，避免 4K/5K 屏性能骤降
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // 画布铺满容器；容器尺寸由外层布局控制，真正的缓冲尺寸在 resize() 中设置
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);
    // 读取显卡支持的各向异性上限，后续纹理（尤其倾斜观看时）统一使用
    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);
    this.camera = new THREE.PerspectiveCamera(FOV, ASPECT, 0.1, 200000);
    // Y 轴向下是幻灯片坐标约定；把相机 up 设为 -Y，画面才不会上下颠倒
    this.camera.up.set(0, -1, 0);
    this.scene.add(this.objectsRoot);

    // 三点布光：环境光保证整体亮度，主光塑造 3D 文字的挤出体积，辅光补亮暗部
    const ambient = new THREE.AmbientLight(0xffffff, 1.15);
    this.scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
    keyLight.position.set(900, -1200, 1400);
    this.scene.add(keyLight);
    // target 必须加入场景，光源才会按世界坐标朝向目标点
    this.scene.add(keyLight.target);
    const fillLight = new THREE.DirectionalLight(0x9fb7d4, 0.7);
    fillLight.position.set(-1000, 600, 800);
    this.scene.add(fillLight);
    this.scene.add(fillLight.target);

    // 选中框 / 缩放点属于覆盖层：关闭深度测试与深度写入，
    // 保证它们永远画在对象之上，且不影响场景本身的深度关系。
    this.solidAccent = new THREE.LineBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    this.dashedAccent = new THREE.LineDashedMaterial({
      color: ACCENT,
      dashSize: 10,
      gapSize: 6,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
    this.dashedGray = new THREE.LineDashedMaterial({
      color: 0x8c94a2,
      dashSize: 9,
      gapSize: 7,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });
    // sizeAttenuation=false：缩放点固定为 6 CSS 像素，不随相机距离缩小
    this.handleMaterial = new THREE.PointsMaterial({
      color: ACCENT,
      size: 6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    // 占位纹理全局复用：同一张纹理被多个节点共享，销毁时统一释放
    this.placeholderTexture = this.createPlaceholderTexture();
    this.modelLoadingTexture = this.createModelPlaceholderTexture('正在加载 3D 模型…');
    this.modelErrorTexture = this.createModelPlaceholderTexture('模型无法加载');
    this.lottieErrorTexture = this.createModelPlaceholderTexture('Lottie 无法加载');

    this.applyView(this.view);
    this.resize(this.width, this.height);
    this.renderer.xr.enabled = true;
    // tick 作为回调传出去会丢失 this，先绑定一次，后续复用同一个引用
    this.tick = this.tick.bind(this);
    if (options.autoStart !== false) this.renderer.setAnimationLoop(this.tick);
  }

  /** 生成图片加载失败时的占位纹理（虚线边框 + 提示文案），全局复用 */
  private createPlaceholderTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 576;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1A2532';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(140,148,162,.5)';
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 3;
    ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(201,210,223,.55)';
    ctx.font = '500 34px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('图片无法加载', canvas.width / 2, canvas.height / 2 - 20);
    ctx.font = '400 24px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText('可重试、替换或删除该对象', canvas.width / 2, canvas.height / 2 + 34);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  /** 生成模型 / Lottie 的占位纹理：等距投影线框立方体 + 自定义提示文案 */
  private createModelPlaceholderTexture(label: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#141E2A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(45,212,191,.35)';
    ctx.lineWidth = 3;
    ctx.setLineDash([18, 12]);
    ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(45,212,191,.55)';
    ctx.lineWidth = 4;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2 - 70;
    const s = 150;
    const cube = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ] as [number, number, number][];
    const project = (point: [number, number, number]) => {
      const k = 1.9 / (3 + point[2]);
      return [cx + point[0] * s * k, cy + point[1] * s * k] as [number, number];
    };
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (const [a, b] of edges) {
      const p1 = project(cube[a]);
      const p2 = project(cube[b]);
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(201,210,223,.7)';
    ctx.font = '500 40px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, canvas.width / 2, cy + 270);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  }

  /**
   * 更新作品背景色。
   * 星空模式下背景被星空覆盖，只记录颜色而不立即应用，退出星空时再恢复。
   */
  setBackground(color: string) {
    this.deckBackground = color;
    if (this.spaceMode === 'none') (this.scene.background as THREE.Color).set(color);
  }

  /**
   * 切换舞台模式。
   * 模式会影响对象可见性、隐藏对象的虚化外观、网格显示与媒体播放行为，
   * 因此切换后需要重新应用所有节点的外观与媒体策略。
   */
  setMode(mode: StageMode) {
    const previousMode = this.mode;
    this.mode = mode;
    for (const node of this.nodes.values()) this.applyNodeAppearance(node);
    this.gridDirty();
    this.handleModeMedia(previousMode, mode);
  }

  /** 显示 / 隐藏编辑参考网格；置脏后由下一帧 tick 重建 */
  setShowGrid(show: boolean) {
    this.showGrid = show;
    this.gridDirty();
  }

  /**
   * 设置镜头特效。
   * @param effect none 原样输出 / fisheye 鱼眼畸变
   * @param strength 鱼眼强度，自动裁剪到 0 ~ 1
   */
  setLens(effect: LensEffect, strength = this.lensStrength) {
    this.lensEffect = effect;
    this.lensStrength = Math.max(0, Math.min(1, strength));
    if (effect === 'fisheye') {
      // 首次启用时才创建后处理资源；之后仅更新强度并同步渲染目标尺寸
      this.ensureLens();
      if (this.lensMaterial) this.lensMaterial.uniforms.uStrength.value = this.lensStrength;
      this.updateLensTarget();
    }
  }

  /** 读取当前镜头特效配置 */
  getLens(): { effect: LensEffect; strength: number } {
    return { effect: this.lensEffect, strength: this.lensStrength };
  }

  /**
   * 切换空间背景。
   * 星空为懒创建（4200 个点一次生成），关闭时只隐藏并恢复作品背景色。
   */
  setSpaceMode(mode: SpaceMode) {
    this.spaceMode = mode;
    if (mode === 'stars') {
      this.ensureStars();
      if (this.stars) this.stars.visible = true;
      (this.scene.background as THREE.Color).set('#04060D');
    } else {
      if (this.stars) this.stars.visible = false;
      (this.scene.background as THREE.Color).set(this.deckBackground);
    }
  }

  /** 显示 / 隐藏世界坐标轴辅助（懒创建，坐标轴不受深度遮挡） */
  setShowAxes(show: boolean) {
    this.showAxes = show;
    if (show) this.ensureAxes();
    if (this.axes) this.axes.visible = show;
  }

  /** 读取坐标轴当前是否显示 */
  getShowAxes(): boolean {
    return this.showAxes;
  }

  /**
   * 立即设置视角。
   * 若存在进行中的飞行动画会先结算其 Promise，再直接跳转到目标视角。
   */
  setView(view: ViewState) {
    this.animation?.resolve();
    this.animation = null;
    this.applyView({ ...view, target: { ...view.target } });
  }

  /** 获取渲染画布；离屏截图与外部事件绑定会用到 */
  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** 同步渲染一帧，用于导出截图或素材预热时手动推进画面 */
  renderOnce() {
    if (this.disposed) return;
    this.tick(performance.now());
  }

  /** 调整渲染像素比（0.5 ~ 3），并同步后处理渲染目标尺寸 */
  setPixelRatio(ratio: number) {
    this.renderer.setPixelRatio(Math.max(0.5, Math.min(3, ratio)));
    this.resize(this.width, this.height);
    if (this.lensMaterial) this.updateLensTarget();
  }

  /** 等待图片、模型、Lottie 与视频首帧就绪，用于离屏导出前预热 */
  async waitForAssets(timeout = 4000): Promise<void> {
    const started = performance.now();
    // 轮询而非事件驱动：素材来自多个异步源（图片 / 模型 / Lottie / 视频首帧），
    // 统一用「是否还有 pending」判断更简单，100ms 一次也不会明显拖慢导出。
    while (!this.disposed && performance.now() - started < timeout) {
      let loading = 0;
      for (const node of this.nodes.values()) {
        if (node.model?.status === 'loading') loading += 1;
        if (node.lottie?.status === 'loading') loading += 1;
        if (
          node.media?.kind === 'video' &&
          !node.media.ready &&
          !node.media.error
        ) {
          loading += 1;
        }
      }
      // 图片、SVG 重绘与模型 / Lottie / 视频都就绪后才返回；
      // 超时后即使仍有素材未完成也会继续，避免导出流程被坏素材卡死。
      if (this.imagePending.size === 0 && this.vectorPending.size === 0 && loading === 0) return;
      this.renderOnce();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
  }

  /** 离屏截图：按 16:9 输出 JPEG dataURL，供首页封面使用 */
  async captureImage(width: number, height: number, timeout = 6000): Promise<string> {
    if (this.disposed) throw new Error('渲染器已销毁');
    // 截图固定 1 倍像素比与指定尺寸，保证不同设备导出的封面分辨率一致
    this.setPixelRatio(1);
    this.resize(width, height);
    await this.waitForAssets(timeout);
    this.renderOnce();
    try {
      // 0.86 质量在体积与清晰度之间折中；preserveDrawingBuffer 关闭时会抛错
      return this.renderer.domElement.toDataURL('image/jpeg', 0.86);
    } catch {
      throw new Error('封面生成失败');
    }
  }

  /** 暂停渲染循环；画布保留最后一帧，用于离开页面或低功耗场景 */
  stopLoop() {
    this.renderer.setAnimationLoop(null);
  }

  /** 恢复渲染循环；已销毁的实例不会重新启动 */
  startLoop() {
    if (this.disposed) return;
    this.renderer.setAnimationLoop(this.tick);
  }

  /**
   * 查询当前设备是否支持沉浸式 VR。
   * WebXR 不存在或查询失败时统一返回 false（不做能力假设，避免误判）。
   */
  getXRSupported(): Promise<boolean> {
    const xr = (navigator as unknown as {
      xr?: { isSessionSupported?: (mode: string) => Promise<boolean> };
    }).xr;
    if (!xr || typeof xr.isSessionSupported !== 'function') return Promise.resolve(false);
    return xr.isSessionSupported('immersive-vr').catch(() => false);
  }

  /**
   * 请求进入沉浸式 VR 会话。
   * 成功后会切换参考空间、搭建 VR 展台并把内容从场景根移到 XR rig 下；
   * 失败（无权限 / 设备不支持 / 用户取消）返回 false，并保证已恢复桌面布局。
   */
  async enterXR(): Promise<boolean> {
    const xr = (navigator as unknown as {
      xr?: { requestSession: (mode: string, init?: unknown) => Promise<XRSessionLike> };
    }).xr;
    if (!xr || typeof xr.requestSession !== 'function') return false;
    if (this.xrActive) return true;
    try {
      const session = await xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor'],
      });
      // local-floor：以用户脚下地面为原点，便于把画板放到视线高度
      this.renderer.xr.setReferenceSpaceType('local-floor');
      await this.renderer.xr.setSession(session as unknown as XRSession);
      this.xrSession = session;
      this.xrActive = true;
      this.setupXrRig();
      // 用户摘下头显 / 系统结束会话时，需要同步恢复桌面渲染状态
      session.addEventListener('end', this.handleXrEnd);
      this.callbacks.onXRChange?.(true);
      return true;
    } catch {
      this.restoreFromXr();
      this.xrActive = false;
      return false;
    }
  }

  /**
   * 主动退出 VR 会话。
   * 正常结束会触发会话的 end 事件走统一清理；结束失败则手动调用清理兜底。
   */
  async exitXR() {
    const session = this.xrSession;
    this.xrSession = null;
    if (!session) return;
    try {
      await session.end();
    } catch {
      this.handleXrEnd();
    }
  }

  /** XR 会话结束的统一清理入口（事件回调与异常兜底都会走到这里） */
  private handleXrEnd = () => {
    this.xrSession = null;
    this.restoreFromXr();
    this.xrActive = false;
    this.callbacks.onXRChange?.(false);
  };

  /** VR：把画板缩放到 4 米宽、放到眼前 5 米处，像坐在影院里 */
  private setupXrRig() {
    if (this.xrRig) return;
    const rig = new THREE.Group();
    rig.position.set(0, 1.55, -5);
    const scale = 4 / Math.max(1, this.deckWidth());
    // 内容组已翻转 X/Y；VR 相机是标准右手系，rig 再翻转 X/Y 才与桌面画面一致且正立
    rig.scale.set(-scale, -scale, scale);
    this.scene.add(rig);
    rig.add(this.objectsRoot);
    this.objectsRoot.position.set(0, 0, 0);
    this.xrRig = rig;
    if (this.grid) this.grid.visible = false;
    if (this.axes) this.axes.visible = false;
  }

  /** 退出 VR 后把内容挂回场景根，并恢复坐标轴等编辑辅助元素的显示状态 */
  private restoreFromXr() {
    if (!this.xrRig) return;
    this.xrRig.remove(this.objectsRoot);
    this.scene.add(this.objectsRoot);
    this.scene.remove(this.xrRig);
    this.xrRig = null;
    if (this.axes) this.axes.visible = this.showAxes;
  }

  /** 估算作品最大宽度，用于计算 VR 展台的缩放比例（最小按 1600 设计单位处理） */
  private deckWidth(): number {
    let width = 0;
    for (const node of this.nodes.values()) width = Math.max(width, node.data.width);
    return Math.max(1600, width);
  }

  /** 当前 WebXR 会话句柄；为 null 表示未进入 XR */
  private xrSession: XRSessionLike | null = null;

  /** 懒创建鱼眼后处理资源：场景、正交相机、着色器材质与覆盖全屏的四边形 */
  private ensureLens() {
    if (this.lensScene && this.lensMaterial) return;
    const lensScene = new THREE.Scene();
    // 正交相机范围固定为 -1~1，配合 2x2 的平面正好铺满 NDC 全屏
    const lensCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const lensMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uStrength: { value: this.lensStrength },
        uVignette: { value: 0.6 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uStrength;
        uniform float uVignette;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r2 = dot(p, p);
          float k = uStrength * 0.55;
          vec2 warped = p * (1.0 + k * r2) / (1.0 + k * 2.0);
          vec2 uv = warped * 0.5 + 0.5;
          vec3 col = texture2D(tDiffuse, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
          float vignette = smoothstep(1.55, 0.45, length(p));
          col *= mix(1.0, vignette, uVignette);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    // 顶点着色器直接输出裁剪空间坐标，四边形无需参与视锥剔除
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lensMaterial);
    quad.frustumCulled = false;
    lensScene.add(quad);
    this.lensScene = lensScene;
    this.lensCamera = lensCamera;
    this.lensMaterial = lensMaterial;
    this.updateLensTarget();
  }

  /**
   * 同步后处理渲染目标尺寸。
   * 使用实际绘图缓冲尺寸（已含像素比），保证离屏纹理与画布像素一一对应。
   */
  private updateLensTarget() {
    if (!this.lensMaterial) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const width = Math.max(1, Math.round(size.x));
    const height = Math.max(1, Math.round(size.y));
    if (!this.lensTarget) {
      this.lensTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
      });
    } else {
      this.lensTarget.setSize(width, height);
    }
    this.lensMaterial.uniforms.tDiffuse.value = this.lensTarget.texture;
  }

  /** 懒创建星空点云：点分布在半径 26000 的球壳上，作为远景背景 */
  private ensureStars() {
    if (this.stars) return;
    const count = 4200;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const radius = 26000;
    for (let i = 0; i < count; i += 1) {
      // 球面均匀采样：u 为纬度余弦，theta 为经度，避免两极堆积
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      positions[i * 3] = Math.cos(theta) * r * radius;
      positions[i * 3 + 1] = u * radius;
      positions[i * 3 + 2] = Math.sin(theta) * r * radius;
      const warm = Math.random();
      colors[i * 3] = 0.75 + warm * 0.25;
      colors[i * 3 + 1] = 0.8 + warm * 0.18;
      colors[i * 3 + 2] = 1;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 46,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    const stars = new THREE.Points(geometry, material);
    // renderOrder 为负保证星空最先画；关闭视锥剔除，因为点云范围远大于相机视锥
    stars.renderOrder = -100;
    stars.frustumCulled = false;
    this.scene.add(stars);
    this.stars = stars;
  }

  /** 懒创建世界坐标轴：X 红 / Y 绿 / Z 蓝，端点带文字标签，始终画在最上层 */
  private ensureAxes() {
    if (this.axes) return;
    const axes = new THREE.Group();
    axes.renderOrder = 1100;
    const length = 1900;
    const definitions: { axis: 'x' | 'y' | 'z'; color: number; hex: string }[] = [
      { axis: 'x', color: 0xf87171, hex: '#F87171' },
      { axis: 'y', color: 0x34d399, hex: '#34D399' },
      { axis: 'z', color: 0x60a5fa, hex: '#60A5FA' },
    ];
    for (const definition of definitions) {
      const material = new THREE.LineBasicMaterial({
        color: definition.color,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      });
      const positions =
        definition.axis === 'x'
          ? [-length, 0, 0, length, 0, 0]
          : definition.axis === 'y'
            ? [0, -length, 0, 0, length, 0]
            : [0, 0, -length, 0, 0, length];
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const line = new THREE.LineSegments(geometry, material);
      line.renderOrder = 1100;
      axes.add(line);
      const ends: { label: string; position: [number, number, number] }[] =
        definition.axis === 'x'
          ? [
              { label: '+X', position: [length + 110, 0, 0] },
              { label: '-X', position: [-length - 110, 0, 0] },
            ]
          : definition.axis === 'y'
            ? [
                { label: '+Y', position: [0, length + 110, 0] },
                { label: '-Y', position: [0, -length - 110, 0] },
              ]
            : [
                { label: '+Z', position: [0, 0, length + 110] },
                { label: '-Z', position: [0, 0, -length - 110] },
              ];
      for (const end of ends) {
        const sprite = this.createAxisLabel(end.label, definition.hex);
        sprite.position.set(...end.position);
        axes.add(sprite);
      }
    }
    this.scene.add(axes);
    this.axes = axes;
  }

  /** 用画布生成坐标轴端点文字精灵；Sprite 始终朝向相机，旋转视角时标签不会变形 */
  private createAxisLabel(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.font = '700 128px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 132);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(300, 300, 1);
    sprite.renderOrder = 1101;
    return sprite;
  }

  /**
   * 更新选中集合。
   * 选中变化只影响选中框与外观，不触发内容重建；顺序与内容完全一致时直接跳过。
   */
  setSelected(ids: string[]) {
    // 浅比较即可：选中 id 列表很短，且变化频率高，避免无意义的全节点遍历
    if (this.selectedIds.length === ids.length && ids.every((id, i) => this.selectedIds[i] === id)) return;
    this.selectedIds = ids;
    for (const node of this.nodes.values()) {
      this.applyOutline(node, node.data.visible);
      this.applyNodeAppearance(node);
    }
  }

  /**
   * 调整画布尺寸。
   * 画布 CSS 尺寸由外层容器控制，这里只设置绘图缓冲尺寸；
   * 相机宽高比固定为作品设计比例 ASPECT，窗口变形时通过视野留白保持画面比例。
   */
  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    // 第三个参数 false：不修改 canvas 的内联 style，避免覆盖 CSS 的 100% 布局
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = ASPECT;
    this.camera.updateProjectionMatrix();
    this.gridDirty();
    if (this.lensMaterial) this.updateLensTarget();
  }

  /** 获取当前视角的深拷贝，防止调用方直接修改内部状态 */
  getView(): ViewState {
    return { ...this.view, target: { ...this.view.target } };
  }

  /**
   * 把 store 中的作品数据同步到场景。
   *
   * 采用增量同步策略：
   * 1. 先删除 deck 中已不存在的对象节点，并释放其 GPU 资源；
   * 2. 按 z 升序处理，保证 renderOrder 与层级一致；
   * 3. 已有节点只更新变换与外观，只有 visualKey 变化时才重建内容；
   * 4. 最后处理模式切换带来的媒体行为与矢量纹理刷新。
   *
   * @param deck 最新的作品数据（对象列表是其唯一来源）
   * @param selectedIds 当前选中的对象 id
   * @param mode 当前舞台模式
   */
  sync(deck: Deck, selectedIds: string[], mode: StageMode) {
    const previousMode = this.mode;
    this.mode = mode;
    this.selectedIds = selectedIds;
    this.setBackground(deck.background);
    // 先做删除：不在新数据中的对象要立刻释放纹理 / 模型 / 媒体元素
    const live = new Set(deck.objects.map((object) => object.id));
    for (const [id, node] of this.nodes) {
      if (!live.has(id)) {
        this.removeNode(node);
        this.nodes.delete(id);
      }
    }
    // z 小的先画、大的后画；renderOrder 与排序下标一致，确保透明对象叠加顺序正确
    const sorted = [...deck.objects].sort((a, b) => a.z - b.z);
    sorted.forEach((object, index) => {
      let node = this.nodes.get(object.id);
      if (!node) {
        // 首次出现的对象才创建节点并挂到对象根组
        node = this.createNode(object);
        this.nodes.set(object.id, node);
        this.objectsRoot.add(node.group);
      }
      node.data = object;
      node.group.position.set(object.x, object.y, object.z);
      // store 中的旋转角单位为度，Three.js 使用弧度，这里逐轴换算
      node.group.rotation.set(
        ((object.rotationX ?? 0) * Math.PI) / 180,
        ((object.rotationY ?? 0) * Math.PI) / 180,
        (object.rotation * Math.PI) / 180,
      );
      node.group.renderOrder = index;
      // 浏览 / 演示模式尊重对象的 visible；编辑模式下即使隐藏也要显示（半透明幽灵态）
      node.group.visible =
        mode === 'present' || mode === 'view' ? object.visible : true;
      if (mode === 'present' || mode === 'view') {
        if (!object.visible) {
          node.group.visible = false;
          return;
        }
      }
      // 脏检查：只有影响内容外观的字段变化才重建，纯移动 / 旋转不会重建几何
      const key = this.visualKey(object);
      if (key !== node.visualKey) {
        node.visualKey = key;
        this.rebuildContent(node);
      }
      if (node.media) this.applyMediaSettings(node.media, object);
      this.applyOutline(node, object.visible);
      this.applyNodeAppearance(node);
    });
    this.gridDirty();
    this.handleModeMedia(previousMode, mode);
    // 进入作品或对象变化后，等画面稳定再按实际缩放重绘 SVG / Lottie
    if (deck.objects.some((object) => object.type === 'svg' || object.type === 'lottie')) {
      this.scheduleVectorRefresh(180);
    }
  }

  /**
   * 生成对象外观脏检查键。
   * 只拼接会触发内容重建的字段（文案、尺寸、颜色、素材地址等），
   * 位置 / 旋转 / 透明度等运行时属性不参与，避免拖动时反复重建几何。
   */
  private visualKey(object: SlideObject): string {
    if (object.type === 'text') {
      const t = object as TextObject;
      return [
        'text', t.text, t.width, t.height, t.fontSize, t.font, t.bold, t.align, t.color, t.lineHeight, t.depth3d ?? 0,
      ].join('|');
    }
    if (object.type === 'image' || object.type === 'svg') {
      const image = object as ImageObject | SvgObject;
      return [object.type, image.src, image.width, image.height, image.fit].join('|');
    }
    if (object.type === 'video') {
      const video = object as VideoObject;
      return ['video', video.src, video.width, video.height, video.fit].join('|');
    }
    if (object.type === 'audio') {
      const audio = object as AudioObject;
      return ['audio', audio.src, audio.name, audio.width, audio.height, audio.duration].join('|');
    }
    if (object.type === 'model') {
      const model = object as ModelObject;
      return ['model', model.src, model.format, model.width, model.height].join('|');
    }
    if (object.type === 'lottie') {
      const lottie = object as LottieObject;
      return ['lottie', lottie.src, lottie.width, lottie.height, lottie.loop, lottie.speed].join('|');
    }
    const shape = object as ShapeObject;
    return [
      'shape',
      shape.shape,
      shape.width,
      shape.height,
      shape.fill,
      shape.stroke ?? '',
      shape.strokeWidth,
      shape.points ? shape.points.join(',') : '',
    ].join('|');
  }

  /**
   * 创建对象节点骨架：根组 + 选中框 + 四角缩放点，并按对象数据构建内容。
   * 节点创建后由 sync 负责挂到 objectsRoot，不在这里插入场景。
   */
  private createNode(object: SlideObject): ObjectNode {
    const group = new THREE.Group();
    // userData 标记用于射线拾取：命中任意子网格后向上找到 nodeRoot 即可得到对象 id
    group.userData.objectId = object.id;
    group.userData.nodeRoot = true;
    const outlineGeometry = this.outlineGeometry(object.width, Math.max(object.height, 8));
    const outline = new THREE.LineSegments(outlineGeometry, this.solidAccent);
    outline.computeLineDistances();
    outline.renderOrder = 1000;
    outline.visible = false;
    group.add(outline);
    const handleGeometry = new THREE.BufferGeometry();
    handleGeometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const handles = new THREE.Points(handleGeometry, this.handleMaterial);
    handles.renderOrder = 1001;
    handles.visible = false;
    group.add(handles);
    const node: ObjectNode = {
      group,
      content: null,
      outline,
      handles,
      materials: [],
      ownedTextures: [],
      visualKey: '',
      outlineWidth: object.width,
      outlineHeight: Math.max(object.height, 8),
      imageState: null,
      svgTexture: null,
      posterState: null,
      media: null,
      model: null,
      lottie: null,
      data: object,
      objectId: object.id,
      pickRoot: null,
    };
    this.rebuildContent(node);
    return node;
  }

  /** 生成矩形选中框几何：四段边线的端点成对排列，供 LineSegments 绘制 */
  private outlineGeometry(width: number, height: number): THREE.BufferGeometry {
    const w = width / 2;
    const h = height / 2;
    const positions = [
      -w, -h, 0, w, -h, 0,
      w, -h, 0, w, h, 0,
      w, h, 0, -w, h, 0,
      -w, h, 0, -w, -h, 0,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }

  /** 生成四角缩放点几何：只包含四个角点，显示大小由 PointsMaterial 的 size 决定 */
  private handleGeometry(width: number, height: number): THREE.BufferGeometry {
    const w = width / 2;
    const h = height / 2;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-w, -h, 0, w, -h, 0, w, h, 0, -w, h, 0], 3),
    );
    return geometry;
  }

  /**
   * 应用选中框与缩放点的显示状态与材质。
   * - 编辑模式下：选中对象显示实线框，隐藏对象显示灰色虚线框，主选中对象额外显示四角缩放点；
   * - 浏览 / 演示模式下不显示任何编辑辅助元素。
   */
  private applyOutline(node: ObjectNode, visibleObject: boolean) {
    const isSelected = this.mode === 'edit' && this.selectedIds.includes(node.objectId);
    const isPrimary = this.mode === 'edit' && this.selectedIds[0] === node.objectId;
    const showHidden = this.mode === 'edit' && !visibleObject;
    // 尺寸变化时才重建几何：旧 BufferGeometry 必须先 dispose，否则每次缩放都会泄漏显存
    if (node.outlineWidth !== node.data.width || node.outlineHeight !== Math.max(node.data.height, 8)) {
      node.outlineWidth = node.data.width;
      node.outlineHeight = Math.max(node.data.height, 8);
      node.outline.geometry.dispose();
      node.outline.geometry = this.outlineGeometry(node.outlineWidth, node.outlineHeight);
      // 虚线材质的 dash 依赖顶点间累积距离，几何更新后必须重新计算
      node.outline.computeLineDistances();
      node.handles.geometry.dispose();
      node.handles.geometry = this.handleGeometry(node.outlineWidth, node.outlineHeight);
    }
    node.outline.visible = isSelected || showHidden;
    node.handles.visible = isPrimary;
    if (isSelected) node.outline.material = this.solidAccent;
    else if (showHidden) node.outline.material = this.dashedGray;
    else node.outline.material = this.dashedAccent;
  }

  /**
   * 应用对象的整体外观（透明度与透明渲染开关）。
   * 编辑模式下被隐藏的对象会以最高 24% 不透明度显示，提示位置但不干扰画面。
   */
  private applyNodeAppearance(node: ObjectNode) {
    const object = node.data;
    const hiddenInEdit = this.mode === 'edit' && !object.visible;
    // store 中的 opacity 是 0 ~ 100 的百分比，材质需要 0 ~ 1
    const base = Math.max(0, Math.min(100, object.opacity)) / 100;
    const opacity = hiddenInEdit ? Math.min(base, 0.24) : base;
    const needsTransparent =
      opacity < 1 ||
      object.type === 'text' ||
      object.type === 'image' ||
      object.type === 'svg' ||
      object.type === 'video' ||
      object.type === 'audio' ||
      object.type === 'lottie' ||
      hiddenInEdit;
    for (const material of node.materials) {
      // 半透明对象关闭深度写入，避免透明面片互相遮挡出现硬边；
      // 不透明对象保持深度写入，保证前后关系正确且减少 overdraw。
      const mat = material as THREE.MeshBasicMaterial;
      mat.opacity = opacity;
      mat.transparent = needsTransparent;
      mat.depthWrite = !needsTransparent;
    }
    this.applyOutline(node, object.visible);
  }

  /**
   * 清空节点内容并释放其 GPU 资源。
   * 注意：共享纹理（图片缓存、占位纹理）不能在这里释放，只释放节点独占的纹理。
   */
  private clearContent(node: ObjectNode) {
    // 模型组可能被上层异步重新挂载，先从父节点摘下，避免随内容一起被遍历销毁
    const modelGroup = node.model?.group;
    if (modelGroup?.parent) modelGroup.parent.remove(modelGroup);
    if (node.content) {
      node.group.remove(node.content);
      // 遍历释放几何与材质；同一材质被多个网格引用时重复 dispose 是安全的
      node.content.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach(disposeMaterial);
        else if (material) disposeMaterial(material);
      });
      node.content = null;
    }
    // 只释放节点独占纹理（如 cover 裁剪的纹理克隆、文字画布纹理）
    for (const texture of node.ownedTextures) texture.dispose();
    node.ownedTextures = [];
    node.materials = [];
    node.pickRoot = null;
  }

  /** 收集所有参与射线拾取的根节点；没有内容的节点不参与命中 */
  private pickRoots(): THREE.Object3D[] {
    const roots: THREE.Object3D[] = [];
    for (const node of this.nodes.values()) {
      if (node.pickRoot) roots.push(node.pickRoot);
    }
    return roots;
  }

  /**
   * 重建节点内容。
   * 先释放旧内容，再按对象类型构建新的内容组；构建完成后统一打上 objectId，
   * 使射线拾取能从任意子网格反查所属对象。
   */
  private rebuildContent(node: ObjectNode) {
    this.clearContent(node);
    const object = node.data;
    const group = new THREE.Group();
    group.userData.objectId = object.id;
    // 世界坐标 Y 轴向下、相机 up=(0,-1,0)，画面相对世界是 180° 翻转；内容同时翻转 X/Y 才能正立且不镜像
    group.scale.x = -1;
    group.scale.y = -1;
    this.buildInto(group, object, node);
    // 递归写入 objectId，保证命中文字挤出网格、模型子网格时也能拿到对象 id
    group.traverse((child) => {
      child.userData.objectId = object.id;
    });
    node.group.add(group);
    node.content = group;
    node.pickRoot = group;
    node.visualKey = this.visualKey(node.data);
    this.applyNodeAppearance(node);
    this.applyOutline(node, node.data.visible);
    node.outline.computeLineDistances();
  }

  /** 按对象类型分发到具体的构建函数（文本 / 图片 / SVG / 视频 / 音频 / 模型 / Lottie / 形状） */
  private buildInto(group: THREE.Group, object: SlideObject, node: ObjectNode) {
    if (object.type === 'text') {
      this.buildText(group, object as TextObject, node);
      return;
    }
    if (object.type === 'image' || object.type === 'svg') {
      this.buildImage(group, object as ImageObject | SvgObject, node);
      return;
    }
    if (object.type === 'video') {
      this.buildVideo(group, object as VideoObject, node);
      return;
    }
    if (object.type === 'audio') {
      this.buildAudio(group, object as AudioObject, node);
      return;
    }
    if (object.type === 'model') {
      this.buildModel(group, object as ModelObject, node);
      return;
    }
    if (object.type === 'lottie') {
      this.buildLottie(group, object as LottieObject, node);
      return;
    }
    this.buildShape(group, object as ShapeObject, node);
  }

  /**
   * 构建文本内容。
   * depth3d <= 0.5 时用平面贴图；否则用画布 alpha 提取轮廓并挤出成真正的 3D 文字，
   * 正面仍贴文字纹理，侧壁使用压暗的独立材质；挤出失败时降级为平面。
   */
  private buildText(group: THREE.Group, object: TextObject, node: ObjectNode) {
    const canvas = this.renderTextCanvas(object);
    // 文字画布纹理由节点独占，随内容重建一起释放
    const texture = this.textureFromCanvas(canvas, node);
    const frontMaterial = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // 深度限制在 0 ~ 600 世界单位，避免极端参数把文字挤出到画面外
    const depth = Math.max(0, Math.min(600, object.depth3d ?? 0));
    if (depth <= 0.5) {
      // 几乎无厚度：直接使用平面贴图，省去轮廓提取开销
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), frontMaterial);
      group.add(mesh);
      node.materials.push(frontMaterial);
      return;
    }
    const geometry = buildTextExtrudeGeometry(canvas, {
      width: object.width,
      height: object.height,
      depth,
    });
    if (!geometry) {
      // 轮廓提取失败（如全透明文字）时降级为平面，保证对象仍然可见
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), frontMaterial);
      mesh.position.z = -depth / 2;
      group.add(mesh);
      node.materials.push(frontMaterial);
      return;
    }
    // 侧壁颜色取文字色的 42%，形成自然的明暗对比，避免侧壁比正面更亮
    const sideColor = new THREE.Color(object.color || '#F3EEE4').multiplyScalar(0.42);
    const sideMaterial = new THREE.MeshStandardMaterial({
      color: sideColor,
      roughness: 0.62,
      metalness: 0.08,
      side: THREE.DoubleSide,
    });
    // ExtrudeGeometry 材质分组：0 = 正背文字面（贴文字纹理），1 = 挤出侧壁
    const mesh = new THREE.Mesh(geometry, [frontMaterial, sideMaterial]);
    group.add(mesh);
    node.materials.push(frontMaterial, sideMaterial);
  }

  /**
   * 把文字渲染到离屏画布，作为文字纹理来源。
   * 渲染密度最高 2 倍，并限制画布单边不超过 4096 像素，兼顾清晰度与显存。
   */
  private renderTextCanvas(object: TextObject): HTMLCanvasElement {
    const density = Math.min(
      2,
      4096 / Math.max(1, object.width),
      4096 / Math.max(1, object.height),
    );
    const canvasWidth = Math.max(1, Math.round(object.width * density));
    const canvasHeight = Math.max(1, Math.round(object.height * density));
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d')!;
    const layout = layoutText(object.text, object.width, object.fontSize, object.font, object.bold, object.lineHeight);
    const fontPx = object.fontSize * density;
    ctx.font = fontCss(object.font, object.fontSize, object.bold, density);
    ctx.fillStyle = object.color;
    ctx.textBaseline = 'alphabetic';
    const lineHeightPx = fontPx * object.lineHeight;
    const paddingTop = fontPx * 0.3;
    ctx.textAlign = object.align === 'center' ? 'center' : object.align === 'right' ? 'right' : 'left';
    const x = object.align === 'center' ? canvasWidth / 2 : object.align === 'right' ? canvasWidth : 0;
    layout.lines.forEach((line, index) => {
      ctx.fillText(line, x, paddingTop + fontPx * 0.8 + index * lineHeightPx);
    });
    return canvas;
  }

  /** 把画布包装为 CanvasTexture，并登记到节点独占纹理列表，随内容重建释放 */
  private textureFromCanvas(canvas: HTMLCanvasElement, node: ObjectNode): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = this.maxAnisotropy;
    node.ownedTextures.push(texture);
    return texture;
  }

  /**
   * 确保图片素材已加载，并记录到节点状态。
   * 同一个 src 通过 imageCache 去重：无论多少个对象引用同一张图，都只发起一次请求；
   * 加载完成后会通知所有等待该 src 的节点并重建它们的内容。
   */
  private ensureImage(node: ObjectNode, object: { src: string }) {
    // src 未变化直接复用已有状态，避免重复加载
    if (node.imageState && node.imageState.src === object.src) return;
    node.imageState = null;
    if (!object.src) {
      node.imageState = { src: '', status: 'error' };
      return;
    }
    const cached = this.imageCache.get(object.src);
    if (cached === 'error') {
      node.imageState = { src: object.src, status: 'error' };
      this.callbacks.onImageError(node.objectId, '图片无法加载');
      return;
    }
    if (cached && cached !== 'loading') {
      node.imageState = { src: object.src, status: 'loaded', texture: cached };
      return;
    }
    node.imageState = { src: object.src, status: 'pending' };
    // 已有其他节点在加载同一张图时直接返回，等它的回调统一通知
    if (this.imagePending.has(object.src)) return;
    this.imagePending.add(object.src);
    this.imageCache.set(object.src, 'loading');
    const loader = new THREE.TextureLoader();
    loader.load(
      object.src,
      (texture) => {
        // 图片是 sRGB 内容；三线性 mipmap 让缩小时不产生闪烁，倾斜观看更清晰
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = this.maxAnisotropy;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        this.imageCache.set(object.src, texture);
        this.imagePending.delete(object.src);
        // 通知所有正在等待同一 src 的节点：更新状态并重建内容
        for (const other of this.nodes.values()) {
          if (other.imageState?.src === object.src && other.imageState.status === 'pending') {
            other.imageState = { src: object.src, status: 'loaded', texture };
            other.visualKey = '';
            this.rebuildContent(other);
          }
        }
      },
      undefined,
      () => {
        this.imageCache.set(object.src, 'error');
        this.imagePending.delete(object.src);
        for (const other of this.nodes.values()) {
          if (other.imageState?.src === object.src && other.imageState.status === 'pending') {
            other.imageState = { src: object.src, status: 'error' };
            this.callbacks.onImageError(other.objectId, '图片无法加载');
            other.visualKey = '';
            this.rebuildContent(other);
          }
        }
      },
    );
  }

  /**
   * 重试对象的素材加载。
   * 会清掉该对象相关的缓存与运行时（媒体 / 模型 / SVG 纹理），然后强制重建内容；
   * 仅清理对应 src 的缓存条目，不影响其他对象共享的纹理。
   */
  retryImage(id: string) {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.media) this.disposeMedia(node);
    if (node.model) this.disposeModel(node);
    const src = node.imageState?.src;
    if (src) {
      // 只有失败与加载中状态需要清除；已成功的纹理可能被其他对象共享，保留缓存
      this.imageCache.delete(src);
      this.imagePending.delete(src);
    }
    const poster = node.posterState?.src;
    if (poster && this.posterCache.get(poster) === 'error') this.posterCache.delete(poster);
    if (node.svgTexture) {
      node.svgTexture.dispose();
      node.svgTexture = null;
    }
    // SVG 的源图 Promise 也一并失效，重试时会重新解码
    if (node.data.type === 'svg') this.svgImageCache.delete(node.data.src);
    // 清空状态后把 visualKey 置空，强制 rebuildContent 走完整重建流程
    node.imageState = null;
    node.posterState = null;
    node.visualKey = '';
    this.rebuildContent(node);
  }

  /** 视频 / Lottie 加载完成前，先用插入时保存的首帧截图作为占位纹理 */
  private ensurePoster(node: ObjectNode, src: string | undefined) {
    if (!src) {
      node.posterState = null;
      return;
    }
    // 海报 src 未变化时复用已有状态
    if (node.posterState?.src === src) return;
    const cached = this.posterCache.get(src);
    if (cached === 'error') {
      node.posterState = { src, status: 'error' };
      return;
    }
    if (cached && cached !== 'loading') {
      node.posterState = { src, status: 'loaded', texture: cached };
      return;
    }
    node.posterState = { src, status: 'pending' };
    // 海报与普通图片共用 imagePending，waitForAssets 会把它们一起等待
    if (cached === 'loading') return;
    this.posterCache.set(src, 'loading');
    this.imagePending.add(src);
    const loader = new THREE.TextureLoader();
    loader.load(
      src,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.anisotropy = this.maxAnisotropy;
        this.posterCache.set(src, texture);
        this.imagePending.delete(src);
        for (const other of this.nodes.values()) {
          if (other.posterState?.src === src && other.posterState.status === 'pending') {
            other.posterState = { src, status: 'loaded', texture };
            other.visualKey = '';
            this.rebuildContent(other);
          }
        }
      },
      undefined,
      () => {
        this.posterCache.set(src, 'error');
        this.imagePending.delete(src);
        for (const other of this.nodes.values()) {
          if (other.posterState?.src === src && other.posterState.status === 'pending') {
            other.posterState = { src, status: 'error' };
            other.visualKey = '';
            this.rebuildContent(other);
          }
        }
      },
    );
  }

  /** 矢量纹理允许的最大长边像素（限制显存占用） */
  private vectorMaxSide(): number {
    const max = this.renderer.capabilities.maxTextureSize || 4096;
    return Math.min(4096, max);
  }

  /**
   * Lottie 每帧都要重绘并整幅上传 GPU，像素量是主要开销（实测 1024→2048 后帧率约降至 1/4）。
   * 因此长边上限取三者最小值：
   * - 1536 硬上限（比 SVG 的 4096 保守，避免放大后整幅上传拖垮帧率）
   * - 物理视口长边（超出屏幕的像素看不到，没必要分配）
   * - 显卡最大纹理尺寸
   */
  private lottieMaxSide(): number {
    const viewportLong = Math.max(this.width, this.height) * this.renderer.getPixelRatio();
    return Math.min(1536, this.vectorMaxSide(), Math.max(512, Math.round(viewportLong)));
  }

  /** 按当前相机到对象的距离，计算该对象在屏幕上实际占用的像素长边 */
  private vectorTargetSide(object: {
    x: number;
    y: number;
    z: number;
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
  }): number {
    const cam = this.camera.position;
    const dx = object.x - cam.x;
    const dy = object.y - cam.y;
    const dz = object.z - cam.z;
    const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const physicalHeight = this.height * this.renderer.getPixelRatio();
    const visibleHeight = 2 * distance * Math.tan(((FOV / 2) * Math.PI) / 180);
    const projected = Math.max(1, object.width, object.height) * (physicalHeight / Math.max(1, visibleHeight));
    const natural = Math.max(object.naturalWidth || 0, object.naturalHeight || 0, 1);
    return Math.min(this.vectorMaxSide(), Math.max(projected, natural));
  }

  /** 把目标像素量化到档位，避免缩放过程中频繁重绘 */
  private vectorBucket(side: number): number {
    const step = 512;
    return Math.max(256, Math.min(this.vectorMaxSide(), Math.ceil(side / step) * step));
  }

  /** 按目标长边等比计算画布尺寸 */
  private fitVectorCanvas(side: number, naturalWidth: number, naturalHeight: number) {
    const target = Math.max(2, Math.min(this.vectorMaxSide(), Math.round(side)));
    const ratio = naturalWidth / naturalHeight || 1;
    if (ratio >= 1) {
      return { width: target, height: Math.max(2, Math.round(target / ratio)) };
    }
    return { width: Math.max(2, Math.round(target * ratio)), height: target };
  }

  /**
   * 安排一次矢量纹理刷新。
   * 多次调用只保留最后一个定时器（防抖），避免相机连续变化时排队执行大量重绘。
   */
  private scheduleVectorRefresh(delay = 220) {
    if (this.disposed) return;
    if (this.vectorTimer) window.clearTimeout(this.vectorTimer);
    this.vectorTimer = window.setTimeout(() => {
      this.vectorTimer = 0;
      this.refreshVectorTextures();
    }, delay);
  }

  /** 相机缩放稳定后，把 SVG / Lottie 重绘到与屏幕像素匹配的分辨率 */
  private refreshVectorTextures() {
    if (this.disposed) return;
    // 连续缩放中直接重绘会与手势抢主线程，等相机稳定后再做
    if (performance.now() - this.lastVectorChangeAt < 120) {
      this.scheduleVectorRefresh(220);
      return;
    }
    for (const node of this.nodes.values()) {
      if (!node.group.visible) continue;
      const object = node.data;
      if (object.type === 'svg') {
        if (this.vectorPending.has(node.objectId)) continue;
        if (!node.svgTexture && node.imageState?.status === 'error') continue;
        const target = this.vectorBucket(this.vectorTargetSide(object));
        const canvas = node.svgTexture?.image as HTMLCanvasElement | undefined;
        const current = canvas ? Math.max(canvas.width, canvas.height) : 0;
        if (current === 0 || target >= current * 1.4) {
          void this.rasterizeSvgNode(node, object, target);
        }
        continue;
      }
      if (object.type === 'lottie') this.resizeLottie(node, object);
    }
  }

  /**
   * 加载 SVG 原图并缓存 Promise。
   * 失败时 resolve(null) 而非 reject，调用方无需再包一层 catch。
   */
  private loadSvgImage(src: string): Promise<HTMLImageElement | null> {
    const cached = this.svgImageCache.get(src);
    if (cached) return cached;
    const pending = new Promise<HTMLImageElement | null>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = src;
    });
    this.svgImageCache.set(src, pending);
    return pending;
  }

  /** 确保 SVG 已按当前缩放栅格化；src 未变化时直接复用已有纹理 */
  private ensureSvg(node: ObjectNode, object: SvgObject) {
    if (node.imageState && node.imageState.src === object.src) return;
    node.imageState = { src: object.src, status: 'pending' };
    void this.rasterizeSvgNode(node, object, this.vectorBucket(this.vectorTargetSide(object)));
  }

  /** SVG 不经过 TextureLoader，直接按目标像素绘制到 canvas，保证任何缩放下都是矢量重采样 */
  private async rasterizeSvgNode(node: ObjectNode, object: SvgObject, side: number): Promise<void> {
    const key = node.objectId;
    // 同一节点同时只允许一个重绘任务，避免重复绘制大画布
    if (this.vectorPending.has(key)) return;
    const src = object.src;
    this.vectorPending.add(key);
    try {
      const image = await this.loadSvgImage(src);
      // 异步等待期间节点可能已被删除、替换或改成其他素材，需要逐项校验后再写回
      if (this.disposed || this.nodes.get(key) !== node) return;
      if (node.data.type !== 'svg' || node.data.src !== src) return;
      if (!image) {
        this.svgImageCache.delete(src);
        node.imageState = { src, status: 'error' };
        node.visualKey = '';
        this.rebuildContent(node);
        this.callbacks.onImageError(key, '图片无法加载');
        return;
      }
      // 优先使用 store 记录的原始尺寸，其次读取图片自身尺寸，最后退化为对象显示尺寸
      const naturalWidth = Math.max(1, object.naturalWidth || image.naturalWidth || object.width);
      const naturalHeight = Math.max(1, object.naturalHeight || image.naturalHeight || object.height);
      const { width, height } = this.fitVectorCanvas(side, naturalWidth, naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0, width, height);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.maxAnisotropy;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      // 先挂载新纹理再重建，旧纹理最后释放，替换过程不闪
      const previous = node.svgTexture;
      node.svgTexture = texture;
      node.imageState = { src, status: 'loaded', texture };
      node.visualKey = '';
      this.rebuildContent(node);
      previous?.dispose();
      // 重绘期间若又放大了，按最新缩放再补一档
      this.scheduleVectorRefresh(80);
    } finally {
      this.vectorPending.delete(key);
    }
  }

  /**
   * 构建图片 / SVG 内容。
   * contain：按比例把图片缩进对象框内；cover：克隆纹理并通过 repeat / offset 居中裁切。
   * 素材未就绪或加载失败时使用占位纹理，保证节点始终有可见内容。
   */
  private buildImage(group: THREE.Group, object: ImageObject | SvgObject, node: ObjectNode) {
    if (object.type === 'svg') {
      this.ensureSvg(node, object);
    } else {
      if (node.svgTexture) {
        node.svgTexture.dispose();
        node.svgTexture = null;
      }
      this.ensureImage(node, object);
    }
    const loaded = node.imageState?.status === 'loaded' && node.imageState.texture;
    let texture: THREE.Texture = this.placeholderTexture;
    let drawWidth = object.width;
    let drawHeight = object.height;
    let clone: THREE.Texture | null = null;

    if (loaded) {
      const source = node.imageState!.texture!;
      const imageAspect = object.naturalWidth / object.naturalHeight || 1;
      if (object.fit === 'contain') {
        // contain：保持图片比例，等比缩放到对象框内（可能留白）
        const boxAspect = object.width / object.height;
        if (imageAspect >= boxAspect) {
          drawWidth = object.width;
          drawHeight = object.width / imageAspect;
        } else {
          drawHeight = object.height;
          drawWidth = object.height * imageAspect;
        }
        texture = source;
      } else {
        // cover：直接复用共享纹理不能改 repeat，必须克隆一份给当前节点独占
        clone = source.clone();
        clone.needsUpdate = true;
        clone.wrapS = THREE.ClampToEdgeWrapping;
        clone.wrapT = THREE.ClampToEdgeWrapping;
        // 通过缩小 UV 采样范围并居中偏移，实现「填满对象框、超出部分裁掉」
        const boxAspect = object.width / object.height;
        if (imageAspect >= boxAspect) {
          const repeatX = boxAspect / imageAspect;
          clone.repeat.set(repeatX, 1);
          clone.offset.set((1 - repeatX) / 2, 0);
        } else {
          const repeatY = imageAspect / boxAspect;
          clone.repeat.set(1, repeatY);
          clone.offset.set(0, (1 - repeatY) / 2);
        }
        texture = clone;
        node.ownedTextures.push(clone);
      }
    }

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geometry = new THREE.PlaneGeometry(drawWidth, drawHeight);
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    node.materials.push(material);
  }

  /**
   * 构建形状内容。
   * 描边不是真正的线框，而是「先画放大一圈的底色面片、再叠一块略微前移的填充面片」模拟，
   * 代价低且在各种缩放下都稳定；path 与 line 走独立构建逻辑。
   */
  private buildShape(group: THREE.Group, object: ShapeObject, node: ObjectNode) {
    const strokeEnabled = object.stroke !== null && object.strokeWidth > 0;
    const strokeColor = object.stroke ?? object.fill;
    if (object.shape === 'path') {
      this.buildFreePath(group, object, node);
      return;
    }
    if (object.shape === 'line') {
      // 直线用圆头胶囊形，避免把切换类型后的对象画成一个大矩形
      const thickness = Math.max(1, object.strokeWidth || 6);
      const radius = thickness / 2;
      const half = Math.max(radius, object.width / 2);
      const shape = new THREE.Shape();
      shape.moveTo(-half + radius, -radius);
      shape.lineTo(half - radius, -radius);
      shape.absarc(half - radius, 0, radius, -Math.PI / 2, Math.PI / 2, false);
      shape.lineTo(-half + radius, radius);
      shape.absarc(-half + radius, 0, radius, Math.PI / 2, Math.PI * 1.5, false);
      const material = new THREE.MeshBasicMaterial({ color: strokeColor, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 16), material);
      group.add(mesh);
      node.materials.push(material);
      return;
    }
    if (object.shape !== 'rect' && object.shape !== 'ellipse') {
      this.buildPathShape(group, object, node);
      return;
    }
    if (object.shape === 'rect') {
      if (strokeEnabled && object.stroke) {
        // 外层铺描边色，内层缩小 strokeWidth*2 后铺填充色；z 轴微移避免共面深度冲突
        const strokeMaterial = new THREE.MeshBasicMaterial({ color: object.stroke, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), strokeMaterial));
        node.materials.push(strokeMaterial);
        const innerWidth = Math.max(1, object.width - object.strokeWidth * 2);
        const innerHeight = Math.max(1, object.height - object.strokeWidth * 2);
        const fillMaterial = new THREE.MeshBasicMaterial({ color: object.fill, side: THREE.DoubleSide });
        const fill = new THREE.Mesh(new THREE.PlaneGeometry(innerWidth, innerHeight), fillMaterial);
        fill.position.z = 0.05;
        group.add(fill);
        node.materials.push(fillMaterial);
      } else {
        const material = new THREE.MeshBasicMaterial({ color: object.fill, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), material));
        node.materials.push(material);
      }
      return;
    }
    // ellipse：用单位圆（半径 0.5）+ 非等比缩放得到椭圆，无需重建几何
    if (strokeEnabled && object.stroke) {
      const strokeMaterial = new THREE.MeshBasicMaterial({ color: object.stroke, side: THREE.DoubleSide });
      const outer = new THREE.Mesh(new THREE.CircleGeometry(0.5, 64), strokeMaterial);
      outer.scale.set(object.width, object.height, 1);
      group.add(outer);
      node.materials.push(strokeMaterial);
      const fillMaterial = new THREE.MeshBasicMaterial({ color: object.fill, side: THREE.DoubleSide });
      const inner = new THREE.Mesh(new THREE.CircleGeometry(0.5, 64), fillMaterial);
      inner.scale.set(
        Math.max(1, object.width - object.strokeWidth * 2),
        Math.max(1, object.height - object.strokeWidth * 2),
        1,
      );
      inner.position.z = 0.05;
      group.add(inner);
      node.materials.push(fillMaterial);
    } else {
      const material = new THREE.MeshBasicMaterial({ color: object.fill, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.5, 64), material);
      mesh.scale.set(object.width, object.height, 1);
      group.add(mesh);
      node.materials.push(material);
    }
  }

  /** 自由绘制路径：按归一化点生成带宽度的三角带网格 */
  private buildFreePath(group: THREE.Group, object: ShapeObject, node: ObjectNode) {
    const raw = object.points ?? [];
    if (raw.length < 4) return;
    const w = object.width;
    const h = object.height;
    const half = Math.max(1, object.strokeWidth) / 2;
    const points: THREE.Vector2[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      // 内容组已沿 X/Y 翻转，归一化画布坐标映射到局部坐标时需要同时取反 X
      const point = new THREE.Vector2(w / 2 - raw[i] * w, h / 2 - raw[i + 1] * h);
      const previous = points[points.length - 1];
      if (previous && previous.distanceTo(point) < 1.2) continue;
      points.push(point);
    }
    if (points.length < 2) return;
    // 用三次贝塞尔（Catmull-Rom 控制点）平滑手绘折线
    const smooth = sampleBezierPath(points, 6);
    const curve: THREE.Vector2[] = [];
    for (const point of smooth) {
      const previous = curve[curve.length - 1];
      if (previous && previous.distanceTo(point as THREE.Vector2) < 0.6) continue;
      curve.push(new THREE.Vector2(point.x, point.y));
    }
    if (curve.length < 2) return;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < curve.length; i += 1) {
      const current = curve[i];
      const previous = curve[Math.max(0, i - 1)];
      const next = curve[Math.min(curve.length - 1, i + 1)];
      const tangent = new THREE.Vector2().subVectors(next, previous);
      if (tangent.lengthSq() < 1e-6) tangent.set(1, 0);
      tangent.normalize();
      const normal = new THREE.Vector2(-tangent.y, tangent.x).multiplyScalar(half);
      positions.push(current.x + normal.x, current.y + normal.y, 0);
      positions.push(current.x - normal.x, current.y - normal.y, 0);
    }
    for (let i = 0; i < curve.length - 1; i += 1) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({
      color: object.stroke ?? object.fill,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    node.materials.push(material);
  }

  /**
   * 构建三角形 / 菱形 / 星形 / 箭头 / 圆角矩形等路径形状。
   * 基础图形都用 -0.5 ~ 0.5 的归一化坐标，再通过 scale 适配对象尺寸。
   */
  private buildPathShape(group: THREE.Group, object: ShapeObject, node: ObjectNode) {
    const geometry = new THREE.ShapeGeometry(this.makePathShape(object.shape), 24);
    const strokeEnabled = object.stroke !== null && object.strokeWidth > 0;
    if (strokeEnabled) {
      const strokeMaterial = new THREE.MeshBasicMaterial({ color: object.stroke!, side: THREE.DoubleSide });
      const outer = new THREE.Mesh(geometry, strokeMaterial);
      outer.scale.set(object.width + object.strokeWidth * 2, object.height + object.strokeWidth * 2, 1);
      group.add(outer);
      node.materials.push(strokeMaterial);
    }
    const fillMaterial = new THREE.MeshBasicMaterial({ color: object.fill, side: THREE.DoubleSide });
    const inner = new THREE.Mesh(geometry, fillMaterial);
    inner.scale.set(object.width, object.height, 1);
    inner.position.z = strokeEnabled ? 0.05 : 0;
    group.add(inner);
    node.materials.push(fillMaterial);
  }

  /** 生成各类形状的归一化路径（坐标系范围 -0.5 ~ 0.5，中心在原点） */
  private makePathShape(kind: ShapeKind): THREE.Shape {
    const shape = new THREE.Shape();
    if (kind === 'triangle') {
      shape.moveTo(0, 0.5);
      shape.lineTo(-0.5, -0.5);
      shape.lineTo(0.5, -0.5);
      shape.closePath();
      return shape;
    }
    if (kind === 'diamond') {
      shape.moveTo(0, 0.5);
      shape.lineTo(0.5, 0);
      shape.lineTo(0, -0.5);
      shape.lineTo(-0.5, 0);
      shape.closePath();
      return shape;
    }
    if (kind === 'star') {
      // 五角星：外/内半径交替 10 个顶点，从正上方开始每隔 36° 取一点
      const outer = 0.5;
      const inner = 0.22;
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 === 0 ? outer : inner;
        const angle = Math.PI / 2 + (i * Math.PI) / 5;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      }
      shape.closePath();
      return shape;
    }
    if (kind === 'arrow') {
      shape.moveTo(-0.5, -0.18);
      shape.lineTo(0.12, -0.18);
      shape.lineTo(0.12, -0.5);
      shape.lineTo(0.5, 0);
      shape.lineTo(0.12, 0.5);
      shape.lineTo(0.12, 0.18);
      shape.lineTo(-0.5, 0.18);
      shape.closePath();
      return shape;
    }
    if (kind === 'roundedRect') {
      const r = 0.16;
      shape.moveTo(-0.5 + r, -0.5);
      shape.lineTo(0.5 - r, -0.5);
      shape.quadraticCurveTo(0.5, -0.5, 0.5, -0.5 + r);
      shape.lineTo(0.5, 0.5 - r);
      shape.quadraticCurveTo(0.5, 0.5, 0.5 - r, 0.5);
      shape.lineTo(-0.5 + r, 0.5);
      shape.quadraticCurveTo(-0.5, 0.5, -0.5, 0.5 - r);
      shape.lineTo(-0.5, -0.5 + r);
      shape.quadraticCurveTo(-0.5, -0.5, -0.5 + r, -0.5);
      return shape;
    }
    shape.moveTo(-0.5, -0.5);
    shape.lineTo(0.5, -0.5);
    shape.lineTo(0.5, 0.5);
    shape.lineTo(-0.5, 0.5);
    shape.closePath();
    return shape;
  }

  /**
   * 确保 3D 模型已开始加载。
   * src 或格式变化时释放旧模型重新加载；异步完成后会校验节点是否仍归属当前对象，
   * 避免对象已删除或换素材时把过期模型挂进场景。
   */
  private ensureModel(node: ObjectNode, object: ModelObject) {
    const existing = node.model;
    if (existing && existing.src === object.src && existing.format === object.format) return;
    this.disposeModel(node);
    const runtime: ModelRuntime = {
      src: object.src,
      format: object.format,
      status: 'loading',
      group: null,
      animations: [],
      mixer: null,
    };
    node.model = runtime;
    if (!object.src) {
      runtime.status = 'error';
      runtime.error = '缺少模型素材';
      return;
    }
    void loadModelGroup(object.src, object.format, object.name)
      .then(({ group, animations }) => {
        // 加载期间节点可能被删除 / 换模型 / 场景已销毁：直接释放加载结果，避免资源泄漏
        if (this.nodes.get(node.objectId) !== node || node.model !== runtime || this.disposed) {
          disposeObject3D(group);
          return;
        }
        runtime.group = group;
        runtime.animations = animations;
        runtime.status = 'ready';
        // 模型自带动画全部自动播放，后续由 tick 每帧推进 mixer
        if (animations.length > 0) {
          runtime.mixer = new THREE.AnimationMixer(group);
          for (const clip of animations) runtime.mixer.clipAction(clip).play();
        }
        node.visualKey = '';
        this.rebuildContent(node);
      })
      .catch((error: unknown) => {
        if (node.model !== runtime) return;
        runtime.status = 'error';
        runtime.error = error instanceof Error ? error.message : '模型加载失败';
        this.callbacks.onImageError(node.objectId, `3D 模型无法加载：${runtime.error}`);
        node.visualKey = '';
        this.rebuildContent(node);
      });
  }

  /**
   * 释放模型运行时。
   * 先停止混合器并清理缓存，再释放模型的几何 / 材质 / 纹理，避免 mixer 持有已释放对象。
   */
  private disposeModel(node: ObjectNode) {
    const runtime = node.model;
    if (!runtime) return;
    node.model = null;
    if (runtime.mixer && runtime.group) {
      runtime.mixer.stopAllAction();
      runtime.mixer.uncacheRoot(runtime.group);
    }
    runtime.mixer = null;
    if (runtime.group) disposeObject3D(runtime.group);
  }

  /** 构建 Lottie 内容：就绪后使用动画画布纹理，加载中优先用封面，失败时用错误占位图 */
  private buildLottie(group: THREE.Group, object: LottieObject, node: ObjectNode) {
    this.ensureLottie(node, object);
    this.ensurePoster(node, object.poster);
    const runtime = node.lottie;
    if (runtime?.animation) {
      runtime.animation.setLoop(object.loop);
      runtime.animation.setSpeed(Math.max(0.1, object.speed || 1));
    }
    if (runtime?.status === 'ready' && runtime.texture) {
      const material = new THREE.MeshBasicMaterial({
        map: runtime.texture,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), material);
      group.add(mesh);
      node.materials.push(material);
      return;
    }
    // 动画加载完成前优先显示插入时保存的首帧截图
    const poster = node.posterState?.status === 'loaded' ? node.posterState.texture : null;
    const texture = poster ?? (runtime?.status === 'error' ? this.lottieErrorTexture : this.modelLoadingTexture);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), material);
    group.add(mesh);
    node.materials.push(material);
  }

  /**
   * 确保 Lottie 动画已初始化。
   * 先按当前缩放创建离屏画布与 CanvasTexture，再动态加载 lottie-web 并绑定到该画布上；
   * 动态 import 让 lottie 只在真正用到时进入主包，减小首屏体积。
   */
  private ensureLottie(node: ObjectNode, object: LottieObject) {
    const existing = node.lottie;
    if (existing && existing.src === object.src) return;
    this.disposeLottie(node);
    const runtime: LottieRuntime = {
      src: object.src,
      status: 'loading',
      canvas: null,
      texture: null,
      animation: null,
      rasterSide: 0,
      lastFrame: -1,
    };
    node.lottie = runtime;
    const data = parseLottieSource(object.src);
    if (!data) {
      runtime.status = 'error';
      runtime.error = 'Lottie 数据无法解析';
      this.callbacks.onImageError(node.objectId, 'Lottie 动画数据无法解析');
      return;
    }
    const naturalWidth = Math.max(1, object.naturalWidth || 800);
    const naturalHeight = Math.max(1, object.naturalHeight || 600);
    const side = Math.min(this.lottieMaxSide(), this.vectorBucket(this.vectorTargetSide(object)));
    const { width, height } = this.fitVectorCanvas(side, naturalWidth, naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    runtime.canvas = canvas;
    runtime.texture = texture;
    runtime.rasterSide = Math.max(width, height);

    void import('lottie-web')
      .then(({ default: lottie }) => {
        // 异步守卫：动画加载完成前节点可能已被删除或换素材
        if (this.nodes.get(node.objectId) !== node || node.lottie !== runtime || this.disposed) return;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建 Lottie 画布');
        const animation = lottie.loadAnimation<'canvas'>({
          renderer: 'canvas',
          loop: object.loop,
          autoplay: true,
          animationData: data,
          rendererSettings: {
            context,
            clearCanvas: true,
            preserveAspectRatio: 'xMidYMid meet',
          },
          // 不传 container：lottie-web 会忽略 context 并新建子 canvas，
          // 这里要让动画直接绘制到 CanvasTexture 使用的画布上。
        } as unknown as AnimationConfigWithData<'canvas'>);
        animation.setSpeed(Math.max(0.1, object.speed || 1));
        runtime.animation = animation;
        runtime.status = 'ready';
        node.visualKey = '';
        this.rebuildContent(node);
      })
      .catch((error: unknown) => {
        if (node.lottie !== runtime) return;
        runtime.status = 'error';
        runtime.error = error instanceof Error ? error.message : 'Lottie 加载失败';
        this.callbacks.onImageError(node.objectId, `Lottie 无法加载：${runtime.error}`);
        node.visualKey = '';
        this.rebuildContent(node);
      });
  }

  /**
   * 缩放稳定后按目标像素调整 Lottie 画布尺寸。
   * 直接复用当前 AnimationItem 与 CanvasTexture，不重新 import / loadAnimation，
   * 不重建元素树，也不会在缩放过程中反复创建大画布。
   */
  private resizeLottie(node: ObjectNode, object: LottieObject) {
    const runtime = node.lottie;
    if (!runtime || runtime.status !== 'ready' || !runtime.animation) return;
    const animation = runtime.animation;
    // 资源尚未加载完成时先不改画布，等就绪后再补一次
    if (!animation.isLoaded) {
      this.scheduleVectorRefresh(300);
      return;
    }
    const side = Math.min(this.lottieMaxSide(), this.vectorBucket(this.vectorTargetSide(object)));
    if (side < runtime.rasterSide * 1.4) return;
    const renderer = animation.renderer as
      | { updateContainerSize?: (width: number, height: number) => void; elements?: unknown[] }
      | null
      | undefined;
    const update = renderer?.updateContainerSize;
    if (!renderer || !update) return;
    const naturalWidth = Math.max(1, object.naturalWidth || 800);
    const naturalHeight = Math.max(1, object.naturalHeight || 600);
    const { width, height } = this.fitVectorCanvas(side, naturalWidth, naturalHeight);
    // 轨道遮罩层内部的缓冲画布按创建时的画布尺寸分配，需先同步尺寸再放大画布
    this.resizeLottieBuffers(renderer.elements, width, height);
    runtime.rasterSide = Math.max(width, height);
    update.call(renderer, width, height);
    // three 首次上传 CanvasTexture 时用 texStorage2D 固定了存储尺寸，
    // 画布变大后 texSubImage2D 会因尺寸不匹配而失败（画面冻结在 resize 前的帧），
    // 这里释放旧的 GPU 纹理，让下一帧按新尺寸重新分配并上传。
    if (runtime.texture) {
      runtime.texture.dispose();
      runtime.texture.needsUpdate = true;
    }
  }

  /** 同步 Lottie 轨道遮罩层内部缓冲画布的尺寸（canvas renderer 不会随画布缩放自动调整） */
  private resizeLottieBuffers(elements: unknown[] | undefined, width: number, height: number) {
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
      this.resizeLottieBuffers(element.elements, width, height);
    }
  }

  /** 释放 Lottie 运行时：销毁动画实例、释放纹理并断开画布引用 */
  private disposeLottie(node: ObjectNode) {
    const runtime = node.lottie;
    if (!runtime) return;
    node.lottie = null;
    if (runtime.animation) {
      runtime.animation.destroy();
      runtime.animation = null;
    }
    if (runtime.texture) runtime.texture.dispose();
    runtime.texture = null;
    runtime.canvas = null;
  }

  /** 构建 3D 模型内容：就绪后按对象较短边缩放模型，否则显示加载 / 错误占位图 */
  private buildModel(group: THREE.Group, object: ModelObject, node: ObjectNode) {
    this.ensureModel(node, object);
    const runtime = node.model;
    if (runtime && runtime.status === 'ready' && runtime.group) {
      // 模型以单位尺寸导入，按对象宽高较小值缩放，保证完整落在对象框内
      const scale = Math.min(object.width, object.height);
      runtime.group.scale.setScalar(scale);
      runtime.group.rotation.set(0, 0, 0);
      group.add(runtime.group);
      runtime.group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) {
          // 内容组沿 Y 轴镜像以匹配画布坐标，模型材质需要双面渲染避免被背面剔除
          material.side = THREE.DoubleSide;
          node.materials.push(material);
        }
      });
      return;
    }
    const texture =
      runtime?.status === 'error' ? this.modelErrorTexture : this.modelLoadingTexture;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), material);
    group.add(mesh);
    node.materials.push(material);
  }

  /** 封面裁切：与图片的 cover 逻辑一致，视频纹理按对象独占，可直接改 repeat */
  private applyCoverCrop(texture: THREE.Texture, imageAspect: number, boxAspect: number) {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    if (imageAspect >= boxAspect) {
      const repeatX = boxAspect / imageAspect;
      texture.repeat.set(repeatX, 1);
      texture.offset.set((1 - repeatX) / 2, 0);
    } else {
      const repeatY = imageAspect / boxAspect;
      texture.repeat.set(1, repeatY);
      texture.offset.set(0, (1 - repeatY) / 2);
    }
  }

  /**
   * 确保视频 / 音频运行时存在。
   * src 与类型未变化时只同步播放参数；否则释放旧元素并重新创建原生媒体元素。
   * 视频额外包装 VideoTexture，并在首帧解码完成后触发一次内容重建。
   */
  private ensureMedia(node: ObjectNode, object: VideoObject | AudioObject) {
    const existing = node.media;
    if (existing && existing.src === object.src && existing.kind === object.type) {
      this.applyMediaSettings(existing, object);
      return;
    }
    this.disposeMedia(node);
    const runtime: MediaRuntime = {
      kind: object.type,
      src: object.src,
      element: null,
      texture: null,
      error: false,
      ready: false,
    };
    node.media = runtime;
    if (!object.src) {
      runtime.error = true;
      return;
    }
    const handleError = () => {
      runtime.error = true;
      runtime.ready = false;
      this.callbacks.onImageError(node.objectId, object.type === 'video' ? '视频无法加载' : '音频无法加载');
      if (this.nodes.get(node.objectId) === node) {
        node.visualKey = '';
        this.rebuildContent(node);
      }
    };
    if (object.type === 'video') {
      const video = document.createElement('video');
      video.src = object.src;
      video.preload = 'auto';
      // playsInline 防止 iOS 自动进入全屏播放器
      video.playsInline = true;
      video.loop = object.loop;
      video.muted = object.muted;
      // store 中音量为 0 ~ 100，原生媒体元素需要 0 ~ 1
      video.volume = Math.max(0, Math.min(1, object.volume / 100));
      video.addEventListener('error', handleError);
      video.addEventListener('loadeddata', () => {
        // 首帧可用后占位卡换成真实视频画面
        runtime.ready = true;
        if (runtime.texture) runtime.texture.needsUpdate = true;
        if (this.nodes.get(node.objectId) === node) {
          node.visualKey = '';
          this.rebuildContent(node);
        }
      });
      video.addEventListener('seeked', () => {
        // 跳转后立即标记纹理更新，拖动进度条时画面能跟上
        if (runtime.texture) runtime.texture.needsUpdate = true;
      });
      video.load();
      // VideoTexture 每帧自动从视频元素取样；关闭 mipmap，避免为动态画面生成 mip 链的开销
      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.anisotropy = this.maxAnisotropy;
      runtime.texture = texture;
      runtime.element = video;
    } else {
      const audio = new Audio();
      audio.src = object.src;
      audio.preload = 'metadata';
      audio.loop = object.loop;
      audio.volume = Math.max(0, Math.min(1, object.volume / 100));
      audio.addEventListener('error', handleError);
      audio.load();
      runtime.element = audio;
    }
  }

  /** 把对象上的循环 / 音量 / 静音设置同步到原生媒体元素 */
  private applyMediaSettings(runtime: MediaRuntime, object: SlideObject) {
    const element = runtime.element;
    if (!element) return;
    if (object.type !== 'video' && object.type !== 'audio') return;
    element.loop = object.loop;
    element.volume = Math.max(0, Math.min(1, object.volume / 100));
    if (object.type === 'video') element.muted = object.muted;
  }

  /**
   * 释放媒体运行时。
   * 先 pause 并移除 src 再 load()，促使浏览器立即释放解码器与网络连接，
   * 否则频繁替换视频会持续占用内存。
   */
  private disposeMedia(node: ObjectNode) {
    const runtime = node.media;
    if (!runtime) return;
    node.media = null;
    if (runtime.element) {
      runtime.element.pause();
      runtime.element.removeAttribute('src');
      runtime.element.load();
      runtime.element = null;
    }
    if (runtime.texture) {
      runtime.texture.dispose();
      runtime.texture = null;
    }
  }

  /**
   * 构建视频内容。
   * 视频就绪后用 VideoTexture；未就绪时退回首帧封面，最后才用通用占位图。
   * cover 裁剪逻辑与图片一致，视频纹理为节点独占，可直接修改 repeat / offset。
   */
  private buildVideo(group: THREE.Group, object: VideoObject, node: ObjectNode) {
    this.ensureMedia(node, object);
    this.ensurePoster(node, object.poster);
    const runtime = node.media;
    const ready = Boolean(runtime && !runtime.error && runtime.ready && runtime.texture);
    let texture: THREE.Texture = this.placeholderTexture;
    let drawWidth = object.width;
    let drawHeight = object.height;
    const imageAspect = object.naturalWidth / object.naturalHeight || 16 / 9;
    const boxAspect = object.width / object.height || 1;
    const applyFit = (source: THREE.Texture) => {
      if (object.fit === 'contain') {
        if (imageAspect >= boxAspect) {
          drawWidth = object.width;
          drawHeight = object.width / imageAspect;
        } else {
          drawHeight = object.height;
          drawWidth = object.height * imageAspect;
        }
        return source;
      }
      const clone = source.clone();
      clone.needsUpdate = true;
      this.applyCoverCrop(clone, imageAspect, boxAspect);
      node.ownedTextures.push(clone);
      return clone;
    };
    if (ready && runtime?.texture) {
      // 每次重建先把共享的 VideoTexture 复位，再按当前 fit 重新裁剪
      const source = runtime.texture;
      source.repeat.set(1, 1);
      source.offset.set(0, 0);
      source.wrapS = THREE.ClampToEdgeWrapping;
      source.wrapT = THREE.ClampToEdgeWrapping;
      texture = applyFit(source);
    } else if (node.posterState?.status === 'loaded' && node.posterState.texture) {
      // 视频解码完成前用插入时保存的首帧截图，避免露出占位卡
      texture = applyFit(node.posterState.texture);
    }
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(drawWidth, drawHeight), material);
    group.add(mesh);
    node.materials.push(material);
  }

  /**
   * 为音频对象绘制一张卡片纹理（播放图标 + 名称 + 伪波形条），
   * 让音频在画面上有可见的占位表现；卡片纹理由节点独占。
   */
  private createAudioCard(object: AudioObject, node: ObjectNode): THREE.CanvasTexture {
    const canvasWidth = 1024;
    const ratio = object.height / object.width || 0.3;
    const canvasHeight = Math.max(96, Math.min(1024, Math.round(canvasWidth * ratio)));
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#111A24';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.strokeStyle = 'rgba(45,212,191,.5)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, canvasWidth - 4, canvasHeight - 4);

    const cy = canvasHeight / 2;
    const radius = Math.min(canvasHeight * 0.3, 90);
    const cx = radius + Math.min(canvasHeight * 0.14, 32);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(45,212,191,.14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(45,212,191,.7)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#2DD4BF';
    ctx.beginPath();
    ctx.moveTo(cx - radius * 0.22, cy - radius * 0.36);
    ctx.lineTo(cx + radius * 0.42, cy);
    ctx.lineTo(cx - radius * 0.22, cy + radius * 0.36);
    ctx.closePath();
    ctx.fill();

    const textLeft = cx + radius + Math.min(canvasHeight * 0.12, 26);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#F3EEE4';
    const nameSize = Math.max(18, Math.round(canvasHeight * 0.2));
    ctx.font = `500 ${nameSize}px "PingFang SC","Microsoft YaHei",sans-serif`;
    const name = object.name.length > 18 ? `${object.name.slice(0, 18)}…` : object.name;
    ctx.fillText(name, textLeft, cy - 4);
    ctx.fillStyle = 'rgba(201,210,223,.6)';
    const metaSize = Math.max(14, Math.round(canvasHeight * 0.15));
    ctx.font = `400 ${metaSize}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.fillText('音频素材', textLeft, cy + metaSize + 8);

    const barCount = Math.max(8, Math.floor((canvasWidth - textLeft) / (canvasHeight * 0.13)));
    const barWidth = canvasHeight * 0.055;
    const gap = canvasHeight * 0.075;
    const startX = canvasWidth - 24 - barCount * (barWidth + gap);
    const maxBar = canvasHeight * 0.34;
    for (let i = 0; i < barCount; i += 1) {
      const wave = 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + 0.6));
      const height = maxBar * wave;
      ctx.fillStyle = `rgba(45,212,191,${0.28 + 0.32 * wave})`;
      ctx.fillRect(startX + i * (barWidth + gap), cy - height / 2, barWidth, height);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = this.maxAnisotropy;
    node.ownedTextures.push(texture);
    return texture;
  }

  /** 构建音频内容：加载失败时显示占位图，否则绘制音频卡片纹理 */
  private buildAudio(group: THREE.Group, object: AudioObject, node: ObjectNode) {
    this.ensureMedia(node, object);
    const texture = node.media?.error ? this.placeholderTexture : this.createAudioCard(object, node);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), material);
    group.add(mesh);
    node.materials.push(material);
  }

  /**
   * 读取媒体播放状态快照。
   * 原生元素的 duration 在元数据加载前为 NaN，此时回退到对象上保存的时长。
   */
  getMediaState(id: string): MediaPlaybackState | null {
    const node = this.nodes.get(id);
    const runtime = node?.media;
    if (!node || !runtime) return null;
    const object = node.data;
    if (object.type !== 'video' && object.type !== 'audio') return null;
    const element = runtime.element;
    const duration = element && Number.isFinite(element.duration) && element.duration > 0
      ? element.duration
      : object.duration;
    return {
      kind: runtime.kind,
      playing: element ? !element.paused && !element.ended : false,
      time: element ? element.currentTime : 0,
      duration: Math.max(0, duration || 0),
      volume: element ? Math.round(element.volume * 100) : object.volume,
      muted: element ? element.muted : false,
      loop: object.loop,
      error: runtime.error,
    };
  }

  /**
   * 播放指定媒体。
   * 浏览器的播放 Promise 可能因自动播放策略被拒绝，这里吞掉异常，
   * 避免产生未处理的 Promise rejection。
   */
  playMedia(id: string) {
    const element = this.nodes.get(id)?.media?.element;
    if (!element) return;
    const result = element.play();
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  }

  /** 手动暂停指定媒体，并把它移出「因离开视野而自动暂停」名单 */
  pauseMedia(id: string) {
    this.mediaAutoPaused.delete(id);
    this.nodes.get(id)?.media?.element?.pause();
  }

  /** 在播放 / 暂停之间切换；播放走 playMedia 以统一处理自动播放失败 */
  toggleMedia(id: string) {
    const element = this.nodes.get(id)?.media?.element;
    if (!element) return;
    if (element.paused) this.playMedia(id);
    else {
      this.mediaAutoPaused.delete(id);
      element.pause();
    }
  }

  /** 跳转播放进度（秒），自动裁剪到 [0, duration]；视频纹理立即标记更新 */
  seekMedia(id: string, time: number) {
    const element = this.nodes.get(id)?.media?.element;
    if (!element) return;
    const duration = Number.isFinite(element.duration) ? element.duration : 0;
    element.currentTime = Math.max(0, duration > 0 ? Math.min(duration, time) : time);
    const texture = this.nodes.get(id)?.media?.texture;
    if (texture) texture.needsUpdate = true;
  }

  /** 设置媒体音量（百分比 0 ~ 100）；从静音状态调大音量时自动取消静音 */
  setMediaVolume(id: string, volume: number) {
    const runtime = this.nodes.get(id)?.media;
    const element = runtime?.element;
    if (!element) return;
    element.volume = Math.max(0, Math.min(1, volume / 100));
    if (element.volume > 0 && element.muted) element.muted = false;
  }

  /** 设置媒体是否静音；音频与视频都生效 */
  setMediaMuted(id: string, muted: boolean) {
    const element = this.nodes.get(id)?.media?.element;
    if (element) element.muted = muted;
  }

  /** 暂停全部媒体，并清空自动暂停名单（离开演示模式时调用） */
  private pauseAllMedia() {
    this.mediaAutoPaused.clear();
    for (const node of this.nodes.values()) node.media?.element?.pause();
  }

  /** 预览时检测相机视锥：离开视野的音视频自动暂停，回到视野后恢复 */
  private updateMediaVisibility(now: number) {
    if (this.mode !== 'present') return;
    if (now - this.mediaVisibilityAt < 140) return;
    this.mediaVisibilityAt = now;
    this.camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse),
    );
    const sphere = new THREE.Sphere();
    for (const node of this.nodes.values()) {
      const element = node.media?.element;
      if (!element) continue;
      const object = node.data;
      if (object.type !== 'video' && object.type !== 'audio') continue;
      node.group.getWorldPosition(sphere.center);
      sphere.radius = Math.max(object.width, object.height) / 2;
      const inView = frustum.intersectsSphere(sphere);
      if (!inView && !element.paused) {
        element.pause();
        this.mediaAutoPaused.add(node.objectId);
      } else if (inView && this.mediaAutoPaused.has(node.objectId)) {
        this.mediaAutoPaused.delete(node.objectId);
        this.playMedia(node.objectId);
      }
    }
  }

  /**
   * 处理模式切换对媒体的影响。
   * 进入演示模式时，为可见且标记了 autoplay 的对象发起播放；
   * 离开演示模式时统一暂停，并解除自动播放标记，便于下次重新进入时再次触发。
   */
  private handleModeMedia(previousMode: StageMode, mode: StageMode) {
    if (mode !== 'present') {
      this.mediaAutoplayArmed = false;
      if (previousMode === 'present') this.pauseAllMedia();
      return;
    }
    // 同一轮演示只自动播放一次，避免拖拽 / 同步时反复触发 play
    if (this.mediaAutoplayArmed) return;
    this.mediaAutoplayArmed = true;
    for (const node of this.nodes.values()) {
      const object = node.data;
      if (!object.visible) continue;
      if ((object.type === 'video' || object.type === 'audio') && object.autoplay) {
        this.playMedia(node.objectId);
      }
    }
  }

  /**
   * 从场景移除节点并释放其全部资源。
   * 顺序：先释放媒体 / 模型 / Lottie 等运行时，再清理内容与选中框几何，
   * 最后从父节点摘除，避免释放过程中仍有对象引用已销毁的材质。
   */
  private removeNode(node: ObjectNode) {
    this.disposeMedia(node);
    this.disposeModel(node);
    this.disposeLottie(node);
    if (node.svgTexture) {
      node.svgTexture.dispose();
      node.svgTexture = null;
    }
    this.clearContent(node);
    node.group.remove(node.outline);
    node.outline.geometry.dispose();
    node.group.remove(node.handles);
    node.handles.geometry.dispose();
    this.objectsRoot.remove(node.group);
  }

  /**
   * 应用视角：把 ViewState 换算成相机位置并朝向目标点。
   * 相机矩阵立即更新，保证同一帧内的拾取 / 投影计算使用的是最新位置。
   */
  private applyView(view: ViewState) {
    this.view = view;
    // 极坐标换算的具体逻辑在 lib/camera，渲染层只消费结果
    const camera = cameraPosition(view);
    this.camera.position.set(camera.x, camera.y, camera.z);
    this.camera.up.set(0, -1, 0);
    this.camera.lookAt(view.target.x, view.target.y, view.target.z);
    this.camera.updateMatrixWorld();
    // 视角变化会改变网格适配的步长与中心，标脏等待下一帧重建
    this.gridDirty();
  }

  /** 标记网格为脏；下一次 updateGrid 会按新视角重建几何 */
  private gridDirty() {
    this.gridKey = '';
  }

  /**
   * 把一个任意步长取整到「1 / 2 / 5 × 10^n」的易读刻度。
   * 例如 37 -> 50、160 -> 200，保证网格间距始终是适合阅读的整数。
   */
  private niceStep(raw: number): number {
    const exponent = Math.floor(Math.log10(Math.max(raw, 0.001)));
    const base = Math.pow(10, exponent);
    const n = raw / base;
    const factor = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return factor * base;
  }

  /** 当前视角下每个屏幕 CSS 像素对应的世界单位长度，用于平移与网格密度换算 */
  private unitsPerPixel(): number {
    const visibleHeight = 2 * this.view.distance * Math.tan((FOV / 2) * (Math.PI / 180));
    return visibleHeight / this.height;
  }

  /**
   * 按当前视角维护参考网格。
   * 网格只用于编辑模式；步长随缩放自适应，并在缓存键未变化时跳过重建。
   */
  private updateGrid() {
    if (!this.showGrid || this.mode !== 'edit') {
      if (this.grid) this.grid.visible = false;
      return;
    }
    // 以「56 像素」为期望间距换算出世界步长，再取整为易读刻度
    const upp = this.unitsPerPixel();
    const step = this.niceStep(upp * 56);
    const centerX = Math.round(this.view.target.x / step) * step;
    const centerY = Math.round(this.view.target.y / step) * step;
    const z = this.view.target.z;
    // 只有步长 / 中心 / z 真正变化时才重建；纯旋转视角复用已有网格
    const key = `${step}|${centerX}|${centerY}|${z.toFixed(1)}`;
    if (key === this.gridKey && this.grid) {
      this.grid.visible = true;
      return;
    }
    this.gridKey = key;
    // 重建前必须释放旧几何与材质，否则每帧拖动都会累积显存
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const range = step * 44;
    const positions: number[] = [];
    const colors: number[] = [];
    const minorColor = new THREE.Color(0x34485c);
    const majorColor = new THREE.Color(0x55708a);
    const steps = Math.round(range / step);
    for (let i = -steps; i <= steps; i += 1) {
      // 跳过中心线，避免与坐标轴 / 画板中心重叠
      if (i === 0) continue;
      const offset = i * step;
      // 每 5 格一条主网格线，用更亮的颜色帮助估算距离
      const isMajor = i % 5 === 0;
      const color = isMajor ? majorColor : minorColor;
      positions.push(centerX - range, centerY + offset, z, centerX + range, centerY + offset, z);
      positions.push(centerX + offset, centerY - range, z, centerX + offset, centerY + range, z);
      for (let k = 0; k < 4; k += 1) colors.push(color.r, color.g, color.b);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = -10;
    this.scene.add(lines);
    this.grid = lines;
    this.grid.visible = true;
  }

  /**
   * 渲染循环入口（由 renderer.setAnimationLoop 每帧调用）。
   * 依次处理：Lottie 纹理上传、模型动画与自动旋转、相机补间、矢量纹理刷新、
   * 媒体可见性、网格更新，最后执行一次渲染。
   */
  private tick(now: number) {
    if (this.disposed) return;
    // dt 上限 60ms：切后台再回来时避免动画一次性跳过大段时间（例如模型瞬移）
    const dt = Math.min(0.06, Math.max(0, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;
    for (const node of this.nodes.values()) {
      const lottie = node.lottie;
      if (lottie?.texture && node.group.visible) {
        // 仅当 Lottie 画出了新的一帧才整幅上传 GPU：
        // 动画暂停/结束或渲染循环与动画帧不同步时，避免重复上传大画布。
        const frame = lottie.animation ? lottie.animation.currentFrame : -1;
        if (frame !== lottie.lastFrame) {
          lottie.lastFrame = frame;
          lottie.texture.needsUpdate = true;
        }
      }
      const runtime = node.model;
      const object = node.data;
      if (!runtime || runtime.status !== 'ready' || !runtime.group) continue;
      if (runtime.mixer) runtime.mixer.update(dt);
      if (object.type !== 'model' || !object.autoRotate) continue;
      // 自动旋转速度单位为「度/秒」，这里换算成弧度并按帧间隔累加
      runtime.group.rotation.y += ((object.rotateSpeed || 0) * Math.PI / 180) * dt;
    }
    if (this.animation) {
      const { from, to, start, duration, resolve } = this.animation;
      // 归一化进度 t 限制在 0 ~ 1，缓动函数为三次 ease-in-out：
      // 前半段加速、后半段减速，运镜更自然且首尾速度为 0。
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.applyView(lerpView(from, to, eased));
      if (t >= 1) {
        // 到达终点后精确落到目标值（避免插值误差），并结算飞行的 Promise
        this.animation = null;
        this.applyView(to);
        resolve();
      }
    }
    // 相机距离变化超过 0.5 个世界单位才认为在缩放，避免微小抖动触发矢量重绘
    if (Math.abs(this.view.distance - this.lastVectorDistance) > 0.5) {
      this.lastVectorDistance = this.view.distance;
      this.lastVectorChangeAt = performance.now();
      this.scheduleVectorRefresh();
    }
    this.updateMediaVisibility(now);
    this.updateGrid();
    this.renderFrame();
  }

  /** 渲染当前帧：鱼眼走离屏后处理，其余直接渲染（XR 由 WebXR 接管） */
  private renderFrame() {
    if (this.xrActive) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.lensEffect !== 'fisheye') {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.ensureLens();
    if (!this.lensTarget || !this.lensScene || !this.lensCamera) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // 第一遍把场景渲到离屏目标；clear 避免沿用上一帧的残留内容
    this.renderer.setRenderTarget(this.lensTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // 第二遍切回屏幕缓冲，用全屏四边形对离屏纹理做鱼眼畸变后输出
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.lensScene, this.lensCamera);
  }

  /**
   * 平滑飞行到目标视角。
   * 若已有动画在进行，会先结算其 Promise 再启动新动画（同一时刻只保留最新目标）。
   *
   * @param view 目标视角
   * @param duration 动画时长（秒），<= 0.001 时直接跳转
   * @returns 动画结束或被中断时 resolve 的 Promise
   */
  flyTo(view: ViewState, duration = 0.4): Promise<void> {
    if (this.animation) {
      this.animation.resolve();
      this.animation = null;
    }
    if (duration <= 0.001) {
      this.applyView(view);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      // 记录起点 / 终点快照，动画过程中只读取这份数据，不受后续 store 变更影响
      this.animation = {
        from: this.getView(),
        to: { ...view, target: { ...view.target } },
        start: performance.now(),
        duration: duration * 1000,
        resolve,
      };
    });
  }

  /** 是否正在进行相机飞行动画；交互层可据此忽略拖拽，避免与动画抢相机 */
  isAnimating(): boolean {
    return this.animation !== null;
  }

  /**
   * 把客户端坐标换算为归一化设备坐标（NDC）。
   * NDC 范围为 [-1, 1]，原点在画布中心，Y 轴与屏幕坐标相反。
   */
  private pointerNdc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /**
   * 射线拾取：返回屏幕坐标下最上层命中的对象 id。
   * 用射线与所有内容根节点求交，命中后沿父链查找 nodeRoot 标记反查对象 id。
   */
  hitTest(clientX: number, clientY: number): string | null {
    const roots = this.pickRoots();
    if (roots.length === 0) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(this.pointerNdc(clientX, clientY), this.camera);
    // intersectObjects 默认按距离排序，第一个命中即视觉上最前面的对象
    const hits = raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      let current: THREE.Object3D | null = hit.object;
      while (current) {
        if (current.userData.nodeRoot) return current.userData.objectId as string;
        current = current.parent;
      }
      // 兜底：内容组内部直接带有 objectId 时也能命中
      const id = hit.object.userData.objectId as string | undefined;
      if (id) return id;
    }
    return null;
  }

  /**
   * 把屏幕坐标投影到指定 z 值的水平平面上，返回世界坐标。
   * 用于拖拽对象时把鼠标位移换算为世界位移；射线与平面平行或反向时回退到目标点。
   */
  screenToWorldOnPlane(clientX: number, clientY: number, z: number): { x: number; y: number } {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(this.pointerNdc(clientX, clientY), this.camera);
    // 平面方程 n·p + constant = 0：法线 (0,0,1)、常量 -z 即平面 z = z
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
    const point = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, point)) {
      return { x: point.x, y: point.y };
    }
    return { x: this.view.target.x, y: this.view.target.y };
  }

  /**
   * 计算对象四角在画布坐标系中的位置（CSS 像素）。
   * 用于判断鼠标是否落在缩放点上；返回的是画布内坐标，不是客户端坐标。
   */
  private cornerScreens(node: ObjectNode): { corner: HandleCorner; x: number; y: number }[] {
    const object = node.data;
    // 手动更新世界矩阵，保证对象刚被移动时投影使用的是最新位置
    node.group.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    const corners: { corner: HandleCorner; x: number; y: number }[] = [
      { corner: 'nw', x: -object.width / 2, y: -object.height / 2 },
      { corner: 'ne', x: object.width / 2, y: -object.height / 2 },
      { corner: 'se', x: object.width / 2, y: object.height / 2 },
      { corner: 'sw', x: -object.width / 2, y: object.height / 2 },
    ];
    return corners.map((corner) => {
      // 局部坐标 -> 世界坐标 -> NDC -> 画布像素
      const world = node.group.localToWorld(new THREE.Vector3(corner.x, corner.y, 0));
      const projected = world.clone().project(this.camera);
      return {
        corner: corner.corner,
        x: ((projected.x + 1) / 2) * this.width,
        y: ((1 - projected.y) / 2) * this.height,
      };
    });
  }

  /** 命中主选中对象的四角缩放点，返回画布坐标下的角点 */
  hitTestHandle(clientX: number, clientY: number): { id: string; corner: HandleCorner } | null {
    if (this.mode !== 'edit') return null;
    const primary = this.selectedIds[0];
    const node = primary ? this.nodes.get(primary) : null;
    if (!node) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    for (const point of this.cornerScreens(node)) {
      // 12px 是缩放点的命中半径（约为四角缩放点视觉直径），略微放大便于鼠标点中
      if (Math.hypot(point.x - px, point.y - py) <= 12) {
        return { id: node.objectId, corner: point.corner };
      }
    }
    return null;
  }

  /** 框选：返回投影包围盒与矩形相交的对象 */
  hitTestRect(left: number, top: number, width: number, height: number): string[] {
    const right = left + width;
    const bottom = top + height;
    const ids: string[] = [];
    for (const node of this.nodes.values()) {
      const projected = this.projectRect(node.objectId);
      if (!projected) continue;
      if (
        projected.left < right &&
        projected.left + projected.width > left &&
        projected.top < bottom &&
        projected.top + projected.height > top
      ) {
        ids.push(node.objectId);
      }
    }
    return ids;
  }

  /**
   * 按屏幕位移平移相机目标点（抓手拖动画布）。
   * 位移按当前像素尺度换算成世界单位，并沿相机的右 / 下方向分解。
   * 相机飞行中忽略平移，避免两套逻辑同时改视角。
   */
  panBy(dx: number, dy: number) {
    if (this.animation) return;
    // 相机世界矩阵的第 0 列是右方向，第 1 列是 up（此处为 -Y），取反得到屏幕向下
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const down = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).negate();
    const upp = this.unitsPerPixel();
    const view = this.getView();
    view.target.x += -dx * upp * right.x + -dy * upp * down.x;
    view.target.y += -dx * upp * right.y + -dy * upp * down.y;
    view.target.z += -dx * upp * right.z + -dy * upp * down.z;
    this.applyView(view);
  }

  /**
   * 按屏幕位移环绕旋转视角。
   * 0.007 为拖动灵敏度（弧度/像素）；pitch 会裁剪到合法范围，防止翻转越过极点。
   */
  orbitBy(dx: number, dy: number) {
    if (this.animation) return;
    const view = this.getView();
    // camera.up 为 (0, -1, 0)、屏幕右为世界 -X：正方向拖动才与画面同向旋转
    view.yaw += dx * 0.007;
    view.pitch = clampPitch(view.pitch + dy * 0.007);
    this.applyView(view);
  }

  /**
   * 以鼠标位置为锚点缩放。
   * 先记录缩放前锚点对应的世界坐标，改变距离后再次求交，
   * 用两次结果的差值反向修正目标点，使鼠标下的内容保持不动。
   *
   * @param factor 缩放倍数（>1 拉远，<1 拉近）
   * @param min / max 距离限制
   */
  zoomAt(clientX: number, clientY: number, factor: number, min: number, max: number) {
    if (this.animation) return;
    const oldView = this.getView();
    const newDistance = Math.max(min, Math.min(max, oldView.distance * factor));
    // 距离几乎没变化时直接返回，避免无意义的重复投影计算
    if (Math.abs(newDistance - oldView.distance) < 0.001) return;
    const z = oldView.target.z;
    const before = this.screenToWorldOnPlane(clientX, clientY, z);
    const next = this.getView();
    next.distance = newDistance;
    this.applyView(next);
    const after = this.screenToWorldOnPlane(clientX, clientY, z);
    // 锚点位移补偿：让缩放前后鼠标指向的世界点保持一致
    next.target.x += before.x - after.x;
    next.target.y += before.y - after.y;
    this.applyView(next);
  }

  /** 空间漫游：以视点朝向为基准移动，保持当前朝向与距离 */
  roamStep(forward: number, right: number, up: number, dt: number) {
    // 仅在演示模式且没有相机补间时响应，避免与自动运镜抢占视角
    if (this.mode !== 'present' || this.animation) return;
    const view = this.getView();
    // 由 yaw / pitch 还原单位前向向量 (fx, fy, fz)：Y 轴向下，故 pitch 为正时 fy 为正
    const cp = Math.cos(view.pitch);
    const fx = -Math.sin(view.yaw) * cp;
    const fy = Math.sin(view.pitch);
    const fz = -Math.cos(view.yaw) * cp;
    // 右向向量只在水平面内，与相机 up=(0,-1,0) 的约定配套
    const rx = -Math.cos(view.yaw);
    const rz = Math.sin(view.yaw);
    // 移动速度与相机距离成正比，保证远处漫游时观感一致；至少保留 180 单位/秒的基础速度
    const speed = Math.max(view.distance * 1.25, 180);
    // dt 上限 0.1 秒，防止页面切后台后单帧跨越过大距离
    const distance = speed * Math.max(0, Math.min(0.1, dt));
    // 漫游改变的是观察目标点而不是相机本身，因此朝向与距离保持不变
    view.target.x += (fx * forward + rx * right) * distance;
    view.target.y += (fy * forward - up) * distance;
    view.target.z += (fz * forward + rz * right) * distance;
    this.applyView(view);
  }

  /**
   * 把对象的世界包围盒投影到屏幕空间，返回覆盖该对象的轴对齐矩形。
   *
   * 用途：框选命中判定，以及上层把 HTML 文本层 / 编辑浮层对齐到 3D 文字的位置。
   * 坐标单位为画布 CSS 像素（左上角为原点），与指针事件坐标一致。
   * 另外按「每世界单位对应多少屏幕像素」换算出字号、行高与内边距，
   * 保证浮层文字与 3D 文字在任意相机距离下都保持视觉一致。
   *
   * @returns 对象不存在时返回 null；宽高至少为 1，避免退化成零尺寸
   */
  projectRect(objectId: string): {
    left: number;
    top: number;
    width: number;
    height: number;
    fontPx: number;
    lineHeightPx: number;
    paddingTop: number;
  } | null {
    const node = this.nodes.get(objectId);
    if (!node) return null;
    const object = node.data;
    // 投影前强制刷新世界矩阵，避免用到上一次 sync 时的旧变换
    node.group.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    // 对象局部坐标系中的四个角（原点位于对象中心，Y 轴向下）
    const corners = [
      new THREE.Vector3(-object.width / 2, -object.height / 2, 0),
      new THREE.Vector3(object.width / 2, -object.height / 2, 0),
      new THREE.Vector3(object.width / 2, object.height / 2, 0),
      new THREE.Vector3(-object.width / 2, object.height / 2, 0),
    ];
    // 局部坐标 -> 世界坐标 -> NDC -> 画布像素坐标（NDC 的 y 向上，画布 y 向下，需翻转）
    const toScreen = (vector: THREE.Vector3) => {
      const world = node.group.localToWorld(vector.clone());
      const projected = world.clone().project(this.camera);
      return {
        x: ((projected.x + 1) / 2) * this.width,
        y: ((1 - projected.y) / 2) * this.height,
      };
    };
    const points = corners.map(toScreen);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    // 对象带旋转时投影四角并非轴对齐矩形，取外接矩形保证完整覆盖
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const width = Math.max(1, Math.max(...xs) - left);
    const height = Math.max(1, Math.max(...ys) - top);
    // 取对象底边处 1 个世界单位的竖直投影长度，得到像素 / 世界单位的换算比例
    const unitTop = toScreen(new THREE.Vector3(0, -object.height / 2, 0));
    const unitBottom = toScreen(new THREE.Vector3(0, -object.height / 2 + 1, 0));
    const pixelsPerUnit = Math.abs(unitBottom.y - unitTop.y);
    // 字号按世界单位下的 fontSize 换算；非文本对象按 48 号字估算浮层排版
    return {
      left,
      top,
      width,
      height,
      fontPx: pixelsPerUnit * (object.type === 'text' ? (object as TextObject).fontSize : 48),
      lineHeightPx: pixelsPerUnit * (object.type === 'text' ? (object as TextObject).fontSize * (object as TextObject).lineHeight : 48),
      paddingTop: pixelsPerUnit * 0.3 * (object.type === 'text' ? (object as TextObject).fontSize : 48),
    };
  }

  /**
   * 销毁场景管理器：停止渲染循环并释放全部 GPU / 媒体资源。
   *
   * 组件卸载时必须调用；执行后实例不可复用（disposed 置位后所有异步回调直接返回）。
   * 释放顺序遵循「先停循环、再拆结构、最后释放共享资源」：
   * 1. 停掉动画循环与延迟刷新定时器，避免释放过程中仍有代码触碰资源；
   * 2. 还原 XR 层级、结算未完成的相机补间 Promise；
   * 3. 逐个节点走 removeNode，由它统一释放模型 / 媒体 / Lottie / 纹理；
   * 4. 释放网格、缓存纹理、星空、坐标轴等场景级资源；
   * 5. 释放共享材质与渲染器，并移除 canvas 元素。
   * 上述步骤均对空值做了判断，重复调用不会抛错。
   */
  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    // 清掉尚未执行的矢量重绘定时器，否则回调会在销毁后继续访问画布
    if (this.vectorTimer) {
      window.clearTimeout(this.vectorTimer);
      this.vectorTimer = 0;
    }
    this.vectorPending.clear();
    this.svgImageCache.clear();
    // 鱼眼后处理使用的离屏目标与全屏材质
    if (this.lensTarget) this.lensTarget.dispose();
    if (this.lensMaterial) this.lensMaterial.dispose();
    // 未处于 XR 会话时，把对象根组从 XR rig 搬回主场景，再摘掉 rig
    if (!this.xrActive && this.xrRig) {
      this.xrRig.remove(this.objectsRoot);
      this.scene.add(this.objectsRoot);
      this.scene.remove(this.xrRig);
      this.xrRig = null;
    }
    // 结算未完成的相机补间，避免 flyTo 的 await 永远挂起
    if (this.animation) {
      this.animation.resolve();
      this.animation = null;
    }
    // 节点自己持有媒体元素、模型、Lottie 实例与纹理，统一交给 removeNode 释放
    for (const node of this.nodes.values()) this.removeNode(node);
    this.nodes.clear();
    if (this.grid) {
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
    // 纹理缓存可能被多个节点共享，须在节点释放之后才能 dispose
    for (const entry of this.imageCache.values()) {
      if (typeof entry !== 'string') entry.dispose();
    }
    this.imageCache.clear();
    for (const entry of this.posterCache.values()) {
      if (typeof entry !== 'string') entry.dispose();
    }
    this.posterCache.clear();
    if (this.stars) {
      this.scene.remove(this.stars);
      this.stars.geometry.dispose();
      (this.stars.material as THREE.Material).dispose();
      this.stars = null;
    }
    // 坐标轴由多个网格 / 精灵组成，需遍历逐个释放几何与材质
    if (this.axes) {
      this.scene.remove(this.axes);
      this.axes.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else if (material) material.dispose();
      });
      this.axes = null;
    }
    // 共享材质与占位纹理由 SceneManager 独占，最后统一释放
    this.placeholderTexture.dispose();
    this.solidAccent.dispose();
    this.dashedAccent.dispose();
    this.dashedGray.dispose();
    this.handleMaterial.dispose();
    // 渲染器释放 WebGL 上下文，并主动移除 canvas 元素，便于容器 DOM 回收
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
