import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  CheckCircle,
  Bug,
  Bot,
  XCircle,
  GitPullRequest,
  GitMerge,
  Clock,
  Play,
  RotateCcw,
  Map as MapIcon,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import type { ActivityEvent, WSEventType } from 'david-shared';
import { useActivityFeed } from '../../hooks/useSocket';

// ── Event icon mapping ───────────────────────────────────────────────────────

function getEventIcon(type: WSEventType) {
  switch (type) {
    case 'scan:started':
      return Search;
    case 'scan:completed':
      return CheckCircle;
    case 'scan:failed':
      return XCircle;
    case 'bug:reported':
    case 'bug:verified':
      return Bug;
    case 'bug:fixed':
      return CheckCircle;
    case 'agent:queued':
      return Clock;
    case 'agent:started':
      return Play;
    case 'agent:completed':
      return CheckCircle;
    case 'agent:failed':
    case 'agent:timeout':
      return XCircle;
    case 'agent:restarted':
      return RotateCcw;
    case 'agent:output':
      return Bot;
    case 'pr:created':
      return GitPullRequest;
    case 'pr:merged':
      return GitMerge;
    case 'pr:closed':
      return XCircle;
    case 'topology:mapping-started':
    case 'topology:mapping-completed':
      return MapIcon;
    case 'audit:started':
    case 'audit:completed':
      return AlertTriangle;
    case 'pool:status-update':
      return Bot;
    default:
      return Bot;
  }
}

// ── Severity-based left edge color ───────────────────────────────────────────

function getSeverityEdgeColor(severity?: 'info' | 'success' | 'warning' | 'error'): string {
  switch (severity) {
    case 'success':
      return 'border-l-emerald-500';
    case 'warning':
      return 'border-l-yellow-500';
    case 'error':
      return 'border-l-red-500';
    case 'info':
    default:
      return 'border-l-blue-500';
  }
}

function getSeverityIconColor(severity?: 'info' | 'success' | 'warning' | 'error'): string {
  switch (severity) {
    case 'success':
      return 'text-emerald-400';
    case 'warning':
      return 'text-yellow-400';
    case 'error':
      return 'text-red-400';
    case 'info':
    default:
      return 'text-blue-400';
  }
}

// ── Causal chain grouping ────────────────────────────────────────────────────

interface DisplayEvent {
  event: ActivityEvent;
  depth: number;
}

/**
 * Recursively walk a causal tree and flatten it into a display list
 * with computed depth values for indentation.
 */
function flattenCausalTree(
  roots: ActivityEvent[],
  childrenOf: Map<string, ActivityEvent[]>,
): DisplayEvent[] {
  const result: DisplayEvent[] = [];

  function walk(event: ActivityEvent, depth: number) {
    result.push({ event, depth });
    const children = childrenOf.get(event.id) || [];
    for (const child of children) {
      walk(child, depth + 1);
    }
  }

  for (const root of roots) {
    walk(root, 0);
  }

  return result;
}

/**
 * Build a causal tree from events and flatten into a display list.
 *
 * Events whose parentId doesn't match any visible event are treated as
 * root-level (depth 0) — this gracefully handles parents that have
 * scrolled out of the activity buffer.
 */
function buildCausalDisplayList(events: ActivityEvent[]): DisplayEvent[] {
  // Build a set of visible event IDs for fast lookup
  const visibleIds = new Set(events.map((e) => e.id));

  // Partition into roots and children
  const childrenOf = new Map<string, ActivityEvent[]>();
  const rootEvents: ActivityEvent[] = [];

  for (const event of events) {
    if (event.parentId && visibleIds.has(event.parentId)) {
      const siblings = childrenOf.get(event.parentId) || [];
      siblings.push(event);
      childrenOf.set(event.parentId, siblings);
    } else {
      // No parent, or parent not in visible window → show at root level
      rootEvents.push(event);
    }
  }

  return flattenCausalTree(rootEvents, childrenOf);
}

// ── Time formatting ──────────────────────────────────────────────────────────

