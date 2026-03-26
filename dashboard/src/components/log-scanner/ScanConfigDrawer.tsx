import { useState, useEffect, useRef } from 'react';
import type {
  ScanScheduleConfig,
  ScanTimeSpan,
  SeverityFilter,
  TriggerScanRequest,
} from 'david-shared';
import {
  X,
  Play,
  Pause,
  Clock,
  Loader2,
  Settings,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanConfigDrawerProps {
  open: boolean;
  onClose: () => void;
  config: ScanScheduleConfig;
  onConfigChange: (updates: Partial<ScanScheduleConfig>) => void;
  onTriggerScan: (config: TriggerScanRequest) => void;
  nextRunAt?: Date;
  isScanning: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIME_SPANS: { value: ScanTimeSpan; label: string }[] = [
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
];

const SEVERITY_OPTIONS: { value: SeverityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'warn-error', label: 'Warn+Error' },
  { value: 'error', label: 'Error Only' },
];

// ---------------------------------------------------------------------------
// Countdown hook
// ---------------------------------------------------------------------------

function useCountdown(targetDate?: Date): string {
  const [now, setNow] = useState(() => Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!targetDate) return;

    intervalRef.current = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [targetDate]);

  if (!targetDate) return '--:--';

  const target = new Date(targetDate).getTime();
  const diff = Math.max(0, target - now);

  if (diff <= 0) return 'now';

  const totalSeconds = Math.floor(diff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return `${hours}h ${remainMinutes}m`;
  }

  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScanConfigDrawer({
  open,
  onClose,
  config,
  onConfigChange,
  onTriggerScan,
  nextRunAt,
  isScanning,
}: ScanConfigDrawerProps) {
  const countdown = useCountdown(nextRunAt);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const handleScanNow = () => {
    onTriggerScan({
      timeSpan: config.timeSpan,
      severity: config.severity,
    });
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
      onClose();
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={`
          fixed inset-0 z-40 bg-black/50 backdrop-blur-sm
          transition-opacity duration-300 ease-in-out
          ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}
        `}
        onClick={handleBackdropClick}
      >
        {/* Drawer panel */}
        <div
          ref={drawerRef}
          className={`
            fixed inset-y-0 right-0 z-50 w-full max-w-sm
            border-l border-[var(--border-color)] bg-[var(--bg-card)]
            shadow-2xl
            transition-transform duration-300 ease-in-out
            ${open ? 'translate-x-0' : 'translate-x-full'}
          `}
          role="dialog"
          aria-modal="true"
          aria-label="Scan Configuration"
        >
          <div className="flex h-full flex-col">
            {/* Drawer header */}
            <div className="flex items-center justify-between border-b border-[var(--border-color)] px-5 py-4">
              <div className="flex items-center gap-2.5">
                <Settings className="h-4 w-4 text-[var(--accent-blue)]" />
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  Scan Configuration
                </h2>
              </div>
              <button
                onClick={onClose}
                className="rounded-md p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                aria-label="Close drawer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Drawer body */}
            <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
              {/* Time Span */}
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--text-secondary)]">
                  Time Span
                </label>
                <div className="flex rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-0.5">
                  {TIME_SPANS.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => onConfigChange({ timeSpan: value })}
                      className={`
                        flex-1 rounded-md px-2 py-2 text-xs font-medium transition-all duration-200
                        ${
                          config.timeSpan === value
                            ? 'bg-[var(--accent-blue)] text-white shadow-[0_0_10px_rgba(59,130,246,0.4)]'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                        }
                      `}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Severity Filter */}
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--text-secondary)]">
                  Severity Filter
                </label>
                <div className="flex rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-0.5">
                  {SEVERITY_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => onConfigChange({ severity: value })}
                      className={`
                        flex-1 rounded-md px-2 py-2 text-xs font-medium transition-all duration-200
                        ${
                          config.severity === value
                            ? 'bg-[var(--accent-blue)] text-white shadow-[0_0_10px_rgba(59,130,246,0.4)]'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                        }
                      `}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Schedule */}
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--text-secondary)]">
                  Schedule
                </label>
                <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {/* Toggle switch */}
                      <button
                        onClick={() => onConfigChange({ enabled: !config.enabled })}
                        className={`
                          relative inline-flex h-5 w-9 shrink-0 items-center rounded-full
                          transition-colors duration-200
                          ${config.enabled ? 'bg-[var(--accent-blue)]' : 'bg-[var(--bg-tertiary)] border border-[var(--border-color)]'}
                        `}
                        role="switch"
                        aria-checked={config.enabled}
                      >
                        <span
                          className={`
                            inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-200
                            ${config.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'}
                          `}
                        />
                      </button>
                      <span className="text-xs text-[var(--text-secondary)]">
                        {config.enabled ? 'Active' : 'Paused'}
                      </span>
                    </div>
                    {config.enabled && (
                      <button
                        onClick={() => onConfigChange({ enabled: false })}
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent-yellow)]"
                      >
                        <Pause className="h-3 w-3" />
                        Pause
                      </button>
                    )}
                  </div>

                  {config.enabled && (
                    <div className="mt-3 space-y-2">
                      {/* Interval display */}
                      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                        <Clock className="h-3 w-3" />
                        <span>
                          Runs every scan cycle ({config.cronExpression})
                        </span>
                      </div>

                      {/* Next run countdown */}
                      {nextRunAt && (
                        <div className="flex items-center gap-2 rounded-md bg-[var(--bg-tertiary)] px-3 py-2">
                          <Clock className="h-3.5 w-3.5 text-[var(--accent-blue)]" />
                          <span className="text-xs text-[var(--text-secondary)]">
                            Next run:{' '}
                            <span className="font-semibold text-[var(--text-primary)] tabular-nums">
                              {countdown}
                            </span>
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Drawer footer — Scan Now */}
            <div className="border-t border-[var(--border-color)] px-5 py-4">
              <button
                onClick={handleScanNow}
                disabled={isScanning}
                className={`
                  flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold
                  transition-all duration-200
                  ${
                    isScanning
                      ? 'cursor-not-allowed bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                      : 'bg-[var(--accent-blue)] text-white shadow-[0_0_16px_rgba(59,130,246,0.4)] hover:shadow-[0_0_24px_rgba(59,130,246,0.6)] hover:bg-blue-600 active:scale-[0.98]'
                  }
                `}
              >
                {isScanning ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {isScanning ? 'Scanning...' : 'Scan Now'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
