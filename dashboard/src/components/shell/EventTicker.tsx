import { useState, useEffect, useRef } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { useActivityFeed } from '../../hooks/useSocket';
import type { ActivityEvent } from 'david-shared';

// ---------------------------------------------------------------------------
// Severity → left-border accent color
// ---------------------------------------------------------------------------

function severityColor(severity?: ActivityEvent['severity']): string {
  switch (severity) {
    case 'success':
      return 'border-l-emerald-400';
    case 'warning':
      return 'border-l-amber-400';
    case 'error':
      return 'border-l-red-400';
    default:
      return 'border-l-[var(--accent-blue)]';
  }
}

function severityDot(severity?: ActivityEvent['severity']): string {
  switch (severity) {
    case 'success':
      return 'bg-emerald-400';
    case 'warning':
      return 'bg-amber-400';
    case 'error':
      return 'bg-red-400';
    default:
      return 'bg-[var(--accent-blue)]';
  }
}

// ---------------------------------------------------------------------------
// Relative time formatter
// ---------------------------------------------------------------------------

function relativeTime(date: Date): string {
  const diff = Date.now() - new Date(date).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// EventTicker
// ---------------------------------------------------------------------------

export function EventTicker() {
  const events = useActivityFeed();
  const [feedOpen, setFeedOpen] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const prevIdRef = useRef<string | null>(null);

  const latest = events[0] ?? null;

  // Trigger entrance animation when latest event changes
  useEffect(() => {
    if (latest && latest.id !== prevIdRef.current) {
      prevIdRef.current = latest.id;
      setAnimKey((k) => k + 1);
    }
  }, [latest]);

  return (
    <>
      {/* ── Ticker bar ──────────────────────────────────────────── */}
      <div
        className="
          z-50 flex h-8 items-center
          border-t border-[var(--border-color)]
          bg-[var(--bg-secondary)]/80 backdrop-blur-md
          px-4 select-none cursor-pointer
        "
        onClick={() => setFeedOpen((v) => !v)}
        role="button"
        tabIndex={0}
        aria-label="Toggle activity feed"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setFeedOpen((v) => !v);
          }
        }}
      >
        {/* Expand/collapse icon */}
        <div className="mr-2 text-[var(--text-muted)]">
          {feedOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" />
          )}
        </div>

        {/* Latest event with entrance animation */}
        {latest ? (
          <div
            key={animKey}
            className="
              flex flex-1 items-center gap-2 overflow-hidden
              animate-[slideIn_300ms_ease-out]
            "
          >
            <span className="text-[var(--accent-blue)]" aria-hidden>
              &#9658;
            </span>
            <span className="truncate text-xs text-[var(--text-secondary)]">
              {latest.message}
            </span>
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">
              {relativeTime(latest.timestamp)}
            </span>
          </div>
        ) : (
          <span className="text-xs text-[var(--text-muted)]">
            No recent events
          </span>
        )}
      </div>

      {/* ── Expanded activity feed overlay ──────────────────────── */}
      {feedOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
            onClick={() => setFeedOpen(false)}
          />

          {/* Feed panel */}
          <div
            className="
              fixed bottom-8 left-0 right-0 z-50
              mx-auto max-w-3xl max-h-[60vh]
              flex flex-col overflow-hidden rounded-t-xl
              border border-[var(--border-color)] border-b-0
              bg-[var(--bg-secondary)] shadow-2xl shadow-black/30
              animate-[slideUp_200ms_ease-out]
            "
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-2.5">
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                Activity Feed
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setFeedOpen(false);
                }}
                className="
                  flex h-6 w-6 items-center justify-center rounded-md
                  text-[var(--text-muted)] transition-colors
                  hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]
                "
                aria-label="Close activity feed"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Event list */}
            <div className="flex-1 overflow-y-auto">
              {events.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-sm text-[var(--text-muted)]">
                  No events yet
                </div>
              ) : (
                <ul className="divide-y divide-[var(--border-color)]">
                  {events.map((event) => (
                    <li
                      key={event.id}
                      className={`
                        flex items-start gap-3 border-l-2 px-4 py-2.5
                        hover:bg-[var(--bg-tertiary)]/50 transition-colors
                        ${severityColor(event.severity)}
                      `}
                    >
                      <div className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${severityDot(event.severity)}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-[var(--text-primary)] leading-relaxed">
                          {event.message}
                        </p>
                        {event.link && (
                          <a
                            href={event.link.url}
                            className="mt-0.5 inline-block text-[10px] font-medium text-[var(--accent-blue)] hover:underline"
                          >
                            {event.link.label}
                          </a>
                        )}
                      </div>
                      <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">
                        {relativeTime(event.timestamp)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
