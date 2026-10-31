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
  title?: string;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  width?: number;
  closeLabel?: string;
}

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
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

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

const toneIcon: Record<ToastTone, 'alert' | 'check' | 'spark'> = {
  info: 'spark',
  success: 'check',
  error: 'alert',
};

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
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

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

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------- Switch ------------------------------ */

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

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

interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}

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
  value: string;
  onChange: (value: string) => void;
  label?: string;
  ariaLabel: string;
}

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
