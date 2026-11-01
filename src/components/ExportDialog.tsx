import { useEffect, useMemo, useRef, useState } from 'react';
import type { Deck, Frame, ViewState } from '../types';
import { easeInOut, lerpView } from '../lib/camera';
import {
  availableVideoFormats,
  downloadBlob,
  filenameFor,
  recordCanvas,
  renderPngSequence,
  type VideoFormat,
} from '../lib/exportVideo';
import { formatBytes } from '../lib/image';
import { SceneManager } from '../three/SceneManager';
import { toast } from '../store/uiStore';
import { FieldBlock, Modal, Segmented } from './ui';
import { Icon } from './Icon';

const RESOLUTIONS = [
  { id: '720', label: '1280 × 720 · HD', width: 1280, height: 720 },
  { id: '1080', label: '1920 × 1080 · Full HD', width: 1920, height: 1080 },
  { id: '1440', label: '2560 × 1440 · 2K', width: 2560, height: 1440 },
  { id: '2160', label: '3840 × 2160 · 4K', width: 3840, height: 2160 },
];

const FPS_OPTIONS = [
  { value: '24', label: '24' },
  { value: '30', label: '30' },
  { value: '60', label: '60' },
];

type Source = 'path' | 'current';
type Kind = 'video' | 'png';

interface Timeline {
  total: number;
  at: (time: number) => ViewState;
}

function copyView(view: ViewState): ViewState {
  return { ...view, target: { ...view.target } };
}

/** 按帧顺序生成相机时间线：进入新视点用段前 45% 的时间做缓动飞行，其余时间停留 */
function pathTimeline(frames: Frame[]): Timeline | null {
  if (frames.length === 0) return null;
  const durations = frames.map((frame) => Math.max(1.5, Number.isFinite(frame.duration) ? frame.duration : 1));
  const starts: number[] = [];
  let total = 0;
  for (const duration of durations) {
    starts.push(total);
    total += duration;
  }
  const at = (time: number): ViewState => {
    const t = Math.max(0, Math.min(total, time));
    let index = durations.length - 1;
    for (let i = 0; i < durations.length; i += 1) {
      if (t < starts[i] + durations[i]) {
        index = i;
        break;
      }
    }
    const local = (t - starts[index]) / durations[index];
    const to = frames[index].view;
    if (index === 0 || local >= 0.45) return copyView(to);
    const from = frames[index - 1].view;
    return lerpView(from, to, easeInOut(local / 0.45));
  };
  return { total, at };
}

interface ExportDialogProps {
  deck: Deck;
  view: ViewState;
  onClose: () => void;
}

