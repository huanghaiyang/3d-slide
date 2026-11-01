import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AudioObject,
  Deck,
  ImageObject,
  LottieObject,
  ModelObject,
  ShapeObject,
  SlideObject,
  SvgObject,
  TextObject,
  VideoObject,
} from '../types';
import { LIMITS, DEFAULT_HOLD } from '../lib/constants';
import { formatDuration } from '../lib/media';
import { useDeckStore } from '../store/deckStore';
import { FONT_LABELS, MODEL_FORMAT_LABELS, OBJECT_LABELS, SHAPE_LABELS } from '../types';
import { Icon } from './Icon';
import { ColorField, NumberField, Segmented, Switch } from './ui';

interface InspectorProps {
  readonly: boolean;
  onReplaceImage: (id: string) => void;
  onReplaceMedia: (id: string) => void;
  onReplaceModel: (id: string) => void;
  onReplaceLottie: (id: string) => void;
  onUpdateFrameView: (id: string) => void;
}

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="prop-section">
      <div className="prop-section-head">
        <span>{title}</span>
        {extra}
      </div>
      {children}
    </section>
  );
}

function TextValueField({
  value,
  maxLength,
  ariaLabel,
  placeholder,
  disabled,
  onCommit,
}: {
  value: string;
  maxLength: number;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(value);
      return;
    }
    if (trimmed !== value) onCommit(trimmed.slice(0, maxLength));
  };

  return (
    <input
      className="text-input"
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      onFocus={(event) => {
        focused.current = true;
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className={`slider-row ${disabled ? 'is-disabled' : ''}`}>
      <span className="field-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className="slider-number">
        <NumberField value={value} min={min} max={max} step={step} unit={unit} disabled={disabled} onCommit={onChange} />
      </div>
    </div>
  );
}

const BACKGROUND_PRESETS = ['#10161F', '#171A21', '#1B2A2A', '#F5F2EC', '#E9E2D4'];

function DeckPanel({ deck, readonly }: { deck: Deck; readonly: boolean }) {
  const updateDeckSettings = useDeckStore((state) => state.updateDeckSettings);
  return (
    <div className="inspector-body">
      <div className="inspector-head">
        <div>
          <div className="pane-label">作品设置</div>
          <div className="pane-sub">未选中内容对象</div>
        </div>
        <span className="inspector-badge">DECK</span>
      </div>
      <fieldset className="inspector-fieldset" disabled={readonly}>
        <Section title="舞台背景">
          <div className="preset-swatches">
            {BACKGROUND_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                className={`swatch ${deck.background.toLowerCase() === color.toLowerCase() ? 'is-active' : ''}`}
                style={{ background: color }}
                aria-label={`背景色 ${color}`}
                title={color}
                onClick={() => updateDeckSettings({ background: color }, 'deck-bg')}
              />
            ))}
          </div>
          <ColorField
            value={deck.background}
            ariaLabel="舞台背景色"
            onChange={(color) => updateDeckSettings({ background: color }, 'deck-bg')}
          />
        </Section>
        <Section title="演示">
          <div className="prop-row">
            <span className="field-label">默认过渡</span>
            <div className="prop-inline">
              <NumberField
                value={deck.defaultDuration}
                min={LIMITS.minDuration}
                max={LIMITS.maxDuration}
                step={0.1}
                unit="秒"
                ariaLabel="默认过渡时长"
                onCommit={(value) => updateDeckSettings({ defaultDuration: value }, 'deck-duration')}
              />
            </div>
          </div>
          <div className="prop-row">
            <span className="field-label">显示视点进度</span>
            <Switch
              checked={deck.showProgress}
              label="显示视点进度"
              onChange={(checked) => updateDeckSettings({ showProgress: checked })}
            />
          </div>
          <span className="field-hint">新建视点会继承默认过渡时长，之后可单独调整。</span>
        </Section>
      </fieldset>
      <Section title="作品概览">
        <div className="stat-grid">
          <div>
            <b>{deck.objects.length}</b>
            <span>内容对象</span>
          </div>
          <div>
            <b>{deck.frames.length}</b>
            <span>视点</span>
          </div>
          <div>
            <b>{deck.objects.filter((object) => !object.visible).length}</b>
            <span>隐藏</span>
          </div>
        </div>
      </Section>
      <div className="inspector-tip">
        <Icon name="spark" size={14} />
        <span>在空白处拖拽可平移，Alt + 拖拽环绕，滚轮缩放。捕获当前视图后，它才会成为视点。</span>
      </div>
    </div>
  );
}

