/**
 * Editor.tsx —— 3D 幻灯片编辑器主界面（页面级容器组件）
 *
 * 组件职责：
 * - 作为编辑器的「总装配层」，把顶部工具栏、左侧对象列表、中间 3D 舞台、右侧属性面板
 *   与底部视点时间轴组合成一个完整工作台；
 * - 负责作品的打开 / 关闭生命周期（进入时 openDeck，离开时 closeDeck）；
 * - 统一处理各类本地文件导入（图片、SVG、媒体、3D 模型、Lottie）以及拖放落点；
 * - 托管应用级快捷键、自动保存与离开页面前的数据落盘；
 * - 在舞台与 store 之间做「函数适配」，把用户操作转发为 deckStore 的具体方法调用；
 * - 用模态框承载演示入口选择、保存失败、离开确认、视频导出、AI 面板与资源库选择。
 *
 * 主要交互：
 * - 快捷键：Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 重做、Delete/Backspace 删除、
 *   Ctrl/Cmd+A 全选、F 聚焦选中对象、Esc 取消选择；焦点在输入类元素上时不拦截。
 * - 演示：从第一个视点或当前视图进入 Presentation，优先请求全屏，
 *   若浏览器拒绝全屏则继续以非全屏方式演示。
 * - 只读模式：未取得编辑锁时展示只读横幅，所有写操作入口由子组件禁用。
 *
 * 与其他模块的关系：
 * - 所有状态与数据修改均来自 ../store/deckStore；
 * - 3D 渲染与相机交互在 Stage 内完成，本组件通过 StageApi（captureView / flyTo）读写取景；
 * - Inspector 直接操作 store，本组件只转交「替换素材」等文件选择请求；
 * - 导出与演示分别委托给 ExportDialog 与 Presentation。
 */

import { useEffect, useRef, useState } from 'react';
import type { ViewState } from '../types';
import type { AssetMeta } from '../lib/assets';
import { readAssetFile, readVideoThumb } from '../lib/assets';
import { LIMITS } from '../lib/constants';
import { exportDeckFile } from '../lib/file';
import { formatBytes, isAcceptedImage, readImageFile } from '../lib/image';
import { isLottieFile, readLottieFile, renderLottieThumbnail } from '../lib/lottie';
import { mediaKindOf, readMediaFile } from '../lib/media';
import { isModelFile, modelFormatOf, MODEL_ACCEPT } from '../lib/model3d';
import { isSvgFile, readSvgFile } from '../lib/svg';
import { flushDeckSave, useDeckStore } from '../store/deckStore';
import { listChartPlugins } from '../plugins';
import { toast } from '../store/uiStore';
import { AssetPicker } from './AssetPicker';
import { AiPanel } from './AiPanel';
import { ExportDialog } from './ExportDialog';
import { FrameTrack } from './FrameTrack';
import { Icon } from './Icon';
import { Inspector } from './Inspector';
import { ObjectList } from './ObjectList';
import { Presentation } from './Presentation';
import { Stage, type StageApi } from './Stage';
import { TopBar } from './TopBar';
import { Modal } from './ui';

interface EditorProps {
  deckId: string;
  onBack: () => void;
}

/**
 * 可插入的图表插件列表。
 * 放在组件外避免每次渲染重复遍历；模块导入 ../plugins 时内置插件已完成注册。
 */
const CHART_PLUGINS = listChartPlugins();

/**
 * 演示会话的入口参数。
 * startIndex 为 -1 表示「从当前视图开始」，不绑定任何视点；
 * entryView 是进入演示那一刻的取景，用于退出后恢复；
 * fullscreenFailed 标记全屏请求是否被浏览器拒绝。
 */
interface PresentState {
  startIndex: number;
  entryView: ViewState;
  fullscreenFailed: boolean;
}

/**
 * 编辑器主组件。
 *
 * @param deckId 当前要打开的作品 id；该值变化时会重新加载作品
 * @param onBack 返回首页的回调，只有作品关闭成功（或用户确认放弃）后才会调用
 */
