import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Deck, ImageObject, ShapeObject, SlideObject, TextObject } from '../types';
import { LIMITS } from '../lib/constants';
import { useDeckStore } from '../store/deckStore';
import { FONT_LABELS, OBJECT_LABELS, SHAPE_LABELS } from '../types';
import { Icon } from './Icon';
import { ColorField, NumberField, Segmented, Switch } from './ui';

interface InspectorProps {
  readonly: boolean;
  onReplaceImage: (id: string) => void;
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
          <button className="btn btn-ghost btn-sm" onClick={() => retryImage(object.id)}>
            <Icon name="reset" size={14} /> 重新加载
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

function ShapeFields({ object }: { object: ShapeObject }) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const key = (field: string) => `${object.id}:${field}`;
  const hasStroke = object.stroke !== null;
  return (
    <Section title="形状">
      <Segmented
        value={object.shape}
        ariaLabel="形状类型"
        options={[
          { value: 'rect', label: '矩形' },
          { value: 'ellipse', label: '椭圆' },
          { value: 'line', label: '直线' },
        ]}
        onChange={(shape) => updateObject(object.id, { shape })}
      />
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

function ObjectPanel({
  deck,
  object,
  readonly,
  onReplaceImage,
}: {
  deck: Deck;
  object: SlideObject;
  readonly: boolean;
  onReplaceImage: (id: string) => void;
}) {
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
          <div className="pane-sub">
            {object.type === 'text' ? '文本对象' : object.type === 'image' ? '图片对象' : SHAPE_LABELS[object.shape]}
          </div>
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
            label="旋转"
            value={object.rotation}
            min={LIMITS.minRotation}
            max={LIMITS.maxRotation}
            step={1}
            unit="°"
            onChange={(rotation) => updateObject(object.id, { rotation }, key('rotation'))}
          />
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
  const deleteFrame = useDeckStore((state) => state.deleteFrame);
  const selectFrame = useDeckStore((state) => state.selectFrame);
  const frame = deck.frames.find((item) => item.id === selectedFrameId);
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
        <span className="field-hint">时长属于被进入的视点；从上一个视点飞到这里时生效。</span>
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

export function Inspector({ readonly, onReplaceImage, onUpdateFrameView }: InspectorProps) {
  const deck = useDeckStore((state) => state.deck);
  const selectedObjectId = useDeckStore((state) => state.selectedObjectId);
  const selectedFrameId = useDeckStore((state) => state.selectedFrameId);
  if (!deck) return null;
  const object = deck.objects.find((item) => item.id === selectedObjectId);

  if (object) {
    return (
      <aside className="rightbar">
        <ObjectPanel deck={deck} object={object} readonly={readonly} onReplaceImage={onReplaceImage} />
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
