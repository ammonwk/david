import { useState } from 'react';
import type { ScanResult, KnownIssue } from 'david-shared';
import {
  Clock,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Search,
  ArrowUpCircle,
  ArrowDownCircle,
  MinusCircle,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScanHistoryProps {
  scanHistory: ScanResult[];
  knownIssuesMap: Map<string, KnownIssue>;
  loading: boolean;
  error: string | null;
  /** If set, only show scans overlapping [start, end) */
  timeFilter: { start: Date; end: Date } | null;
  onClearFilter: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function durationLabel(scan: ScanResult): string {
  if (!scan.completedAt) return '--';
  const ms = new Date(scan.completedAt).getTime() - new Date(scan.startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

function configSummary(scan: ScanResult): string {
  return `${scan.config.timeSpan} / ${scan.config.severity}`;
}

function resultBadges(scan: ScanResult): Array<{ label: string; variant: 'red' | 'amber' | 'green' | 'muted' }> {
  const badges: Array<{ label: string; variant: 'red' | 'amber' | 'green' | 'muted' }> = [];
  if (scan.status === 'running') {
    badges.push({ label: 'Scanning...', variant: 'muted' });
    return badges;
  }
  if (scan.status === 'failed') {
    badges.push({ label: 'Failed', variant: 'red' });
    return badges;
  }
  if (scan.newIssues.length > 0) {
    badges.push({
      label: `${scan.newIssues.length} new bug${scan.newIssues.length !== 1 ? 's' : ''}`,
      variant: 'red',
    });
  }
  if (scan.resolvedIssues.length > 0) {
    badges.push({
      label: `${scan.resolvedIssues.length} resolved`,
      variant: 'green',
    });
  }
  if (scan.updatedIssues.length > 0) {
    badges.push({
      label: `${scan.updatedIssues.length} updated`,
      variant: 'amber',
    });
  }
  if (badges.length === 0) {
    badges.push({ label: 'Clean', variant: 'muted' });
  }
  return badges;
}

function severityColor(level: string): string {
  switch (level.toLowerCase()) {
    case 'error':
    case 'critical':
      return 'text-[var(--accent-red)]';
    case 'warn':
    case 'warning':
      return 'text-[var(--accent-yellow)]';
    case 'info':
      return 'text-[var(--accent-blue)]';
    default:
      return 'text-[var(--text-secondary)]';
  }
}

const BADGE_STYLES: Record<string, string> = {
  red: 'bg-[var(--accent-red)]/15 text-[var(--accent-red)] border-[var(--accent-red)]/25',
  amber: 'bg-[var(--accent-amber)]/15 text-[var(--accent-amber)] border-[var(--accent-amber)]/25',
  green: 'bg-[var(--accent-green)]/15 text-[var(--accent-green)] border-[var(--accent-green)]/25',
  muted: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-color)]',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { status: ScanResult['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle className="h-3.5 w-3.5 text-[var(--accent-green)]" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-[var(--accent-red)]" />;
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent-blue)]" />;
    default:
      return null;
  }
}

