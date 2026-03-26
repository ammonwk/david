import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AlertCircle,
  Search,
  Shield,
  Wrench,
  GitPullRequest,
  GitMerge,
  XCircle,
  Loader2,
} from 'lucide-react';
import type { BugReport, PullRequestRecord, PipelineColumn } from 'david-shared';
import { api } from '../../lib/api';
import { useSocketEvent } from '../../hooks/useSocket';
import { PipelineCard, type PipelineCardData } from './PipelineCard';

// ── Column Definitions ──────────────────────────────────────

interface ColumnDef {
  key: PipelineColumn;
  label: string;
  icon: React.FC<{ className?: string }>;
  headerColor: string;
  badgeColor: string;
}

const COLUMNS: ColumnDef[] = [
  {
    key: 'reported',
    label: 'Reported',
    icon: AlertCircle,
    headerColor: 'text-slate-400',
    badgeColor: 'bg-slate-500/15 text-slate-400',
  },
  {
    key: 'verifying',
    label: 'Verifying',
    icon: Search,
    headerColor: 'text-amber-400',
    badgeColor: 'bg-amber-500/15 text-amber-400',
  },
  {
    key: 'fixing',
    label: 'Fixing',
    icon: Wrench,
    headerColor: 'text-blue-400',
    badgeColor: 'bg-blue-500/15 text-blue-400',
  },
  {
    key: 'pr-open',
    label: 'PR Open',
    icon: GitPullRequest,
    headerColor: 'text-purple-400',
    badgeColor: 'bg-purple-500/15 text-purple-400',
  },
  {
    key: 'merged',
    label: 'Merged',
    icon: GitMerge,
    headerColor: 'text-emerald-400',
    badgeColor: 'bg-emerald-500/15 text-emerald-400',
  },
  {
    key: 'closed',
    label: 'Closed',
    icon: XCircle,
    headerColor: 'text-red-400',
    badgeColor: 'bg-red-500/15 text-red-400',
  },
];

// ── Helpers ─────────────────────────────────────────────────

