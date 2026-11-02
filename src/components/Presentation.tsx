/**
 * Presentation.tsx —— 全屏演示层
 *
 * 组件职责：
 * - 以 Portal 形式覆盖在编辑器之上，独占整个浏览器窗口（document.body）；
 * - 复用 Stage 的 3D 渲染能力，但使用 present 模式：无编辑手柄、无网格、无选中框；
 * - 按视点顺序播放：自动播放、上一个 / 下一个、回到路径、备注面板与进度显示；
 * - 提供附加的观影功能：空间漫游（WASD 飞行）、鱼眼镜头、星空剧场、VR 头显预览；
 * - 演示中可自由拖拽环绕、滚轮缩放，退出时把最终取景回传给编辑器继续编辑。
 *
 * 主要交互：
 * - 单击 / 点击工具按钮 / → / 空格 / Enter：下一个视点；
 * - 双击 / R：回到当前视点路径（放弃自由浏览的临时取景）；
 * - Esc：退出演示；M：漫游模式开关；N：演讲者备注；
 * - 触屏左右滑动切换视点，滑动后短暂屏蔽点击，避免误触发「下一张」。
 *
 * 与其他模块的关系：
 * - 视点数据来自 Deck.frames，媒体播放状态从 Stage 的 mediaState 查询；
 * - 相机控制全部通过 StageApi（flyTo / roamStep / setLens / setSpaceMode / enterXR 等）；
 * - 退出时通过 onExit 把最终 ViewState 与停留视点交回 Editor。
 */

import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { Deck, ViewState } from '../types';
import { DEFAULT_HOLD } from '../lib/constants';
import type { MediaPlaybackState } from '../three/SceneManager';
import { Stage, type StageApi } from './Stage';
import { Icon } from './Icon';

// localStorage 键：记录用户是否看过操作提示，看过之后同一浏览器不再每次弹出
const HINT_KEY = '3d-slide:present-hint-seen';

/**
 * 把秒数格式化为 m:ss（用于媒体播放条的当前时间与总时长）。
 * 非法值、负数与 0 统一显示为 0:00，避免出现 NaN。
 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

interface PresentationProps {
  /** 当前作品，提供视点、对象、背景与是否显示进度条等演示所需数据。 */
  deck: Deck;
  /** 起始视点下标；-1 表示不绑定视点，从当前视图自由开始。 */
  startIndex: number;
  /** 进入演示时的取景，用于退出或「回到路径」时兜底。 */
  entryView: ViewState;
  /** 全屏请求是否失败，失败时在界面上给出提示。 */
  fullscreenFailed: boolean;
  /** 退出回调：回传最终取景与停留的视点 id（自由视图为 null）。 */
  onExit: (finalView: ViewState, frameId: string | null) => void;
}

/**
 * 演示视图主组件。
 *
 * @param deck 作品数据
 * @param startIndex 起始视点下标（-1 表示自由视图）
 * @param entryView 进入演示时的取景
 * @param fullscreenFailed 全屏是否被浏览器拒绝
 * @param onExit 退出演示时回传最终取景与视点 id
 */
