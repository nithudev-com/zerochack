'use client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Toast = { id: string; message: string; tone: 'info' | 'success' | 'danger' };
type ToastContextValue = { notify: (message: string, tone?: Toast['tone']) => void };
const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = crypto.randomUUID(); setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4_000);
  }, []);
  const value = useMemo(() => ({ notify }), [notify]);
  return <ToastContext.Provider value={value}>{children}<div className="ui-toast-region" aria-live="polite">{toasts.map((toast) => <div className={`ui-toast ui-toast--${toast.tone}`} key={toast.id}>{toast.message}</div>)}</div></ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext); if (!value) throw new Error('useToast must be used within ToastProvider'); return value;
}
