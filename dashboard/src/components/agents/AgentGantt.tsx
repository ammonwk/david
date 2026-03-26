import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import type { AgentRecord, AgentType, AgentStatus } from 'david-shared';

interface AgentGanttProps {
  agents: AgentRecord[];
  onSelectAgent: (agentId: string) => void;
  selectedAgentId: string | null;
}

// ── Colors ───────────────────────────────────────────────────

// Agent-type accent colors — these are consistent between light and dark themes
// (the slight hue shift between themes is handled via CSS variables elsewhere;
// these hex values are used directly in SVG fill attributes).
const TYPE_FILL: Record<AgentType, { solid: string; faded: string; label: string }> = {
  'log-analysis': { solid: '#3b82f6', faded: '#3b82f680', label: 'Log Analysis' },
  audit:          { solid: '#8b5cf6', faded: '#8b5cf680', label: 'Audit' },
  fix:            { solid: '#22c55e', faded: '#22c55e80', label: 'Fix' },
  verify:         { solid: '#f59e0b', faded: '#f59e0b80', label: 'Verify' },
};

// ── Helpers ──────────────────────────────────────────────────

function agentId(a: AgentRecord): string {
  return a._id ?? a.taskId;
}

function targetLabel(a: AgentRecord): string {
  if (a.nodeId) {
    const parts = a.nodeId.split('/');
    return parts[parts.length - 1];
  }
  return a.taskId.length > 16 ? `${a.taskId.slice(0, 16)}...` : a.taskId;
}

function statusOrder(s: AgentStatus): number {
  switch (s) {
    case 'running': return 0;
    case 'starting': return 1;
    case 'queued': return 2;
    case 'completed': return 3;
    case 'failed': return 4;
    case 'timeout': return 5;
    default: return 6;
  }
}

interface FlatRow {
  agent: AgentRecord;
  depth: number;
}

/** Flatten agent tree into rows with depth for nesting. */
function buildFlatRows(agents: AgentRecord[]): FlatRow[] {
  const byId = new Map<string, AgentRecord>();
  const childrenOf = new Map<string, AgentRecord[]>();
  const rootAgents: AgentRecord[] = [];

  for (const a of agents) {
    byId.set(agentId(a), a);
    if (!childrenOf.has(agentId(a))) childrenOf.set(agentId(a), []);
  }

  for (const a of agents) {
    if (a.parentAgentId && byId.has(a.parentAgentId)) {
      childrenOf.get(a.parentAgentId)!.push(a);
    } else {
      rootAgents.push(a);
    }
  }

  const sortByStatus = (arr: AgentRecord[]) =>
    arr.sort((a, b) => statusOrder(a.status) - statusOrder(b.status));

  const rows: FlatRow[] = [];
  const walk = (list: AgentRecord[], depth: number) => {
    for (const a of sortByStatus([...list])) {
      rows.push({ agent: a, depth });
      const kids = childrenOf.get(agentId(a)) ?? [];
      if (kids.length > 0) walk(kids, depth + 1);
    }
  };

  walk(rootAgents, 0);
  return rows;
}

/** Format a Date to HH:MM. */
function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Component ────────────────────────────────────────────────

const ROW_HEIGHT = 32;
const LABEL_WIDTH = 180;
const MIN_BAR_WIDTH = 4;
const HEADER_HEIGHT = 28;
const PADDING_RIGHT = 40;