export function Presentation({ deck, startIndex, entryView, fullscreenFailed, onExit }: PresentationProps) {
  const stageRef = useRef<StageApi>(null);
  // 当前视点下标；另存一份 ref，供延时计时器 / 事件监听器读取最新值，避免闭包陈旧
  const indexRef = useRef(startIndex);
  // 相机是否正处于飞行动画中：期间屏蔽切换与点击，避免运镜被打断或叠加
  const busy = useRef(false);
  // 是否已开始退出流程：用于防止 Esc、全屏退出、按钮多次触发重复 onExit
  const exiting = useRef(false);
  // 单击延迟计时器：区分单击（下一张）与双击（回到路径）
  const clickTimer = useRef<number>();
  // 鼠标静止后隐藏光标的计时器
  const hideTimer = useRef<number>();
  // 漫游模式下当前按住的移动键集合（小写 w/a/s/d/q/e）
  const pressedKeys = useRef<Set<string>>(new Set());
  // 漫游状态的 ref 副本，供键盘与触摸事件读取最新值
  const roamRef = useRef(false);
  // 触屏按下时的起始坐标，用于判断是否为横向滑动
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // 滑动切换后的时间戳，在 500ms 内忽略点击，避免滑动结束又触发下一张
  const suppressClick = useRef(0);
  // 记录进入演示前是否已经处于全屏，用于区分「用户按 Esc 退出全屏」与全屏请求失败
  const hadFullscreen = useRef(Boolean(document.fullscreenElement));
  // 系统是否开启「减少动态效果」：开启时所有相机飞行改为瞬间切换
  const reduced = useRef(
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  const [index, setIndex] = useState(startIndex);
  const [roam, setRoam] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) !== '1';
    } catch {
      return true;
    }
  });
  const [showFullscreenNote, setShowFullscreenNote] = useState(fullscreenFailed);
  const [cursorHidden, setCursorHidden] = useState(false);
  const [lens, setLens] = useState(false);
  const [space, setSpace] = useState(false);
  const [xrSupported, setXrSupported] = useState(false);
  const [xrActive, setXrActive] = useState(false);
  const [mediaState, setMediaState] = useState<MediaPlaybackState | null>(null);
  const [buffering, setBuffering] = useState(true);
  // 进入星空剧场前的取景，退出该模式时用来飞回原位
  const savedViewRef = useRef<ViewState | null>(null);
  // 画布中的所有媒体对象，演示时在底部提供统一的播放控制条
  const mediaItems = deck.objects.filter(
    (object) => object.type === 'video' || object.type === 'audio',
  ) as { id: string; name: string; type: 'video' | 'audio' }[];
  // 当前选中的媒体对象；未手动选择时默认操作第一个媒体
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeMedia = activeId ?? mediaItems[0]?.id ?? null;

  // 每次渲染同步 ref，保证异步回调与事件监听器读到的是最新状态
  indexRef.current = index;
  roamRef.current = roam;

  // 当前视点（自由视图时为 null）；initialView 是 Stage 首帧使用的取景
  const currentFrame = index >= 0 ? deck.frames[index] : null;
  const initialView = currentFrame?.view ?? entryView;

  /**
   * 结束演示并退出全屏。
   * 先读取最终取景与停留视点，再请求退出全屏，最后把结果交给父组件；
   * exiting 幂等标记确保全屏变化事件不会导致二次退出。
   */
  const finish = () => {
    if (exiting.current) return;
    exiting.current = true;
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    const finalView = stageRef.current?.captureView() ?? initialView;
    const frameId = indexRef.current >= 0 ? deck.frames[indexRef.current]?.id ?? null : null;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onExit(finalView, frameId);
  };

  /**
   * 相机飞行到指定取景。
   * 飞行期间 busy 为 true，自动播放的计时器会等待飞行结束再继续；
   * 系统开启「减少动态效果」时把时长压到 0.01 秒，近似瞬间切换。
   */
  const flyTo = async (view: ViewState, duration: number) => {
    const manager = stageRef.current;
    if (!manager) return;
    busy.current = true;
    await manager.flyTo(view, reduced.current ? 0.01 : duration);
    busy.current = false;
  };

  /**
   * 切换到相邻视点。
   *
   * @param delta 1 表示下一个，-1 表示上一个
   * @param auto 是否由自动播放触发；自动播放时不要因此停止播放状态
   *
   * 边界处理：首视点向前时从「自由视图」进入第 0 个视点；
   * 末视点向后不再移动；飞行中或退出中一律忽略。
   */
  const go = (delta: 1 | -1, auto = false) => {
    if (!auto) setPlaying(false);
    if (busy.current || exiting.current) return;
    const frames = deck.frames;
    if (frames.length === 0) return;
    const current = indexRef.current;
    let target: number;
    if (delta > 0) {
      if (current >= frames.length - 1) return;
      target = current < 0 ? 0 : current + 1;
    } else {
      if (current < 0 || current === 0) return;
      target = current - 1;
    }
    const frame = frames[target];
    setIndex(target);
    void flyTo(frame.view, frame.duration);
  };

  /**
   * 切换自动播放。
   * 开始播放时若当前处于自由视图或已是最后一页，会先回到第一个视点；
   * 取消待执行的单击计时器，避免刚点播放又被判定为「下一张」。
   */
  const togglePlay = () => {
    if (exiting.current) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (deck.frames.length === 0) return;
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    if (indexRef.current < 0 || indexRef.current >= deck.frames.length - 1) {
      const first = deck.frames[0];
      setIndex(0);
      void flyTo(first.view, first.duration);
    }
    setPlaying(true);
  };

  /**
   * 自动播放的帧计时循环。
   *
   * 每个视点停留 hold 秒（默认 DEFAULT_HOLD，最少 0.5 秒）；若相机仍在飞行
   * （busy 为 true），每 220ms 重试一次调度，等飞行完成后再开始计时。
   * 到达最后一页时停止播放。cleanup 会清除所有计时器并置 cancelled，
   * 避免快速切换视点时出现多个并行计时器。
   */
  useEffect(() => {
    if (!playing) return;
    if (deck.frames.length === 0) {
      setPlaying(false);
      return;
    }
    let cancelled = false;
    let timer = 0;
    let waitTimer = 0;
    const schedule = () => {
      if (cancelled) return;
      if (busy.current) {
        waitTimer = window.setTimeout(schedule, 220);
        return;
      }
      const frame = indexRef.current >= 0 ? deck.frames[indexRef.current] : null;
      const hold = Math.max(0.5, frame?.hold ?? DEFAULT_HOLD);
      timer = window.setTimeout(() => {
        if (cancelled) return;
        if (indexRef.current >= deck.frames.length - 1) {
          setPlaying(false);
          return;
        }
        go(1, true);
      }, hold * 1000);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearTimeout(waitTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, index, deck.frames.length]);

  /**
   * 回到当前视点的路径取景（双击 / R 触发）。
   * 会先停止自动播放；相机若正在飞行则忽略本次请求。
   */
  const returnToPath = () => {
    setPlaying(false);
    if (busy.current || exiting.current) return;
    const frame = indexRef.current >= 0 ? deck.frames[indexRef.current] : null;
    void flyTo(frame?.view ?? entryView, 0.6);
  };

  /**
   * 切换空间漫游模式。
   * 进入 / 退出时都会停止自动播放并清空按键集合，防止残留按键导致角色持续漂移；
   * 同时取消待执行的单击计时器，避免与双击操作冲突。
   */
  const toggleRoam = () => {
    if (exiting.current) return;
    setPlaying(false);
    pressedKeys.current.clear();
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    setRoam((value) => !value);
  };

  /**
   * 漫游模式的逐帧移动循环。
   * 用 requestAnimationFrame 按真实帧间隔推动相机；每帧位移时间 dt 上限 0.06 秒，
   * 避免切后台回来时单帧跨度过大造成瞬移。W/S 前后、A/D 左右、Q/E 升降。
   */
  useEffect(() => {
    if (!roam) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.06, Math.max(0, (now - last) / 1000));
      last = now;
      const keys = pressedKeys.current;
      const forward = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
      const right = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
      const up = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0);
      if (forward !== 0 || right !== 0 || up !== 0) {
        stageRef.current?.roamStep(forward, right, up, dt);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [roam]);

  // 询问舞台当前环境是否支持 WebXR，仅支持时才显示「VR 预览」按钮
  useEffect(() => {
    let alive = true;
    void stageRef.current?.getXRSupported().then((supported) => {
      if (alive) setXrSupported(supported);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 首屏缓冲：等待舞台素材（纹理、模型等）就绪，最多 6 秒后自动解除遮罩，
  // 避免个别素材加载失败导致演示一直卡在「正在缓冲」
  useEffect(() => {
    let cancelled = false;
    const api = stageRef.current;
    if (!api) {
      setBuffering(false);
      return;
    }
    void api.waitAssets(6000).finally(() => {
      if (!cancelled) setBuffering(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 媒体播放状态轮询：每 160ms 从舞台同步一次当前媒体（时间、时长、音量、静音、错误），
  // 让底部控制条与 3D 场景中的实际播放保持接近实时的同步
  useEffect(() => {
    if (!activeMedia) {
      setMediaState(null);
      return;
    }
    const update = () => setMediaState(stageRef.current?.mediaState(activeMedia) ?? null);
    update();
    const timer = window.setInterval(update, 160);
    return () => window.clearInterval(timer);
  }, [activeMedia]);

  // 组件卸载时确保退出 VR 会话，释放头显占用
  useEffect(() => {
    return () => {
      void stageRef.current?.exitXR();
    };
  }, []);

  /** 切换鱼眼镜头；相机端用 0.45 秒过渡，避免视野突变引起不适。 */
  const toggleLens = () => {
    const next = !lens;
    setLens(next);
    stageRef.current?.setLens(next ? 'fisheye' : 'none', 0.45);
  };

  /**
   * 切换「星空剧场」：进入时保存当前取景，把画板推到远处并铺上星空背景；
   * 退出时关闭星空模式并飞回进入前的取景。飞行距离至少 6800，保证画板像悬浮在远处。
   */
  const toggleSpace = () => {
    const stage = stageRef.current;
    if (!stage) return;
    if (!space) {
      savedViewRef.current = stage.captureView();
      stage.setSpaceMode('stars');
      const current = stage.captureView();
      void stage.flyTo(
        {
          target: { x: 0, y: 0, z: 0 },
          distance: Math.max(current.distance, 6800),
          yaw: current.yaw,
          pitch: current.pitch,
        },
        0.8,
      );
      setSpace(true);
    } else {
      stage.setSpaceMode('none');
      if (savedViewRef.current) void stage.flyTo(savedViewRef.current, 0.7);
      setSpace(false);
    }
  };

  /** 进入 / 退出 VR 头显预览；进入失败时复用全屏失败提示条告知用户。 */
  const toggleXR = async () => {
    const stage = stageRef.current;
    if (!stage) return;
    if (xrActive) {
      await stage.exitXR();
      setXrActive(false);
      return;
    }
    const ok = await stage.enterXR();
    setXrActive(ok);
    if (!ok) setShowFullscreenNote(true);
  };

  /**
   * 向舞台发送媒体控制指令。
   * 所有操作都针对当前 activeMedia，未选择媒体时静默忽略；
   * seek / volume 的取值范围由界面控件的 min / max 保证。
   */
  const mediaCommand = (action: 'toggle' | 'seek' | 'volume' | 'mute', value?: number) => {
    const stage = stageRef.current;
    if (!stage || !activeMedia) return;
    if (action === 'toggle') stage.mediaToggle(activeMedia);
    else if (action === 'seek') stage.mediaSeek(activeMedia, value ?? 0);
    else if (action === 'volume') stage.mediaVolume(activeMedia, value ?? 0);
    else stage.mediaMute(activeMedia);
  };

  useEffect(() => {
    const first = deck.frames[startIndex]?.view ?? entryView;
    void stageRef.current?.flyTo(first, 0.01);
    // 初始取景已由 Stage 的 initialView 提供，这里只做尺寸变化时的兜底
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 首次进入时展示操作提示并在 3.4 秒后自动收起，同时写入 localStorage 标记，
  // 之后同一浏览器不再重复弹出（localStorage 不可用时退化为每次显示）
  useEffect(() => {
    if (!hint) return;
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // ignore
    }
    const timer = window.setTimeout(() => setHint(false), 3400);
    return () => window.clearTimeout(timer);
  }, [hint]);

  /**
   * 演示层键盘事件。
   *
   * 优先级：Esc 退出 > M/N 全局开关 > 漫游移动键（吞掉方向键与 Enter）> 普通翻页。
   * 漫游模式下方向键 / 空格 / Enter 被显式拦截，避免边移动边跳页；
   * keyup 与窗口失焦都会清空按键集合，防止按键卡住导致持续移动。
   */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') {
        event.preventDefault();
        finish();
        return;
      }
      if (key === 'm') {
        event.preventDefault();
        toggleRoam();
        return;
      }
      if (key === 'n') {
        event.preventDefault();
        setNotesOpen((value) => !value);
        return;
      }
      if (roamRef.current) {
        if (key === 'w' || key === 'a' || key === 's' || key === 'd' || key === 'q' || key === 'e') {
          event.preventDefault();
          pressedKeys.current.add(key);
          return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          return;
        }
        if (key === 'r') {
          event.preventDefault();
          returnToPath();
        }
        return;
      }
      if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        go(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(-1);
      } else if (key === 'r') {
        event.preventDefault();
        returnToPath();
      }
    };
    const keyup = (event: KeyboardEvent) => {
      pressedKeys.current.delete(event.key.toLowerCase());
    };
    const clearKeys = () => pressedKeys.current.clear();
    const fullscreenHandler = () => {
      if (document.fullscreenElement) {
        hadFullscreen.current = true;
        return;
      }
      if (hadFullscreen.current && !exiting.current) {
        finish();
      }
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', clearKeys);
    document.addEventListener('fullscreenchange', fullscreenHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', clearKeys);
      document.removeEventListener('fullscreenchange', fullscreenHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, entryView]);

  // 鼠标移动时显示光标，静止 2 秒后隐藏，获得干净的观影画面
  useEffect(() => {
    const wake = () => {
      setCursorHidden(false);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setCursorHidden(true), 2000);
    };
    window.addEventListener('mousemove', wake);
    wake();
    return () => {
      window.removeEventListener('mousemove', wake);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (clickTimer.current) window.clearTimeout(clickTimer.current);
    };
  }, []);

  const progress = deck.frames.length > 0 ? `${index >= 0 ? index + 1 : '—'} / ${deck.frames.length}` : '1 / 1';

  return createPortal(
    <div className={`present-layer ${cursorHidden ? 'is-cursor-hidden' : ''}`}>
      <div
        className="present-stage"
        // 触屏手势：记录起点，结束时判断横向位移是否足够大（>50px 且明显大于纵向），
        // 满足条件则切换视点，并记录时间戳在随后 500ms 内屏蔽点击，避免滑动误触发点击翻页
        onTouchStart={(event) => {
          const touch = event.touches[0];
          if (!touch) return;
          touchStart.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchEnd={(event) => {
          const start = touchStart.current;
          touchStart.current = null;
          if (!start || busy.current || roamRef.current) return;
          const touch = event.changedTouches[0];
          if (!touch) return;
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            suppressClick.current = Date.now();
            if (clickTimer.current) window.clearTimeout(clickTimer.current);
            go(dx < 0 ? 1 : -1);
          }
        }}
      >
        <Stage
          ref={stageRef}
          deck={deck}
          mode="present"
          initialView={initialView}
          // Stage 的单击事件：延迟 260ms 执行，给双击留出判定窗口；
          // 双击时 onStageDoubleClick 会先清除该计时器，因此双击不会触发翻页
          onStageClick={() => {
            if (Date.now() - suppressClick.current < 500) return;
            if (busy.current || roamRef.current) return;
            if (clickTimer.current) window.clearTimeout(clickTimer.current);
            clickTimer.current = window.setTimeout(() => go(1), 260);
          }}
          onStageDoubleClick={() => {
            if (clickTimer.current) window.clearTimeout(clickTimer.current);
            returnToPath();
          }}
        />
        {buffering && (
          <div className="present-buffer" role="status">
            <div className="loading-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <span>正在缓冲素材…</span>
          </div>
        )}
      </div>

      {deck.showProgress && <div className="present-progress">{progress}</div>}

      <div className="present-tools">
        <button
          className={`present-tool ${playing ? 'is-on' : ''}`}
          onClick={togglePlay}
          aria-pressed={playing}
          disabled={deck.frames.length === 0}
          title="按每个视点的停留时长自动播放"
        >
          <Icon name={playing ? 'pause' : 'play'} size={15} />
          {playing ? '暂停' : '自动播放'}
        </button>
        <button
          className={`present-tool ${notesOpen ? 'is-on' : ''}`}
          onClick={() => setNotesOpen((value) => !value)}
          aria-pressed={notesOpen}
          title="显示演讲者备注（N）"
        >
          <Icon name="text" size={15} />
          备注
        </button>
        <button
          className={`present-tool ${lens ? 'is-on' : ''}`}
          onClick={toggleLens}
          aria-pressed={lens}
          title="切换鱼眼镜头效果"
        >
          <Icon name="fisheye" size={15} />
          鱼眼
        </button>
        <button
          className={`present-tool ${space ? 'is-on' : ''}`}
          onClick={toggleSpace}
          aria-pressed={space}
          title="远距离空间投射：画板悬浮在星空中，像在 VR 影院"
        >
          <Icon name="spark" size={15} />
          星空剧场
        </button>
        {xrSupported && (
          <button
            className={`present-tool ${xrActive ? 'is-on' : ''}`}
            onClick={() => void toggleXR()}
            aria-pressed={xrActive}
            title="进入或退出 VR 头显预览"
          >
            <Icon name="vr" size={15} />
            {xrActive ? '退出 VR' : 'VR 预览'}
          </button>
        )}
      </div>

      {activeMedia && mediaState && (
        <div className="present-media-bar" aria-label="播放控制">
          {mediaItems.length > 1 && (
            <select
              className="present-media-select"
              value={activeMedia}
              aria-label="选择媒体"
              onChange={(event) => setActiveId(event.target.value)}
            >
              {mediaItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="present-media-btn"
            onClick={() => mediaCommand('toggle')}
            aria-label={mediaState.playing ? '暂停' : '播放'}
          >
            <Icon name={mediaState.playing ? 'pause' : 'play'} size={16} />
          </button>
          <span className="present-media-time">{formatTime(mediaState.time)}</span>
          <input
            className="present-media-range"
            type="range"
            min={0}
            max={Math.max(0.1, mediaState.duration)}
            step={0.05}
            value={Math.min(mediaState.time, mediaState.duration || 0)}
            aria-label="播放进度"
            onChange={(event) => mediaCommand('seek', Number(event.target.value))}
          />
          <span className="present-media-time">{formatTime(mediaState.duration)}</span>
          <button
            className="present-media-btn"
            onClick={() => mediaCommand('mute')}
            aria-label={mediaState.muted ? '取消静音' : '静音'}
          >
            <Icon name={mediaState.muted ? 'volumeOff' : 'volume'} size={16} />
          </button>
          <input
            className="present-media-range is-volume"
            type="range"
            min={0}
            max={100}
            value={mediaState.volume}
            aria-label="音量"
            onChange={(event) => mediaCommand('volume', Number(event.target.value))}
          />
          {mediaState.error && <span className="present-media-error">媒体无法播放</span>}
        </div>
      )}

      <button
        className={`present-roam-toggle ${roam ? 'is-on' : ''}`}
        onClick={toggleRoam}
        aria-pressed={roam}
        title="按 M 切换漫游模式"
      >
        <Icon name="focus" size={15} />
        {roam ? '退出漫游' : '空间漫游'}
      </button>

      {roam && (
        <div className="present-roam-hint">
          <span>
            <b>W / S</b> 前进 / 后退
          </span>
          <span>
            <b>A / D</b> 左移 / 右移
          </span>
          <span>
            <b>Q / E</b> 下降 / 上升
          </span>
          <span>
            <b>拖拽 / 滚轮</b> 转向 / 推拉
          </span>
          <span>
            <b>R</b> 回到路径
          </span>
          <span>
            <b>Esc</b> 退出演示
          </span>
        </div>
      )}

      {hint && (
        <div className="present-hint">
          <span>
            <b>单击 / →</b> 下一个视点
          </span>
          <span>
            <b>双击 / R</b> 回到路径
          </span>
          <span>
            <b>拖拽 / 滚轮</b> 自由浏览
          </span>
          <span>
            <b>M</b> 空间漫游
          </span>
          <span>
            <b>N</b> 备注
          </span>
          <span className="present-hint-touch">
            <b>左右滑动</b> 切换视点
          </span>
          <span>
            <b>Esc</b> 退出
          </span>
        </div>
      )}

      {notesOpen && (
        <aside className="present-notes" aria-label="演讲者备注">
          <div className="present-notes-head">
            <span>演讲者备注 · {currentFrame?.name ?? '自由视图'}</span>
            <button className="icon-btn" onClick={() => setNotesOpen(false)} aria-label="关闭备注">
              <Icon name="close" size={13} />
            </button>
          </div>
          {currentFrame?.notes ? (
            <p>{currentFrame.notes}</p>
          ) : (
            <p className="is-empty">该视点还没有备注。可在编辑器的「视点属性」里补充。</p>
          )}
        </aside>
      )}

      {showFullscreenNote && (
        <div className="present-note">
          <Icon name="alert" size={14} />
          <span>浏览器阻止了全屏，按 Esc 退出演示。</span>
          <button className="icon-btn" onClick={() => setShowFullscreenNote(false)} aria-label="关闭提示">
            <Icon name="close" size={13} />
          </button>
        </div>
      )}

      {deck.frames.length === 0 && (
        <div className="present-empty-path">作品还没有视点，当前为自由展示视图。</div>
      )}
    </div>,
    document.body,
  );
}