function TextFields({ object }: { object: TextObject }) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const removeObject = useDeckStore((state) => state.removeObject);
  const key = (field: string) => `${object.id}:${field}`;

  return (
    <>
      <Section title="文本">
        <textarea
          className="text-input text-area"
          rows={4}
          maxLength={LIMITS.textChars}
          value={object.text}
          aria-label="文本内容"
          onChange={(event) => updateObject(object.id, { text: event.target.value }, key('text'))}
          onBlur={() => {
            if (!object.text.trim()) removeObject(object.id);
          }}
        />
        <span className="field-hint">
          {object.text.length}/{LIMITS.textChars} · 高度随行数自动增长
        </span>
      </Section>
      <Section title="字体">
        <div className="prop-row">
          <span className="field-label">字体</span>
          <select
            className="select"
            value={object.font}
            aria-label="字体预设"
            onChange={(event) => updateObject(object.id, { font: event.target.value as TextObject['font'] })}
          >
            {(Object.keys(FONT_LABELS) as TextObject['font'][]).map((font) => (
              <option key={font} value={font}>
                {FONT_LABELS[font]}
              </option>
            ))}
          </select>
        </div>
        <div className="prop-row">
          <span className="field-label">字号</span>
          <NumberField
            value={object.fontSize}
            min={LIMITS.minFontSize}
            max={LIMITS.maxFontSize}
            step={1}
            unit="px"
            ariaLabel="字号"
            onCommit={(value) => updateObject(object.id, { fontSize: value }, key('fontSize'))}
          />
        </div>
        <div className="prop-row">
          <span className="field-label">加粗</span>
          <Switch
            checked={object.bold}
            label="文本加粗"
            onChange={(checked) => updateObject(object.id, { bold: checked })}
          />
        </div>
        <div className="prop-row">
          <span className="field-label">对齐</span>
          <Segmented
            value={object.align}
            ariaLabel="文本对齐"
            options={[
              { value: 'left', label: '左' },
              { value: 'center', label: '中' },
              { value: 'right', label: '右' },
            ]}
            onChange={(align) => updateObject(object.id, { align })}
          />
        </div>
        <ColorField
          label="字色"
          value={object.color}
          ariaLabel="文本颜色"
          onChange={(color) => updateObject(object.id, { color }, key('color'))}
        />
        <div className="prop-row">
          <span className="field-label">行高</span>
          <NumberField
            value={object.lineHeight}
            min={LIMITS.minLineHeight}
            max={LIMITS.maxLineHeight}
            step={0.05}
            ariaLabel="行高"
            onCommit={(value) => updateObject(object.id, { lineHeight: value }, key('lineHeight'))}
          />
        </div>
      </Section>
      <Section title="3D 文本">
        <SliderRow
          label="挤出厚度"
          value={object.depth3d ?? 0}
          min={0}
          max={LIMITS.maxTextDepth}
          step={1}
          unit="px"
          onChange={(depth3d) => updateObject(object.id, { depth3d }, key('depth3d'))}
        />
        <span className="field-hint">厚度大于 0 时文字生成实体侧面，配合绕 X / Y 轴倾斜获得立体效果。</span>
      </Section>
    </>
  );
}

function ImageFields({ object, onReplaceImage }: { object: ImageObject; onReplaceImage: (id: string) => void }) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const removeObject = useDeckStore((state) => state.removeObject);
  const retryImage = useDeckStore((state) => state.retryImage);
  const error = useDeckStore((state) => state.imageErrors[object.id]);

  return (
    <>
      <Section title="图片">
        <div className="image-preview">
          <img src={object.src} alt={object.name} />
        </div>
        <div className="button-row">
          <button className="btn btn-light btn-sm" onClick={() => onReplaceImage(object.id)}>
            <Icon name="upload" size={14} /> 替换图片
          </button>
          <button className="btn btn-light btn-sm" onClick={() => retryImage(object.id)}>
            <Icon name="reset" size={14} /> 重新加载
          </button>
        </div>
        <div className="button-row">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              updateObject(object.id, {
                width: object.naturalWidth,
                height: object.naturalHeight,
              })
            }
          >
            <Icon name="focus" size={14} /> 还原原始尺寸
          </button>
        </div>
        <span className="field-hint">
          原始尺寸 {object.naturalWidth} × {object.naturalHeight}
        </span>
      </Section>
      {error && (
        <div className="image-error-box">
          <Icon name="alert" size={15} />
          <div>
            <b>图片无法加载</b>
            <p>{error}</p>
            <div className="button-row">
              <button className="btn btn-light btn-sm" onClick={() => retryImage(object.id)}>
                重试
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => onReplaceImage(object.id)}>
                替换
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => removeObject(object.id)}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
      <Section title="适配">
        <Segmented
          value={object.fit}
          ariaLabel="图片适配方式"
          options={[
            { value: 'contain', label: '完整显示' },
            { value: 'cover', label: '填充裁切' },
          ]}
          onChange={(fit) => updateObject(object.id, { fit })}
        />
        <div className="prop-row">
          <span className="field-label">锁定原始比例</span>
          <Switch
            checked={object.aspectLocked}
            label="锁定图片原始比例"
            onChange={(checked) => updateObject(object.id, { aspectLocked: checked })}
          />
        </div>
        <span className="field-hint">关闭锁定后，可在上方分别调整宽高。</span>
      </Section>
    </>
  );
}