export function AgentGantt({ agents, onSelectAgent, selectedAgentId }: AgentGanttProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; agent: AgentRecord } | null>(null);
  const [now, setNow] = useState(Date.now());

  // Keep "now" ticking for running agents
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Track container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const rows = useMemo(() => buildFlatRows(agents), [agents]);

  // Compute time range
  const { timeMin, timeMax, chartWidth } = useMemo(() => {
    if (rows.length === 0) return { timeMin: now - 60_000, timeMax: now, chartWidth: 600 };

    let min = Infinity;
    let max = -Infinity;

    for (const { agent } of rows) {
      const start = agent.startedAt ? new Date(agent.startedAt).getTime() : new Date(agent.createdAt).getTime();
      const end = agent.completedAt ? new Date(agent.completedAt).getTime() : now;
      if (start < min) min = start;
      if (end > max) max = end;
    }

    // Add some padding
    const range = max - min || 60_000;
    min -= range * 0.02;
    max += range * 0.05;

    const cw = Math.max(containerWidth - LABEL_WIDTH - PADDING_RIGHT, 200);
    return { timeMin: min, timeMax: max, chartWidth: cw };
  }, [rows, now, containerWidth]);

  const timeToX = useCallback(
    (t: number) => ((t - timeMin) / (timeMax - timeMin)) * chartWidth,
    [timeMin, timeMax, chartWidth],
  );

  // Generate time axis ticks
  const ticks = useMemo(() => {
    const count = Math.max(Math.floor(chartWidth / 100), 2);
    const step = (timeMax - timeMin) / count;
    const result: { x: number; label: string }[] = [];
    for (let i = 0; i <= count; i++) {
      const t = timeMin + step * i;
      result.push({ x: timeToX(t), label: formatTime(new Date(t)) });
    }
    return result;
  }, [timeMin, timeMax, chartWidth, timeToX]);

  const totalHeight = rows.length * ROW_HEIGHT + HEADER_HEIGHT;

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-sm text-[var(--text-muted)]">
        No agents to display in timeline.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="overflow-x-auto rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)]">
      <svg
        width={LABEL_WIDTH + chartWidth + PADDING_RIGHT}
        height={totalHeight}
        className="select-none"
      >
        {/* ---- Time axis header ---- */}
        <g>
          <rect
            x={0}
            y={0}
            width={LABEL_WIDTH + chartWidth + PADDING_RIGHT}
            height={HEADER_HEIGHT}
            className="fill-[var(--bg-tertiary)]"
          />
          {ticks.map((tick, i) => (
            <g key={i}>
              <line
                x1={LABEL_WIDTH + tick.x}
                y1={HEADER_HEIGHT}
                x2={LABEL_WIDTH + tick.x}
                y2={totalHeight}
                stroke="var(--border-color)"
                strokeWidth={0.5}
                strokeDasharray="4,4"
              />
              <text
                x={LABEL_WIDTH + tick.x}
                y={HEADER_HEIGHT - 8}
                textAnchor="middle"
                className="fill-[var(--text-muted)] text-[10px]"
                style={{ fontSize: '10px' }}
              >
                {tick.label}
              </text>
            </g>
          ))}
        </g>

        {/* ---- "Now" line ---- */}
        {now >= timeMin && now <= timeMax && (
          <line
            x1={LABEL_WIDTH + timeToX(now)}
            y1={HEADER_HEIGHT}
            x2={LABEL_WIDTH + timeToX(now)}
            y2={totalHeight}
            stroke="var(--accent-red)"
            strokeWidth={1.5}
            strokeDasharray="3,3"
            opacity={0.7}
          />
        )}

        {/* ---- Rows ---- */}
        {rows.map(({ agent, depth }, idx) => {
          const id = agentId(agent);
          const y = HEADER_HEIGHT + idx * ROW_HEIGHT;
          const isSelected = selectedAgentId === id;
          const isActive = agent.status === 'running' || agent.status === 'starting';
          const isFailed = agent.status === 'failed' || agent.status === 'timeout';

          const start = agent.startedAt
            ? new Date(agent.startedAt).getTime()
            : new Date(agent.createdAt).getTime();
          const end = agent.completedAt ? new Date(agent.completedAt).getTime() : now;

          const barX = timeToX(start);
          const barW = Math.max(timeToX(end) - barX, MIN_BAR_WIDTH);

          const typeFill = TYPE_FILL[agent.type];
          const fill = agent.status === 'completed'
            ? typeFill.faded
            : typeFill.solid;

          return (
            <g
              key={id}
              className="cursor-pointer"
              onClick={() => onSelectAgent(id)}
              onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, agent })}
              onMouseMove={(e) => setTooltip((prev) => prev ? { ...prev, x: e.clientX, y: e.clientY } : null)}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* Row background */}
              <rect
                x={0}
                y={y}
                width={LABEL_WIDTH + chartWidth + PADDING_RIGHT}
                height={ROW_HEIGHT}
                fill={isSelected ? 'rgba(59,130,246,0.08)' : idx % 2 === 0 ? 'transparent' : 'rgba(128,128,128,0.04)'}
              />

              {/* Row label */}
              <text
                x={12 + depth * 16}
                y={y + ROW_HEIGHT / 2 + 4}
                className="fill-[var(--text-secondary)] text-[11px]"
                style={{ fontSize: '11px' }}
              >
                {targetLabel(agent)}
              </text>

              {/* Type badge */}
              <text
                x={LABEL_WIDTH - 8}
                y={y + ROW_HEIGHT / 2 + 3}
                textAnchor="end"
                style={{ fontSize: '9px', fill: typeFill.solid }}
              >
                {agent.type}
              </text>

              {/* Bar */}
              <rect
                x={LABEL_WIDTH + barX}
                y={y + 6}
                width={barW}
                height={ROW_HEIGHT - 12}
                rx={3}
                fill={fill}
                opacity={agent.status === 'queued' ? 0.3 : 1}
              >
                {isActive && (
                  <animate
                    attributeName="opacity"
                    values="1;0.7;1"
                    dur="2s"
                    repeatCount="indefinite"
                  />
                )}
              </rect>

              {/* Hatching for failed */}
              {isFailed && (
                <rect
                  x={LABEL_WIDTH + barX}
                  y={y + 6}
                  width={barW}
                  height={ROW_HEIGHT - 12}
                  rx={3}
                  fill="url(#hatch-pattern)"
                />
              )}

              {/* Selection ring */}
              {isSelected && (
                <rect
                  x={LABEL_WIDTH + barX - 1}
                  y={y + 5}
                  width={barW + 2}
                  height={ROW_HEIGHT - 10}
                  rx={4}
                  fill="none"
                  stroke="var(--accent-blue)"
                  strokeWidth={1.5}
                />
              )}
            </g>
          );
        })}

        {/* ---- Hatch pattern for failed bars ---- */}
        <defs>
          <pattern
            id="hatch-pattern"
            patternUnits="userSpaceOnUse"
            width={6}
            height={6}
            patternTransform="rotate(45)"
          >
            <line
              x1={0}
              y1={0}
              x2={0}
              y2={6}
              stroke="rgba(239,68,68,0.4)"
              strokeWidth={2}
            />
          </pattern>
        </defs>
      </svg>

      {/* ---- Tooltip ---- */}
      {tooltip && <GanttTooltip agent={tooltip.agent} x={tooltip.x} y={tooltip.y} />}

      {/* ---- Legend ---- */}
      <div className="flex flex-wrap items-center gap-4 border-t border-[var(--border-color)] px-4 py-2">
        {Object.entries(TYPE_FILL).map(([type, { solid, label }]) => (
          <div key={type} className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: solid }} />
            {label}
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
          <span className="inline-block h-0.5 w-3 bg-red-500" style={{ borderStyle: 'dashed' }} />
          Now
        </div>
      </div>
    </div>
  );
}

