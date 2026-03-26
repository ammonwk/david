import { useEffect, useState, useRef, useCallback } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { usePoolStatus, useSocketEvent } from '../../hooks/useSocket';
import { api } from '../../lib/api';
import type { OverviewStats } from 'david-shared';

// ---------------------------------------------------------------------------
// Animated counter — spring-style interpolation for smooth number transitions
// ---------------------------------------------------------------------------

function useAnimatedValue(target: number, duration = 400): number {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number>(0);
  const displayRef = useRef(target);

  useEffect(() => {
    const start = displayRef.current;
    if (start === target) return;

    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(start + (target - start) * eased);
      displayRef.current = current;
      setDisplay(current);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, duration]);

  return display;
}

// ---------------------------------------------------------------------------
// Time-since display — auto-updating relative time
// ---------------------------------------------------------------------------

function useTimeSince(date: Date | undefined | null): string {
  const [label, setLabel] = useState('--');

  useEffect(() => {
    if (!date) {
      setLabel('--');
      return;
    }

    const update = () => {
      const diffMs = Date.now() - new Date(date).getTime();
      if (diffMs < 0) {
        setLabel('just now');
        return;
      }
      const sec = Math.floor(diffMs / 1000);
      if (sec < 60) {
        setLabel(`${sec}s ago`);
        return;
      }
      const min = Math.floor(sec / 60);
      if (min < 60) {
        setLabel(`${min}m ago`);
        return;
      }
      const hr = Math.floor(min / 60);
      if (hr < 24) {
        setLabel(`${hr}h ${min % 60}m ago`);
        return;
      }
      setLabel(`${Math.floor(hr / 24)}d ago`);
    };

    update();
    const id = setInterval(update, 10_000);
    return () => clearInterval(id);
  }, [date]);

  return label;
}

// ---------------------------------------------------------------------------
// Health dot color
// ---------------------------------------------------------------------------

function healthColor(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.6)]';
    case 'paused':
      return 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.6)]';
    default:
      return 'bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.6)]';
  }
}

// ---------------------------------------------------------------------------
// Theme icon
// ---------------------------------------------------------------------------

function ThemeIcon({ theme }: { theme: string }) {
  if (theme === 'light') return <Sun className="h-4 w-4" />;
  if (theme === 'dark') return <Moon className="h-4 w-4" />;
  return <Monitor className="h-4 w-4" />;
}

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

export function TopBar() {
  const { theme, toggle } = useTheme();
  const poolStatus = usePoolStatus();

  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [lastScan, setLastScan] = useState<Date | undefined>(undefined);

  // Fetch initial overview data
  const fetchStats = useCallback(async () => {
    try {
      const data = await api.getOverviewStats();
      setStats(data);
      if (data.lastScanAt) setLastScan(new Date(data.lastScanAt));
    } catch {
      // silently degrade — counters show 0
    }
  }, []);

  // Initial fetch only — no polling
  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Re-fetch on state-changing events (pure push, no polling)
  useSocketEvent('scan:completed', () => {
    setLastScan(new Date());
    fetchStats();
  });
  useSocketEvent('pr:created', fetchStats);
  useSocketEvent('pr:merged', fetchStats);
  useSocketEvent('pr:closed', fetchStats);
  useSocketEvent('bug:reported', fetchStats);
  useSocketEvent('agent:completed', fetchStats);

  // Resolve numbers: prefer real-time pool, fall back to stats
  const activeAgents = poolStatus?.activeCount ?? stats?.activeAgents ?? 0;
  const queuedAgents = poolStatus?.queuedCount ?? stats?.queuedAgents ?? 0;
  const openPRs = stats?.prsCreatedToday ?? 0;
  const systemStatus = stats?.systemStatus ?? 'running';

  // Animated values
  const animActive = useAnimatedValue(activeAgents);
  const animQueued = useAnimatedValue(queuedAgents);
  const animPRs = useAnimatedValue(openPRs);

  const timeSince = useTimeSince(lastScan);

  return (
    <header
      className="
        z-50 flex h-11 items-center
        border-b border-[var(--border-color)]
        bg-[var(--bg-secondary)]/80 backdrop-blur-md
        px-4 select-none
      "
    >
      {/* ── Left: wordmark + health dot ─────────────────────────── */}
      <div className="flex items-center gap-2.5 min-w-[120px]">
        <span
          className={`h-2 w-2 rounded-full ${healthColor(systemStatus)}`}
        />
        <span className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
          David
        </span>
      </div>

      {/* ── Center: live counters ───────────────────────────────── */}
      <div className="flex flex-1 items-center justify-center gap-6 text-xs text-[var(--text-secondary)]">
        <CounterChip
          value={animActive}
          suffix={animActive === 1 ? ' agent active' : ' agents active'}
        />
        <Separator />
        <CounterChip value={animQueued} suffix=" queued" />
        <Separator />
        <span className="whitespace-nowrap">
          last scan{' '}
          <span className="font-semibold tabular-nums text-[var(--text-primary)]">
            {timeSince}
          </span>
        </span>
        <Separator />
        <CounterChip value={animPRs} suffix=" PRs" />
      </div>

      {/* ── Right: theme toggle ─────────────────────────────────── */}
      <div className="flex items-center min-w-[120px] justify-end">
        <button
          onClick={toggle}
          className="
            flex h-7 w-7 items-center justify-center rounded-md
            text-[var(--text-muted)] transition-colors duration-200
            hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]
          "
          aria-label={`Switch theme (current: ${theme})`}
          title={`Theme: ${theme}`}
        >
          <ThemeIcon theme={theme} />
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function CounterChip({ value, suffix }: { value: number; suffix: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-semibold tabular-nums text-[var(--text-primary)]">
        {value}
      </span>
      {suffix}
    </span>
  );
}

function Separator() {
  return (
    <span className="text-[var(--border-color)]" aria-hidden>
      |
    </span>
  );
}
