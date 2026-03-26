import { useMemo } from 'react';
import type { AgentRecord } from 'david-shared';
import { Wrench, GitPullRequest } from 'lucide-react';
import type { ActiveNodes } from './Treemap';

// ── Types ──────────────────────────────────────────────────

export interface ActivityOverlayProps {
  /** Pre-computed active node sets (activity visuals are rendered on the treemap cells directly) */
  activeNodes: ActiveNodes;
  /** Whether the overlay legend is currently visible */
  visible: boolean;
}

// ── Helpers ──────────────────────────────────────────────────

/** Derive ActiveNodes sets from raw agent records. */
export function computeActiveNodes(agents: AgentRecord[]): ActiveNodes {
  const auditing = new Set<string>();
  const fixing = new Set<string>();
  const hasPR = new Set<string>();

  for (const agent of agents) {
    if (!agent.nodeId) continue;

    if (agent.type === 'audit' && (agent.status === 'running' || agent.status === 'starting')) {
      auditing.add(agent.nodeId);
    }

    if (agent.type === 'fix' && (agent.status === 'running' || agent.status === 'starting')) {
      fixing.add(agent.nodeId);
    }

    if (
      agent.type === 'fix' &&
      agent.status === 'completed' &&
      agent.result?.prsCreated &&
      agent.result.prsCreated > 0
    ) {
      const completedAt = agent.completedAt ? new Date(agent.completedAt) : null;
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (completedAt && completedAt > oneHourAgo) {
        hasPR.add(agent.nodeId);
      }
    }
  }

  return { auditing, fixing, hasPR };
}

// ── Component ──────────────────────────────────────────────

/**
 * Legend panel for the activity overlay. The actual node decorations
 * (animated dashed borders, wrench/PR icons) are rendered directly
 * on the treemap cells via the `activeNodes` prop on `<Treemap>`.
 */
export function ActivityOverlay({ activeNodes, visible }: ActivityOverlayProps) {
  const counts = useMemo(() => ({
    auditing: activeNodes.auditing.size,
    fixing: activeNodes.fixing.size,
    hasPR: activeNodes.hasPR.size,
  }), [activeNodes]);

  if (!visible || (counts.auditing === 0 && counts.fixing === 0 && counts.hasPR === 0)) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {/* Activity legend */}
      <div className="pointer-events-auto absolute left-3 top-3 flex flex-col gap-1 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/95 px-3 py-2 shadow-lg backdrop-blur-sm">
        <span className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Activity Overlay
        </span>
        <div className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
          <span className="inline-block h-3 w-5 rounded-sm border border-dashed border-blue-400" style={{ animation: 'scan-dash 1.5s linear infinite' }} />
          <span>Auditing ({counts.auditing})</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
          <Wrench className="h-3 w-3 text-amber-400" />
          <span>Fix Agent ({counts.fixing})</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
          <GitPullRequest className="h-3 w-3 text-green-400" />
          <span>Recent PR ({counts.hasPR})</span>
        </div>
      </div>

      {/* CSS animation for the scanning dashed border effect (used by legend preview) */}
      <style>{`
        @keyframes scan-dash {
          0% { stroke-dashoffset: 0; }
          100% { stroke-dashoffset: -18; }
        }
      `}</style>
    </div>
  );
}
