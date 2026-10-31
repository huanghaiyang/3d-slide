import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface UiStore {
  toasts: ToastItem[];
  pushToast: (message: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

export const useUiStore = create<UiStore>((set) => ({
  toasts: [],
  pushToast: (message, tone = 'info') => {
    toastSeq += 1;
    const id = toastSeq;
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }].slice(-4) }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, 4200);
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export function toast(message: string, tone: ToastTone = 'info') {
  useUiStore.getState().pushToast(message, tone);
}
