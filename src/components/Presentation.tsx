import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { Deck, ViewState } from '../types';
import { Stage, type StageApi } from './Stage';
import { Icon } from './Icon';

const HINT_KEY = '3d-slide:present-hint-seen';

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
  const hadFullscreen = useRef(Boolean(document.fullscreenElement));
  const reduced = useRef(
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  const [index, setIndex] = useState(startIndex);
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) !== '1';
    } catch {
      return true;
    }
  });
  const [showFullscreenNote, setShowFullscreenNote] = useState(fullscreenFailed);
  const [cursorHidden, setCursorHidden] = useState(false);

  indexRef.current = index;

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

  const go = (delta: 1 | -1) => {
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

  const returnToPath = () => {
    if (busy.current || exiting.current) return;
    const frame = indexRef.current >= 0 ? deck.frames[indexRef.current] : null;
    void flyTo(frame?.view ?? entryView, 0.6);
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
      if (event.key === 'Escape') {
        event.preventDefault();
        finish();
      } else if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        go(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(-1);
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        returnToPath();
      }
    };
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
    document.addEventListener('fullscreenchange', fullscreenHandler);
    return () => {
      window.removeEventListener('keydown', handler);
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
      <div className="present-stage">
        <Stage
          ref={stageRef}
          deck={deck}
          mode="present"
          initialView={initialView}
          onStageClick={() => {
            if (busy.current) return;
            if (clickTimer.current) window.clearTimeout(clickTimer.current);
            clickTimer.current = window.setTimeout(() => go(1), 260);
          }}
          onStageDoubleClick={() => {
            if (clickTimer.current) window.clearTimeout(clickTimer.current);
            returnToPath();
          }}
        />
      </div>

      {deck.showProgress && <div className="present-progress">{progress}</div>}

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
            <b>Esc</b> 退出
          </span>
        </div>
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
