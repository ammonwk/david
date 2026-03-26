import { useMemo, useState, useEffect } from 'react';
import type { AgentRecord } from 'david-shared';
import {
  X,
  Square,
  FileText,
  Bug,
  GitPullRequest,
  Folder,
  ExternalLink,
} from 'lucide-react';
import { TerminalViewer } from './TerminalViewer';
import { api } from '../../lib/api';

interface AgentDetailProps {
  agent: AgentRecord;
  onClose: () => void;
  onStop: (agentId: string) => void;
}

/** Format seconds into HH:MM:SS or MM:SS. */
function formatRuntime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Slide-in detail panel for a selected agent.
 * Left side: TerminalViewer (live output).
 * Right side: Context info (files, bug report, PR link).
 */
export function AgentDetail({ agent, onClose, onStop }: AgentDetailProps) {
  const id = agent._id ?? agent.taskId;
  const isActive = agent.status === 'running' || agent.status === 'starting';

  // Fetch PR URL for fix agents that have created PRs
  const [prUrl, setPrUrl] = useState<string | null>(null);
  useEffect(() => {
    if (agent.type === 'fix' && agent.result?.prsCreated && agent.result.prsCreated > 0) {
      api.getPRs({ agentId: id }).then(prs => {
        if (prs.length > 0) setPrUrl(prs[0].prUrl);
      }).catch(() => {});
    }
  }, [agent.type, agent.result?.prsCreated, id]);

  // Compute static runtime for completed agents
  const staticRuntime = useMemo(() => {
    if (!agent.startedAt) return 0;
    const start = new Date(agent.startedAt).getTime();
    const end = agent.completedAt ? new Date(agent.completedAt).getTime() : Date.now();
    return Math.max(0, Math.floor((end - start) / 1000));
  }, [agent.startedAt, agent.completedAt]);

  return (
    <div className="animate-slide-in-panel-right fixed inset-y-0 right-0 z-50 flex w-full max-w-4xl flex-col border-l border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl shadow-black/30">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            Agent Detail
          </span>
          <span className="rounded-md bg-[var(--bg-tertiary)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
            {id.slice(0, 16)}
          </span>
          <AgentTypeBadge type={agent.type} />
          <AgentStatusBadge status={agent.status} />
        </div>

        <div className="flex items-center gap-2">
          {isActive && (
            <button
              onClick={() => onStop(id)}
              className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
            >
              <Square className="h-3 w-3" />
              Stop Agent
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ---- Body: Split pane ---- */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left pane: Terminal */}
        <div className="flex flex-1 flex-col overflow-hidden border-r border-[var(--border-color)] p-3">
          <TerminalViewer agentId={id} isActive={isActive} />
        </div>

        {/* Right pane: Context */}
        <div className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto p-4">
          {/* Runtime info */}
          <ContextSection title="Runtime">
            <div className="space-y-1.5 text-xs text-[var(--text-secondary)]">
              <div className="flex justify-between">
                <span className="text-[var(--text-muted)]">Type</span>
                <span className="font-medium">{agent.type}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--text-muted)]">Status</span>
                <span className="font-medium">{agent.status}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--text-muted)]">Duration</span>
                <span className="font-mono">{formatRuntime(staticRuntime)}</span>
              </div>
              {agent.restarts > 0 && (
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">Restarts</span>
                  <span className="text-amber-400">{agent.restarts}/{agent.maxRestarts}</span>
                </div>
              )}
              {agent.branch && (
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">Branch</span>
                  <span className="truncate font-mono text-[10px]">{agent.branch}</span>
                </div>
              )}
            </div>
          </ContextSection>

          {/* Target / node */}
          {agent.nodeId && (
            <ContextSection title="Target Node">
              <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate font-mono">{agent.nodeId}</span>
              </div>
            </ContextSection>
          )}

          {/* Worktree files */}
          {agent.worktreePath && (
            <ContextSection title="Files">
              <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate font-mono text-[10px]">{agent.worktreePath}</span>
              </div>
            </ContextSection>
          )}

          {/* Bug report link (if available via result) */}
          {agent.result && (
            <ContextSection title="Result Summary">
              <div className="space-y-1 text-xs text-[var(--text-secondary)]">
                <p className="leading-relaxed">{agent.result.summary}</p>
                {agent.result.bugsFound !== undefined && agent.result.bugsFound > 0 && (
                  <div className="flex items-center gap-1.5 text-amber-400">
                    <Bug className="h-3 w-3" />
                    {agent.result.bugsFound} bug(s) found
                  </div>
                )}
                {agent.result.prsCreated !== undefined && agent.result.prsCreated > 0 && (
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <GitPullRequest className="h-3 w-3" />
                    {agent.result.prsCreated} PR(s) created
                  </div>
                )}
              </div>
            </ContextSection>
          )}

          {/* PR link — shown when a fix agent has a result with PRs */}
          {agent.type === 'fix' && agent.result?.prsCreated && agent.result.prsCreated > 0 && prUrl && (
            <ContextSection title="Pull Request">
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-blue-400 transition-colors hover:text-blue-300"
              >
                <ExternalLink className="h-3 w-3" />
                View PR
              </a>
            </ContextSection>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small helper components ────────────────────────────────────

function ContextSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </h4>
      {children}
    </div>
  );
}

const TYPE_COLORS: Record<string, string> = {
  'log-analysis': 'bg-blue-500/10 text-blue-400 ring-blue-500/30',
  audit: 'bg-violet-500/10 text-violet-400 ring-violet-500/30',
  fix: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30',
  verify: 'bg-amber-500/10 text-amber-400 ring-amber-500/30',
};

function AgentTypeBadge({ type }: { type: string }) {
  const cls = TYPE_COLORS[type] ?? 'bg-slate-500/10 text-slate-400 ring-slate-500/30';
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-semibold ring-1 ${cls}`}>
      {type}
    </span>
  );
}

const STATUS_COLORS: Record<string, string> = {
  queued: 'text-yellow-400',
  starting: 'text-yellow-400',
  running: 'text-emerald-400',
  completed: 'text-slate-400',
  failed: 'text-red-400',
  timeout: 'text-red-400',
};

function AgentStatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? 'text-slate-400';
  return (
    <span className={`text-[10px] font-semibold ${color}`}>
      {status}
    </span>
  );
}
