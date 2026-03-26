import { useState, useEffect, useCallback, useMemo } from 'react';
import type { PipelineItem, PipelineColumn, BugEventData, PREventData } from 'david-shared';
import { api } from '../lib/api';
import { useSocketEvent } from './useSocket';

/**
 * Hook for the PR Pipeline kanban board.
 *
 * Fetches pipeline items on mount and keeps them updated in real-time
 * via WebSocket events for bug and PR lifecycle changes.
 */
export function usePipeline() {
  const [items, setItems] = useState<PipelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const fetchPipeline = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getPipelineItems();
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch pipeline');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  // Live updates: refresh on bug lifecycle events
  useSocketEvent<BugEventData>('bug:reported', () => {
    fetchPipeline();
  });

  useSocketEvent<BugEventData>('bug:verified', () => {
    fetchPipeline();
  });

  useSocketEvent<BugEventData>('bug:fixed', () => {
    fetchPipeline();
  });

  // Live updates: refresh on PR lifecycle events
  useSocketEvent<PREventData>('pr:created', () => {
    fetchPipeline();
  });

  useSocketEvent<PREventData>('pr:merged', () => {
    fetchPipeline();
  });

  useSocketEvent<PREventData>('pr:closed', () => {
    fetchPipeline();
  });

  // Group items by pipeline column for the kanban board
  const columns = useMemo(() => {
    const grouped: Record<PipelineColumn, PipelineItem[]> = {
      reported: [],
      verifying: [],
      fixing: [],
      'pr-open': [],
      merged: [],
      closed: [],
    };
    for (const item of items) {
      if (grouped[item.column]) {
        grouped[item.column].push(item);
      }
    }
    return grouped;
  }, [items]);

  // Convenience: get the currently selected pipeline item
  const selectedItem = useMemo(() => {
    if (!selectedItemId) return null;
    return items.find((item) => item.id === selectedItemId) ?? null;
  }, [items, selectedItemId]);

  return {
    items,
    columns,
    loading,
    error,
    selectedItemId,
    setSelectedItemId,
    selectedItem,
    refresh: fetchPipeline,
  };
}
