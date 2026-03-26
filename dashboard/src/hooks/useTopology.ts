import { useState, useEffect, useCallback, useMemo } from 'react';
import type { CodebaseTopology, TopologyNode, TopologyNodeLevel, TriggerAuditRequest, TopologyEventData } from 'david-shared';
import { api } from '../lib/api';
import { useSocketEvent } from './useSocket';

export function useTopology() {
  const [topology, setTopology] = useState<CodebaseTopology | null>(null);
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mappingInProgress, setMappingInProgress] = useState(false);

  // Zoom state for treemap navigation (L1 → L2 → L3)
  const [zoomPath, setZoomPath] = useState<TopologyNode[]>([]);
  const [zoomLevel, setZoomLevel] = useState<TopologyNodeLevel>(1);
  const [currentParent, setCurrentParent] = useState<string | null>(null);

  const fetchTopology = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getTopology();
      setTopology(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch topology');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchTopology();
  }, [fetchTopology]);

  // Live updates: refresh topology when mapping completes
  useSocketEvent<TopologyEventData>('topology:mapping-started', () => {
    setMappingInProgress(true);
  });

  useSocketEvent<TopologyEventData>('topology:mapping-completed', () => {
    setMappingInProgress(false);
    fetchTopology();
  });

  const triggerMapping = useCallback(async () => {
    try {
      setError(null);
      setMappingInProgress(true);
      await api.triggerMapping();
    } catch (err) {
      setMappingInProgress(false);
      setError(err instanceof Error ? err.message : 'Failed to trigger mapping');
    }
  }, []);

  const triggerAudit = useCallback(async (nodeIds?: string[]) => {
    try {
      setError(null);
      const req: TriggerAuditRequest = nodeIds ? { nodeIds } : {};
      return await api.triggerAudit(req);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger audit');
      return null;
    }
  }, []);

  // Zoom into a node: push it onto the breadcrumb path and advance the level
  const zoomTo = useCallback(
    (node: TopologyNode) => {
      setZoomPath((prev) => [...prev, node]);
      setZoomLevel((prev) => Math.min(prev + 1, 3) as TopologyNodeLevel);
      setCurrentParent(node.id);
    },
    [],
  );

  // Zoom out to a specific index in the breadcrumb path
  const zoomOut = useCallback(
    (levelIndex: number) => {
      if (levelIndex <= 0) {
        // Go back to root
        setZoomPath([]);
        setZoomLevel(1);
        setCurrentParent(null);
      } else {
        setZoomPath((prev) => prev.slice(0, levelIndex));
        setZoomLevel(Math.min(levelIndex + 1, 3) as TopologyNodeLevel);
        setCurrentParent(zoomPath[levelIndex - 1]?.id ?? null);
      }
    },
    [zoomPath],
  );

  // Reset zoom back to the L1 (root) view
  const resetZoom = useCallback(() => {
    setZoomPath([]);
    setZoomLevel(1);
    setCurrentParent(null);
  }, []);

  // Compute the visible nodes at the current zoom level
  const visibleNodes = useMemo(() => {
    if (!topology) return [];
    if (!currentParent) {
      // Root level: show L1 nodes
      return topology.nodes.filter((n) => n.level === 1);
    }
    return topology.nodes.filter((n) => n.parentId === currentParent);
  }, [topology, currentParent]);

  return {
    topology,
    selectedNodes,
    setSelectedNodes,
    triggerMapping,
    triggerAudit,
    loading,
    error,
    mappingInProgress,
    // Zoom state
    zoomPath,
    zoomLevel,
    currentParent,
    zoomTo,
    zoomOut,
    resetZoom,
    visibleNodes,
  };
}
