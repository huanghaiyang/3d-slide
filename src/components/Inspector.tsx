/**
 * Inspector.tsx —— 右侧属性检查器面板
 *
 * 职责：
 * - 根据当前选中状态渲染四种互斥面板：作品设置（DeckPanel）、单个对象（ObjectPanel）、
 *   多选（MultiPanel）与视点（FramePanel）。
 * - 作为「受控视图」工作：所有修改都直接写入 deckStore，由 store 统一处理撤销历史、
 *   数值边界裁剪与自动保存；面板自身只保留少量输入过程中的本地草稿（名称、备注）。
 *
 * 主要交互：
 * - 输入框 / 滑块 / 开关修改对象或作品属性；连续输入通过 historyKey 合并成一步撤销。
 * - 替换图片 / 媒体 / 模型 / Lottie 由外层传入的回调触发（文件选择与上传解析在 App 层）。
 * - 多选面板提供对齐、等距分布、统一不透明度、批量显隐与批量删除。
 * - 视点面板可改名、调整过渡与停留时长、填写演讲备注、用当前视图覆盖取景或跳转。
 *
 * 依赖：
 * - store/deckStore.ts：读取 deck 与选中 id，调用 updateObject / removeObject /
 *   updateDeckSettings / 视点相关操作等。
 * - lib/constants.ts：LIMITS 各项数值上限、DEFAULT_HOLD 默认停留时长。
 * - lib/media.ts 的 formatDuration，types.ts 的中文标签映射，以及 ./ui 中的表单原子组件。
 */

import { useEffect, useState } from 'react';
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
// 图表属性面板由插件提供，核心只负责按对象上的 plugin 字段解析
import { resolveChartPlugin } from '../plugins/registry';
import { LOTTIE_BACKEND_CANVAS, listLottieBackends } from '../lib/lottieBackends';
import { Icon } from './Icon';
import { Section, TextValueField } from './inspectorKit';
import { ColorField, NumberField, Segmented, Switch } from './ui';

interface InspectorProps {
  /** 只读模式：为 true 时禁用内部所有 fieldset，仅可查看属性。 */
  readonly: boolean;
  /** 请求用新文件替换指定对象的图片。 */
  onReplaceImage: (id: string) => void;
  /** 请求替换视频 / 音频素材。 */
  onReplaceMedia: (id: string) => void;
  /** 请求替换 3D 模型文件。 */
  onReplaceModel: (id: string) => void;
  /** 请求替换 Lottie 动画文件。 */
  onReplaceLottie: (id: string) => void;
  /** 请求用当前相机视图更新指定视点的取景。 */
  onUpdateFrameView: (id: string) => void;
}

/**
 * 滑块 + 数字输入组合控件：两者共享同一数值，拖动滑块会即时回调 onChange，
 * 数字框则在失焦 / 回车时提交。单位（unit）只用于数字框后缀显示。
 */
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

/** 舞台背景预设色板，用于快速切换常见的深色 / 浅色背景。 */
const BACKGROUND_PRESETS = ['#10161F', '#171A21', '#1B2A2A', '#F5F2EC', '#E9E2D4'];

/**
 * 作品级设置面板：未选中任何对象、视点或未多选时展示。
 *
 * 数据全部来自 deck 字段；修改通过 updateDeckSettings 写回 store，
 * 传入的 historyKey（如 'deck-bg'、'deck-duration'）让连续拖动只占一步撤销。
 */
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

/**
 * 文本对象专属属性：内容、字体样式、行高与 3D 挤出厚度。
 *
 * 注意：文本高度由内容行数自动决定，因此这里不提供 H 输入；
 * 文本清空后失焦会自动删除该对象（空文本框在舞台上没有意义）。
 */
function TextFields({ object }: { object: TextObject }) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const removeObject = useDeckStore((state) => state.removeObject);
  // historyKey：同一对象同一字段的连续输入在 1 秒内合并，避免逐字产生大量撤销步骤。
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

/**
 * 图片对象属性：预览、替换 / 重试 / 还原尺寸、适配方式与比例锁定。
 *
 * naturalWidth / naturalHeight 是素材解析时记录的原始像素尺寸，用于「还原原始尺寸」
 * 以及锁定比例时计算宽高比；修改宽高会由 store 按 aspectLocked 自动联动。
 */