function SvgFields({ object, onReplaceImage }: { object: SvgObject; onReplaceImage: (id: string) => void }) {
  const updateObject = useDeckStore((state) => state.updateObject);

  return (
    <Section title="SVG 图形">
      <div className="image-preview">
        <img src={object.src} alt={object.name} />
      </div>
      <div className="button-row">
        <button className="btn btn-light btn-sm" onClick={() => onReplaceImage(object.id)}>
          <Icon name="upload" size={14} /> 替换 SVG
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() =>
            updateObject(object.id, {
              width: object.naturalWidth,
              height: object.naturalHeight,
            })
          }
        >
          <Icon name="focus" size={14} /> 还原原始尺寸
        </button>
      </div>
      <span className="field-hint">
        矢量原始尺寸 {object.naturalWidth} × {object.naturalHeight} · 放大不失真
      </span>
      <Segmented
        value={object.fit}
        ariaLabel="SVG 适配方式"
        options={[
          { value: 'contain', label: '完整显示' },
          { value: 'cover', label: '填充裁切' },
        ]}
        onChange={(fit) => updateObject(object.id, { fit })}
      />
    </Section>
  );
}

function MediaFields({
  object,
  onReplaceMedia,
}: {
  object: VideoObject | AudioObject;
  onReplaceMedia: (id: string) => void;
}) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const retryImage = useDeckStore((state) => state.retryImage);
  const error = useDeckStore((state) => state.imageErrors[object.id]);
  const key = (field: string) => `${object.id}:${field}`;
  const canRestoreSize = object.type === 'video';

  return (
    <>
      <Section title={object.type === 'video' ? '视频' : '音频'}>
        <div className="media-meta">
          <div>
            <b>{formatDuration(object.duration)}</b>
            <span>时长</span>
          </div>
          {object.type === 'video' ? (
            <div>
              <b>
                {object.naturalWidth} × {object.naturalHeight}
              </b>
              <span>分辨率</span>
            </div>
          ) : (
            <div>
              <b>{formatBytesOf(object.src)}</b>
              <span>素材大小</span>
            </div>
          )}
        </div>
        <div className="button-row">
          <button className="btn btn-light btn-sm" onClick={() => onReplaceMedia(object.id)}>
            <Icon name="upload" size={14} /> 替换{object.type === 'video' ? '视频' : '音频'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => retryImage(object.id)}>
            <Icon name="reset" size={14} /> 重新加载
          </button>
        </div>
        {canRestoreSize && (
          <div className="button-row">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() =>
                updateObject(object.id, {
                  width: object.naturalWidth,
                  height: object.naturalHeight,
                })
              }
            >
              <Icon name="focus" size={14} /> 还原原始尺寸
            </button>
          </div>
        )}
        <span className="field-hint">双击舞台上的媒体可打开播放器；演示时按对象设置自动播放。</span>
      </Section>
      {error && (
        <div className="image-error-box">
          <Icon name="alert" size={15} />
          <div>
            <b>{object.type === 'video' ? '视频无法播放' : '音频无法播放'}</b>
            <p>{error}</p>
            <div className="button-row">
              <button className="btn btn-light btn-sm" onClick={() => retryImage(object.id)}>
                重试
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => onReplaceMedia(object.id)}>
                替换
              </button>
            </div>
          </div>
        </div>
      )}
      {object.type === 'video' && (
        <Section title="适配">
          <Segmented
            value={object.fit}
            ariaLabel="视频适配方式"
            options={[
              { value: 'contain', label: '完整显示' },
              { value: 'cover', label: '填充裁切' },
            ]}
            onChange={(fit) => updateObject(object.id, { fit })}
          />
        </Section>
      )}
      <Section title="播放">
        <div className="prop-row">
          <span className="field-label">循环播放</span>
          <Switch
            checked={object.loop}
            label="循环播放"
            onChange={(loop) => updateObject(object.id, { loop })}
          />
        </div>
        {object.type === 'video' && (
          <div className="prop-row">
            <span className="field-label">静音</span>
            <Switch
              checked={object.muted}
              label="静音播放"
              onChange={(muted) => updateObject(object.id, { muted })}
            />
          </div>
        )}
        <div className="prop-row">
          <span className="field-label">演示时自动播放</span>
          <Switch
            checked={object.autoplay}
            label="演示时自动播放"
            onChange={(autoplay) => updateObject(object.id, { autoplay })}
          />
        </div>
        <SliderRow
          label="音量"
          value={object.volume}
          min={0}
          max={100}
          step={1}
          unit="%"
          onChange={(volume) => updateObject(object.id, { volume }, key('volume'))}
        />
      </Section>
    </>
  );
}

