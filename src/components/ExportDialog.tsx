/**
 * ExportDialog.tsx —— 视频 / PNG 序列离线导出对话框
 *
 * 组件职责：
 * - 让用户选择导出方式（浏览器实时编码的视频文件，或 PNG 帧 + ZIP 序列）；
 * - 选择取景来源（当前视角固定时长，或按视点路径生成运镜时间线）、分辨率、帧率与格式；
 * - 在对话框内创建一个离屏 SceneManager，把 3D 场景渲染到画布并逐帧提供给编码器 / 截图器；
 * - 展示实时进度与状态，支持中途取消，并在关闭时释放渲染资源。
 *
 * 关键实现：
 * - 导出使用独立场景，不干扰编辑器中的交互场景；像素比固定为 1，直接按目标分辨率渲染；
 * - 生成的视频只有视频轨，所有媒体对象都会被静音，音频不会写入文件；
 * - 时间线由 pathTimeline 生成：每个视点前 45% 的时长用于缓动飞行，其余时间停留。
 *
 * 与其他模块的关系：
 * - 相机插值与缓动来自 lib/camera；
 * - 录制、截图与下载封装在 lib/exportVideo；
 * - 场景创建复用 three/SceneManager，以 present 模式渲染。
 */

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

// 可选导出分辨率；id 同时作为界面状态值与下拉框 value
const RESOLUTIONS = [
  { id: '720', label: '1280 × 720 · HD', width: 1280, height: 720 },
  { id: '1080', label: '1920 × 1080 · Full HD', width: 1920, height: 1080 },
  { id: '1440', label: '2560 × 1440 · 2K', width: 2560, height: 1440 },
  { id: '2160', label: '3840 × 2160 · 4K', width: 3840, height: 2160 },
];

// 可选帧率；以字符串保存，直接传给 Segmented 与 Number() 转换
const FPS_OPTIONS = [
  { value: '24', label: '24' },
  { value: '30', label: '30' },
  { value: '60', label: '60' },
];

/** 取景来源：path 按视点路径运镜，current 固定当前视角。 */
type Source = 'path' | 'current';
/** 导出产物类型：video 视频文件，png PNG 帧序列（ZIP 打包）。 */
type Kind = 'video' | 'png';

/**
 * 导出时间线：总时长 + 按时间取对应相机视角的函数。
 * 导出器每帧只需调用 at(elapsed) 即可得到该时刻的取景。
 */
interface Timeline {
  total: number;
  at: (time: number) => ViewState;
}

/** 深拷贝视角，避免导出过程中修改到原对象（尤其 target 是嵌套对象）。 */
function copyView(view: ViewState): ViewState {
  return { ...view, target: { ...view.target } };
}

/**
 * 按帧顺序生成相机时间线。
 *
 * 每个视点的时长至少 1.5 秒；进入第 n 个视点时，用该段前 45% 的时间
 * 从上一个视点缓动插值到目标视点，剩余 55% 保持不动（给观众阅读内容）。
 * 第一个视点没有前驱，整段都停留在它自身的取景。
 * 没有视点时返回 null，由调用方回退到固定视角时间线。
 *
 * @param frames 视点列表（已按演示顺序排列）
 * @returns 时间线对象；无帧时为 null
 */
function pathTimeline(frames: Frame[]): Timeline | null {
  if (frames.length === 0) return null;
  const durations = frames.map((frame) => Math.max(1.5, Number.isFinite(frame.duration) ? frame.duration : 1));
  const starts: number[] = [];
  let total = 0;
  for (const duration of durations) {
    starts.push(total);
    total += duration;
  }
  /**
   * 取指定时刻的视角。
   * 先把时间夹在 [0, total]；再定位所在视点段；段内前 45% 做 from->to 的缓动插值，
   * 之后的 55% 直接返回目标视点视角。
   */
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
  /** 要导出的作品（对象、背景与视点路径）。 */
  deck: Deck;
  /** 打开对话框时的当前取景；选择「当前视角」时使用。 */
  view: ViewState;
  /** 关闭对话框。 */
  onClose: () => void;
}

/**
 * 导出对话框主组件。
 *
 * @param deck 要导出的作品
 * @param view 当前编辑器取景（固定视角导出的来源）
 * @param onClose 关闭对话框
 *
 * 导出参数状态：
 * - source 取景来源；resolutionId 目标分辨率；fps 帧率；
 * - kind 导出方式；formatId 视频封装格式；holdSeconds 固定视角的时长（秒）。
 */
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

  // 离屏场景挂载容器；managerRef 保存场景实例；abortRef 用于取消录制 / 渲染
  const hostRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<SceneManager | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 当前选中的分辨率与视频格式；找不到时回退到默认项，保证导出始终有有效参数
  const resolution = RESOLUTIONS.find((item) => item.id === resolutionId) ?? RESOLUTIONS[1];
  const format = formats.find((item) => item.id === formatId) ?? formats[0] ?? null;

  // 根据取景来源实时生成导出时间线：路径模式优先，路径不可用时回退到固定视角
  const timeline = useMemo<Timeline>(() => {
    if (source === 'path') {
      const path = pathTimeline(deck.frames);
      if (path) return path;
    }
    return { total: holdSeconds, at: () => copyView(view) };
  }, [source, deck.frames, holdSeconds, view]);

  // 卸载时兜底释放：取消进行中的导出并销毁离屏场景，避免 WebGL 上下文泄漏
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      managerRef.current?.dispose();
      managerRef.current = null;
    };
  }, []);

  /**
   * 关闭按钮：导出进行中时先发出取消信号并提示「正在取消」，
   * 等导出流程自身清理完成后再真正关闭，避免直接关掉仍在写画布的渲染器。
   */
  const handleClose = () => {
    if (busy) {
      abortRef.current?.abort();
      setStatus('正在取消…');
      return;
    }
    onClose();
  };

  /**
   * 开始导出。
   *
   * 流程：
   * 1. 创建离屏 SceneManager（autoStart=false，避免额外渲染循环），按目标分辨率 resize；
   * 2. 同步作品数据、静音所有媒体、渲染首帧并等待素材就绪（最多 3.5 秒）；
   * 3. 视频模式：recordCanvas 实时录制，每帧用 timeline 更新相机并重渲染；
   *    PNG 模式：renderPngSequence 逐帧离线渲染并打包 ZIP；
   * 4. 校验取消信号后下载文件并提示大小 / 帧数；
   * 5. finally 中统一销毁场景、清空容器并解除忙碌态。
   *
   * 参数取值：分辨率决定输出宽高；fps 决定录制 / 采样帧率；
   * format 决定编码器与文件扩展名；totalDuration 为时间线总时长（最少 0.5 秒）。
   */
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

  // 底部提示：预计时长与视点数；PNG 序列超过 1800 帧时提示会被截断
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