function ImageFields({ object, onReplaceImage }: { object: ImageObject; onReplaceImage: (id: string) => void }) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const removeObject = useDeckStore((state) => state.removeObject);
  const retryImage = useDeckStore((state) => state.retryImage);
  // 加载错误来自 store 的 imageErrors 映射；重试计数变化会促使 SceneManager 重新加载贴图。
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

/** SVG 矢量对象属性：复用图片的替换回调，但展示矢量原始尺寸并支持等比放大。 */
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

/**
 * 视频 / 音频共用属性面板（两者字段大部分重叠）。
 *
 * - 视频显示分辨率且可还原原始尺寸；音频没有画面，改为显示素材大小。
 * - 播放设置统一写入对象的 loop / autoplay / volume；muted 仅视频有。
 * - 错误信息同样存于 imageErrors，重试会清空错误并递增重试计数。
 */
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

/**
 * 仅按 dataURL 字符串长度估算素材体积，得到近似的 B / KB / MB 展示。
 * 注意：这不是精确的文件大小（素材以 base64 形式存在对象里），仅用于给用户量级参考。
 */
function formatBytesOf(src: string): string {
  const size = src.length;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 3D 模型对象属性：格式 / 体积信息、替换与重试、重置包围盒、自动旋转设置。
 *
 * 模型在 SceneManager 中按包围盒等比缩放居中渲染，因此这里的 W / H 只是
 * 包围盒的显示尺寸；「重置包围盒」固定回 760 × 760 便于恢复默认构图。
 */
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

/**
 * 形状对象属性：类型切换、填充 / 描边颜色与宽度。
 *
 * 形状类型切换有两条特殊规则（见下方分支）：
 * - 切到「直线」时，把当前高度（或描边宽度）转成线宽，避免线太细看不见，并用填充色补描边色；
 * - 从「直线」切回面状形状时，若高度仍是线的厚度（< 20），恢复为默认高度 340，避免变成扁条。
 */
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
                // 直线用「高度」表示线宽：取原描边宽度，最少 6px；描边色缺失时沿用填充色。
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
                // 从细线切回面状形状：过薄的高度会变成一条扁条，恢复默认高度。
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

/**
 * Lottie 动画属性：画布尺寸、时长、替换 / 重试、循环与播放速度。
 * duration 为 0 通常表示动画信息未解析出来或依赖循环播放，此时展示「循环」。
 */
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
  // 后端列表来自注册中心：后续新增 WebGPU 等方案时下拉框会自动多出一项
  const backends = listLottieBackends();
  const activeBackend = object.renderer ?? LOTTIE_BACKEND_CANVAS;
  const activeHint = backends.find((backend) => backend.id === activeBackend)?.hint ?? '';
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
        <div className="prop-row">
          <span className="field-label">渲染后端</span>
          <select
            className="select"
            value={activeBackend}
            aria-label="Lottie 渲染后端"
            onChange={(event) => {
              // 默认后端不写入字段，保持与旧存档一致的数据形态
              const next = event.target.value;
              updateObject(object.id, { renderer: next === LOTTIE_BACKEND_CANVAS ? undefined : next });
            }}
          >
            {backends.map((backend) => (
              <option key={backend.id} value={backend.id} disabled={!backend.supported}>
                {backend.label}
                {backend.supported ? '' : '（不支持）'}
              </option>
            ))}
          </select>
        </div>
        <span className="field-hint">{activeHint}</span>
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

/**
 * 单个对象的属性面板入口：名称 + 按类型分发到具体字段组 + 通用变换 / 图层 / 删除。
 *
 * 图层顺序说明：sorted 按 z 降序，索引 0 为最靠前的对象；因此
 * 「上移图层」取 sorted[index - 1]（更靠前），「下移」取 sorted[index + 1]。
 */
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
  // 图表插件只在 chart 对象上解析：副标题与属性面板都由它提供
  const chartPlugin = object.type === 'chart' ? resolveChartPlugin(object.plugin) : undefined;
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
                : object.type === 'chart'
                  ? chartPlugin?.name ?? '图表'
                  : `${MODEL_FORMAT_LABELS[object.format]} 模型`;
  const updateObject = useDeckStore((state) => state.updateObject);
  // 图表渲染错误与重试动作由核心统一管理，插件面板只负责展示
  const imageErrors = useDeckStore((state) => state.imageErrors);
  const retryImage = useDeckStore((state) => state.retryImage);
  const removeObject = useDeckStore((state) => state.removeObject);
  const moveObjectLayer = useDeckStore((state) => state.moveObjectLayer);
  const requestFocus = useDeckStore((state) => state.requestFocus);
  // 按 z 从大到小排序，得到从最上层到最下层的展示顺序；layerIndex 用于判断能否上移 / 下移。
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
        {object.type === 'chart' &&
          (chartPlugin ? (
            <chartPlugin.Inspector
              object={object}
              onChange={(patch, historyKey) => updateObject(object.id, patch, historyKey)}
              error={imageErrors[object.id]}
              onRetry={() => retryImage(object.id)}
            />
          ) : (
            <Section title="图表插件">
              <span className="field-hint">
                当前图表依赖插件「{object.plugin || '未知'}」，请安装对应插件后再编辑。
              </span>
            </Section>
          ))}
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
            {/* 文本高度由内容自动排版决定，这里只读展示，不能直接编辑 */}
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

/**
 * 视点（帧）属性面板：名称、过渡时长、自动停留、演讲者备注、取景更新与删除。
 *
 * 备注使用本地 notes 状态做输入缓冲，同时每次输入都同步写 store：
 * 本地状态保证输入不丢字，store 保证撤销与自动保存可用；当切换视点或外部修改
 * 备注时，依赖 frame.id / frame.notes 重新同步。
 */
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
    // 切换视点或备注被外部改写（如撤销）时，把 store 中的备注同步回本地输入框。
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

/**
 * 多选属性面板：批量对齐、等距分布、统一不透明度、批量显隐 / 删除。
 *
 * 注意：包围盒按未旋转的 width / height 计算（未考虑 rotation），
 * 因此对齐结果对旋转对象是近似值，这与舞台框选的几何判断保持一致。
 */
function MultiPanel({ deck, ids, readonly }: { deck: Deck; ids: string[]; readonly: boolean }) {
  const updateObject = useDeckStore((state) => state.updateObject);
  const removeObjects = useDeckStore((state) => state.removeObjects);
  const selectObjects = useDeckStore((state) => state.selectObjects);
  const objects = deck.objects.filter((object) => ids.includes(object.id));
  if (objects.length === 0) return null;
  // 选中集合的整体包围盒：由每个对象中心 ± 宽高的一半推导。
  const bounds = {
    minX: Math.min(...objects.map((object) => object.x - object.width / 2)),
    maxX: Math.max(...objects.map((object) => object.x + object.width / 2)),
    minY: Math.min(...objects.map((object) => object.y - object.height / 2)),
    maxY: Math.max(...objects.map((object) => object.y + object.height / 2)),
  };
  const opacity = Math.round(objects[0].opacity);

  const align = (kind: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom') => {
    // 逐个计算目标坐标：左 / 上按包围盒边对齐，中心取包围盒中点，右 / 下按边减去自身尺寸。
    // 只在坐标确实变化时写 store，并共用 historyKey 让一次对齐只产生一步撤销。
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
    // 等距分布至少需要 3 个对象；少于 3 个时两端不动，没有中间项可调整。
    if (objects.length < 3) return;
    // 先按中心坐标排序，确定左右 / 上下两个端点对象。
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
    // 剩余空间平均分给 n - 1 个间隙；间隙可以为负（对象过宽重叠时会被压缩排列）。
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
              // 以主选中对象的值为滑块基准；逐个更新，只跳过已经一致的对象以减少无谓渲染。
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

/**
 * 属性检查器根组件：根据当前选中状态分发到对应子面板。
 *
 * 优先级：多选（selectedIds.length > 1）> 单对象（selectedObjectId 命中）> 视点 > 作品设置。
 * 该顺序保证多选时即使主选中对象仍存在，也不会误显示单对象面板。
 */
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
    // 多选优先：ids 中第一个即主选中对象，MultiPanel 内部会据此高亮。
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
