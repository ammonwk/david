import { useState, useMemo, useCallback, useEffect } from 'react';
import type { TopologyNode, BugReport, PullRequestRecord } from 'david-shared';
import { useTopology } from '../hooks/useTopology';
import { useAgents } from '../hooks/useAgents';
import { Treemap } from '../components/topology/Treemap';
import type { NodeHealthStatus } from '../components/topology/Treemap';
import { ActivityOverlay, computeActiveNodes } from '../components/topology/ActivityOverlay';
import { NodeDetailDrawer } from '../components/topology/NodeDetailDrawer';
import { api } from '../lib/api';
import {
  RefreshCw,
  Scan,
  Crosshair,
  X,
  FileCode2,
  Clock,
  Layers,
  Hash,
  AlertTriangle,
  Map as MapIcon,
  Loader2,
  Activity,
} from 'lucide-react';

export function CodebaseMap() {
  const {
    topology,
    selectedNodes: selectedNodeIds,
    setSelectedNodes,
    triggerMapping,
    triggerAudit,
    loading,
    error,
    mappingInProgress,
  } = useTopology();

  const { agents } = useAgents();

  // Local UI state
  const [detailNode, setDetailNode] = useState<TopologyNode | null>(null);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [activityOverlayVisible, setActivityOverlayVisible] = useState(false);
  const [zoomPath, setZoomPath] = useState<TopologyNode[]>([]);

  // Data for detail drawer
  const [bugReports, setBugReports] = useState<BugReport[]>([]);
  const [pullRequests, setPullRequests] = useState<PullRequestRecord[]>([]);

  // Fetch bug reports and PRs for the detail drawer
  useEffect(() => {
    api.getBugReports().then(setBugReports).catch(() => {});
    api.getPRs().then(setPullRequests).catch(() => {});
  }, []);

  // Convert selectedNodeIds (string[]) to a Set for the treemap component
  const selectedSet = useMemo(
    () => new Set(selectedNodeIds),
    [selectedNodeIds],
  );

  // Node map for quick lookup
  const nodeMap = useMemo(() => {
    if (!topology) return new globalThis.Map<string, TopologyNode>();
    const m = new globalThis.Map<string, TopologyNode>();
    for (const n of topology.nodes) m.set(n.id, n);
    return m;
  }, [topology]);

  // Compute health status per node from bug reports
  const healthByNode = useMemo(() => {
    const m = new globalThis.Map<string, NodeHealthStatus>();
    if (!topology) return m;

    // Index bugs by nodeId
    const bugsByNode = new globalThis.Map<string, BugReport[]>();
    for (const bug of bugReports) {
      if (!bug.nodeId) continue;
      const list = bugsByNode.get(bug.nodeId) ?? [];
      list.push(bug);
      bugsByNode.set(bug.nodeId, list);
    }

    for (const node of topology.nodes) {
      const bugs = bugsByNode.get(node.id);
      if (bugs && bugs.length > 0) {
        const hasCritical = bugs.some((b) => b.severity === 'critical' || b.severity === 'high');
        m.set(node.id, hasCritical ? 'critical' : 'warning');
      } else if (node.files.length > 0) {
        m.set(node.id, 'healthy');
      } else {
        m.set(node.id, 'unaudited');
      }
    }

    return m;
  }, [topology, bugReports]);

  // Compute active node sets from agents
  const activeNodes = useMemo(() => computeActiveNodes(agents), [agents]);

  // ── Handlers ──

  const handleNodeSelect = useCallback(
    (nodeId: string) => {
      setSelectedNodes((prev: string[]) =>
        prev.includes(nodeId)
          ? prev.filter((id: string) => id !== nodeId)
          : [...prev, nodeId],
      );
    },
    [setSelectedNodes],
  );

  const handleNodeClick = useCallback(
    (node: TopologyNode) => {
      setDetailNode(node);
      setDetailPanelOpen(true);
    },
    [],
  );

  const handleZoomChange = useCallback(
    (path: TopologyNode[]) => {
      setZoomPath(path);
    },
    [],
  );

  const handleCloseDetail = useCallback(() => {
    setDetailPanelOpen(false);
    setTimeout(() => setDetailNode(null), 300);
  }, []);

  const handleNavigateToNode = useCallback(
    (node: TopologyNode) => {
      setDetailNode(node);
    },
    [],
  );

  const handleAuditNode = useCallback(
    (nodeId: string) => {
      triggerAudit([nodeId]);
    },
    [triggerAudit],
  );

  const handleClearSelection = useCallback(() => {
    setSelectedNodes([]);
    setSelectionMode(false);
  }, [setSelectedNodes]);

  const handleAuditAll = useCallback(() => {
    triggerAudit();
  }, [triggerAudit]);

  const handleAuditSelected = useCallback(() => {
    if (selectionMode && selectedNodeIds.length > 0) {
      triggerAudit(selectedNodeIds);
      setSelectionMode(false);
      setSelectedNodes([]);
    } else {
      // Enter selection mode
      setSelectionMode(true);
    }
  }, [triggerAudit, selectedNodeIds, selectionMode, setSelectedNodes]);

  // Summary stats
  const stats = useMemo(() => {
    if (!topology) return null;
    const l1Count = topology.nodes.filter((n) => n.level === 1).length;
    const l2Count = topology.nodes.filter((n) => n.level === 2).length;
    const l3Count = topology.nodes.filter((n) => n.level === 3).length;
    return { l1Count, l2Count, l3Count, total: topology.nodes.length };
  }, [topology]);

  // Formatted mapping date
  const mappedAtDisplay = useMemo(() => {
    if (!topology) return null;
    const date = new Date(topology.mappedAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }, [topology]);

  return (
    <div className="flex h-[calc(100vh-5rem)] flex-col gap-4">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-bold text-[var(--text-primary)]">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-500/20 ring-1 ring-blue-500/30">
              <MapIcon className="h-5 w-5 text-blue-400" />
            </div>
            Codebase Topology
          </h1>
          {topology && stats && (
            <div className="mt-1.5 flex items-center gap-4 text-xs text-[var(--text-muted)]">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" /> Mapped {mappedAtDisplay}
              </span>
              <span className="flex items-center gap-1">
                <FileCode2 className="h-3 w-3" /> {topology.fileCount.toLocaleString()} files
              </span>
              <span className="flex items-center gap-1">
                <Hash className="h-3 w-3" /> {topology.totalLines.toLocaleString()} lines
              </span>
              <span className="flex items-center gap-1">
                <Layers className="h-3 w-3" /> {stats.l1Count} areas / {stats.l2Count} modules / {stats.l3Count} components
              </span>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={triggerMapping}
            disabled={mappingInProgress}
            className="flex items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] ring-1 ring-[var(--border-color)] transition-all duration-200 hover:bg-[var(--bg-card)] hover:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${mappingInProgress ? 'animate-spin' : ''}`}
            />
            {mappingInProgress ? 'Mapping...' : 'Re-map Codebase'}
          </button>

          <button
            onClick={handleAuditSelected}
            disabled={mappingInProgress || (selectionMode && selectedNodeIds.length === 0)}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ring-1 transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
              selectionMode
                ? 'bg-blue-500/20 text-blue-400 ring-blue-500/40 hover:bg-blue-500/30'
                : 'bg-blue-500/10 text-blue-400 ring-blue-500/30 hover:bg-blue-500/20'
            }`}
          >
            <Crosshair className="h-4 w-4" />
            {selectionMode
              ? selectedNodeIds.length > 0
                ? `Audit ${selectedNodeIds.length} Selected`
                : 'Select Nodes...'
              : 'Audit Selected'}
          </button>

          <button
            onClick={handleAuditAll}
            disabled={!topology || mappingInProgress}
            className="flex items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] ring-1 ring-[var(--border-color)] transition-all duration-200 hover:bg-[var(--bg-card)] hover:ring-purple-500/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Scan className="h-4 w-4" />
            Audit All
          </button>

          <button
            onClick={() => setActivityOverlayVisible((v) => !v)}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1 transition-all duration-200 ${
              activityOverlayVisible
                ? 'bg-amber-500/15 text-amber-400 ring-amber-500/30'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] ring-[var(--border-color)] hover:text-[var(--text-primary)]'
            }`}
            title="Toggle activity overlay"
          >
            <Activity className="h-4 w-4" />
          </button>

          {(selectionMode || selectedNodeIds.length > 0) && (
            <button
              onClick={handleClearSelection}
              className="flex items-center gap-1 rounded-lg px-3 py-2 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Selection mode banner ── */}
      {selectionMode && (
        <div className="animate-fade-in flex items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-sm text-blue-400">
          <Crosshair className="h-4 w-4" />
          <span>
            Selection mode active — click treemap nodes to select them for audit.
            {selectedNodeIds.length > 0 && (
              <span className="ml-1 font-medium">
                {selectedNodeIds.length} node{selectedNodeIds.length !== 1 ? 's' : ''} selected.
              </span>
            )}
          </span>
        </div>
      )}

      {/* ── Error banner ── */}
      {error && (
        <div className="animate-fade-in flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* ── Mapping progress banner ── */}
      {mappingInProgress && (
        <div className="animate-fade-in flex items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-sm text-blue-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>
            Mapping codebase topology... This may take a few minutes depending
            on repository size.
          </span>
          <div className="ml-auto h-1.5 w-32 overflow-hidden rounded-full bg-blue-500/20">
            <div className="h-full w-1/2 animate-pulse-slow rounded-full bg-blue-500/60" />
          </div>
        </div>
      )}

      {/* ── Main content: Treemap + Detail Drawer ── */}
      <div className="relative flex min-h-0 flex-1 gap-0 overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)]">
        {/* Treemap area */}
        <div
          className={`min-h-0 flex-1 transition-all duration-300 ${
            detailPanelOpen ? 'mr-0' : ''
          }`}
        >
          <Treemap
            topology={topology}
            selectedNodes={selectedSet}
            onNodeSelect={handleNodeSelect}
            onNodeClick={handleNodeClick}
            onZoomChange={handleZoomChange}
            loading={loading}
            healthByNode={healthByNode}
            activeNodes={activeNodes}
          />

          {/* Activity overlay legend */}
          <ActivityOverlay
            activeNodes={activeNodes}
            visible={activityOverlayVisible}
          />
        </div>

        {/* ── Detail Drawer (slides in from right) ── */}
        <NodeDetailDrawer
          node={detailNode}
          open={detailPanelOpen}
          onClose={handleCloseDetail}
          onAuditNode={handleAuditNode}
          onNavigateToNode={handleNavigateToNode}
          nodeMap={nodeMap}
          bugReports={bugReports}
          pullRequests={pullRequests}
          agents={agents}
        />
      </div>

      {/* ── Bottom stats bar ── */}
      {topology && stats && (
        <div className="flex items-center justify-between rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2 text-xs text-[var(--text-muted)]">
          <div className="flex items-center gap-4">
            <span>
              <span className="mr-1.5 inline-block h-2 w-2 rounded bg-[var(--treemap-green,#22c55e)]/60" />
              Healthy
            </span>
            <span>
              <span className="mr-1.5 inline-block h-2 w-2 rounded bg-[#f59e0b]/60" />
              Has Bugs
            </span>
            <span>
              <span className="mr-1.5 inline-block h-2 w-2 rounded bg-[#ef4444]/60" />
              Critical
            </span>
            <span>
              <span className="mr-1.5 inline-block h-2 w-2 rounded bg-[#64748b]/60" />
              Never Audited
            </span>
            <span className="ml-2 text-[var(--border-color)]">|</span>
            <span>L1: {stats.l1Count}</span>
            <span>L2: {stats.l2Count}</span>
            <span>L3: {stats.l3Count}</span>
          </div>
          <div className="flex items-center gap-3">
            {zoomPath.length > 0 && (
              <span className="text-[var(--text-secondary)]">
                Zoomed: {zoomPath.map((n) => n.name).join(' > ')}
              </span>
            )}
            {selectedNodeIds.length > 0 && (
              <span className="text-blue-400">
                {selectedNodeIds.length} selected
              </span>
            )}
            <span className="font-mono text-[10px]">
              {topology.commitHash.slice(0, 8)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