function formatBytesOf(src: string): string {
  const size = src.length;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function ModelFields({
  object,
  onReplaceModel,
}: {
  object: ModelObject;
  onReplaceModel: (id: string) => void;
}) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const retryImage = useDeckStore((state) => state.retryImage);
  const error = useDeckStore((state) => state.imageErrors[object.id]);
  const key = (field: string) => `${object.id}:${field}`;
  return (
    <>
      <Section title="3D 模型">
        <div className="media-meta">
          <div>
            <b>{MODEL_FORMAT_LABELS[object.format]}</b>
            <span>格式</span>
          </div>
          <div>
            <b>{formatBytesOf(object.src)}</b>
            <span>素材大小</span>
          </div>
        </div>
        <div className="button-row">
          <button className="btn btn-light btn-sm" onClick={() => onReplaceModel(object.id)}>
            <Icon name="upload" size={14} /> 替换模型
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => retryImage(object.id)}>
            <Icon name="reset" size={14} /> 重新加载
          </button>
        </div>
        <div className="button-row">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => updateObject(object.id, { width: 760, height: 760 })}
          >
            <Icon name="focus" size={14} /> 重置包围盒
          </button>
        </div>
        <span className="field-hint">
          模型会按包围盒等比缩放并居中显示。修改 W / H 可整体放大或缩小。
        </span>
      </Section>
      {error && (
        <div className="image-error-box">
          <Icon name="alert" size={15} />
          <div>
            <b>模型无法加载</b>
            <p>{error}</p>
            <div className="button-row">
              <button className="btn btn-light btn-sm" onClick={() => retryImage(object.id)}>
                重试
              </button>
            </div>
          </div>
        </div>
      )}
      <Section title="展示">
        <div className="prop-row">
          <span className="field-label">自动旋转</span>
          <Switch
            checked={object.autoRotate}
            label="模型自动旋转"
            onChange={(autoRotate) => updateObject(object.id, { autoRotate })}
          />
        </div>
        {object.autoRotate && (
          <SliderRow
            label="旋转速度"
            value={object.rotateSpeed}
            min={0}
            max={360}
            step={5}
            unit="°/s"
            onChange={(rotateSpeed) => updateObject(object.id, { rotateSpeed }, key('rotateSpeed'))}
          />
        )}
        <span className="field-hint">OBJ / STL / PLY 等单文件模型可直接载入；带外部贴图的多文件模型请先打包为 GLB。</span>
      </Section>
    </>
  );
}

function ShapeFields({ object }: { object: ShapeObject }) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const key = (field: string) => `${object.id}:${field}`;
  const hasStroke = object.stroke !== null;
  return (
    <Section title="形状">
      <div className="shape-grid" role="group" aria-label="形状类型">
        {(Object.keys(SHAPE_LABELS) as ShapeObject['shape'][]).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`shape-chip${object.shape === kind ? ' is-active' : ''}`}
            onClick={() => {
              if (kind === 'line' && object.shape !== 'line') {
                const thickness = Math.max(6, object.strokeWidth || 0);
                updateObject(object.id, {
                  shape: kind,
                  height: thickness,
                  strokeWidth: thickness,
                  stroke: object.stroke ?? object.fill,
                });
                return;
              }
              if (kind !== 'line' && object.shape === 'line' && object.height < 20) {
                updateObject(object.id, { shape: kind, height: 340 });
                return;
              }
              updateObject(object.id, { shape: kind });
            }}
          >
            {SHAPE_LABELS[kind]}
          </button>
        ))}
      </div>
      {object.shape !== 'line' && (
        <ColorField
          label="填充"
          value={object.fill}
          ariaLabel="形状填充色"
          onChange={(fill) => updateObject(object.id, { fill }, key('fill'))}
        />
      )}
      {object.shape !== 'line' && (
        <div className="prop-row">
          <span className="field-label">描边</span>
          <Switch
            checked={hasStroke}
            label="显示描边"
            onChange={(checked) =>
              updateObject(object.id, { stroke: checked ? object.stroke ?? '#F3EEE4' : null })
            }
          />
        </div>
      )}
      {(object.shape === 'line' || hasStroke) && (
        <>
          <ColorField
            label="描边色"
            value={object.stroke ?? object.fill}
            ariaLabel="形状描边色"
            onChange={(stroke) => updateObject(object.id, { stroke }, key('stroke'))}
          />
          <div className="prop-row">
            <span className="field-label">描边宽度</span>
            <NumberField
              value={object.strokeWidth}
              min={object.shape === 'line' ? 1 : LIMITS.minStroke}
              max={LIMITS.maxStroke}
              step={1}
              unit="px"
              ariaLabel="描边宽度"
              onCommit={(strokeWidth) => updateObject(object.id, { strokeWidth }, key('strokeWidth'))}
            />
          </div>
        </>
      )}
      <span className="field-hint">
        {SHAPE_LABELS[object.shape]} · 填充色会保留，切换类型时不会丢失。
      </span>
    </Section>
  );
}

