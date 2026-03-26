import { memo, forwardRef } from 'react';
import { ExternalLink, Clock } from 'lucide-react';
import type { IssueSeverity, BugReportSource, PipelineColumn } from 'david-shared';

export type { PipelineColumn };

// ── Types ─────────────────────────────────────────────────────

export interface PipelineCardData {
  /** Unique id (bug report _id or PR _id) */
  id: string;
  title: string;
  severity: IssueSeverity;
  source: BugReportSource;
  /** L1 > L2 label for affected area */
  area: string;
  /** ISO date string for age display */
  createdAt: string;
  /** Mini diff stat — lines added */
  linesAdded: number;
  /** Mini diff stat — lines removed */
  linesRemoved: number;
  /** GitHub PR URL (only present for PR Open / Merged / Closed) */
  prUrl?: string;
  /** Kanban column key */
  column: PipelineColumn;
}

// ── Helpers ──────────────────────────────────────────────────

function relativeTime(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const SEVERITY_COLORS: Record<IssueSeverity, { bg: string; text: string; ring: string }> = {
  critical: { bg: 'bg-red-500/15', text: 'text-red-400', ring: 'ring-red-500/30' },
  high: { bg: 'bg-orange-500/15', text: 'text-orange-400', ring: 'ring-orange-500/30' },
  medium: { bg: 'bg-yellow-500/15', text: 'text-yellow-400', ring: 'ring-yellow-500/30' },
  low: { bg: 'bg-blue-500/15', text: 'text-blue-400', ring: 'ring-blue-500/30' },
};

const COLUMN_ACCENT: Record<PipelineColumn, string> = {
  reported: 'border-l-slate-400',
  verifying: 'border-l-amber-400',
  fixing: 'border-l-blue-400',
  'pr-open': 'border-l-purple-400',
  merged: 'border-l-emerald-400',
  closed: 'border-l-red-400',
};

// ── Component ────────────────────────────────────────────────

interface PipelineCardProps {
  card: PipelineCardData;
  onClick: (card: PipelineCardData) => void;
  style?: React.CSSProperties;
}

export const PipelineCard = memo(
  forwardRef<HTMLDivElement, PipelineCardProps>(function PipelineCard(
    { card, onClick, style },
    ref,
  ) {
    const sev = SEVERITY_COLORS[card.severity];

    return (
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        onClick={() => onClick(card)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick(card);
          }
        }}
        style={style}
        className={`
          group cursor-pointer rounded-lg border border-[var(--border-color)] border-l-[3px]
          ${COLUMN_ACCENT[card.column]}
          bg-[var(--bg-card)] p-3 shadow-sm
          transition-all duration-200
          hover:shadow-md hover:border-[var(--text-muted)]
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/50
        `}
      >
        {/* Title */}
        <p className="mb-2 truncate text-sm font-medium text-[var(--text-primary)]">
          {card.title}
        </p>

        {/* Badges row */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {/* Severity */}
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1 ${sev.bg} ${sev.text} ${sev.ring}`}
          >
            {card.severity}
          </span>

          {/* Source */}
          {card.source === 'log-scan' ? (
            <span className="inline-flex items-center rounded-full bg-orange-500/10 px-2 py-0.5 text-[10px] font-medium text-orange-400 ring-1 ring-orange-500/20">
              log scan
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-400 ring-1 ring-violet-500/20">
              audit
            </span>
          )}
        </div>

        {/* Area */}
        {card.area && (
          <p className="mb-1.5 truncate text-[11px] text-[var(--text-muted)]">
            {card.area}
          </p>
        )}

        {/* Bottom row: age, diff stat, link */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            {/* Age */}
            <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
              <Clock className="h-3 w-3" />
              {relativeTime(card.createdAt)}
            </span>

            {/* Diff stat */}
            {(card.linesAdded > 0 || card.linesRemoved > 0) && (
              <span className="font-mono text-[11px]">
                <span className="text-emerald-400">+{card.linesAdded}</span>
                {' '}
                <span className="text-red-400">-{card.linesRemoved}</span>
              </span>
            )}
          </div>

          {/* GitHub link */}
          {card.prUrl && (
            <a
              href={card.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-[var(--text-muted)] transition-colors hover:text-[var(--accent-blue)]"
              aria-label="Open PR on GitHub"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>
    );
  }),
);