export function Editor({ deckId, onBack }: EditorProps) {
  const deck = useDeckStore((state) => state.deck);
  const loading = useDeckStore((state) => state.loading);
  const loadError = useDeckStore((state) => state.loadError);
  const readonly = useDeckStore((state) => state.readonly);
  const saveStatus = useDeckStore((state) => state.saveStatus);
  const cameraRequest = useDeckStore((state) => state.cameraRequest);
  const selectedObjectId = useDeckStore((state) => state.selectedObjectId);
  const selectedIds = useDeckStore((state) => state.selectedIds);
  const imageRetry = useDeckStore((state) => state.imageRetry);
  const canUndo = useDeckStore((state) => state.past.length > 0);
  const canRedo = useDeckStore((state) => state.future.length > 0);

  const stageRef = useRef<StageApi>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const lottieInput = useRef<HTMLInputElement>(null);
  // 记录「这次文件选择是替换哪个已有对象」；为 null 表示新增。
  // 四个隐藏 input 共用该 ref，打开选择器前写入，onChange 读取后立即清空。
  const pendingReplace = useRef<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1024);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [startChoice, setStartChoice] = useState(false);
  const [presentState, setPresentState] = useState<PresentState | null>(null);
  const [saveErrorOpen, setSaveErrorOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [exportView, setExportView] = useState<ViewState | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // 只要任意模态框 / 抽屉 / 演示层打开，就暂时屏蔽编辑器的全局快捷键
  const modalOpen = Boolean(
    startChoice || saveErrorOpen || leaveOpen || presentState || assetsOpen || exportView || aiOpen,
  );
  // 用 ref 保存最新的 modalOpen，供只注册一次的键盘事件监听器读取，
  // 避免每次开关弹窗都重新绑定 keydown 监听。
  const modalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;

  /**
   * 读取当前舞台取景。
   * 舞台尚未挂载（如加载中）时回退到 store 中的实时视角，
   * 用于捕获视点、导出取景与进入演示时固定入口视角。
   */
  const capture = (): ViewState => stageRef.current?.captureView() ?? useDeckStore.getState().view;

  // 进入编辑器时加载作品；卸载（返回首页或切换作品）时强制关闭，
  // 强制关闭会尽力落盘，避免残留未保存状态。
  useEffect(() => {
    void useDeckStore.getState().openDeck(deckId);
    return () => {
      void useDeckStore.getState().closeDeck(true);
    };
  }, [deckId]);

  // 窗口宽度低于 1024px 时显示窄屏提示（功能不变，仅提示部分面板可能需要滚动）
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 页面隐藏（切到后台或关闭标签页）时强制落盘，降低数据丢失风险
  useEffect(() => {
    const flush = () => {
      void flushDeckSave();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // 是否有尚未落盘的修改；只读模式不参与判断，避免只读页误弹确认
  const unsaved = !readonly && saveStatus.state !== 'saved';
  // 同样用 ref 保存最新值，让只绑定一次的 beforeunload 监听器读到最新状态
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;

  // 有未保存改动时，关闭浏览器页面前弹出系统级确认（浏览器不允许自定义文案）
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsavedRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  /**
   * 全局快捷键处理。
   * 命中条件：没有模态框打开，且焦点不在输入框 / 文本域 / 下拉框 / 可编辑区域内，
   * 这样标题、属性面板与 AI 输入框可以正常使用浏览器原生快捷键。
   * 只读状态下除 Esc 外的编辑类快捷键一律失效。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (modalOpenRef.current) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const state = useDeckStore.getState();
      if (state.readonly) return;
      const mod = event.ctrlKey || event.metaKey;
      // 撤销 / 重做：Shift 决定方向，同时兼容 Windows(Ctrl) 与 macOS(Cmd)
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        return;
      }
      // 删除：优先删除多选集合，没有多选时退回主选中对象
      if ((event.key === 'Delete' || event.key === 'Backspace') && (state.selectedIds.length > 0 || state.selectedObjectId)) {
        event.preventDefault();
        const ids = state.selectedIds.length > 0 ? state.selectedIds : state.selectedObjectId ? [state.selectedObjectId] : [];
        state.removeObjects(ids);
        return;
      }
      // 全选画布中的所有对象（不包含帧）
      if (mod && event.key.toLowerCase() === 'a' && !event.shiftKey) {
        event.preventDefault();
        state.selectObjects(state.deck?.objects.map((object) => object.id) ?? []);
        return;
      }
      // F：让相机聚焦到当前主选中对象
      if ((event.key === 'f' || event.key === 'F') && state.selectedObjectId) {
        event.preventDefault();
        state.requestFocus(state.selectedObjectId);
        return;
      }
      // Esc：取消对象选择（帧的选中状态由 selectObject 一并清空）
      if (event.key === 'Escape' && state.selectedObjectId) {
        event.preventDefault();
        state.selectObject(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 返回首页：先尝试正常关闭（内部会先落盘），保存失败则弹出「是否仍要离开」。 */
  const handleBack = async () => {
    const ok = await useDeckStore.getState().closeDeck();
    if (!ok) {
      setLeaveOpen(true);
      return;
    }
    onBack();
  };

  /** 重试落盘；成功后关闭保存错误 / 离开确认弹窗并提示，失败则提示具体原因。 */
  const retrySave = async () => {
    if (retrying) return;
    setRetrying(true);
    const ok = await flushDeckSave();
    setRetrying(false);
    if (ok) {
      setSaveErrorOpen(false);
      setLeaveOpen(false);
      toast('已保存', 'success');
    } else {
      toast(useDeckStore.getState().saveStatus.message ?? '保存失败', 'error');
    }
  };

  /** 导出 .slide 工程文件（由 lib/file 序列化整份 deck），并提示文件名与大小。 */
  const handleExport = () => {
    const current = useDeckStore.getState().deck;
    if (!current) return;
    const result = exportDeckFile(current);
    if (result.ok) {
      toast(`已导出 · ${result.filename} · ${formatBytes(result.size)}`, 'success');
    } else {
      toast(result.message, 'error');
    }
  };

  /**
   * 处理 SVG 文件导入。
   * replaceId 非空时校验目标对象类型（仅允许 image / svg）后原位替换素材；
   * 否则创建新的 SVG 对象。
   *
   * @param point 新对象的落点（世界坐标），不传则由 store 按当前视角居中放置
   */
  const handleSvgFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
      const result = await readSvgFile(file);
      const state = useDeckStore.getState();
      if (replaceId) {
        const object = state.deck?.objects.find((item) => item.id === replaceId);
        if (!object || (object.type !== 'image' && object.type !== 'svg')) return;
        state.updateObject(replaceId, {
          src: result.src,
          naturalWidth: result.naturalWidth,
          naturalHeight: result.naturalHeight,
        });
        toast('SVG 已替换', 'success');
        return;
      }
      const id = state.addSvg(result.src, result.naturalWidth, result.naturalHeight, point);
      if (!id) {
        toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
        return;
      }
      toast('SVG 图形已添加到画板', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'SVG 添加失败', 'error');
    }
  };

  /**
   * 处理图片文件导入（SVG 会自动转交给 handleSvgFile）。
   * 读取后会得到可持久化的 data URL 与原始宽高；若解码失败仍插入占位内容并提示。
   */
  const handleImageFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
      if (isSvgFile(file)) {
        await handleSvgFile(file, replaceId, point);
        return;
      }
      const result = await readImageFile(file);
      const state = useDeckStore.getState();
      if (replaceId) {
        const object = state.deck?.objects.find((item) => item.id === replaceId);
        if (!object) return;
        state.updateObject(replaceId, {
          src: result.src,
          naturalWidth: result.naturalWidth,
          naturalHeight: result.naturalHeight,
        });
        toast('图片已替换', 'success');
      } else {
        const id = state.addImage(result.src, result.naturalWidth, result.naturalHeight, point);
        if (!id) {
          toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
          return;
        }
      }
      if (!result.decoded) toast(result.error ?? '图片解码失败，已用占位图显示', 'error');
    } catch (error) {
      toast(error instanceof Error ? error.message : '图片添加失败', 'error');
    }
  };

  /** 打开隐藏的图片选择器；replaceId 用于区分「新增」还是「替换已有对象」。 */
  const pickImage = (replaceId?: string) => {
    pendingReplace.current = replaceId ?? null;
    imageInput.current?.click();
  };

  /**
   * 处理视频 / 音频文件导入。
   * 替换时要求素材类型与目标对象一致（视频只能换视频、音频只能换音频）；
   * 视频还会额外截取一帧作为封面（poster），供未播放状态展示。
   */
  const handleMediaFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
      const result = await readMediaFile(file);
      const poster =
        result.kind === 'video' ? (await readVideoThumb(result.src, 480, 2500)).thumb : '';
      const state = useDeckStore.getState();
      if (replaceId) {
        const object = state.deck?.objects.find((item) => item.id === replaceId);
        if (!object || (object.type !== 'video' && object.type !== 'audio')) return;
        if (object.type !== result.kind) {
          toast('素材类型不一致，视频对象只能替换视频，音频对象只能替换音频', 'error');
          return;
        }
        const patch =
          result.kind === 'video'
            ? {
                src: result.src,
                naturalWidth: result.width,
                naturalHeight: result.height,
                duration: result.duration,
                poster: poster || undefined,
              }
            : { src: result.src, duration: result.duration };
        state.updateObject(replaceId, patch);
        toast('媒体已替换', 'success');
      } else {
        const id = state.addMedia(
          result.kind,
          result.src,
          { width: result.width, height: result.height, duration: result.duration, poster: poster || undefined },
          point,
        );
        if (!id) {
          toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
          return;
        }
      }
      if (result.error) toast(result.error, 'error');
    } catch (error) {
      toast(error instanceof Error ? error.message : '媒体添加失败', 'error');
    }
  };

  /** 打开隐藏的媒体选择器（视频与音频共用同一个 input）。 */
  const pickMedia = (replaceId?: string) => {
    pendingReplace.current = replaceId ?? null;
    mediaInput.current?.click();
  };

  /**
   * 处理 3D 模型文件导入。
   * 优先使用资源读取结果里的 format，其次按文件名后缀推断；
   * 无法识别格式时不会插入对象，只提示错误。
   */
  const handleModelFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
      const payload = await readAssetFile(file);
      const format = payload.meta.format ?? modelFormatOf(file.name);
      if (!format) throw new Error('无法识别该模型格式');
      const state = useDeckStore.getState();
      if (replaceId) {
        const object = state.deck?.objects.find((item) => item.id === replaceId);
        if (!object || object.type !== 'model') return;
        state.updateObject(replaceId, { src: payload.src, format });
        toast('模型已替换', 'success');
      } else {
        const id = state.addModel(payload.src, format, point);
        if (!id) {
          toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
          return;
        }
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : '模型添加失败', 'error');
    }
  };

  /** 打开隐藏的模型文件选择器。 */
  const pickModel = (replaceId?: string) => {
    pendingReplace.current = replaceId ?? null;
    modelInput.current?.click();
  };

  /**
   * 处理 Lottie 动画文件导入。
   * 除动画源文件外还会渲染一张封面缩略图（poster），
   * 替换时同步更新时长与封面，保证时间轴与静态预览一致。
   */
  const handleLottieFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
      const payload = await readLottieFile(file);
      const poster = await renderLottieThumbnail(payload.src, 480);
      const state = useDeckStore.getState();
      if (replaceId) {
        const object = state.deck?.objects.find((item) => item.id === replaceId);
        if (!object || object.type !== 'lottie') return;
        state.updateObject(replaceId, {
          src: payload.src,
          naturalWidth: payload.naturalWidth,
          naturalHeight: payload.naturalHeight,
          duration: payload.duration,
          poster: poster || undefined,
        });
        toast('Lottie 动画已替换', 'success');
        return;
      }
      const id = state.addLottie(
        payload.src,
        payload.naturalWidth,
        payload.naturalHeight,
        payload.duration,
        point,
        poster || undefined,
      );
      if (!id) {
        toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
        return;
      }
      toast('Lottie 动画已添加到画板', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Lottie 添加失败', 'error');
    }
  };

  /** 打开隐藏的 Lottie 文件选择器。 */
  const pickLottie = (replaceId?: string) => {
    pendingReplace.current = replaceId ?? null;
    lottieInput.current?.click();
  };

  /**
   * 从资源库选中资源后插入画布。
   *
   * 按资源类型分派到对应的 add* 方法：图片 / SVG、视频 / 音频、模型、Lottie。
   * 视频与 Lottie 若缺少现成缩略图，会现场生成封面；缺失尺寸时使用一组兜底值，
   * 避免出现零尺寸、难以选中的对象。
   *
   * @param asset 资源元数据（类型、原始尺寸、时长、格式等）
   * @param src 可直接使用的资源地址（通常是 data URL 或对象存储地址）
   */
  const handleAssetPick = async (asset: AssetMeta, src: string) => {
    const state = useDeckStore.getState();
    if (!state.deck) return;
    let poster = asset.kind === 'video' || asset.kind === 'lottie' ? asset.thumb : '';
    if (!poster && asset.kind === 'video') poster = (await readVideoThumb(src, 480, 2500)).thumb;
    if (!poster && asset.kind === 'lottie') poster = await renderLottieThumbnail(src, 480);
    let id: string | null = null;
    if (asset.kind === 'image') {
      const isSvg = asset.mime === 'image/svg+xml' || asset.ext === 'svg';
      id = isSvg
        ? state.addSvg(src, asset.width || 800, asset.height || 600)
        : state.addImage(src, asset.width || 1600, asset.height || 900);
    } else if (asset.kind === 'video' || asset.kind === 'audio') {
      id = state.addMedia(
        asset.kind,
        src,
        {
          width: asset.width || 1280,
          height: asset.height || 720,
          duration: asset.duration,
          poster: poster || undefined,
        },
      );
    } else if (asset.kind === 'model') {
      const format = asset.format ?? modelFormatOf(asset.name);
      if (!format) {
        toast('无法识别该模型格式', 'error');
        return;
      }
      id = state.addModel(src, format);
    } else if (asset.kind === 'lottie') {
      id = state.addLottie(src, asset.width || 800, asset.height || 600, asset.duration, undefined, poster || undefined);
    } else {
      toast('该资源类型暂不支持插入画板', 'error');
      return;
    }
    if (!id) {
      toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
      return;
    }
    toast(`已插入「${asset.name}」`, 'success');
  };

  /**
   * 文件类型分派入口（用于舞台拖放与粘贴）。
   * 依次按 SVG、图片、模型、媒体、Lottie 的顺序识别，全部不匹配时提示不支持。
   */
  const handleFile = (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    if (isSvgFile(file)) void handleSvgFile(file, replaceId, point);
    else if (isAcceptedImage(file)) void handleImageFile(file, replaceId, point);
    else if (isModelFile(file)) void handleModelFile(file, replaceId, point);
    else if (mediaKindOf(file)) void handleMediaFile(file, replaceId, point);
    else if (isLottieFile(file)) void handleLottieFile(file, replaceId, point);
    else toast('不支持的文件类型', 'error');
  };

  /** 把当前画面捕获为一个新视点；达到数量上限时提示先删除旧视点。 */
  const captureFrame = () => {
    const state = useDeckStore.getState();
    if (!state.deck) return;
    if (state.deck.frames.length >= LIMITS.frames) {
      toast(`已达到 ${LIMITS.frames} 个视点上限，删除后可继续添加`, 'error');
      return;
    }
    state.captureFrame(capture());
    toast('已捕获当前视图作为一个视点', 'success');
  };

  /** 用当前取景覆盖指定视点（不新增视点，常用于微调镜头后重新固定）。 */
  const updateFrameView = (id: string) => {
    useDeckStore.getState().updateFrameView(id, capture());
    toast('已用当前视图更新该视点', 'success');
  };

  /**
   * 开始演示。
   *
   * 进入前先记录当前取景作为退出后的恢复点，并尝试请求全屏：
   * - requestFullscreen 是异步的，被拒绝时通过 Promise 的 catch 标记 fullscreenFailed；
   * - 同步抛错（老浏览器 / 权限策略）则直接置 failed，同样继续进入演示；
   * - 无论全屏成功与否，都立刻挂载 Presentation，不阻塞演示开始。
   *
   * @param startIndex 起始视点下标；-1 表示从当前视图自由开始
   */
  const startPresentation = (startIndex: number) => {
    setStartChoice(false);
    const entryView = capture();
    let failed = false;
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      try {
        const request = document.documentElement.requestFullscreen();
        if (request) {
          request.catch(() => {
            setPresentState((current) => (current ? { ...current, fullscreenFailed: true } : current));
          });
        }
      } catch {
        failed = true;
      }
    }
    setPresentState({ startIndex, entryView, fullscreenFailed: failed });
  };

  /** 点击「演示」：没有视点时直接以当前视图开始，否则先让用户选择入口。 */
  const handlePresent = () => {
    const state = useDeckStore.getState();
    if (!state.deck) return;
    if (state.deck.frames.length === 0) {
      toast('作品还没有视点，已从当前视图开始', 'info');
      startPresentation(-1);
      return;
    }
    setStartChoice(true);
  };

  /**
   * 退出演示并回到编辑器。
   *
   * @param finalView 演示结束时的取景，写回编辑器视角，让用户从刚才的位置继续编辑
   * @param frameId 退出时停留的视点 id；为 null 表示自由视图
   *
   * 副作用：清空对象选中的同时保留当前视点指针，随后用极短飞行把舞台对齐到该取景。
   */
  const exitPresentation = (finalView: ViewState, frameId: string | null) => {
    const state = useDeckStore.getState();
    state.commitView(finalView);
    useDeckStore.setState({
      selectedObjectId: null,
      selectedIds: [],
      selectedFrameId: null,
      currentFrameId: frameId,
    });
    setPresentState(null);
    void stageRef.current?.flyTo(finalView, 0.01);
  };

  if (loadError) {
    return (
      <div className="screen-center">
        <div className="screen-card">
          <Icon name="alert" size={26} />
          <h2>作品无法打开</h2>
          <p>{loadError}</p>
          <div className="button-row center">
            <button className="btn btn-ghost" onClick={onBack}>
              返回首页
            </button>
            <button className="btn btn-primary" onClick={() => void useDeckStore.getState().openDeck(deckId)}>
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading || !deck) {
    return (
      <div className="screen-center">
        <div className="loading-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <p>正在读取作品…</p>
      </div>
    );
  }

  const mode = readonly ? 'view' : 'edit';

  return (
    <div className="editor">
      {narrow && (
        <div className="narrow-banner">
          <Icon name="alert" size={14} />
          <span>建议使用更宽的窗口（≥ 1024px）。编辑功能保留，部分面板可能需要滚动。</span>
        </div>
      )}
      <TopBar
        deck={deck}
        readonly={readonly}
        saveStatus={saveStatus}
        canUndo={canUndo}
        canRedo={canRedo}
        onBack={() => void handleBack()}
        onRename={(title) => useDeckStore.getState().renameDeck(title)}
        onUndo={() => useDeckStore.getState().undo()}
        onRedo={() => useDeckStore.getState().redo()}
        onPresent={handlePresent}
        onExport={handleExport}
        onExportVideo={() => setExportView(capture())}
        onOpenAi={() => setAiOpen(true)}
        onOpenAssets={() => setAssetsOpen(true)}
        onShowSaveError={() => setSaveErrorOpen(true)}
      />
      {readonly && (
        <div className="readonly-banner">
          <Icon name="lock" size={14} />
          <span>该作品已在另一窗口编辑，当前为只读。关闭原窗口后刷新即可恢复编辑。</span>
        </div>
      )}

      <div className={`editor-body${leftCollapsed ? ' is-left-collapsed' : ''}`}>
        <ObjectList
          objects={deck.objects}
          selectedId={selectedObjectId}
          selectedIds={selectedIds}
          readonly={readonly}
          collapsed={leftCollapsed}
          onToggleCollapsed={() => setLeftCollapsed((value) => !value)}
          onSelect={(id, additive) => {
            if (additive) useDeckStore.getState().toggleObjectSelection(id);
            else useDeckStore.getState().selectObject(id);
          }}
          onRangeSelect={(ids) => useDeckStore.getState().selectObjects(ids)}
          onToggleVisible={(id, visible) => useDeckStore.getState().updateObject(id, { visible })}
          onReorder={(source, target) => useDeckStore.getState().moveObjectLayer(source, target)}
          onAddText={() => useDeckStore.getState().addText()}
          onAddImage={() => pickImage()}
          onAddVideo={() => pickMedia()}
          onAddAudio={() => pickMedia()}
          onAddModel={() => pickModel()}
          onAddLottie={() => pickLottie()}
          onAddShape={() => useDeckStore.getState().addShape('rect')}
          chartPlugins={CHART_PLUGINS}
          onAddChart={(pluginId) => useDeckStore.getState().addChart(pluginId)}
        />

        <main className="stage-column">
          <Stage
            ref={stageRef}
            deck={deck}
            mode={mode}
            selectedObjectId={selectedObjectId}
            selectedObjectIds={selectedIds}
            cameraRequest={cameraRequest}
            imageRetry={imageRetry}
            initialView={deck.lastView}
            onViewChange={(next) => useDeckStore.getState().commitView(next)}
            onSelectMany={(ids) => useDeckStore.getState().selectObjects(ids)}
            onMoveObject={(id, x, y) => useDeckStore.getState().updateObject(id, { x, y }, `move:${id}`)}
            onResizeObject={(id, patch) => useDeckStore.getState().updateObject(id, patch, `resize:${id}`)}
            onGestureEnd={() => useDeckStore.getState().endHistoryCoalesce()}
            onImageError={(id, message) => useDeckStore.getState().markImageError(id, message)}
            onAddText={() => useDeckStore.getState().addText()}
            onAddShape={(shape) => useDeckStore.getState().addShape(shape)}
            onAddFile={(file, point) => handleFile(file, null, point)}
            onPickImage={() => pickImage()}
            onDrawPath={(points, box, strokeWidth) => {
              const id = useDeckStore.getState().addPath(points, box, strokeWidth);
              if (!id) toast('路径点太少，无法生成图形', 'error');
            }}
            onTextCommit={(id, text) => {
              if (!text.trim()) useDeckStore.getState().removeObject(id);
              else useDeckStore.getState().updateObject(id, { text });
            }}
          />
        </main>

        <Inspector
          readonly={readonly}
          onReplaceImage={(id) => pickImage(id)}
          onReplaceMedia={(id) => pickMedia(id)}
          onReplaceModel={(id) => pickModel(id)}
          onReplaceLottie={(id) => pickLottie(id)}
          onUpdateFrameView={updateFrameView}
        />
      </div>

      <FrameTrack readonly={readonly} onCapture={captureFrame} />

      <input
        ref={imageInput}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const replaceId = pendingReplace.current;
          pendingReplace.current = null;
          event.target.value = '';
          if (file) void handleImageFile(file, replaceId);
        }}
      />

      <input
        ref={mediaInput}
        type="file"
        hidden
        accept="video/*,audio/*,.mkv,.avi,.mov,.flv,.wmv,.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const replaceId = pendingReplace.current;
          pendingReplace.current = null;
          event.target.value = '';
          if (file) void handleMediaFile(file, replaceId);
        }}
      />

      <input
        ref={modelInput}
        type="file"
        hidden
        accept={MODEL_ACCEPT}
        onChange={(event) => {
          const file = event.target.files?.[0];
          const replaceId = pendingReplace.current;
          pendingReplace.current = null;
          event.target.value = '';
          if (file) void handleModelFile(file, replaceId);
        }}
      />

      <input
        ref={lottieInput}
        type="file"
        hidden
        accept=".json,.lottie,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const replaceId = pendingReplace.current;
          pendingReplace.current = null;
          event.target.value = '';
          if (file) void handleLottieFile(file, replaceId);
        }}
      />

      {exportView && deck && (
        <ExportDialog deck={deck} view={exportView} onClose={() => setExportView(null)} />
      )}

      {aiOpen && deck && <AiPanel deck={deck} onClose={() => setAiOpen(false)} />}

      {assetsOpen && (
        <AssetPicker
          kinds={['image', 'video', 'audio', 'model', 'lottie']}
          onPick={handleAssetPick}
          onClose={() => setAssetsOpen(false)}
        />
      )}

      {startChoice && deck.frames.length > 0 && (
        <Modal
          title="从哪里开始演示？"
          eyebrow="PRESENT"
          onClose={() => setStartChoice(false)}
          width={500}
          footer={
            <button className="btn btn-ghost" onClick={() => setStartChoice(false)}>
              取消
            </button>
          }
        >
          <div className="start-options">
            <button className="start-option is-primary" onClick={() => startPresentation(0)}>
              <span className="start-option-icon">
                <Icon name="play" size={18} />
              </span>
              <span>
                <b>从第一个视点开始</b>
                <small>
                  {deck.frames[0].name} · 共 {deck.frames.length} 个视点
                </small>
              </span>
            </button>
            <button className="start-option" onClick={() => startPresentation(-1)}>
              <span className="start-option-icon">
                <Icon name="focus" size={18} />
              </span>
              <span>
                <b>从当前视图开始</b>
                <small>按当前取景直接开始，之后可用 → 进入第一个视点</small>
              </span>
            </button>
          </div>
          <p className="modal-note">
            演示中可自由拖拽环绕、滚轮缩放；双击舞台或按 R 回到当前视点，Esc 退出并回到编辑器。
          </p>
        </Modal>
      )}

      {saveErrorOpen && (
        <Modal
          title="保存失败"
          eyebrow="SAVE ERROR"
          onClose={() => setSaveErrorOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setSaveErrorOpen(false)}>
                稍后处理
              </button>
              <button className="btn btn-light" onClick={handleExport}>
                <Icon name="download" size={15} /> 导出工程
              </button>
              <button className="btn btn-primary" disabled={retrying} onClick={() => void retrySave()}>
                {retrying ? '正在重试…' : '重试保存'}
              </button>
            </>
          }
        >
          <p>当前编辑状态仍保留在页面中，但尚未写入浏览器本地存储。</p>
          <p className="error-note">{saveStatus.message ?? '未知错误'}</p>
          <p className="modal-note">
            可以先导出工程文件避免丢失；本地空间不足时，可删除不再需要的作品后重试。
          </p>
        </Modal>
      )}

      {leaveOpen && (
        <Modal
          title="保存失败，仍要离开？"
          eyebrow="UNSAVED"
          onClose={() => setLeaveOpen(false)}
          footer={
            <div className="leave-actions">
              <button className="btn btn-ghost" onClick={() => setLeaveOpen(false)}>
                留下
              </button>
              <button className="btn btn-light" onClick={handleExport}>
                导出工程
              </button>
              <button className="btn btn-light" disabled={retrying} onClick={() => void retrySave()}>
                重试保存
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  void useDeckStore.getState().closeDeck(true).then(() => onBack());
                }}
              >
                仍然离开
              </button>
            </div>
          }
        >
          <p>离开后，尚未保存的修改可能丢失。建议先导出工程或重试保存。</p>
          <p className="error-note">{saveStatus.message ?? '保存失败'}</p>
        </Modal>
      )}

      {presentState && (
        <Presentation
          deck={deck}
          startIndex={presentState.startIndex}
          entryView={presentState.entryView}
          fullscreenFailed={presentState.fullscreenFailed}
          onExit={exitPresentation}
        />
      )}
    </div>
  );
}