export function ExportDialog({ deck, view, onClose }: ExportDialogProps) {
  const formats = useMemo<VideoFormat[]>(() => availableVideoFormats(), []);
  const [source, setSource] = useState<Source>(deck.frames.length > 0 ? 'path' : 'current');
  const [resolutionId, setResolutionId] = useState('1080');
  const [fps, setFps] = useState('30');
  const [kind, setKind] = useState<Kind>(formats.length > 0 ? 'video' : 'png');
  const [formatId, setFormatId] = useState(formats[0]?.id ?? '');
  const [holdSeconds, setHoldSeconds] = useState(8);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');

  const hostRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<SceneManager | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const resolution = RESOLUTIONS.find((item) => item.id === resolutionId) ?? RESOLUTIONS[1];
  const format = formats.find((item) => item.id === formatId) ?? formats[0] ?? null;

  const timeline = useMemo<Timeline>(() => {
    if (source === 'path') {
      const path = pathTimeline(deck.frames);
      if (path) return path;
    }
    return { total: holdSeconds, at: () => copyView(view) };
  }, [source, deck.frames, holdSeconds, view]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      managerRef.current?.dispose();
      managerRef.current = null;
    };
  }, []);

  const handleClose = () => {
    if (busy) {
      abortRef.current?.abort();
      setStatus('正在取消…');
      return;
    }
    onClose();
  };

  const start = async () => {
    const host = hostRef.current;
    if (!host || busy) return;
    if (deck.objects.length === 0) {
      toast('画板为空，没有可导出的内容', 'error');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const totalDuration = Math.max(0.5, timeline.total);
    setBusy(true);
    setProgress(0);
    setStatus('正在准备离屏场景…');
    let manager: SceneManager | null = null;

    try {
      host.innerHTML = '';
      const baseView = timeline.at(0);
      manager = new SceneManager(
        host,
        deck.background,
        baseView,
        'present',
        { onImageError: () => undefined },
        { autoStart: false },
      );
      managerRef.current = manager;
      manager.setPixelRatio(1);
      manager.resize(resolution.width, resolution.height);
      manager.setShowGrid(false);
      manager.sync(deck, [], 'present');
      for (const object of deck.objects) {
        if (object.type === 'video' || object.type === 'audio') manager.setMediaMuted(object.id, true);
      }
      manager.setView(baseView);
      manager.renderOnce();
      setStatus('正在等待素材就绪…');
      await manager.waitForAssets(3500);
      if (controller.signal.aborted) throw new Error('已取消导出');
      if (kind === 'video') {
        if (!format) throw new Error('当前浏览器没有可用的视频编码器，请选择 PNG 序列');
        setStatus('正在实时录制…');
        const blob = await recordCanvas(manager.getCanvas(), {
          mime: format.mime,
          fps: Number(fps),
          duration: totalDuration,
          width: resolution.width,
          height: resolution.height,
          signal: controller.signal,
          onFrame: (elapsed) => {
            manager?.setView(timeline.at(elapsed));
            manager?.renderOnce();
          },
          onProgress: (ratio) => {
            setProgress(ratio);
            setStatus(`正在实时录制… ${Math.round(ratio * 100)}%`);
          },
        });
        if (controller.signal.aborted) throw new Error('已取消导出');
        setStatus('正在封装文件…');
        const filename = filenameFor(deck.title, format.ext);
        downloadBlob(blob, filename);
        toast(`已导出 ${filename} · ${formatBytes(blob.size)}`, 'success');
        setProgress(1);
        setStatus(`已导出 · ${filename} · ${formatBytes(blob.size)}（画面仅含视频轨）`);
      } else {
        setStatus('正在逐帧离线渲染…');
        const result = await renderPngSequence(manager.getCanvas(), {
          fps: Number(fps),
          duration: totalDuration,
          signal: controller.signal,
          onFrame: (time) => {
            manager?.setView(timeline.at(time));
            manager?.renderOnce();
          },
          onProgress: (ratio, frame, total) => {
            setProgress(ratio);
            setStatus(`正在离线渲染 · 第 ${frame} / ${total} 帧`);
          },
        });
        if (controller.signal.aborted) throw new Error('已取消导出');
        const filename = filenameFor(`${deck.title}_frames`, 'zip');
        downloadBlob(result.blob, filename);
        toast(`已导出 ${result.frames} 帧 PNG 序列`, 'success');
        setProgress(1);
        setStatus(`已导出 ${result.frames} 帧 · ${result.width} × ${result.height} · ${formatBytes(result.blob.size)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出失败';
      setStatus(message === '已取消导出' ? '已取消' : `导出失败：${message}`);
      if (message !== '已取消导出') toast(message, 'error');
      setProgress(0);
    } finally {
      manager?.dispose();
      managerRef.current = null;
      host.innerHTML = '';
      abortRef.current = null;
      setBusy(false);
    }
  };

  const estimateLabel =
    source === 'path' && deck.frames.length > 0
      ? `约 ${timeline.total.toFixed(1)} 秒 · ${deck.frames.length} 个视点`
      : `约 ${Math.max(0.5, timeline.total).toFixed(1)} 秒`;
  const estimatedFrames = Math.round(Number(fps) * Math.max(0.5, timeline.total));
  const sequenceTruncated = kind === 'png' && estimatedFrames > 1800;

  return (
    <Modal
      title="导出视频"
      eyebrow="OFFLINE RENDER"
      width={600}
      onClose={handleClose}
      footer={
        <>
          <span className="export-foot-note">{estimateLabel}</span>
          <button className="btn btn-ghost" onClick={handleClose}>
            {busy ? '取消导出' : '关闭'}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>
            <Icon name="video" size={15} />
            {busy ? '导出中…' : '开始导出'}
          </button>
        </>
      }
    >
      <div className="export-preview">
        <div ref={hostRef} className="export-canvas-host" aria-hidden="true" />
        {busy && (
          <div className="export-progress">
            <div className="export-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
      {status && <div className={`export-status${status.startsWith('导出失败') ? ' is-error' : ''}`}>{status}</div>}

      <div className="export-grid">
        <FieldBlock label="取景来源">
          <Segmented
            value={source}
            ariaLabel="取景来源"
            disabled={busy}
            options={[
              { value: 'current', label: '当前视角' },
              { value: 'path', label: deck.frames.length > 0 ? `演示路径 ${deck.frames.length}` : '演示路径 0' },
            ]}
            onChange={(next) => {
              if (next === 'path' && deck.frames.length === 0) {
                toast('还没有捕获任何视点', 'info');
                return;
              }
              setSource(next);
            }}
          />
        </FieldBlock>

        {source === 'current' && (
          <FieldBlock label="时长">
            <div className="slider-row">
              <span className="field-label">秒</span>
              <input
                type="range"
                min={2}
                max={30}
                step={1}
                value={holdSeconds}
                disabled={busy}
                aria-label="导出时长"
                onChange={(event) => setHoldSeconds(Number(event.target.value))}
              />
              <span className="export-value">{holdSeconds.toFixed(1)}s</span>
            </div>
          </FieldBlock>
        )}

        <FieldBlock label="分辨率">
          <select
            className="select export-select"
            value={resolutionId}
            disabled={busy}
            aria-label="导出分辨率"
            onChange={(event) => setResolutionId(event.target.value)}
          >
            {RESOLUTIONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </FieldBlock>

        <FieldBlock label="帧率">
          <Segmented
            value={fps}
            ariaLabel="帧率"
            disabled={busy}
            options={FPS_OPTIONS}
            onChange={setFps}
          />
        </FieldBlock>

        <FieldBlock label="导出方式">
          <Segmented
            value={kind}
            ariaLabel="导出方式"
            disabled={busy}
            options={[
              { value: 'video', label: '视频文件' },
              { value: 'png', label: 'PNG 序列' },
            ]}
            onChange={(next) => {
              if (next === 'video' && !format) {
                toast('当前浏览器不支持直接录制视频编码，请使用 PNG 序列', 'error');
                return;
              }
              setKind(next);
            }}
          />
        </FieldBlock>

        {kind === 'video' ? (
          <FieldBlock label="视频格式" hint={formats.length === 0 ? '当前浏览器没有可用的视频编码器' : undefined}>
            <select
              className="select export-select"
              value={format?.id ?? ''}
              disabled={busy || formats.length === 0}
              aria-label="视频格式"
              onChange={(event) => setFormatId(event.target.value)}
            >
              {formats.length === 0 && <option value="">无可用编码</option>}
              {formats.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · .{item.ext}
                </option>
              ))}
            </select>
          </FieldBlock>
        ) : (
          <FieldBlock label="序列格式">
            <span className="export-value is-block">
              PNG 帧 + ZIP 打包，可用 ffmpeg 等工具转成任意格式
            </span>
          </FieldBlock>
        )}
      </div>

      <p className="export-hint">
        视频导出由浏览器的实时编码器完成，因此可用格式取决于当前浏览器；需要任意格式时，请选择 PNG 序列再自行转码。
        音轨不会被写入文件，视频与音频对象会按自身播放状态出现在画面中。
        {sequenceTruncated && (
          <strong> 当前设置约 {estimatedFrames} 帧，超过 PNG 序列 1800 帧上限，超出部分会被截断。</strong>
        )}
      </p>
    </Modal>
  );
}
