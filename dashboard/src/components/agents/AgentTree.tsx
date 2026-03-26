import { useState, useEffect, useMemo, useCallback } from 'react';
import type { AgentRecord, AgentType, AgentStatus } from 'david-shared';
import {
  ChevronRight,
  ChevronDown,
  Search,
  ShieldCheck,
  Wrench,
  FileSearch,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

interface AgentTreeProps {
  agents: AgentRecord[];
  onSelectAgent: (agentId: string) => void;
  selectedAgentId: string | null;
}

// ── Helpers ──────────────────────────────────────────────────

/** Icon per agent type. */
const TYPE_ICON: Record<AgentType, typeof Search> = {
  'log-analysis': FileSearch,
  audit: Search,
  verify: ShieldCheck,
  fix: Wrench,
};

/** Color theme per agent type. */
const TYPE_THEME: Record<AgentType, { text: string; bg: string; border: string }> = {
  'log-analysis': { text: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30' },
  audit: { text: 'text-violet-400', bg: 'bg-violet-500/10', border: 'border-violet-500/30' },
  fix: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
  verify: { text: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30' },
};

/** Status indicator config. */
const STATUS_CONFIG: Record<AgentStatus, {
  dot: string;
  pulse: boolean;
  icon: typeof CheckCircle2 | null;
  label: string;
}> = {
  queued:    { dot: 'bg-yellow-400', pulse: false, icon: Clock, label: 'Queued' },
  starting:  { dot: 'bg-yellow-400', pulse: true, icon: Loader2, label: 'Starting' },
  running:   { dot: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]', pulse: true, icon: null, label: 'Running' },
  completed: { dot: 'bg-slate-400', pulse: false, icon: CheckCircle2, label: 'Done' },
  failed:    { dot: 'bg-red-400', pulse: false, icon: XCircle, label: 'Failed' },
  timeout:   { dot: 'bg-red-400', pulse: false, icon: AlertTriangle, label: 'Timeout' },
};

/** Format elapsed seconds into MM:SS or HH:MM:SS. */
function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Derive a display name from the agent target. */
function targetLabel(agent: AgentRecord): string {
  if (agent.nodeId) {
    const parts = agent.nodeId.split('/');
    return parts[parts.length - 1];
  }
  return agent.taskId.length > 24 ? `${agent.taskId.slice(0, 24)}...` : agent.taskId;
}

// ── Tree node type ───────────────────────────────────────────

interface TreeNode {
  agent: AgentRecord;
  children: TreeNode[];
}

/** Build hierarchical tree from flat agent list. */
function buildTree(agents: AgentRecord[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // Create nodes
  for (const agent of agents) {
    const id = agent._id ?? agent.taskId;
    byId.set(id, { agent, children: [] });
  }

  // Wire parent-child
  for (const agent of agents) {
    const id = agent._id ?? agent.taskId;
    const node = byId.get(id)!;

    if (agent.parentAgentId && byId.has(agent.parentAgentId)) {
      byId.get(agent.parentAgentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort: running first, then by startedAt
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const orderA = statusOrder(a.agent.status);
      const orderB = statusOrder(b.agent.status);
      if (orderA !== orderB) return orderA - orderB;
      const tA = a.agent.startedAt ? new Date(a.agent.startedAt).getTime() : 0;
      const tB = b.agent.startedAt ? new Date(b.agent.startedAt).getTime() : 0;
      return tB - tA;
    });
    for (const n of nodes) sortNodes(n.children);
  };

  sortNodes(roots);
  return roots;
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

// ── Components ───────────────────────────────────────────────

export function AgentTree({ agents, onSelectAgent, selectedAgentId }: AgentTreeProps) {
  const tree = useMemo(() => buildTree(agents), [agents]);

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-sm text-[var(--text-muted)]">
        <FileSearch className="mb-3 h-8 w-8" />
        No agents have been dispatched yet.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {tree.map((node) => (
        <TreeNodeRow
          key={node.agent._id ?? node.agent.taskId}
          node={node}
          depth={0}
          onSelect={onSelectAgent}
          selectedId={selectedAgentId}
        />
      ))}
    </div>
  );
}

// ── Individual tree node ─────────────────────────────────────

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  onSelect: (id: string) => void;
  selectedId: string | null;
}

function TreeNodeRow({ node, depth, onSelect, selectedId }: TreeNodeRowProps) {
  const { agent } = node;
  const id = agent._id ?? agent.taskId;
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(true);
  const isSelected = selectedId === id;
  const isActive = agent.status === 'running' || agent.status === 'starting';
  const isFailed = agent.status === 'failed' || agent.status === 'timeout';
  const isCompleted = agent.status === 'completed';

  const theme = TYPE_THEME[agent.type];
  const statusCfg = STATUS_CONFIG[agent.status];
  const TypeIcon = TYPE_ICON[agent.type];

  // ── Live runtime counter ──────────────────────────────────
  const [elapsed, setElapsed] = useState<number>(() => {
    if (!agent.startedAt) return 0;
    const start = new Date(agent.startedAt).getTime();
    const end = agent.completedAt ? new Date(agent.completedAt).getTime() : Date.now();
    return Math.max(0, Math.floor((end - start) / 1000));
  });

  useEffect(() => {
    if (!isActive || !agent.startedAt) return;
    const tick = () => {
      const start = new Date(agent.startedAt!).getTime();
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isActive, agent.startedAt]);

  // Recompute for non-active
  useEffect(() => {
    if (isActive) return;
    if (!agent.startedAt) { setElapsed(0); return; }
    const start = new Date(agent.startedAt).getTime();
    const end = agent.completedAt ? new Date(agent.completedAt).getTime() : Date.now();
    setElapsed(Math.max(0, Math.floor((end - start) / 1000)));
  }, [isActive, agent.startedAt, agent.completedAt]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  }, []);

  const handleClick = useCallback(() => {
    onSelect(id);
  }, [onSelect, id]);

  return (
    <div>
      {/* Node row */}
      <button
        onClick={handleClick}
        className={`
          group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-all duration-150
          ${isSelected
            ? 'bg-blue-500/10 ring-1 ring-blue-500/30'
            : 'hover:bg-[var(--bg-tertiary)]'
          }
          ${isCompleted ? 'opacity-60' : ''}
        `}
        style={{ paddingLeft: `${depth * 24 + 8}px` }}
      >
        {/* Tree connector lines (visual indentation) */}
        {depth > 0 && (
          <span className="mr-1 inline-block h-4 w-px bg-[var(--border-color)]" />
        )}

        {/* Expand/collapse chevron */}
        {hasChildren ? (
          <span
            onClick={handleToggle}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        {/* Agent type icon */}
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${theme.bg} ${theme.border}`}>
          <TypeIcon className={`h-3.5 w-3.5 ${theme.text}`} />
        </span>

        {/* Target name */}
        <span className={`min-w-0 flex-1 truncate text-sm font-medium ${isCompleted ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
          {targetLabel(agent)}
        </span>

        {/* Status indicator */}
        <span className="flex items-center gap-1.5">
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusCfg.dot} ${statusCfg.pulse ? 'animate-pulse' : ''}`}
          />
          <span className={`text-[10px] font-medium ${isFailed ? 'text-red-400' : isActive ? 'text-emerald-400' : 'text-[var(--text-muted)]'}`}>
            {statusCfg.label}
          </span>
        </span>

        {/* Runtime counter */}
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-mono text-[var(--text-muted)]">
          <Clock className="h-3 w-3" />
          {agent.startedAt ? formatElapsed(elapsed) : '--:--'}
        </span>

        {/* Restarts badge */}
        {agent.restarts > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            {agent.restarts}x
          </span>
        )}

        {/* Active spinner */}
        {isActive && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--text-muted)]" />
        )}
      </button>

      {/* Children */}
      {hasChildren && expanded && (
        <div className="relative">
          {/* Vertical connector line */}
          <div
            className="absolute left-0 top-0 bottom-0 w-px bg-[var(--border-color)]"
            style={{ marginLeft: `${depth * 24 + 20}px` }}
          />
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.agent._id ?? child.agent.taskId}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedId={selectedId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