function ExpandedFindings({
  scan,
  knownIssuesMap,
}: {
  scan: ScanResult;
  knownIssuesMap: Map<string, KnownIssue>;
}) {
  const allIssueIds = [
    ...scan.newIssues.map((id) => ({ id, type: 'new' as const })),
    ...scan.updatedIssues.map((id) => ({ id, type: 'updated' as const })),
    ...scan.resolvedIssues.map((id) => ({ id, type: 'resolved' as const })),
  ];

  return (
    <div className="border-t border-[var(--border-color)]/50 bg-[var(--bg-secondary)]/50 px-5 py-4">
      {/* Summary */}
      {scan.summary && (
        <div className="mb-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3">
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{scan.summary}</p>
        </div>
      )}

      {/* Error */}
      {scan.status === 'failed' && scan.error && (
        <div className="mb-3 rounded-lg border border-[var(--accent-red)]/30 bg-[var(--accent-red)]/5 px-4 py-3">
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-red)]" />
            <p className="text-xs text-[var(--accent-red)]">{scan.error}</p>
          </div>
        </div>
      )}

      {/* Findings list */}
      {allIssueIds.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-2 text-xs font-semibold text-[var(--text-primary)]">
            Issues ({allIssueIds.length})
          </h4>
          <div className="space-y-1">
            {allIssueIds.map(({ id, type }) => {
              const issue = knownIssuesMap.get(id);
              const icon =
                type === 'new' ? (
                  <ArrowUpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent-red)]" />
                ) : type === 'resolved' ? (
                  <ArrowDownCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent-green)]" />
                ) : (
                  <MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent-yellow)]" />
                );
              const statusLabel =
                type === 'new' ? 'New' : type === 'resolved' ? 'Resolved' : 'Updated';
              const statusColor =
                type === 'new'
                  ? 'text-[var(--accent-red)]'
                  : type === 'resolved'
                    ? 'text-[var(--accent-green)]'
                    : 'text-[var(--accent-yellow)]';

              return (
                <div
                  key={`${type}-${id}`}
                  className="flex items-start gap-2.5 rounded-md px-3 py-2 transition-colors duration-150 hover:bg-[var(--bg-tertiary)]/50"
                >
                  {icon}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-semibold uppercase ${statusColor}`}>
                        {statusLabel}
                      </span>
                      {issue?.severity && (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${severityColor(issue.severity)}`}
                        >
                          {issue.severity}
                        </span>
                      )}
                      {issue?.status && (
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {issue.status}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[var(--text-secondary)]">
                      {issue?.pattern || id}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Log Patterns */}
      {scan.logPatterns && scan.logPatterns.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold text-[var(--text-primary)]">
            Log Patterns ({scan.logPatterns.length})
          </h4>
          <div className="overflow-x-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--border-color)] text-[var(--text-muted)]">
                  <th className="px-3 py-2 font-medium">Pattern</th>
                  <th className="px-3 py-2 font-medium text-right">Count</th>
                  <th className="px-3 py-2 font-medium">Level</th>
                </tr>
              </thead>
              <tbody>
                {[...scan.logPatterns]
                  .sort((a, b) => b.count - a.count)
                  .map((pattern, i) => (
                    <tr
                      key={i}
                      className="border-b border-[var(--border-color)]/30 last:border-b-0 hover:bg-[var(--bg-tertiary)]/30"
                    >
                      <td className="max-w-xs truncate px-3 py-1.5 font-mono text-[var(--text-secondary)]">
                        {pattern.message}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono font-semibold text-[var(--text-primary)] tabular-nums">
                        {pattern.count.toLocaleString()}
                      </td>
                      <td className={`px-3 py-1.5 font-medium ${severityColor(pattern.level)}`}>
                        {pattern.level}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* No findings at all */}
      {allIssueIds.length === 0 &&
        (!scan.logPatterns || scan.logPatterns.length === 0) &&
        scan.status === 'completed' && (
          <div className="flex items-center gap-2 py-2">
            <CheckCircle className="h-4 w-4 text-[var(--accent-green)]" />
            <p className="text-xs text-[var(--text-secondary)]">No issues found in this scan.</p>
          </div>
        )}
    </div>
  );
}

/** Loading skeleton rows */
function SkeletonRows() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div
            className="h-4 rounded bg-[var(--bg-tertiary)] animate-pulse-slow"
            style={{ width: `${80 + Math.random() * 40}px` }}
          />
          <div
            className="h-4 rounded bg-[var(--bg-tertiary)] animate-pulse-slow"
            style={{ width: `${50 + Math.random() * 30}px` }}
          />
          <div
            className="h-4 flex-1 rounded bg-[var(--bg-tertiary)] animate-pulse-slow"
          />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ScanHistory({
  scanHistory,
  knownIssuesMap,
  loading,
  error,
  timeFilter,
  onClearFilter,
}: ScanHistoryProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Filter by time range if active
  const filteredHistory = timeFilter
    ? scanHistory.filter((scan) => {
        const scanStart = new Date(scan.startedAt).getTime();
        const scanEnd = scan.completedAt
          ? new Date(scan.completedAt).getTime()
          : Date.now();
        const filterStart = timeFilter.start.getTime();
        const filterEnd = timeFilter.end.getTime();
        // Overlap check
        return scanStart < filterEnd && scanEnd > filterStart;
      })
    : scanHistory;

  return (
    <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border-color)] px-5 py-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-[var(--text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Scan History</h2>
          {filteredHistory.length > 0 && (
            <span className="text-xs text-[var(--text-muted)]">
              ({filteredHistory.length})
            </span>
          )}
        </div>
        {timeFilter && (
          <button
            onClick={onClearFilter}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-[var(--accent-blue)] transition-colors hover:bg-[var(--accent-blue)]/10"
          >
            <XCircle className="h-3 w-3" />
            Clear filter
          </button>
        )}
      </div>

      {/* Time filter indicator */}
      {timeFilter && (
        <div className="border-b border-[var(--border-color)]/50 bg-[var(--accent-blue)]/5 px-5 py-2">
          <span className="text-[10px] text-[var(--accent-blue)]">
            Showing scans from {formatDate(timeFilter.start)}{' '}
            {formatTime(timeFilter.start)} to {formatTime(timeFilter.end)}
          </span>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <SkeletonRows />
      ) : error ? (
        <div className="px-5 py-8 text-center">
          <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-[var(--accent-yellow)]" />
          <p className="text-xs text-[var(--text-muted)]">{error}</p>
        </div>
      ) : filteredHistory.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <Search className="mx-auto mb-2 h-5 w-5 text-[var(--text-muted)]" />
          <p className="text-xs text-[var(--text-muted)]">
            {timeFilter
              ? 'No scans match this time range.'
              : 'No scans yet. Click "Scan Now" to run your first scan.'}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[var(--border-color)]/50">
          {filteredHistory.map((scan) => {
            const id = scan._id || String(new Date(scan.startedAt).getTime());
            const isExpanded = expandedIds.has(id);
            const badges = resultBadges(scan);

            return (
              <div key={id}>
                {/* Row */}
                <button
                  onClick={() => toggleExpand(id)}
                  className={`
                    flex w-full items-center gap-4 px-5 py-3 text-left transition-colors duration-150
                    ${isExpanded ? 'bg-[var(--accent-blue)]/5' : 'hover:bg-[var(--bg-tertiary)]/30'}
                  `}
                >
                  {/* Status icon */}
                  <StatusIcon status={scan.status} />

                  {/* Timestamp */}
                  <div className="w-28 shrink-0">
                    <span className="text-xs font-mono text-[var(--text-secondary)] tabular-nums">
                      {formatTime(scan.startedAt)}
                    </span>
                    <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">
                      {formatDate(scan.startedAt)}
                    </span>
                  </div>

                  {/* Duration */}
                  <span className="w-14 shrink-0 text-[10px] font-mono text-[var(--text-muted)] tabular-nums">
                    {durationLabel(scan)}
                  </span>

                  {/* Config summary */}
                  <span className="shrink-0 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                    {configSummary(scan)}
                  </span>

                  {/* Result badges */}
                  <div className="flex flex-1 flex-wrap items-center gap-1.5">
                    {badges.map((badge, i) => (
                      <span
                        key={i}
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${BADGE_STYLES[badge.variant]}`}
                      >
                        {badge.label}
                      </span>
                    ))}
                  </div>

                  {/* Expand icon */}
                  <div className="shrink-0 text-[var(--text-muted)]">
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </div>
                </button>

                {/* Expanded content with smooth animation */}
                <div
                  className="overflow-hidden transition-all duration-300 ease-in-out"
                  style={{
                    maxHeight: isExpanded ? '2000px' : '0px',
                    opacity: isExpanded ? 1 : 0,
                  }}
                >
                  {isExpanded && (
                    <ExpandedFindings scan={scan} knownIssuesMap={knownIssuesMap} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