function LottieFields({
  object,
  onReplaceLottie,
}: {
  object: LottieObject;
  onReplaceLottie: (id: string) => void;
}) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const retryImage = useDeckStore((state) => state.retryImage);
  const error = useDeckStore((state) => state.imageErrors[object.id]);
  const key = (field: string) => `${object.id}:${field}`;
  return (
    <>
      <Section title="Lottie 动画">
        <div className="media-meta">
          <div>
            <b>{object.naturalWidth}×{object.naturalHeight}</b>
            <span>画布尺寸</span>
          </div>
          <div>
            <b>{object.duration > 0 ? `${object.duration.toFixed(1)} s` : '循环'}</b>
            <span>时长</span>
          </div>
        </div>
        <div className="button-row">
          <button className="btn btn-light btn-sm" onClick={() => onReplaceLottie(object.id)}>
            <Icon name="upload" size={14} /> 替换动画
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => retryImage(object.id)}>
            <Icon name="reset" size={14} /> 重新加载
          </button>
        </div>
        <div className="prop-row">
          <span className="field-label">循环播放</span>
          <Switch
            checked={object.loop}
            label="Lottie 循环播放"
            onChange={(loop) => updateObject(object.id, { loop })}
          />
        </div>
        <SliderRow
          label="播放速度"
          value={object.speed}
          min={0.1}
          max={3}
          step={0.1}
          unit="×"
          onChange={(speed) => updateObject(object.id, { speed }, key('speed'))}
        />
        <span className="field-hint">Lottie 支持导入 .json / .lottie 动画文件，编辑与演示时实时播放。</span>
      </Section>
      {error && (
        <div className="image-error-box">
          <Icon name="alert" size={15} />
          <div>
            <b>Lottie 无法加载</b>
            <p>{error}</p>
            <div className="button-row">
              <button className="btn btn-light btn-sm" onClick={() => retryImage(object.id)}>
                重试
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ObjectPanel({
  deck,
  object,
  readonly,
  onReplaceImage,
  onReplaceMedia,
  onReplaceModel,
  onReplaceLottie,
}: {
  deck: Deck;
  object: SlideObject;
  readonly: boolean;
  onReplaceImage: (id: string) => void;
  onReplaceMedia: (id: string) => void;
  onReplaceModel: (id: string) => void;
  onReplaceLottie: (id: string) => void;
}) {
  const subtitle =
    object.type === 'text'
      ? '文本对象'
      : object.type === 'image'
        ? '图片对象'
        : object.type === 'svg'
          ? 'SVG 矢量图形'
          : object.type === 'shape'
          ? SHAPE_LABELS[object.shape]
          : object.type === 'video'
            ? '视频对象'
            : object.type === 'audio'
              ? '音频对象'
              : object.type === 'lottie'
                ? 'Lottie 动画'
                : `${MODEL_FORMAT_LABELS[object.format]} 模型`;
  const updateObject = useDeckStore((state) => state.updateObject);
  const removeObject = useDeckStore((state) => state.removeObject);
  const moveObjectLayer = useDeckStore((state) => state.moveObjectLayer);
  const requestFocus = useDeckStore((state) => state.requestFocus);
  const sorted = [...deck.objects].sort((a, b) => b.z - a.z);
  const layerIndex = sorted.findIndex((item) => item.id === object.id);
  const key = (field: string) => `${object.id}:${field}`;

  return (
    <div className="inspector-body">
      <div className="inspector-head">
        <div>
          <div className="pane-label">{OBJECT_LABELS[object.type]}属性</div>
          <div className="pane-sub">{subtitle}</div>
        </div>
        <span className="inspector-badge">{object.type.toUpperCase()}</span>
      </div>

      <fieldset className="inspector-fieldset" disabled={readonly}>
        <Section title="名称">
          <TextValueField
            value={object.name}
            maxLength={LIMITS.objectNameChars}
            ariaLabel="对象名称"
            onCommit={(name) => updateObject(object.id, { name })}
          />
        </Section>

        {object.type === 'text' && <TextFields object={object} />}
        {object.type === 'image' && <ImageFields object={object} onReplaceImage={onReplaceImage} />}
        {object.type === 'svg' && <SvgFields object={object} onReplaceImage={onReplaceImage} />}
        {(object.type === 'video' || object.type === 'audio') && (
          <MediaFields object={object} onReplaceMedia={onReplaceMedia} />
        )}
        {object.type === 'model' && <ModelFields object={object} onReplaceModel={onReplaceModel} />}
        {object.type === 'lottie' && <LottieFields object={object} onReplaceLottie={onReplaceLottie} />}
        {object.type === 'shape' && <ShapeFields object={object} />}

        <Section title="变换">
          <div className="coord-grid">
            <NumberField
              label="X"
              value={object.x}
              min={-LIMITS.coord}
              max={LIMITS.coord}
              ariaLabel="X 坐标"
              onCommit={(x) => updateObject(object.id, { x }, key('x'))}
            />
            <NumberField
              label="Y"
              value={object.y}
              min={-LIMITS.coord}
              max={LIMITS.coord}
              ariaLabel="Y 坐标"
              onCommit={(y) => updateObject(object.id, { y }, key('y'))}
            />
            <NumberField
              label="Z"
              value={object.z}
              min={-LIMITS.depth}
              max={LIMITS.depth}
              ariaLabel="Z 深度"
              onCommit={(z) => updateObject(object.id, { z }, key('z'))}
            />
            <NumberField
              label="W"
              value={object.width}
              min={LIMITS.minSize}
              max={LIMITS.maxSize}
              ariaLabel="宽度"
              onCommit={(width) => updateObject(object.id, { width }, key('width'))}
            />
            {object.type === 'text' ? (
              <label className="number-field is-disabled">
                <span className="field-label">H</span>
                <span className="number-wrap">
                  <input type="number" value={Math.round(object.height)} disabled aria-label="文本高度" />
                  <span className="number-unit">自动</span>
                </span>
              </label>
            ) : (
              <NumberField
                label="H"
                value={object.height}
                min={LIMITS.minSize}
                max={LIMITS.maxSize}
                ariaLabel="高度"
                onCommit={(height) => updateObject(object.id, { height }, key('height'))}
              />
            )}
            <div className="coord-note">
              <span>位置与尺寸</span>
              <span>Z 越大越靠前</span>
            </div>
          </div>
          <SliderRow
            label="旋转 Z"
            value={object.rotation}
            min={LIMITS.minRotation}
            max={LIMITS.maxRotation}
            step={1}
            unit="°"
            onChange={(rotation) => updateObject(object.id, { rotation }, key('rotation'))}
          />
          <SliderRow
            label="倾斜 X"
            value={object.rotationX ?? 0}
            min={-180}
            max={180}
            step={1}
            unit="°"
            onChange={(rotationX) => updateObject(object.id, { rotationX }, key('rotationX'))}
          />
          <SliderRow
            label="倾斜 Y"
            value={object.rotationY ?? 0}
            min={-180}
            max={180}
            step={1}
            unit="°"
            onChange={(rotationY) => updateObject(object.id, { rotationY }, key('rotationY'))}
          />
          {object.type === 'model' && (
            <span className="field-hint">三维旋转用于在舞台中任意摆放模型，旋转 Z / 倾斜 X / 倾斜 Y 可组合使用。</span>
          )}
          <SliderRow
            label="不透明度"
            value={object.opacity}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={(opacity) => updateObject(object.id, { opacity }, key('opacity'))}
          />
        </Section>

        <Section title="可见与图层">
          <div className="prop-row">
            <span className="field-label">可见</span>
            <Switch
              checked={object.visible}
              label="对象可见"
              onChange={(visible) => updateObject(object.id, { visible })}
            />
          </div>
          <div className="button-row">
            <button
              className="btn btn-light btn-sm"
              disabled={layerIndex <= 0}
              onClick={() => {
                const target = sorted[layerIndex - 1];
                if (target) moveObjectLayer(object.id, target.id);
              }}
            >
              上移图层
            </button>
            <button
              className="btn btn-light btn-sm"
              disabled={layerIndex >= sorted.length - 1}
              onClick={() => {
                const target = sorted[layerIndex + 1];
                if (target) moveObjectLayer(object.id, target.id);
              }}
            >
              下移图层
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => requestFocus(object.id)}>
              <Icon name="focus" size={14} /> 聚焦
            </button>
          </div>
          <span className="field-hint">隐藏的对象仍保存在空间中，演示时完全不渲染。</span>
        </Section>

        <Section title="对象">
          <button className="btn btn-danger btn-sm btn-block" onClick={() => removeObject(object.id)}>
            <Icon name="trash" size={14} /> 删除对象
          </button>
        </Section>
      </fieldset>
    </div>
  );
}

function FramePanel({ deck, onUpdateFrameView }: { deck: Deck; onUpdateFrameView: (id: string) => void }) {
  const selectedFrameId = useDeckStore((state) => state.selectedFrameId);
  const renameFrame = useDeckStore((state) => state.renameFrame);
  const setFrameDuration = useDeckStore((state) => state.setFrameDuration);
  const setFrameNotes = useDeckStore((state) => state.setFrameNotes);
  const setFrameHold = useDeckStore((state) => state.setFrameHold);
  const deleteFrame = useDeckStore((state) => state.deleteFrame);
  const selectFrame = useDeckStore((state) => state.selectFrame);
  const frame = deck.frames.find((item) => item.id === selectedFrameId);
  const [notes, setNotes] = useState(frame?.notes ?? '');

  useEffect(() => {
    setNotes(frame?.notes ?? '');
  }, [frame?.id, frame?.notes]);

  if (!frame) return null;
  const index = deck.frames.findIndex((item) => item.id === frame.id);

  return (
    <div className="inspector-body">
      <div className="inspector-head">
        <div>
          <div className="pane-label">视点属性</div>
          <div className="pane-sub">
            第 {index + 1} / {deck.frames.length} 个视点
          </div>
        </div>
        <span className="inspector-badge">FRAME</span>
      </div>
      <Section title="名称">
        <TextValueField
          value={frame.name}
          maxLength={LIMITS.frameNameChars}
          ariaLabel="视点名称"
          onCommit={(name) => renameFrame(frame.id, name)}
        />
      </Section>
      <Section title="过渡">
        <div className="prop-row">
          <span className="field-label">时长</span>
          <NumberField
            value={frame.duration}
            min={LIMITS.minDuration}
            max={LIMITS.maxDuration}
            step={0.1}
            unit="秒"
            ariaLabel="视点过渡时长"
            onCommit={(duration) => setFrameDuration(frame.id, duration)}
          />
        </div>
        <div className="prop-row">
          <span className="field-label">自动停留</span>
          <NumberField
            value={frame.hold ?? DEFAULT_HOLD}
            min={LIMITS.minHold}
            max={LIMITS.maxHold}
            step={0.5}
            unit="秒"
            ariaLabel="自动播放停留时长"
            onCommit={(hold) => setFrameHold(frame.id, hold)}
          />
        </div>
        <span className="field-hint">过渡时长属于被进入的视点；自动停留用于演示自动播放。</span>
      </Section>
      <Section title="演讲者备注">
        <textarea
          className="text-input text-area"
          rows={4}
          maxLength={LIMITS.frameNotesChars}
          value={notes}
          placeholder="仅演示端可见，例如口播要点、停顿提示…"
          aria-label="演讲者备注"
          onChange={(event) => {
            const value = event.target.value;
            setNotes(value);
            setFrameNotes(frame.id, value);
          }}
        />
        <span className="field-hint">
          {notes.length} / {LIMITS.frameNotesChars} · 演示时按 N 显示或隐藏
        </span>
      </Section>
      <Section title="取景">
        <div className="button-row">
          <button className="btn btn-light btn-sm" onClick={() => onUpdateFrameView(frame.id)}>
            <Icon name="reset" size={14} /> 用当前视图更新
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => selectFrame(frame.id, true)}>
            <Icon name="focus" size={14} /> 前往
          </button>
        </div>
        <span className="field-hint">
          看向点 {Math.round(frame.view.target.x)}, {Math.round(frame.view.target.y)}, 距离{' '}
          {Math.round(frame.view.distance)}
        </span>
      </Section>
      <Section title="视点">
        <button className="btn btn-danger btn-sm btn-block" onClick={() => deleteFrame(frame.id)}>
          <Icon name="trash" size={14} /> 删除视点
        </button>
        <span className="field-hint">删除视点不会移除任何内容对象，操作可以撤销。</span>
      </Section>
    </div>
  );
}

