/**
 * uiStore.ts —— 全局轻提示（Toast）状态
 *
 * 基于 Zustand 实现，与 deckStore 分离：Toast 属于纯界面反馈，不参与作品数据、
 * 撤销历史或持久化，因此单独放在一个极简 store 中，避免编辑操作触发无关的
 * 状态更新。
 *
 * 行为约定：
 * - 每条 Toast 自动编号（模块级自增序列，保证同一会话内唯一）；
 * - 最多同时保留 4 条，超出时丢弃最早的；
 * - 默认 4200ms 后自动消失，也可由用户手动关闭；
 * - 提供 toast() 辅助函数，调用方无需直接操作 store。
 */

import { create } from 'zustand';

/** Toast 的语义色调：info 普通提示、success 成功、error 失败。 */
export type ToastTone = 'info' | 'success' | 'error';

/** 单条 Toast 数据。 */
export interface ToastItem {
  /** 自增 id，用于定位与关闭 */
  id: number;
  /** 展示文案 */
  message: string;
  /** 语义色调，决定图标与配色 */
  tone: ToastTone;
}

/**
 * UI store 的状态与操作。
 * toasts 为当前展示中的队列；pushToast 追加一条；dismissToast 按 id 移除。
 */
interface UiStore {
  /** 当前展示中的 Toast 列表，按加入时间排序 */
  toasts: ToastItem[];
  /** 追加一条 Toast（默认 tone 为 info），并安排自动消失 */
  pushToast: (message: string, tone?: ToastTone) => void;
  /** 立即关闭指定 id 的 Toast */
  dismissToast: (id: number) => void;
}

/** Toast 全局自增序号；模块级变量，不进入 store，避免无意义的状态变更。 */
let toastSeq = 0;

/**
 * Toast 全局 store。
 *
 * pushToast 通过 set 的函数式更新读取最新列表，避免并发追加时覆盖彼此；
 * 自动消失的定时器在创建时就绑定当前 id，因此即使中途列表变化也能正确移除。
 */
export const useUiStore = create<UiStore>((set) => ({
  toasts: [],
  pushToast: (message, tone = 'info') => {
    toastSeq += 1;
    const id = toastSeq;
    // 只保留最近 4 条，防止连续报错时堆满屏幕
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }].slice(-4) }));
    // 4200ms 后自动移除；按 id 过滤，避免误删同文案的其他 Toast
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, 4200);
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

/**
 * 便捷的 Toast 调用入口。
 *
 * 直接读取 store 最新状态并追加，适合在事件回调或非组件代码中使用；
 * 组件内也可直接调用 useUiStore.getState().pushToast。
 *
 * @param message 展示文案
 * @param tone    语义色调，默认 info
 */
export function toast(message: string, tone: ToastTone = 'info') {
  useUiStore.getState().pushToast(message, tone);
}
