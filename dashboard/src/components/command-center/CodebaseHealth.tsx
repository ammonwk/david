import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
  ShieldAlert,
  Search,
  Wrench,
  CheckCircle2,
  FileCode2,
  GitPullRequest,
  ChevronDown,
  Cpu,
  MemoryStick,
  AlertTriangle,
} from 'lucide-react';
import type { SREState, KnownIssue, IssueStatus, IssueSeverity } from 'david-shared';
import { api } from '../../lib/api';

// ── Severity colors ──────────────────────────────────────────────────────────

const SEVERITY_EDGE: Record<IssueSeverity, string> = {
  critical: 'border-l-red-500',
  high: 'border-l-orange-500',
  medium: 'border-l-yellow-500',
  low: 'border-l-blue-500',
};

const SEVERITY_DOT: Record<IssueSeverity, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
};

const SEVERITY_TEXT: Record<IssueSeverity, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-yellow-400',
  low: 'text-blue-400',
};

// ── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<IssueStatus, { label: string; color: string; bg: string }> = {
  active: { label: 'Active', color: 'text-red-400', bg: 'bg-red-500/10' },
  investigating: { label: 'Investigating', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  fixing: { label: 'Fixing', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  resolved: { label: 'Resolved', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
};

// ── Time formatting ──────────────────────────────────────────────────────────

function timeAgo(date: Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Summary pill ─────────────────────────────────────────────────────────────

function SummaryPill({
  icon: Icon,
  count,
  label,
  colorClass,
  bgClass,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  count: number;
  label: string;
  colorClass: string;
  bgClass: string;
}) {
  return (
    <div className={`flex items-center gap-1.5 rounded-md px-2 py-1 ${bgClass}`}>
      <Icon className={`h-3 w-3 ${colorClass}`} strokeWidth={2} />
      <span className={`text-xs font-bold tabular-nums ${colorClass}`}>{count}</span>
      <span className="text-[10px] text-[var(--text-muted)]">{label}</span>
    </div>
  );
}

// ── Issue row ────────────────────────────────────────────────────────────────

function IssueRow({ issue, onClick }: { issue: KnownIssue; onClick?: () => void }) {
  const status = STATUS_CONFIG[issue.status];
  const fileCount = issue.affectedFiles?.length ?? 0;
  const prCount = issue.relatedPrIds?.length ?? 0;

  return (
    <button
      onClick={onClick}
      className={`
        group flex w-full items-start gap-2.5 border-l-2 px-3 py-2
        text-left transition-all duration-150
        hover:bg-[var(--bg-tertiary)]
        ${SEVERITY_EDGE[issue.severity]}
      `}
    >
      {/* Severity dot */}
      <div className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[issue.severity]}`} />

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-snug text-[var(--text-primary)] group-hover:text-[var(--accent-blue)]">
          {issue.pattern}
        </p>

        {issue.rootCause && (
          <p className="mt-0.5 truncate text-[10px] text-[var(--text-muted)]">
            {issue.rootCause}
          </p>
        )}

        {/* Meta row */}
        <div className="mt-1 flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${status.color} ${status.bg}`}>
            {status.label}
          </span>
          <span className={`text-[10px] font-medium ${SEVERITY_TEXT[issue.severity]}`}>
            {issue.severity}
          </span>
          {fileCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-[var(--text-muted)]">
              <FileCode2 className="h-2.5 w-2.5" />
              {fileCount}
            </span>
          )}
          {prCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-[var(--text-muted)]">
              <GitPullRequest className="h-2.5 w-2.5" />
              {prCount}
            </span>
          )}
          <span className="ml-auto text-[10px] tabular-nums text-[var(--text-muted)]">
            {timeAgo(issue.lastSeen)}
          </span>
        </div>
      </div>
    </button>
  );
}

// ── Baselines strip ──────────────────────────────────────────────────────────

