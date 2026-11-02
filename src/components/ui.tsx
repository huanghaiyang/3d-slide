/**
 * ui.tsx —— 通用基础 UI 组件集合
 *
 * 本文件集中实现编辑器中反复使用的小型交互组件，避免各业务组件重复造轮子：
 * - Modal / ConfirmDialog：Portal 模态框与二次确认框；
 * - ToastHost：全局轻提示的渲染宿主（数据来自 store/uiStore）；
 * - NumberField：带本地草稿、聚焦不被打断、失焦提交的数值输入；
 * - Switch / Segmented / FieldBlock / ColorField：表单类控件；
 * - Tip：带 aria-describedby 的轻量文字气泡提示。
 *
 * 设计约定：
 * - 所有组件只负责展示与交互，不直接读写业务状态；需要状态的由调用方传入回调；
 * - 弹层统一使用 createPortal 挂到 document.body，避免被编辑器布局的 z-index / overflow 裁切；
 * - 所有可交互控件都补齐 role / aria-* 属性，保证键盘与读屏可用。
 *
 * 与其他模块的关系：ToastHost 依赖 store/uiStore，Icon 提供统一的 SVG 图标。
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { ToastTone } from '../store/uiStore';
import { useUiStore } from '../store/uiStore';
import { Icon } from './Icon';

/* ------------------------------- Modal ------------------------------- */

interface ModalProps {
  /** 标题；与 eyebrow 同时为空时不渲染头部区域。 */
  title?: string;
  /** 标题上方的小号英文标签，用于强调弹窗类别。 */
  eyebrow?: string;
  /** 弹窗主体内容。 */
  children: ReactNode;
  /** 底部操作区；为空时不渲染。 */
  footer?: ReactNode;
  /** 关闭回调；不传时不显示右上角关闭按钮，也不响应 Esc / 点击遮罩。 */
  onClose?: () => void;
  /** 弹窗宽度（像素），默认 440。 */
  width?: number;
  /** 无标题时用于 aria-label 的兜底文案。 */
  closeLabel?: string;
}

/**
 * 通用模态框。
 *
 * 通过 Portal 挂载到 body；点击遮罩或按 Esc 触发 onClose，
 * 点击弹窗内部会阻止冒泡，避免误关闭。
 * Esc 监听使用 stopPropagation，防止同时触发下层的全局快捷键。
 *
 * @param props 见 ModalProps
 */
export function Modal({ title, eyebrow, children, footer, onClose, width = 440, closeLabel = '关闭' }: ModalProps) {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && onClose) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div className="modal-layer" role="presentation">
      <div className="modal-scrim" onMouseDown={onClose} />
      <section
        className="modal"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? closeLabel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {(title || eyebrow) && (
          <header className="modal-head">
            <div>
              {eyebrow && <div className="modal-eyebrow">{eyebrow}</div>}
              {title && <h3>{title}</h3>}
            </div>
            {onClose && (
              <button className="icon-btn" onClick={onClose} aria-label="关闭">
                <Icon name="close" size={18} />
              </button>
            )}
          </header>
        )}
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  /** 确认框标题。 */
  title: string;
  /** 说明文案，可包含强调内容。 */
  message: ReactNode;
  /** 确认按钮文案，默认「确认」。 */
  confirmLabel?: string;
  /** 取消按钮文案，默认「取消」。 */
  cancelLabel?: string;
  /** 危险操作（如删除）时确认按钮使用红色样式。 */
  danger?: boolean;
  /** 点击确认。 */
  onConfirm: () => void;
  /** 点击取消或关闭。 */
  onCancel: () => void;
}

/**
 * 二次确认对话框：基于 Modal 封装的「取消 + 确认」两键结构。
 * 点击遮罩 / Esc 等价于取消。
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width={420}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-text">{message}</div>
    </Modal>
  );
}

/* ------------------------------- Toast ------------------------------- */

// 不同提示语气对应的图标：info 星芒、success 对勾、error 警告三角
const toneIcon: Record<ToastTone, 'alert' | 'check' | 'spark'> = {
  info: 'spark',
  success: 'check',
  error: 'alert',
};

/**
 * 全局轻提示宿主。
 * 从 uiStore 读取当前所有 toast 并按顺序渲染；每条可手动关闭。
 * 容器使用 aria-live="polite"，让读屏软件在提示出现时朗读内容。
 */
