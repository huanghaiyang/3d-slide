/**
 * MediaPlayer.tsx —— 场景内媒体对象的浮动播放条
 *
 * 组件职责：
 * - 当场景中的视频 / 音频对象被选中时，在画布上叠加一个轻量播放器；
 * - 显示媒体类型、名称、当前时间 / 总时长、播放暂停、进度、静音与音量；
 * - 解码失败时给出不可播放的提示。
 *
 * 主要交互：
 * - 播放器的位置与宽度由父组件按对象在屏幕上的投影计算，通过 left/top/width 传入；
 * - 所有操作（播放暂停、拖动进度、调音量、静音、关闭）都只是回调，
 *   真正的媒体控制由 SceneManager 持有的 HTMLMediaElement 完成；
 * - 播放器自身阻止指针事件冒泡，避免在播放条上拖动 / 双击时误触场景的选择或聚焦。
 *
 * 与其他模块的关系：
 * - 状态类型 MediaPlaybackState 来自 three/SceneManager，由其定时推送；
 * - 时间格式化复用 lib/media 的 formatDuration，图标来自 Icon。
 */

import { formatDuration } from '../lib/media';
import type { MediaPlaybackState } from '../three/SceneManager';
import { Icon } from './Icon';

interface MediaPlayerProps {
  /** 播放器左边缘位置（相对画布容器，像素）。 */
  left: number;
  /** 播放器上边缘位置（相对画布容器，像素）。 */
  top: number;
  /** 播放器宽度（像素），通常与对应媒体对象的屏幕投影宽度一致。 */
  width: number;
  /** 媒体对象名称，用于标题展示。 */
  name: string;
  /** 由 SceneManager 推送的播放状态快照。 */
  state: MediaPlaybackState;
  /** 播放 / 暂停切换。 */
  onToggle: () => void;
  /** 拖动进度条：参数为秒数。 */
  onSeek: (time: number) => void;
  /** 调整音量：参数为 0 ~ 100 的百分比。 */
  onVolume: (volume: number) => void;
  /** 切换静音。 */
  onToggleMute: () => void;
  /** 收起播放器（不影响媒体本身的播放状态）。 */
  onClose: () => void;
}

/**
 * 媒体浮动播放器。
 *
 * 纯展示组件：不持有播放状态，也不直接操作媒体元素；
 * 进度与音量均受控于传入的 state，事件通过回调上抛。
 *
 * @param props 见 MediaPlayerProps
 */
export function MediaPlayer({
  left,
  top,
  width,
  name,
  state,
  onToggle,
  onSeek,
  onVolume,
  onToggleMute,
  onClose,
}: MediaPlayerProps) {
  // duration 未知（元数据未就绪）时为 0，这里兜底为 0.1 以免 range 的 max 与 min 相等；
  // 当前时间截断到 max，防止元数据切换瞬间出现 value 越界
  const max = Math.max(0.1, state.duration);
  const time = Math.min(state.time, max);
  return (
    <div
      className="media-player"
      style={{ left, top, width }}
      // 阻止指针与双击事件冒泡到画布，避免拖动进度条时触发场景的选择 / 聚焦
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="media-player-head">
        {/* 类型徽标：视频 / 音频分别用不同底色与图标 */}
        <span className={`media-player-kind is-${state.kind}`}>
          <Icon name={state.kind === 'video' ? 'video' : 'audio'} size={13} />
          {state.kind === 'video' ? '视频' : '音频'}
        </span>
        <b title={name}>{name}</b>
        <button className="icon-btn media-player-close" onClick={onClose} aria-label="收起播放器">
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="media-player-row">
        {/* 播放 / 暂停按钮：图标与无障碍文案都随 playing 状态切换 */}
        <button
          className="media-play"
          onClick={onToggle}
          aria-label={state.playing ? '暂停' : '播放'}
          title={state.playing ? '暂停' : '播放'}
        >
          <Icon name={state.playing ? 'pause' : 'play'} size={15} />
        </button>
        <span className="media-time">{formatDuration(time)}</span>
        {/* 进度条：受控于 state.time，拖动时立即回调 onSeek（秒） */}
        <input
          className="media-seek"
          type="range"
          min={0}
          max={max}
          step={0.05}
          value={time}
          aria-label="播放进度"
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        {/* 右侧总时长直接使用元数据 duration；未知时 formatDuration 返回 --:-- */}
        <span className="media-time">{formatDuration(state.duration)}</span>
        {/* 静音按钮：静音或音量为 0 时都显示带斜线的扬声器图标 */}
        <button
          className="icon-btn media-mute"
          onClick={onToggleMute}
          aria-label={state.muted ? '取消静音' : '静音'}
          title={state.muted ? '取消静音' : '静音'}
        >
          <Icon name={state.muted || state.volume === 0 ? 'volumeOff' : 'volume'} size={15} />
        </button>
        {/* 音量条：0 ~ 100；静音时显示为 0，但实际音量值仍保留，取消静音即可恢复 */}
        <input
          className="media-volume"
          type="range"
          min={0}
          max={100}
          value={state.muted ? 0 : state.volume}
          aria-label="音量"
          onChange={(event) => onVolume(Number(event.target.value))}
        />
      </div>
      {/* 解码失败 / 素材缺失时由 SceneManager 置位 error */}
      {state.error && <div className="media-player-error">该媒体无法解码或缺少素材</div>}
    </div>
  );
}
