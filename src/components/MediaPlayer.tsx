import { formatDuration } from '../lib/media';
import type { MediaPlaybackState } from '../three/SceneManager';
import { Icon } from './Icon';

interface MediaPlayerProps {
  left: number;
  top: number;
  width: number;
  name: string;
  state: MediaPlaybackState;
  onToggle: () => void;
  onSeek: (time: number) => void;
  onVolume: (volume: number) => void;
  onToggleMute: () => void;
  onClose: () => void;
}

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
  const max = Math.max(0.1, state.duration);
  const time = Math.min(state.time, max);
  return (
    <div
      className="media-player"
      style={{ left, top, width }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="media-player-head">
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
        <button
          className="media-play"
          onClick={onToggle}
          aria-label={state.playing ? '暂停' : '播放'}
          title={state.playing ? '暂停' : '播放'}
        >
          <Icon name={state.playing ? 'pause' : 'play'} size={15} />
        </button>
        <span className="media-time">{formatDuration(time)}</span>
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
        <span className="media-time">{formatDuration(state.duration)}</span>
        <button
          className="icon-btn media-mute"
          onClick={onToggleMute}
          aria-label={state.muted ? '取消静音' : '静音'}
          title={state.muted ? '取消静音' : '静音'}
        >
          <Icon name={state.muted || state.volume === 0 ? 'volumeOff' : 'volume'} size={15} />
        </button>
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
      {state.error && <div className="media-player-error">该媒体无法解码或缺少素材</div>}
    </div>
  );
}