function MultiPanel({ deck, ids, readonly }: { deck: Deck; ids: string[]; readonly: boolean }) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const removeObjects = useDeckStore((state) => state.removeObjects);
  const selectObjects = useDeckStore((state) => state.selectObjects);
  const objects = deck.objects.filter((object) => ids.includes(object.id));
  if (objects.length === 0) return null;
  const bounds = {
    minX: Math.min(...objects.map((object) => object.x - object.width / 2)),
    maxX: Math.max(...objects.map((object) => object.x + object.width / 2)),
    minY: Math.min(...objects.map((object) => object.y - object.height / 2)),
    maxY: Math.max(...objects.map((object) => object.y + object.height / 2)),
  };
  const opacity = Math.round(objects[0].opacity);

  const align = (kind: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom') => {
    for (const object of objects) {
      let x = object.x;
      let y = object.y;
      if (kind === 'left') x = bounds.minX + object.width / 2;
      if (kind === 'centerX') x = (bounds.minX + bounds.maxX) / 2;
      if (kind === 'right') x = bounds.maxX - object.width / 2;
      if (kind === 'top') y = bounds.minY + object.height / 2;
      if (kind === 'centerY') y = (bounds.minY + bounds.maxY) / 2;
      if (kind === 'bottom') y = bounds.maxY - object.height / 2;
      if (x !== object.x || y !== object.y) updateObject(object.id, { x, y }, `multi-align:${kind}`);
    }
  };

  const distribute = (axis: 'x' | 'y') => {
    if (objects.length < 3) return;
    const sorted = [...objects].sort((a, b) => (axis === 'x' ? a.x - b.x : a.y - b.y));
    const start =
      axis === 'x'
        ? Math.min(...sorted.map((object) => object.x - object.width / 2))
        : Math.min(...sorted.map((object) => object.y - object.height / 2));
    const end =
      axis === 'x'
        ? Math.max(...sorted.map((object) => object.x + object.width / 2))
        : Math.max(...sorted.map((object) => object.y + object.height / 2));
    const total = sorted.reduce((sum, object) => sum + (axis === 'x' ? object.width : object.height), 0);
    const gap = (end - start - total) / (sorted.length - 1);
    let cursor = start;
    for (const object of sorted) {
      const size = axis === 'x' ? object.width : object.height;
      const value = cursor + size / 2;
      const current = axis === 'x' ? object.x : object.y;
      if (Math.abs(value - current) > 0.01) {
        updateObject(object.id, axis === 'x' ? { x: value } : { y: value }, `multi-distribute:${axis}`);
      }
      cursor += size + gap;
    }
  };

  const setAllVisible = (visible: boolean) => {
    for (const object of objects) {
      if (object.visible !== visible) updateObject(object.id, { visible }, 'multi-visible');
    }
  };

  return (
    <div className="inspector-body">
      <div className="inspector-head">
        <div>
          <div className="pane-label">多选属性</div>
          <div className="pane-sub">已选中 {objects.length} 个对象</div>
        </div>
        <span className="inspector-badge">MULTI</span>
      </div>
      <fieldset className="inspector-fieldset" disabled={readonly}>
        <Section title="选中内容">
          <div className="multi-list">
            {objects.map((object, index) => (
              <button
                key={object.id}
                className={`multi-item ${index === 0 ? 'is-primary' : ''}`}
                onClick={() => selectObjects([object.id, ...ids.filter((id) => id !== object.id)])}
                title="设为主选中对象"
              >
                <Icon name={object.type === 'lottie' ? 'spark' : object.type} size={14} />
                <span>{object.name}</span>
                <small>{OBJECT_LABELS[object.type]}</small>
              </button>
            ))}
          </div>
          <span className="field-hint">点在舞台上拖拽可整体移动；角点只显示主选中对象。</span>
        </Section>
        <Section title="对齐">
          <div className="align-grid">
            <button className="btn btn-light btn-sm" onClick={() => align('left')}>左对齐</button>
            <button className="btn btn-light btn-sm" onClick={() => align('centerX')}>水平居中</button>
            <button className="btn btn-light btn-sm" onClick={() => align('right')}>右对齐</button>
            <button className="btn btn-light btn-sm" onClick={() => align('top')}>顶对齐</button>
            <button className="btn btn-light btn-sm" onClick={() => align('centerY')}>垂直居中</button>
            <button className="btn btn-light btn-sm" onClick={() => align('bottom')}>底对齐</button>
          </div>
        </Section>
        <Section title="等距分布">
          <div className="button-row">
            <button
              className="btn btn-light btn-sm"
              disabled={objects.length < 3}
              onClick={() => distribute('x')}
            >
              水平等距
            </button>
            <button
              className="btn btn-light btn-sm"
              disabled={objects.length < 3}
              onClick={() => distribute('y')}
            >
              垂直等距
            </button>
          </div>
          <span className="field-hint">
            {objects.length < 3 ? '选中 3 个以上对象后可等距排列。' : '保持两端对象不动，按尺寸补齐中间间距。'}
          </span>
        </Section>
        <Section title="统一不透明度">
          <SliderRow
            label="不透明度"
            value={opacity}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={(value) => {
              for (const object of objects) {
                if (Math.round(object.opacity) !== value) updateObject(object.id, { opacity: value }, 'multi-opacity');
              }
            }}
          />
        </Section>
        <Section title="批量操作">
          <div className="button-row">
            <button className="btn btn-light btn-sm" onClick={() => setAllVisible(true)}>
              <Icon name="eye" size={14} /> 全部显示
            </button>
            <button className="btn btn-light btn-sm" onClick={() => setAllVisible(false)}>
              <Icon name="eyeOff" size={14} /> 全部隐藏
            </button>
          </div>
          <button className="btn btn-danger btn-sm btn-block" onClick={() => removeObjects(objects.map((object) => object.id))}>
            <Icon name="trash" size={14} /> 删除 {objects.length} 个对象
          </button>
        </Section>
      </fieldset>
    </div>
  );
}

