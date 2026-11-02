/**
 * components/inspectorKit.tsx —— 属性面板通用小组件
 *
 * 这些组件与具体业务无关，既被核心 Inspector 使用，也作为插件属性面板的
 * 公共依赖（插件不应复制一份自己的输入框实现）。
 *
 * 导出的内容：
 * - Section：属性分组容器（标题栏 + 内容区）；
 * - TextValueField：失焦 / 回车才提交的单行文本输入。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 属性面板中的通用分组容器：统一的标题栏 + 内容区。
 * extra 用于在标题右侧放置额外操作（多数面板未使用）。
 */
export function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
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

/**
 * 单行文本输入：内部维护 draft 草稿，只在失焦或回车时才提交。
 *
 * 状态含义：
 * - draft：输入过程中的本地值，输入法组合期间也以它为准。
 * - focused ref：记录是否正在编辑，避免外部 value 变化（例如撤销）覆盖用户未提交的输入。
 *
 * 副作用：提交时对内容 trim，空值回退为原值（不允许把名称清空），并按 maxLength 截断。
 */
export function TextValueField({
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

  // 仅当用户不在输入状态时，才把外部值同步回草稿；否则会打断正在输入的内容。
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    // 空内容视为取消编辑，恢复原值，避免对象 / 视点丢失名称。
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
