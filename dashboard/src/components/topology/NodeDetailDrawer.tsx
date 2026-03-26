import { useCallback, useMemo } from 'react';
import type { TopologyNode, BugReport, PullRequestRecord, AgentRecord } from 'david-shared';
import {
  X,
  FileCode2,
  ChevronRight,
  Bug,
  GitPullRequest,
  Scan,
  Clock,
  History,
  Layers,
  Hash,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────

export interface NodeDetailDrawerProps {
  /** The node to display details for, or null if drawer is closed */
  node: TopologyNode | null;
  /** Whether the drawer is open (controls slide animation) */
  open: boolean;
  /** Called when the user closes the drawer */
  onClose: () => void;
  /** Called when the user clicks "Audit This Node" */
  onAuditNode: (nodeId: string) => void;
  /** Called when the user clicks a child node in the list */
  onNavigateToNode: (node: TopologyNode) => void;
  /** Map of all nodes for path resolution and child lookup */
  nodeMap: globalThis.Map<string, TopologyNode>;
  /** Bug reports associated with this node area */
  bugReports: BugReport[];
  /** Pull requests associated with this node area */
  pullRequests: PullRequestRecord[];
  /** Agent records for audit history */
  agents: AgentRecord[];
}

// ── Severity badge colors ─────────────────────────────────

const severityColors: Record<string, { bg: string; text: string; ring: string }> = {
  critical: { bg: 'bg-red-500/15', text: 'text-red-400', ring: 'ring-red-500/30' },
  high: { bg: 'bg-orange-500/15', text: 'text-orange-400', ring: 'ring-orange-500/30' },
  medium: { bg: 'bg-amber-500/15', text: 'text-amber-400', ring: 'ring-amber-500/30' },
  low: { bg: 'bg-blue-500/15', text: 'text-blue-400', ring: 'ring-blue-500/30' },
};

const prStatusColors: Record<string, { bg: string; text: string }> = {
  open: { bg: 'bg-green-500/15', text: 'text-green-400' },
  merged: { bg: 'bg-purple-500/15', text: 'text-purple-400' },
  closed: { bg: 'bg-red-500/15', text: 'text-red-400' },
};

// ── Component ──────────────────────────────────────────────

export function NodeDetailDrawer({
  node,
  open,
  onClose,
  onAuditNode,
  onNavigateToNode,
  nodeMap,
  bugReports,
  pullRequests,
  agents,
}: NodeDetailDrawerProps) {
  // Get parent path for breadcrumb
  const getNodePath = useCallback(
    (n: TopologyNode): TopologyNode[] => {
      const path: TopologyNode[] = [];
      let current: TopologyNode | undefined = n;
      while (current) {
        path.unshift(current);
        current = current.parentId ? nodeMap.get(current.parentId) : undefined;
      }
      return path;
    },
    [nodeMap],
  );

  // Get children of the node
  const children = useMemo(() => {
    if (!node) return [];
    return node.children
      .map((id) => nodeMap.get(id))
      .filter(Boolean) as TopologyNode[];
  }, [node, nodeMap]);

  // Filter bug reports for this node
  const nodeBugs = useMemo(() => {
    if (!node) return [];
    return bugReports.filter(
      (b) =>
        b.nodeId === node.id ||
        b.affectedFiles.some((f) => node.files.includes(f)),
    );
  }, [node, bugReports]);

  // Filter PRs for this node
  const nodePRs = useMemo(() => {
    if (!node) return [];
    return pullRequests.filter((pr) => pr.nodeId === node.id);
  }, [node, pullRequests]);

  // Audit history: completed audit agents targeting this node
  const auditHistory = useMemo(() => {
    if (!node) return [];
    return agents
      .filter(
        (a) =>
          a.type === 'audit' &&
          a.nodeId === node.id &&
          a.status === 'completed',
      )
      .sort((a, b) => {
        const aDate = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const bDate = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return bDate - aDate;
      })
      .slice(0, 10);
  }, [node, agents]);

  // Path for breadcrumb
  const path = useMemo(() => {
    if (!node) return [];
    return getNodePath(node);
  }, [node, getNodePath]);

  // Level badge color
  const levelColor =
    node?.level === 1
      ? '#3b82f6'
      : node?.level === 2
        ? '#7c3aed'
        : '#10b981';

  return (
    <div
      className={`
        absolute right-0 top-0 z-30 h-full w-[380px] border-l border-[var(--border-color)]
        bg-[var(--bg-secondary)]/95 backdrop-blur-md
        transition-transform duration-300 ease-in-out
        ${open && node ? 'translate-x-0' : 'translate-x-full'}
      `}
    >
      {node && (
        <div className="flex h-full flex-col overflow-hidden">
          {/* ── Header ── */}
          <div className="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-3">
            <div className="flex items-center gap-2 truncate">
              <span
                className="inline-block h-3 w-3 shrink-0 rounded"
                style={{ background: levelColor }}
              />
              <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
                {node.name}
              </span>
              <span className="shrink-0 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                L{node.level}
              </span>
            </div>
            <button
              onClick={onClose}
              className="ml-2 shrink-0 rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* ── Scrollable content ── */}
          <div className="flex-1 overflow-y-auto">
            {/* Breadcrumb path */}
            <div className="border-b border-[var(--border-color)] px-4 py-2">
              <div className="flex flex-wrap items-center gap-1 text-[10px] text-[var(--text-muted)]">
                {path.map((segment, i) => (
                  <span key={segment.id} className="flex items-center gap-1">
                    <span
                      className={
                        i === path.length - 1
                          ? 'text-[var(--text-secondary)]'
                          : ''
                      }
                    >
                      {segment.name}
                    </span>
                    {i < path.length - 1 && (
                      <ChevronRight className="h-2.5 w-2.5" />
                    )}
                  </span>
                ))}
              </div>
            </div>

            {/* Description */}
            {node.description && (
              <div className="border-b border-[var(--border-color)] px-4 py-3">
                <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                  {node.description}
                </p>
              </div>
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-px border-b border-[var(--border-color)] bg-[var(--border-color)]">
              <div className="flex flex-col gap-0.5 bg-[var(--bg-secondary)] p-3">
                <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  <FileCode2 className="h-2.5 w-2.5" /> Files
                </span>
                <span className="text-lg font-bold text-[var(--text-primary)]">
                  {node.files.length}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 bg-[var(--bg-secondary)] p-3">
                <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  <Hash className="h-2.5 w-2.5" /> Lines
                </span>
                <span className="text-lg font-bold text-[var(--text-primary)]">
                  {node.totalLines.toLocaleString()}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 bg-[var(--bg-secondary)] p-3">
                <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  <Layers className="h-2.5 w-2.5" /> Level
                </span>
                <span className="text-lg font-bold text-[var(--text-primary)]">
                  L{node.level}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 bg-[var(--bg-secondary)] p-3">
                <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  <Layers className="h-2.5 w-2.5" /> Children
                </span>
                <span className="text-lg font-bold text-[var(--text-primary)]">
                  {node.children.length}
                </span>
              </div>
            </div>

            {/* Child nodes */}
            {children.length > 0 && (
              <div className="border-b border-[var(--border-color)] px-4 py-3">
                <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Child Nodes
                </h4>
                <div className="space-y-1">
                  {children.map((child) => (
                    <button
                      key={child.id}
                      onClick={() => onNavigateToNode(child)}
                      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-tertiary)]"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-2 w-2 rounded"
                          style={{
                            background:
                              child.level === 1
                                ? '#3b82f6'
                                : child.level === 2
                                  ? '#7c3aed'
                                  : '#10b981',
                          }}
                        />
                        <span className="text-[var(--text-primary)]">
                          {child.name}
                        </span>
                      </div>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {child.files.length} files
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Files list */}
            {node.files.length > 0 && (
              <div className="border-b border-[var(--border-color)] px-4 py-3">
                <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Files ({node.files.length})
                </h4>
                <div className="max-h-48 space-y-0.5 overflow-y-auto">
                  {node.files.map((file) => (
                    <div
                      key={file}
                      className="flex items-center gap-2 rounded px-2 py-1 text-xs transition-colors hover:bg-[var(--bg-tertiary)]"
                    >
                      <FileCode2 className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                      <span className="truncate font-mono text-[var(--text-secondary)]">
                        {file}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Audit history timeline */}
            <div className="border-b border-[var(--border-color)] px-4 py-3">
              <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <History className="h-3 w-3" />
                Audit History
              </h4>
              {auditHistory.length > 0 ? (
                <div className="space-y-2">
                  {auditHistory.map((audit) => {
                    const completedAt = audit.completedAt
                      ? new Date(audit.completedAt)
                      : null;
                    const bugsFound = audit.result?.bugsFound ?? 0;
                    return (
                      <div
                        key={audit._id || audit.taskId}
                        className="flex items-start gap-2 rounded px-2 py-1.5 text-xs hover:bg-[var(--bg-tertiary)]"
                      >
                        <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-blue-400/60" />
                        <div className="flex-1">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-[var(--text-primary)]">
                              Audit completed
                            </span>
                            {completedAt && (
                              <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                                <Clock className="h-2.5 w-2.5" />
                                {completedAt.toLocaleDateString()}
                              </span>
                            )}
                          </div>
                          <span className="text-[var(--text-muted)]">
                            {bugsFound} finding{bugsFound !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs italic text-[var(--text-muted)]">
                  No audit history for this node
                </p>
              )}
            </div>

            {/* Open bugs */}
            <div className="border-b border-[var(--border-color)] px-4 py-3">
              <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <Bug className="h-3 w-3" />
                Open Issues ({nodeBugs.length})
              </h4>
              {nodeBugs.length > 0 ? (
                <div className="space-y-1.5">
                  {nodeBugs.map((bug) => {
                    const colors = severityColors[bug.severity] || severityColors.low;
                    return (
                      <div
                        key={bug._id || bug.pattern}
                        className="rounded-md border border-[var(--border-color)] px-2.5 py-2 text-xs"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium text-[var(--text-primary)]">
                            {bug.pattern.length > 60
                              ? bug.pattern.slice(0, 57) + '...'
                              : bug.pattern}
                          </span>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${colors.bg} ${colors.text} ${colors.ring}`}
                          >
                            {bug.severity}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                          <span>{bug.status}</span>
                          <span>&middot;</span>
                          <span>{bug.source}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs italic text-[var(--text-muted)]">
                  No issues found for this node
                </p>
              )}
            </div>

            {/* Related PRs */}
            <div className="px-4 py-3">
              <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <GitPullRequest className="h-3 w-3" />
                Related PRs ({nodePRs.length})
              </h4>
              {nodePRs.length > 0 ? (
                <div className="space-y-1.5">
                  {nodePRs.map((pr) => {
                    const statusColors = prStatusColors[pr.status] || prStatusColors.open;
                    return (
                      <div
                        key={pr._id || pr.prNumber}
                        className="rounded-md border border-[var(--border-color)] px-2.5 py-2 text-xs"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <a
                            href={pr.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-[var(--text-primary)] underline-offset-2 hover:underline"
                          >
                            #{pr.prNumber} {pr.title}
                          </a>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${statusColors.bg} ${statusColors.text}`}
                          >
                            {pr.status}
                          </span>
                        </div>
                        <div className="mt-1 text-[10px] text-[var(--text-muted)]">
                          {pr.branch}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs italic text-[var(--text-muted)]">
                  No PRs related to this node
                </p>
              )}
            </div>
          </div>

          {/* ── Footer action ── */}
          <div className="border-t border-[var(--border-color)] px-4 py-3">
            <button
              onClick={() => onAuditNode(node.id)}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-500/10 px-3 py-2.5 text-xs font-medium text-blue-400 ring-1 ring-blue-500/30 transition-all duration-200 hover:bg-blue-500/20"
            >
              <Scan className="h-3.5 w-3.5" />
              Audit This Node
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