function formatTimestamp(date: Date): string {
  const ts = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - ts.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  return ts.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatAbsoluteTime(date: Date): string {
  const ts = date instanceof Date ? date : new Date(date);
  return ts.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ── Navigation helper ────────────────────────────────────────────────────────

function getEventNavigationPath(event: ActivityEvent): string | null {
  // Use the link from the event if provided
  if (event.link?.url) {
    return event.link.url;
  }
  // Fallback: navigate based on event type
  if (event.type.startsWith('scan:')) return '/logs';
  if (event.type.startsWith('bug:')) return '/logs';
  if (event.type.startsWith('agent:')) return '/agents';
  if (event.type.startsWith('pr:')) return '/prs';
  if (event.type.startsWith('topology:') || event.type.startsWith('audit:')) return '/map';
  return null;
}

// ── Main Component ───────────────────────────────────────────────────────────

export function EventTimeline() {
  const navigate = useNavigate();
  const events = useActivityFeed(200);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isUserScrolledRef = useRef(false);
  const [showScrollHint, setShowScrollHint] = useState(false);
  const prevEventCountRef = useRef(0);

  // Track scroll position for auto-scroll behavior
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // If user scrolled more than 80px from top, they have manually scrolled up
    isUserScrolledRef.current = el.scrollTop > 80;
    setShowScrollHint(isUserScrolledRef.current && events.length > 0);
  }, [events.length]);

  // Auto-scroll to top when new events arrive (unless user scrolled away)
  useEffect(() => {
    if (events.length > prevEventCountRef.current && !isUserScrolledRef.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
    prevEventCountRef.current = events.length;
  }, [events.length]);

  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    isUserScrolledRef.current = false;
    setShowScrollHint(false);
  }, []);

  const handleEventClick = useCallback(
    (event: ActivityEvent) => {
      const path = getEventNavigationPath(event);
      if (path) {
        navigate(path);
      }
    },
    [navigate],
  );

  // Build the causal display list from raw events
  const displayList = useMemo(() => buildCausalDisplayList(events), [events]);

  return (
    <div className="flex h-full flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <Clock className="h-4 w-4 text-[var(--accent-blue)]" strokeWidth={2} />
          Live Events
        </h2>
        {events.length > 0 && (
          <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
            {events.length} events
          </span>
        )}
      </div>

      {/* Timeline */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full space-y-0.5 overflow-y-auto pr-1"
        >
          {displayList.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-[var(--text-muted)]">
              <Bot className="mb-2 h-6 w-6 animate-pulse" />
              <p className="text-xs">Waiting for events...</p>
            </div>
          ) : (
            displayList.map(({ event, depth }, index) => {
              const Icon = getEventIcon(event.type);
              const edgeColor = getSeverityEdgeColor(event.severity);
              const iconColor = getSeverityIconColor(event.severity);
              const isNew = index === 0 && displayList.length > 1;

              return (
                <button
                  key={event.id}
                  onClick={() => handleEventClick(event)}
                  className={`
                    group flex w-full items-start gap-2 rounded-r-md border-l-2 px-2 py-1.5
                    text-left transition-all duration-200
                    hover:bg-[var(--bg-tertiary)]
                    ${edgeColor}
                    ${isNew ? 'animate-fade-in bg-[var(--accent-blue)]/5' : ''}
                  `}
                  style={{ paddingLeft: `${8 + depth * 12}px` }}
                >
                  {/* Icon */}
                  <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded ${iconColor}`}>
                    <Icon className="h-3 w-3" strokeWidth={2} />
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs leading-snug text-[var(--text-primary)] group-hover:text-[var(--accent-blue)]">
                      {event.message}
                    </p>
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[10px] text-[var(--text-muted)]"
                        title={formatAbsoluteTime(event.timestamp)}
                      >
                        {formatTimestamp(event.timestamp)}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Scroll-to-top hint */}
        {showScrollHint && (
          <button
            onClick={scrollToTop}
            className="absolute left-1/2 top-1 -translate-x-1/2 rounded-full border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1 text-[10px] font-medium text-[var(--accent-blue)] shadow-lg transition-all hover:bg-[var(--bg-tertiary)]"
          >
            <ChevronDown className="mr-1 inline h-3 w-3 rotate-180" />
            New events
          </button>
        )}
      </div>
    </div>
  );
}
