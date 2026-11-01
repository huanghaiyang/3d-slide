import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { Deck, ViewState } from '../types';
import { DEFAULT_HOLD } from '../lib/constants';
import type { MediaPlaybackState } from '../three/SceneManager';
import { Stage, type StageApi } from './Stage';
import { Icon } from './Icon';

const HINT_KEY = '3d-slide:present-hint-seen';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

interface PresentationProps {
  deck: Deck;
  startIndex: number;
  entryView: ViewState;
  fullscreenFailed: boolean;
  onExit: (finalView: ViewState, frameId: string | null) => void;
}

export function Presentation({ deck, startIndex, entryView, fullscreenFailed, onExit }: PresentationProps) {
  const stageRef = useRef<StageApi>(null);
  const indexRef = useRef(startIndex);
  const busy = useRef(false);
  const exiting = useRef(false);
  const clickTimer = useRef<number>();
  const hideTimer = useRef<number>();
  const pressedKeys = useRef<Set<string>>(new Set());
  const roamRef = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(0);
  const hadFullscreen = useRef(Boolean(document.fullscreenElement));
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
  const savedViewRef = useRef<ViewState | null>(null);
  const mediaItems = deck.objects.filter(
    (object) => object.type === 'video' || object.type === 'audio',
  ) as { id: string; name: string; type: 'video' | 'audio' }[];
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeMedia = activeId ?? mediaItems[0]?.id ?? null;

  indexRef.current = index;
  roamRef.current = roam;

  const currentFrame = index >= 0 ? deck.frames[index] : null;
  const initialView = currentFrame?.view ?? entryView;

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

  const flyTo = async (view: ViewState, duration: number) => {
    const manager = stageRef.current;
    if (!manager) return;
    busy.current = true;
    await manager.flyTo(view, reduced.current ? 0.01 : duration);
    busy.current = false;
  };

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

  const returnToPath = () => {
    setPlaying(false);
    if (busy.current || exiting.current) return;
    const frame = indexRef.current >= 0 ? deck.frames[indexRef.current] : null;
    void flyTo(frame?.view ?? entryView, 0.6);
  };

  const toggleRoam = () => {
    if (exiting.current) return;
    setPlaying(false);
    pressedKeys.current.clear();
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    setRoam((value) => !value);
  };

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

  useEffect(() => {
    let alive = true;
    void stageRef.current?.getXRSupported().then((supported) => {
      if (alive) setXrSupported(supported);
    });
    return () => {
      alive = false;
    };
  }, []);

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

  useEffect(() => {
    return () => {
      void stageRef.current?.exitXR();
    };
  }, []);

  const toggleLens = () => {
    const next = !lens;
    setLens(next);
    stageRef.current?.setLens(next ? 'fisheye' : 'none', 0.45);
  };

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