function parseDiffStats(diff: string): { added: number; removed: number } {
  if (!diff) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

function bugToColumn(bug: BugReport): PipelineColumn {
  switch (bug.status) {
    case 'reported':
      return 'reported';
    case 'verifying':
      return 'verifying';
    case 'verified':
      return 'verifying'; // verified but not yet fixing stays in verifying
    case 'fixing':
      return 'fixing';
    case 'fixed':
      return 'fixing'; // fixed but PR not created yet stays in fixing
    case 'pr-created':
      return 'pr-open'; // will be overridden if PR record found
    case 'wont-fix':
      return 'closed';
    default:
      return 'reported';
  }
}

function buildCards(
  bugs: BugReport[],
  prs: PullRequestRecord[],
): PipelineCardData[] {
  const prByBugId = new Map<string, PullRequestRecord>();
  for (const pr of prs) {
    prByBugId.set(pr.bugReportId, pr);
  }

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const cards: PipelineCardData[] = [];
  const bugIdsWithCards = new Set<string>();

  for (const bug of bugs) {
    const bugId = bug._id ?? bug.pattern;
    const pr = bug._id ? prByBugId.get(bug._id) : undefined;

    let column = bugToColumn(bug);
    let prUrl: string | undefined;
    let linesAdded = 0;
    let linesRemoved = 0;

    // If PR exists, determine column from PR status
    if (pr) {
      const stats = parseDiffStats(pr.diff);
      linesAdded = stats.added;
      linesRemoved = stats.removed;
      prUrl = pr.prUrl;

      if (pr.status === 'merged') {
        // Only show merged from last 7 days
        const resolvedTime = pr.resolvedAt
          ? new Date(pr.resolvedAt).getTime()
          : new Date(pr.createdAt).getTime();
        if (resolvedTime < sevenDaysAgo) continue;
        column = 'merged';
      } else if (pr.status === 'closed') {
        const resolvedTime = pr.resolvedAt
          ? new Date(pr.resolvedAt).getTime()
          : new Date(pr.createdAt).getTime();
        if (resolvedTime < sevenDaysAgo) continue;
        column = 'closed';
      } else if (pr.status === 'open') {
        column = 'pr-open';
      }
    }

    // Build area label from nodeId
    const area = bug.nodeId ?? '';

    cards.push({
      id: bugId,
      title: bug.pattern,
      severity: bug.severity,
      source: bug.source,
      area,
      createdAt:
        typeof bug.createdAt === 'string'
          ? bug.createdAt
          : new Date(bug.createdAt).toISOString(),
      linesAdded,
      linesRemoved,
      prUrl,
      column,
    });

    bugIdsWithCards.add(bugId);
  }

  // Also include PRs whose bugReportId doesn't match any loaded bug
  // (e.g., if bug data is stale)
  for (const pr of prs) {
    if (bugIdsWithCards.has(pr.bugReportId)) continue;

    const resolvedTime = pr.resolvedAt
      ? new Date(pr.resolvedAt).getTime()
      : new Date(pr.createdAt).getTime();

    let column: PipelineColumn;
    if (pr.status === 'merged') {
      if (resolvedTime < sevenDaysAgo) continue;
      column = 'merged';
    } else if (pr.status === 'closed') {
      if (resolvedTime < sevenDaysAgo) continue;
      column = 'closed';
    } else {
      column = 'pr-open';
    }

    const stats = parseDiffStats(pr.diff);

    cards.push({
      id: pr._id ?? String(pr.prNumber),
      title: pr.title,
      severity: 'medium', // PRs without bugs default to medium
      source: pr.scanType === 'log' ? 'log-scan' : 'codebase-audit',
      area: pr.nodeId ?? '',
      createdAt:
        typeof pr.createdAt === 'string'
          ? pr.createdAt
          : new Date(pr.createdAt).toISOString(),
      linesAdded: stats.added,
      linesRemoved: stats.removed,
      prUrl: pr.prUrl,
      column,
    });
  }

  return cards;
}

// ── Component ───────────────────────────────────────────────

interface KanbanBoardProps {
  onCardClick: (card: PipelineCardData) => void;
}

export function KanbanBoard({ onCardClick }: KanbanBoardProps) {
  const [bugs, setBugs] = useState<BugReport[]>([]);
  const [prs, setPrs] = useState<PullRequestRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Track previous card positions for animation
  const prevColumnMap = useRef<Map<string, PipelineColumn>>(new Map());
  const [animatingCards, setAnimatingCards] = useState<Set<string>>(new Set());

  // ── Data Fetching ──────────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      const [bugsData, prsData] = await Promise.all([
        api.getBugReports(),
        api.getPRs(),
      ]);
      setBugs(bugsData);
      setPrs(prsData);
    } catch (err) {
      console.error('Failed to fetch pipeline data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Real-time Updates via WebSocket ─────────────────────────

  // Debounced fetch — coalesces multiple rapid WS events into one API call
  const fetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedFetch = useCallback(() => {
    if (fetchTimeoutRef.current) {
      clearTimeout(fetchTimeoutRef.current);
    }
    fetchTimeoutRef.current = setTimeout(() => {
      fetchData();
      fetchTimeoutRef.current = null;
    }, 300); // 300ms debounce window
  }, [fetchData]);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
      }
    };
  }, []);

  useSocketEvent('bug:reported', debouncedFetch);
  useSocketEvent('bug:verified', debouncedFetch);
  useSocketEvent('bug:fixed', debouncedFetch);
  useSocketEvent('pr:created', debouncedFetch);
  useSocketEvent('pr:merged', debouncedFetch);
  useSocketEvent('pr:closed', debouncedFetch);
  useSocketEvent('agent:started', debouncedFetch);
  useSocketEvent('agent:completed', debouncedFetch);

  // ── Build Cards & Detect Column Changes ────────────────────

  const cards = useMemo(() => buildCards(bugs, prs), [bugs, prs]);

  // Detect column changes and trigger animations
  useEffect(() => {
    const newAnimating = new Set<string>();
    const newColumnMap = new Map<string, PipelineColumn>();

    for (const card of cards) {
      const prevCol = prevColumnMap.current.get(card.id);
      newColumnMap.set(card.id, card.column);

      if (prevCol && prevCol !== card.column) {
        newAnimating.add(card.id);
      }
    }

    prevColumnMap.current = newColumnMap;

    if (newAnimating.size > 0) {
      setAnimatingCards(newAnimating);
      // Clear animation class after the animation completes
      const timer = setTimeout(() => {
        setAnimatingCards(new Set());
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [cards]);

  // ── Group Cards by Column ──────────────────────────────────

  const columnCards = useMemo(() => {
    const grouped = new Map<PipelineColumn, PipelineCardData[]>();
    for (const col of COLUMNS) {
      grouped.set(col.key, []);
    }
    for (const card of cards) {
      const list = grouped.get(card.column);
      if (list) list.push(card);
    }
    return grouped;
  }, [cards]);

  // ── Render ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {COLUMNS.map((col) => {
        const colCards = columnCards.get(col.key) ?? [];
        const Icon = col.icon;

        return (
          <div
            key={col.key}
            className="flex w-64 shrink-0 flex-col rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)]"
          >
            {/* Column Header */}
            <div className="flex items-center justify-between px-3 py-3 border-b border-[var(--border-color)]">
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${col.headerColor}`} />
                <h3 className={`text-sm font-semibold ${col.headerColor}`}>
                  {col.label}
                </h3>
              </div>
              <span
                className={`inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${col.badgeColor}`}
              >
                {colCards.length}
              </span>
            </div>

            {/* Column Body — vertical scroll */}
            <div className="flex-1 space-y-2 overflow-y-auto p-2" style={{ maxHeight: 'calc(100vh - 18rem)' }}>
              {colCards.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Icon className="mb-2 h-6 w-6 text-[var(--text-muted)]/30" />
                  <p className="text-[11px] text-[var(--text-muted)]">
                    No items
                  </p>
                </div>
              ) : (
                colCards.map((card) => {
                  const isAnimating = animatingCards.has(card.id);
                  return (
                    <div
                      key={card.id}
                      className={isAnimating ? 'animate-card-enter' : ''}
                    >
                      <PipelineCard card={card} onClick={onCardClick} />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })}

      {/* Animation keyframes */}
      <style>{`
        @keyframes card-enter {
          0% {
            opacity: 0;
            transform: scale(0.92) translateY(-8px);
            box-shadow: 0 0 0 2px var(--accent-blue);
          }
          50% {
            opacity: 1;
            transform: scale(1.02) translateY(0);
            box-shadow: 0 0 12px 2px rgba(59, 130, 246, 0.3);
          }
          100% {
            opacity: 1;
            transform: scale(1) translateY(0);
            box-shadow: none;
          }
        }
        .animate-card-enter {
          animation: card-enter 0.5s ease-out;
        }
      `}</style>
    </div>
  );
}
