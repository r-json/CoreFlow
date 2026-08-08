'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import { CheckCircle2, AlertCircle, Info, X, AlertTriangle } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string, duration?: number) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fallback — return a no-op toast interface so components work even outside provider
    return {
      toast: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
      warning: () => {},
    } as ToastContextValue;
  }
  return ctx;
}

const TOAST_CONFIG: Record<
  ToastType,
  { icon: typeof CheckCircle2; borderColor: string; bgColor: string; textColor: string; iconColor: string }
> = {
  success: {
    icon: CheckCircle2,
    borderColor: 'border-emerald-500/30',
    bgColor: 'bg-emerald-950/80',
    textColor: 'text-emerald-200',
    iconColor: 'text-emerald-400',
  },
  error: {
    icon: AlertCircle,
    borderColor: 'border-rose-500/30',
    bgColor: 'bg-rose-950/80',
    textColor: 'text-rose-200',
    iconColor: 'text-rose-400',
  },
  info: {
    icon: Info,
    borderColor: 'border-violet-500/30',
    bgColor: 'bg-violet-950/80',
    textColor: 'text-violet-200',
    iconColor: 'text-violet-400',
  },
  warning: {
    icon: AlertTriangle,
    borderColor: 'border-amber-500/30',
    bgColor: 'bg-amber-950/80',
    textColor: 'text-amber-200',
    iconColor: 'text-amber-400',
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (type: ToastType, message: string, duration = 4000) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const newToast: Toast = { id, type, message, duration };
      setToasts((prev) => [...prev.slice(-4), newToast]); // Keep max 5

      if (duration > 0) {
        setTimeout(() => removeToast(id), duration);
      }
    },
    [removeToast]
  );

  const contextValue: ToastContextValue = {
    toast: addToast,
    success: (msg) => addToast('success', msg),
    error: (msg) => addToast('error', msg, 6000),
    info: (msg) => addToast('info', msg),
    warning: (msg) => addToast('warning', msg, 5000),
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}

      {/* Toast Container */}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map((t) => {
          const config = TOAST_CONFIG[t.type];
          const Icon = config.icon;

          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border ${config.borderColor} ${config.bgColor} backdrop-blur-xl shadow-2xl shadow-black/40 animate-fade-in`}
            >
              <Icon className={`w-4 h-4 ${config.iconColor} shrink-0 mt-0.5`} />
              <p className={`text-xs font-medium ${config.textColor} flex-1`}>
                {t.message}
              </p>
              <button
                onClick={() => removeToast(t.id)}
                className="text-slate-500 hover:text-slate-300 transition-colors shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
