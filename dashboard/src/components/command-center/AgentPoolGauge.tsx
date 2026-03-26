import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, CheckCircle, XCircle, Clock } from 'lucide-react';
import type { AgentRecord, AgentType, AgentStatus } from 'david-shared';
import { usePoolStatus } from '../../hooks/useSocket';
import { useAgents } from '../../hooks/useAgents';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_POOL = 30;

const AGENT_TYPE_COLORS: Record<AgentType, { fill: string; label: string }> = {
  'log-analysis': { fill: 'bg-blue-500', label: 'Log Analysis' },
  audit: { fill: 'bg-violet-500', label: 'Audit' },
  verify: { fill: 'bg-amber-500', label: 'Verify' },
  fix: { fill: 'bg-emerald-500', label: 'Fix' },
};

const AGENT_TYPE_CSS: Record<AgentType, string> = {
  'log-analysis': '#3b82f6',
  audit: '#8b5cf6',
  verify: '#f59e0b',
  fix: '#10b981',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRuntime(startedAt?: Date): string {
  if (!startedAt) return '--';
  const ms = Date.now() - new Date(startedAt).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function statusBadge(status: AgentStatus) {
  switch (status) {
    case 'completed':
      return { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/10' };
    case 'failed':
    case 'timeout':
      return { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10' };
    default:
      return { icon: Clock, color: 'text-yellow-400', bg: 'bg-yellow-500/10' };
  }
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

interface TooltipData {
  agentId: string;
  type: AgentType;
  runtime: string;
  status: AgentStatus;
}

function SegmentTooltip({ data, x, y }: { data: TooltipData; x: number; y: number }) {
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2 text-xs shadow-xl"
      style={{ left: x + 12, top: y - 10 }}
    >
      <p className="font-medium text-[var(--text-primary)]">{data.agentId.slice(0, 12)}...</p>
      <p className="text-[var(--text-muted)]">
        Type: <span className="text-[var(--text-secondary)]">{AGENT_TYPE_COLORS[data.type].label}</span>
      </p>
      <p className="text-[var(--text-muted)]">
        Runtime: <span className="text-[var(--text-secondary)]">{data.runtime}</span>
      </p>
      <p className="text-[var(--text-muted)]">
        Status: <span className="text-[var(--text-secondary)]">{data.status}</span>
      </p>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export function AgentPoolGauge() {
  const navigate = useNavigate();
  const poolStatus = usePoolStatus();
  const { agents, loading } = useAgents();
  const [tooltip, setTooltip] = useState<{ data: TooltipData; x: number; y: number } | null>(null);

  // Separate active (running/starting) vs queued vs recently completed
  const { activeAgents, queuedAgents, recentCompletions } = useMemo(() => {
    const active: AgentRecord[] = [];
    const queued: AgentRecord[] = [];
    const completed: AgentRecord[] = [];

    for (const agent of agents) {
      if (agent.status === 'running' || agent.status === 'starting') {
        active.push(agent);
      } else if (agent.status === 'queued') {
        queued.push(agent);
      } else {
        completed.push(agent);
      }
    }

    // Sort completions by most recent first
    completed.sort((a, b) => {
      const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bTime - aTime;
    });

    return {
      activeAgents: active,
      queuedAgents: queued,
      recentCompletions: completed.slice(0, 5),
    };
  }, [agents]);

  const activeCount = poolStatus?.activeCount ?? activeAgents.length;
  const queuedCount = poolStatus?.queuedCount ?? queuedAgents.length;
  const maxPool = poolStatus?.maxConcurrent ?? MAX_POOL;

  // Build segment data: active agents first, then queued, then empty
  const segments = useMemo(() => {
    const result: Array<{
      type: 'active' | 'queued' | 'empty';
      agent?: AgentRecord;
      color: string;
    }> = [];

    // Active segments
    for (const agent of activeAgents.slice(0, maxPool)) {
      result.push({
        type: 'active',
        agent,
        color: AGENT_TYPE_CSS[agent.type] || '#3b82f6',
      });
    }

    // Queued segments (dimmed)
    for (const agent of queuedAgents.slice(0, maxPool - result.length)) {
      result.push({
        type: 'queued',
        agent,
        color: AGENT_TYPE_CSS[agent.type] || '#3b82f6',
      });
    }

    // Empty segments
    while (result.length < maxPool) {
      result.push({ type: 'empty', color: 'transparent' });
    }

    return result;
  }, [activeAgents, queuedAgents, maxPool]);

  const handleSegmentHover = (
    e: React.MouseEvent,
    segment: (typeof segments)[0],
  ) => {
    if (!segment.agent) {
      setTooltip(null);
      return;
    }
    setTooltip({
      data: {
        agentId: segment.agent._id || 'unknown',
        type: segment.agent.type,
        runtime: formatRuntime(segment.agent.startedAt),
        status: segment.agent.status,
      },
      x: e.clientX,
      y: e.clientY,
    });
  };

  const handleSegmentClick = (segment: (typeof segments)[0]) => {
    if (segment.agent?._id) {
      navigate(`/agents?id=${segment.agent._id}`);
    }
  };

  const utilizationPct = maxPool > 0 ? Math.round((activeCount / maxPool) * 100) : 0;

  // Show skeleton while initial data is loading
  if (loading && agents.length === 0) {
    return (
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <Bot className="h-4 w-4 text-[var(--accent-blue)]" strokeWidth={2} />
            Agent Pool
          </h2>
          <div className="h-3 w-16 animate-pulse rounded bg-[var(--bg-tertiary)]" />
        </div>
        <div className="flex flex-1 gap-3 overflow-hidden">
          <div className="w-10 flex-1 animate-pulse rounded-lg bg-[var(--bg-tertiary)]" />
          <div className="flex flex-1 flex-col justify-center gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)]" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <Bot className="h-4 w-4 text-[var(--accent-blue)]" strokeWidth={2} />
          Agent Pool
        </h2>
        <span className="text-xs text-[var(--text-muted)]">
          {utilizationPct}% utilized
        </span>
      </div>

      {/* Gauge + stats */}
      <div className="flex flex-1 gap-3 overflow-hidden">
        {/* Vertical bar gauge */}
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-medium text-[var(--text-muted)]">{maxPool}</span>
          <div className="relative flex w-10 flex-1 flex-col-reverse gap-px overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-0.5">
            {segments.map((segment, i) => (
              <div
                key={i}
                className={`
                  relative w-full flex-1 rounded-sm transition-all duration-300
                  ${segment.type === 'empty' ? 'bg-[var(--bg-tertiary)]/40' : ''}
                  ${segment.type !== 'empty' ? 'cursor-pointer hover:brightness-125' : ''}
                `}
                style={
                  segment.type === 'active'
                    ? { backgroundColor: segment.color }
                    : segment.type === 'queued'
                      ? { backgroundColor: segment.color, opacity: 0.3 }
                      : undefined
                }
                onMouseMove={(e) => handleSegmentHover(e, segment)}
                onMouseLeave={() => setTooltip(null)}
                onClick={() => handleSegmentClick(segment)}
              />
            ))}
          </div>
          <span className="text-[10px] font-medium text-[var(--text-muted)]">0</span>
        </div>

        {/* Counts panel */}
        <div className="flex flex-1 flex-col justify-center gap-2">
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Active</p>
            <p className="text-xl font-bold text-[var(--accent-blue)]">{activeCount}</p>
          </div>
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Queued</p>
            <p className="text-xl font-bold text-[var(--accent-yellow)]">{queuedCount}</p>
          </div>
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Capacity</p>
            <p className="text-xl font-bold text-[var(--text-secondary)]">{maxPool - activeCount - queuedCount}</p>
          </div>

          {/* Legend */}
          <div className="mt-1 space-y-1">
            {(Object.entries(AGENT_TYPE_COLORS) as [AgentType, { fill: string; label: string }][]).map(
              ([type, { fill, label }]) => (
                <div key={type} className="flex items-center gap-1.5">
                  <div className={`h-2 w-2 rounded-sm ${fill}`} />
                  <span className="text-[10px] text-[var(--text-muted)]">{label}</span>
                </div>
              ),
            )}
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-sm bg-[var(--text-muted)] opacity-30" />
              <span className="text-[10px] text-[var(--text-muted)]">Queued</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent completions */}
      <div>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Recent Completions
        </h3>
        {recentCompletions.length === 0 ? (
          <p className="text-[11px] italic text-[var(--text-muted)]">No completed agents yet</p>
        ) : (
          <div className="space-y-1">
            {recentCompletions.map((agent) => {
              const badge = statusBadge(agent.status);
              const BadgeIcon = badge.icon;
              return (
                <button
                  key={agent._id}
                  onClick={() => agent._id && navigate(`/agents?id=${agent._id}`)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                  <div className={`flex h-5 w-5 items-center justify-center rounded ${badge.bg}`}>
                    <BadgeIcon className={`h-3 w-3 ${badge.color}`} />
                  </div>
                  <span className="flex-1 truncate text-[11px] text-[var(--text-secondary)]">
                    {AGENT_TYPE_COLORS[agent.type].label}
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {formatRuntime(agent.startedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Floating tooltip */}
      {tooltip && <SegmentTooltip data={tooltip.data} x={tooltip.x} y={tooltip.y} />}
    </div>
  );
}