// ── Tooltip ──────────────────────────────────────────────────

function GanttTooltip({ agent, x, y }: { agent: AgentRecord; x: number; y: number }) {
  const start = agent.startedAt ? new Date(agent.startedAt) : null;
  const end = agent.completedAt ? new Date(agent.completedAt) : null;

  return (
    <div
      className="pointer-events-none fixed z-[100] max-w-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2 shadow-xl shadow-black/20"
      style={{ left: x + 12, top: y - 10 }}
    >
      <div className="mb-1 text-xs font-semibold text-[var(--text-primary)]">
        {targetLabel(agent)}
      </div>
      <div className="space-y-0.5 text-[10px] text-[var(--text-muted)]">
        <div>Type: <span className="text-[var(--text-secondary)]">{agent.type}</span></div>
        <div>Status: <span className="text-[var(--text-secondary)]">{agent.status}</span></div>
        {start && <div>Started: <span className="text-[var(--text-secondary)]">{formatTime(start)}</span></div>}
        {end && <div>Ended: <span className="text-[var(--text-secondary)]">{formatTime(end)}</span></div>}
        {agent.result?.summary && (
          <div className="mt-1 border-t border-[var(--border-color)] pt-1 text-[var(--text-secondary)]">
            {agent.result.summary.slice(0, 80)}
          </div>
        )}
      </div>
    </div>
  );
}