function BaselinesStrip({ baselines }: { baselines: SREState['baselines'] }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2">
      <span className="text-[10px] font-medium text-[var(--text-muted)]">Baselines</span>
      <div className="h-3 w-px bg-[var(--border-color)]" />
      <div className="flex items-center gap-1">
        <Cpu className="h-3 w-3 text-blue-400" />
        <span className="text-[10px] tabular-nums text-[var(--text-secondary)]">{baselines.cpuMax}%</span>
      </div>
      <div className="flex items-center gap-1">
        <MemoryStick className="h-3 w-3 text-violet-400" />
        <span className="text-[10px] tabular-nums text-[var(--text-secondary)]">{baselines.memoryMax}%</span>
      </div>
      <div className="flex items-center gap-1">
        <AlertTriangle className="h-3 w-3 text-amber-400" />
        <span className="text-[10px] tabular-nums text-[var(--text-secondary)]">{baselines.errorRatePerHour}/hr</span>
      </div>
      <span className="ml-auto text-[10px] text-[var(--text-muted)]">
        updated {timeAgo(baselines.lastUpdated)}
      </span>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export function CodebaseHealth() {
  const navigate = useNavigate();
  const [state, setState] = useState<SREState | null>(null);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      const data = await api.getSREState();
      setState(data);
    } catch {
      // Retry on next interval
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll every 30s
  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 30_000);
    return () => clearInterval(interval);
  }, [fetchState]);

  // Derive counts
  const activeIssues = state?.knownIssues ?? [];
  const resolvedIssues = state?.resolvedIssues ?? [];

  const countByStatus = (status: IssueStatus) =>
    activeIssues.filter(i => i.status === status).length;

  const activeCount = countByStatus('active');
  const investigatingCount = countByStatus('investigating');
  const fixingCount = countByStatus('fixing');
  const resolvedCount = resolvedIssues.length;

  // Sort active issues: critical first, then high, etc.
  const SEVERITY_ORDER: Record<IssueSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sortedActive = [...activeIssues].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  // Health indicator
  const criticalOrHigh = activeIssues.filter(
    i => i.severity === 'critical' || i.severity === 'high',
  ).length;
  const isHealthy = activeIssues.length === 0;
  const isWarning = !isHealthy && criticalOrHigh === 0;
  const isAlert = criticalOrHigh > 0;

  if (loading) {
    return (
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[var(--accent-blue)]" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">Codebase Health</span>
        </div>
        <div className="flex-1 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-md border border-[var(--border-color)] bg-[var(--bg-card)]"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          {isHealthy && <ShieldCheck className="h-4 w-4 text-emerald-400" strokeWidth={2} />}
          {isWarning && <ShieldCheck className="h-4 w-4 text-yellow-400" strokeWidth={2} />}
          {isAlert && <ShieldAlert className="h-4 w-4 text-red-400" strokeWidth={2} />}
          Codebase Health
        </h2>

        {isHealthy && (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
            All clear
          </span>
        )}
        {!isHealthy && (
          <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
            {activeIssues.length} issue{activeIssues.length !== 1 ? 's' : ''} tracked
          </span>
        )}
      </div>

      {/* Summary pills */}
      <div className="flex flex-wrap gap-1.5">
        <SummaryPill icon={ShieldAlert} count={activeCount} label="Active" colorClass="text-red-400" bgClass="bg-red-500/10" />
        <SummaryPill icon={Search} count={investigatingCount} label="Investigating" colorClass="text-amber-400" bgClass="bg-amber-500/10" />
        <SummaryPill icon={Wrench} count={fixingCount} label="Fixing" colorClass="text-blue-400" bgClass="bg-blue-500/10" />
        <SummaryPill icon={CheckCircle2} count={resolvedCount} label="Resolved" colorClass="text-emerald-400" bgClass="bg-emerald-500/10" />
      </div>

      {/* Active issues list */}
      <div className="flex-1 overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
        {sortedActive.length === 0 && resolvedCount === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-[var(--text-muted)]">
            <ShieldCheck className="mb-2 h-8 w-8 text-emerald-400/50" />
            <p className="text-xs">No known issues</p>
            <p className="mt-1 text-[10px]">Run a scan or audit to analyze the codebase</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-color)]">
            {/* Active issues */}
            {sortedActive.map(issue => (
              <IssueRow
                key={issue.id}
                issue={issue}
                onClick={() => navigate('/logs')}
              />
            ))}

            {/* Resolved issues (collapsible) */}
            {resolvedCount > 0 && (
              <>
                <button
                  onClick={() => setShowResolved(v => !v)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                  <ChevronDown
                    className={`h-3 w-3 text-[var(--text-muted)] transition-transform ${showResolved ? 'rotate-0' : '-rotate-90'}`}
                  />
                  <span className="text-[10px] font-medium text-[var(--text-muted)]">
                    {resolvedCount} resolved issue{resolvedCount !== 1 ? 's' : ''}
                  </span>
                </button>

                {showResolved &&
                  resolvedIssues.map(issue => (
                    <IssueRow
                      key={issue.id}
                      issue={{ ...issue, status: 'resolved' }}
                      onClick={() => navigate('/logs')}
                    />
                  ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Baselines footer */}
      {state?.baselines && <BaselinesStrip baselines={state.baselines} />}
    </div>
  );
}
