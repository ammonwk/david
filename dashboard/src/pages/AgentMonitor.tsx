import { useState, useMemo, useCallback } from 'react';
import type { AgentRecord, AgentType } from 'david-shared';
import {
  Bot,
  AlertTriangle,
  RefreshCw,
  TreePine,
  GanttChart,
} from 'lucide-react';

import { useAgents } from '../hooks/useAgents';
import { usePoolStatus } from '../hooks/useSocket';
import { PoolBar } from '../components/agents/PoolBar';
import { AgentTree } from '../components/agents/AgentTree';
import { AgentGantt } from '../components/agents/AgentGantt';
import { AgentDetail } from '../components/agents/AgentDetail';

// ── Types ────────────────────────────────────────────────────

type ViewMode = 'tree' | 'timeline';

// ── Component ────────────────────────────────────────────────

export function AgentMonitor() {
  const { agents, poolStatus: hookPoolStatus, loading, error, stopAgent, refresh } = useAgents();
  const livePoolStatus = usePoolStatus();

  // Merge: prefer live WS status, fall back to REST-fetched pool status
  const pool = livePoolStatus ?? hookPoolStatus;

  const [viewMode, setViewMode] = useState<ViewMode>('tree');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // ── Derived data ──────────────────────────────────────────
  const selectedAgent = useMemo<AgentRecord | null>(() => {
    if (!selectedAgentId) return null;
    return agents.find((a) => (a._id ?? a.taskId) === selectedAgentId) ?? null;
  }, [agents, selectedAgentId]);

  /** Breakdown of active agents by type for PoolBar segments. */
  const activeByType = useMemo(() => {
    const counts: Partial<Record<AgentType, number>> = {};
    for (const a of agents) {
      if (a.status === 'running' || a.status === 'starting') {
        counts[a.type] = (counts[a.type] ?? 0) + 1;
      }
    }
    return counts;
  }, [agents]);

  // ── Handlers ──────────────────────────────────────────────
  const handleSelectAgent = useCallback((id: string) => {
    setSelectedAgentId((prev) => (prev === id ? null : id));
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedAgentId(null);
  }, []);

  const handleStop = useCallback(async (id: string) => {
    await stopAgent(id);
  }, [stopAgent]);

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* ── Page header ──────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Left: title + pool gauge */}
        <div className="flex items-center gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg shadow-blue-500/20">
            <Bot className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[var(--text-primary)]">Agent Monitor</h1>
            <p className="text-xs text-[var(--text-muted)]">Real-time view of all agent activity</p>
          </div>

          {/* Pool capacity gauge */}
          <div className="hidden sm:block">
            {loading && agents.length === 0 ? (
              <div className="flex items-center gap-3">
                <div className="h-3 w-48 animate-pulse rounded-full bg-[var(--bg-tertiary)]" />
                <div className="h-3 w-20 animate-pulse rounded bg-[var(--bg-tertiary)]" />
              </div>
            ) : (
              <PoolBar
                active={pool?.activeCount ?? 0}
                max={pool?.maxConcurrent ?? 30}
                queued={pool?.queuedCount ?? 0}
                activeByType={activeByType}
              />
            )}
          </div>
        </div>

        {/* Right: view toggle + refresh */}
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)]">
            <ViewToggleButton
              active={viewMode === 'tree'}
              onClick={() => setViewMode('tree')}
              icon={<TreePine className="h-3.5 w-3.5" />}
              label="Tree"
            />
            <ViewToggleButton
              active={viewMode === 'timeline'}
              onClick={() => setViewMode('timeline')}
              icon={<GanttChart className="h-3.5 w-3.5" />}
              label="Timeline"
            />
          </div>

          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Pool gauge for mobile (below header) ──────────── */}
      <div className="sm:hidden">
        {loading && agents.length === 0 ? (
          <div className="flex items-center gap-3">
            <div className="h-3 w-48 animate-pulse rounded-full bg-[var(--bg-tertiary)]" />
            <div className="h-3 w-20 animate-pulse rounded bg-[var(--bg-tertiary)]" />
          </div>
        ) : (
          <PoolBar
            active={pool?.activeCount ?? 0}
            max={pool?.maxConcurrent ?? 30}
            queued={pool?.queuedCount ?? 0}
            activeByType={activeByType}
          />
        )}
      </div>

      {/* ── Error banner ─────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* ── Main content area ────────────────────────────── */}
      {loading && agents.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="h-6 w-6 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
          {viewMode === 'tree' ? (
            <AgentTree
              agents={agents}
              onSelectAgent={handleSelectAgent}
              selectedAgentId={selectedAgentId}
            />
          ) : (
            <AgentGantt
              agents={agents}
              onSelectAgent={handleSelectAgent}
              selectedAgentId={selectedAgentId}
            />
          )}
        </div>
      )}

      {/* ── Agent detail panel (slides in from right) ────── */}
      {selectedAgentId && selectedAgent && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
            onClick={handleCloseDetail}
          />
          <AgentDetail
            agent={selectedAgent}
            onClose={handleCloseDetail}
            onStop={handleStop}
          />
        </>
      )}
    </div>
  );
}

// ── Small helper components ──────────────────────────────────

interface ViewToggleButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function ViewToggleButton({ active, onClick, icon, label }: ViewToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`
        flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all duration-200
        ${
          active
            ? 'bg-blue-500/15 text-blue-400'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }
      `}
    >
      {icon}
      {label}
    </button>
  );
}
