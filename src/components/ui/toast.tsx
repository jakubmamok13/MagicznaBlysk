import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Czas wyświetlania w ms (domyślnie 4500). */
  duration?: number;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
  dismiss: (id: number) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastVariant, React.ComponentType<{ className?: string }>> = {
  info: Info,
  success: CheckCircle2,
  error: AlertTriangle,
};

const ACCENTS: Record<ToastVariant, string> = {
  info: 'border-l-primary',
  success: 'border-l-success',
  error: 'border-l-destructive',
};

const ICON_COLORS: Record<ToastVariant, string> = {
  info: 'text-primary',
  success: 'text-success',
  error: 'text-destructive',
};

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);
  const timers = React.useRef(new Map<number, number>());
  const nextId = React.useRef(1);

  const dismiss = React.useCallback((id: number): void => {
    setToasts((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = React.useCallback(
    (input: ToastInput): void => {
      const id = nextId.current;
      nextId.current += 1;
      const message: ToastMessage = {
        id,
        title: input.title,
        variant: input.variant ?? 'info',
        ...(input.description !== undefined ? { description: input.description } : {}),
      };
      setToasts((current) => [...current.slice(-3), message]);
      const timer = window.setTimeout(() => dismiss(id), input.duration ?? 4500);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  React.useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const value = React.useMemo<ToastContextValue>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 safe-bottom sm:inset-x-auto sm:right-0 sm:items-end"
        role="region"
        aria-label="Powiadomienia"
      >
        {toasts.map((item) => {
          const Icon = ICONS[item.variant];
          return (
            <div
              key={item.id}
              role="status"
              aria-live="polite"
              className={cn(
                'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-l-4 bg-card p-3 shadow-lg animate-slide-up',
                ACCENTS[item.variant],
              )}
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', ICON_COLORS[item.variant])} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug">{item.title}</p>
                {item.description !== undefined && (
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                    {item.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Zamknij powiadomienie"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast musi być użyty wewnątrz <ToastProvider>.');
  }
  return context;
}
