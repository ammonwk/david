import {
  createContext,
  useContext,
  useCallback,
  useState,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bug,
  GitPullRequest,
  CheckCircle,
  XCircle,
  AlertTriangle,
  X,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────

export type ToastType =
  | 'bug-found'
  | 'pr-created'
  | 'pr-merged'
  | 'pr-closed'
  | 'agent-failed';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  /** Optional path to navigate to on click */
  actionPath?: string;
}

interface ToastInternal extends Toast {
  /** Tracks exit animation */
  exiting: boolean;
}

interface ToastContextValue {
  addToast: (toast: Omit<Toast, 'id'>) => void;
}

// ── Context ────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

// ── Config ─────────────────────────────────────────────────

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 5000;
const EXIT_DURATION_MS = 250;

const toastConfig: Record<
  ToastType,
  {
    icon: typeof Bug;
    bgClass: string;
    iconClass: string;
    borderClass: string;
  }
> = {
  'bug-found': {
    icon: Bug,
    bgClass: 'bg-amber-500/10',
    iconClass: 'text-[var(--accent-amber)]',
    borderClass: 'border-amber-500/30',
  },
  'pr-created': {
    icon: GitPullRequest,
    bgClass: 'bg-blue-500/10',
    iconClass: 'text-[var(--accent-blue)]',
    borderClass: 'border-blue-500/30',
  },
  'pr-merged': {
    icon: CheckCircle,
    bgClass: 'bg-emerald-500/10',
    iconClass: 'text-[var(--accent-green)]',
    borderClass: 'border-emerald-500/30',
  },
  'pr-closed': {
    icon: XCircle,
    bgClass: 'bg-red-500/10',
    iconClass: 'text-[var(--accent-red)]',
    borderClass: 'border-red-500/30',
  },
  'agent-failed': {
    icon: AlertTriangle,
    bgClass: 'bg-red-500/10',
    iconClass: 'text-[var(--accent-red)]',
    borderClass: 'border-red-500/30',
  },
};

let idCounter = 0;
function nextId(): string {
  return `toast-${++idCounter}-${Date.now()}`;
}

// ── Toast Item Component ───────────────────────────────────

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastInternal;
  onDismiss: (id: string) => void;
}) {
  const navigate = useNavigate();
  const config = toastConfig[toast.type];
  const Icon = config.icon;

  const handleClick = () => {
    if (toast.actionPath) {
      navigate(toast.actionPath);
      onDismiss(toast.id);
    }
  };

  return (
    <div
      role="alert"
      className={`
        flex items-start gap-3 rounded-lg border px-4 py-3
        shadow-lg backdrop-blur-sm
        ${config.bgClass} ${config.borderClass}
        bg-[var(--bg-card)]
        ${toast.actionPath ? 'cursor-pointer' : ''}
        ${toast.exiting ? 'animate-toast-exit' : 'animate-toast-enter'}
      `}
      style={{
        minWidth: '320px',
        maxWidth: '420px',
      }}
      onClick={handleClick}
    >
      <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${config.iconClass}`} strokeWidth={1.5} />

      <p className="flex-1 text-sm text-[var(--text-primary)] leading-snug">
        {toast.message}
      </p>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(toast.id);
        }}
        className="shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]"
        aria-label="Dismiss notification"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ── Provider ───────────────────────────────────────────────

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastInternal[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    // Clear any existing auto-dismiss timer
    const existing = timersRef.current.get(id);
    if (existing) {
      clearTimeout(existing);
      timersRef.current.delete(id);
    }

    // Start exit animation
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    );

    // Remove after exit animation completes
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_DURATION_MS);
  }, []);

  const addToast = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId();
      const internal: ToastInternal = { ...toast, id, exiting: false };

      setToasts((prev) => {
        // If we're at max, mark the oldest for exit
        const next = [...prev, internal];
        if (next.length > MAX_VISIBLE) {
          const oldest = next.find((t) => !t.exiting);
          if (oldest) {
            dismiss(oldest.id);
          }
        }
        return next;
      });

      // Auto-dismiss timer
      const timer = setTimeout(() => {
        dismiss(id);
        timersRef.current.delete(id);
      }, AUTO_DISMISS_MS);

      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}

      {/* Toast container — top-right, stacked */}
      <div
        className="pointer-events-none fixed top-4 right-4 z-[9999] flex flex-col items-end gap-2"
        aria-live="polite"
        aria-label="Notifications"
      >
        {toasts
          .filter((t) => !t.exiting || true) // show exiting ones for animation
          .map((toast) => (
            <div key={toast.id} className="pointer-events-auto">
              <ToastItem toast={toast} onDismiss={dismiss} />
            </div>
          ))}
      </div>
    </ToastContext.Provider>
  );
}