export function ToastHost() {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismissToast);
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone}`} role="status">
          <span className="toast-ico">
            <Icon name={toneIcon[item.tone]} size={16} />
          </span>
          <span>{item.message}</span>
          <button className="toast-close" onClick={() => dismiss(item.id)} aria-label="关闭提示">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------- NumberField ---------------------------- */

interface NumberFieldProps {
  /** 当前受控数值（外部真值）。 */
  value: number;
  /** 允许的最小值，默认负无穷。 */
  min?: number;
  /** 允许的最大值，默认正无穷。 */
  max?: number;
  /** 数字输入框的步进。 */
  step?: number;
  /** 数值后显示的单位，如 px、s。 */
  unit?: string;
  /** 左侧标签文字。 */
  label?: string;
  /** 无标签时用于读屏的字段名。 */
  ariaLabel?: string;
  /** 是否禁用编辑。 */
  disabled?: boolean;
  /** 提交回调：仅在数值真正变化且合法时调用。 */
  onCommit: (value: number) => void;
}

/** 把数值限制在 [min, max] 区间内。 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 数值输入框。
 *
 * 内部维护一份字符串草稿 draft，允许用户临时输入「-」「1.」等中间状态；
 * 聚焦期间外部 value 变化不会覆盖草稿（避免拖动滑块时输入框内容跳动），
 * 失焦、Enter 或 Esc 时统一提交 / 回滚。
 * 输入支持千分位逗号，解析前会去除逗号；非法值回滚为当前 value。
 *
 * @param props 见 NumberFieldProps
 */
export function NumberField({
  value,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit,
  label,
  ariaLabel,
  disabled,
  onCommit,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(String(round(value)));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(String(round(value)));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft.replace(/,/g, '').trim());
    if (!Number.isFinite(parsed)) {
      setDraft(String(round(value)));
      return;
    }
    const next = clamp(parsed, min, max);
    setDraft(String(round(next)));
    if (next !== value) onCommit(next);
  };

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      setDraft(String(round(value)));
      event.currentTarget.blur();
    }
  };

  return (
    <label className={`number-field ${disabled ? 'is-disabled' : ''}`}>
      {label && <span className="field-label">{label}</span>}
      <span className="number-wrap">
        <input
          type="number"
          inputMode="decimal"
          value={draft}
          min={Number.isFinite(min) ? min : undefined}
          max={Number.isFinite(max) ? max : undefined}
          step={step}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          onFocus={(event) => {
            focused.current = true;
            event.currentTarget.select();
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onKeyDown={handleKey}
        />
        {unit && <span className="number-unit">{unit}</span>}
      </span>
    </label>
  );
}

/** 保留两位小数，避免浮点误差导致输入框显示一长串尾数。 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------- Switch ------------------------------ */

interface SwitchProps {
  /** 当前开关状态。 */
  checked: boolean;
  /** 切换回调，参数为切换后的状态。 */
  onChange: (checked: boolean) => void;
  /** 读屏与 aria-label 使用的开关名称。 */
  label: string;
  /** 是否禁用。 */
  disabled?: boolean;
}

/** 开关按钮：使用 role="switch" 与 aria-checked 表达状态，点击时回调取反值。 */
export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

/* ----------------------------- Segmented ----------------------------- */

/** 分段控件中的一个选项。 */
interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  /** 当前选中的值。 */
  value: T;
  /** 全部可选项。 */
  options: SegmentOption<T>[];
  /** 选择变化回调。 */
  onChange: (value: T) => void;
  /** 控件组的读屏名称。 */
  ariaLabel: string;
  /** 是否整体禁用。 */
  disabled?: boolean;
}

/**
 * 分段选择控件（单选按钮组的轻量实现）。
 * 泛型 T 保证 value 与 options 的取值类型一致，调用方无需做额外断言。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
}: SegmentedProps<T>) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'is-active' : ''}
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------- FieldBlock ---------------------------- */

/**
 * 表单字段容器：统一「标签 + 控件 + 可选提示」的纵向布局。
 * 仅负责排版，不参与任何状态管理。
 */
export function FieldBlock({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field-block">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/* ---------------------------- ColorField ----------------------------- */

interface ColorFieldProps {
  /** 当前颜色（十六进制字符串，如 #RRGGBB）。 */
  value: string;
  /** 颜色变化回调，参数为原生颜色选择器返回的十六进制值。 */
  onChange: (value: string) => void;
  /** 左侧标签文字。 */
  label?: string;
  /** 颜色输入的读屏名称。 */
  ariaLabel: string;
}

/**
 * 颜色选择控件：色块覆盖在原生 input[type=color] 上，
 * 点击色块实际触发原生取色器；右侧同步展示大写十六进制值。
 */
export function ColorField({ value, onChange, label, ariaLabel }: ColorFieldProps) {
  return (
    <label className="color-field">
      {label && <span className="field-label">{label}</span>}
      <span className="color-control">
        <span className="color-swatch" style={{ background: value }}>
          <input
            type="color"
            value={value}
            aria-label={ariaLabel}
            onChange={(event) => onChange(event.target.value)}
          />
        </span>
        <span className="color-hex">{value.toUpperCase()}</span>
      </span>
    </label>
  );
}

/* ------------------------------ Tooltip ------------------------------ */

/**
 * 轻量气泡提示。
 * 用 useMemo 生成唯一的 tooltip id，并通过 aria-describedby 关联触发元素，
 * 气泡内容始终渲染在 DOM 中、由 CSS 控制显隐，读屏软件也能获取提示文本。
 */
export function Tip({ text, children }: { text: string; children: ReactNode }) {
  const id = useMemo(() => `tip-${Math.random().toString(36).slice(2)}`, []);
  return (
    <span className="tip" aria-describedby={id}>
      {children}
      <span className="tip-bubble" role="tooltip" id={id}>
        {text}
      </span>
    </span>
  );
}