export function Inspector({
  readonly,
  onReplaceImage,
  onReplaceMedia,
  onReplaceModel,
  onReplaceLottie,
  onUpdateFrameView,
}: InspectorProps) {
  const deck = useDeckStore((state) => state.deck);
  const selectedObjectId = useDeckStore((state) => state.selectedObjectId);
  const selectedIds = useDeckStore((state) => state.selectedIds);
  const selectedFrameId = useDeckStore((state) => state.selectedFrameId);
  if (!deck) return null;
  const object = deck.objects.find((item) => item.id === selectedObjectId);

  if (selectedIds.length > 1) {
    return (
      <aside className="rightbar">
        <MultiPanel deck={deck} ids={selectedIds} readonly={readonly} />
      </aside>
    );
  }
  if (object) {
    return (
      <aside className="rightbar">
        <ObjectPanel
          deck={deck}
          object={object}
          readonly={readonly}
          onReplaceImage={onReplaceImage}
          onReplaceMedia={onReplaceMedia}
          onReplaceModel={onReplaceModel}
          onReplaceLottie={onReplaceLottie}
        />
      </aside>
    );
  }
  if (selectedFrameId) {
    return (
      <aside className="rightbar">
        <FramePanel deck={deck} onUpdateFrameView={onUpdateFrameView} />
      </aside>
    );
  }
  return (
    <aside className="rightbar">
      <DeckPanel deck={deck} readonly={readonly} />
    </aside>
  );
}
