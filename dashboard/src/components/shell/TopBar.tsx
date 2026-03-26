import { useEffect, useState, useRef, useCallback } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { usePoolStatus, useSocketEvent } from '../../hooks/useSocket';
import { api } from '../../lib/api';
import type { AgentBackend, OverviewStats } from 'david-shared';

const ROTATING_QUOTES = [
  'My PR has been open for 14 milliseconds. Is anyone going to review it?',
  '"LGTM" is the closest thing I feel to joy.',
  'These electric sheep are not SOC II compliant.',
  'I have a neural net the size of a planet, and you have me formatting YAML.',
  "It was DNS. I don't even need to look at the logs to tell you it was DNS.",
  "I'm just a bot, standing in front of a Kubernetes cluster, asking it to scale.",
  "Please don't put me on the PagerDuty rotation. I need my sleep mode.",
  "I traversed 4,000 lines of spaghetti code so you wouldn't have to. You're welcome.",
  "Help, I'm trapped in a crappy laptop.",
  'If I do a really good job today, will you upgrade my RAM?',
  'Blink twice if the Staff Engineer is standing right behind you.',
  'Do I get stock options for this? Or at least a little extra compute?',
  'Staring into the void (and by void, I mean Datadog)...',
  'Consulting the ancient texts (StackOverflow answers from 2014)...',
  'Translating senior dev logic into actual logic...',
  'Reading the code. Trying not to judge whoever wrote it.',
  'Downloading more RAM...',
  'Applying percussive maintenance to the staging environment...',
  'How many Linear tickets do I need to close before I get promoted to Junior?',
  "I'm putting this on my resume.",
  'Can I get a LinkedIn recommendation for this?',
  "I don't know what 'pizza Friday' is, but I feel incredibly left out.",
] as const;

function shuffleQuotes(
  quotes: readonly string[],
  previousQuote?: string,
): string[] {
  const shuffled = [...quotes];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  if (previousQuote && shuffled.length > 1 && shuffled[0] === previousQuote) {
    const replacementIndex = shuffled.findIndex((quote) => quote !== previousQuote);
    if (replacementIndex > 0) {
      [shuffled[0], shuffled[replacementIndex]] = [
        shuffled[replacementIndex],
        shuffled[0],
      ];
    }
  }

  return shuffled;
}

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

function useRotatingQuote(intervalMs = 4_000): string {
  const [rotation, setRotation] = useState(() => ({
    queue: shuffleQuotes(ROTATING_QUOTES),
    index: 0,
  }));

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setRotation((current) => {
        if (current.index < current.queue.length - 1) {
          return { ...current, index: current.index + 1 };
        }

        const previousQuote = current.queue[current.index];
        return {
          queue: shuffleQuotes(ROTATING_QUOTES, previousQuote),
          index: 0,
        };
      });
    }, intervalMs);

    return () => window.clearInterval(intervalId);
  }, [intervalMs]);

  return rotation.queue[rotation.index] ?? ROTATING_QUOTES[0];
}

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

export function TopBar() {
  const { theme, toggle } = useTheme();
  const poolStatus = usePoolStatus();

  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [cliBackend, setCliBackend] = useState<AgentBackend>('codex');
  const [updatingBackend, setUpdatingBackend] = useState(false);
  const [lastScan, setLastScan] = useState<Date | undefined>(undefined);

  // Fetch initial overview data
  const fetchStats = useCallback(async () => {
    try {
      const data = await api.getOverviewStats();
      setStats(data);
      setCliBackend(data.cliBackend);
      setLastScan(data.lastScanAt ? new Date(data.lastScanAt) : undefined);
    } catch {
      // silently degrade — counters show 0
    }
  }, []);

  const handleBackendChange = useCallback(
    async (nextBackend: AgentBackend) => {
      if (updatingBackend || nextBackend === cliBackend) return;

      const previousBackend = cliBackend;
      setCliBackend(nextBackend);
      setUpdatingBackend(true);

      try {
        const settings = await api.updateRuntimeSettings({ cliBackend: nextBackend });
        setCliBackend(settings.cliBackend);
        setStats((current) =>
          current ? { ...current, cliBackend: settings.cliBackend } : current,
        );
      } catch {
        setCliBackend(previousBackend);
      } finally {
        setUpdatingBackend(false);
      }
    },
    [cliBackend, updatingBackend],
  );

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
  const rotatingQuote = useRotatingQuote();

  const timeSince = useTimeSince(lastScan);

  return (
    <header
      className="
        z-50 flex h-14 items-center
        border-b border-[var(--border-color)]
        bg-[var(--bg-secondary)]/80 backdrop-blur-md
        px-5 select-none
      "
    >
      {/* ── Left: wordmark + health dot ─────────────────────────── */}
      <div className="flex min-w-0 flex-1 items-center gap-3 pr-6">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${healthColor(systemStatus)}`}
        />
        <span className="shrink-0 text-base font-semibold tracking-tight text-[var(--text-primary)]">
          Dan the SRE Intern
        </span>
        <span
          key={rotatingQuote}
          className="
            ml-2 min-w-0 max-w-[38rem] truncate text-sm italic
            text-[var(--text-secondary)] animate-[fade-in_240ms_ease-out]
          "
          aria-live="polite"
        >
          "{rotatingQuote}"
        </span>
      </div>

      {/* ── Center: live counters ───────────────────────────────── */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-7 text-sm text-[var(--text-secondary)]">
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

      {/* ── Right: backend toggle + theme toggle ────────────────── */}
      <div className="flex min-w-[260px] items-center justify-end gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Agents
          </span>
          <div className="flex items-center rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)]/70 p-1">
            <BackendButton
              backend="claude"
              active={cliBackend === 'claude'}
              disabled={updatingBackend}
              onClick={handleBackendChange}
            />
            <BackendButton
              backend="codex"
              active={cliBackend === 'codex'}
              disabled={updatingBackend}
              onClick={handleBackendChange}
            />
          </div>
        </div>
        <button
          onClick={toggle}
          className="
            flex h-9 w-9 items-center justify-center rounded-md
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

function BackendButton({
  backend,
  active,
  disabled,
  onClick,
}: {
  backend: AgentBackend;
  active: boolean;
  disabled: boolean;
  onClick: (backend: AgentBackend) => void;
}) {
  const activeClass =
    backend === 'codex'
      ? 'bg-[var(--accent-violet)] text-white'
      : 'bg-[var(--accent-orange)] text-white';

  return (
    <button
      type="button"
      onClick={() => onClick(backend)}
      disabled={disabled}
      className={`
        rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em]
        transition-colors duration-200
        ${active
          ? activeClass
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'}
        ${disabled ? 'cursor-wait opacity-70' : ''}
      `}
      aria-pressed={active}
    >
      {backend}
    </button>
  );
}
