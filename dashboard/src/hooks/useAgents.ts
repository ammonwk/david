import { useState, useEffect, useCallback, useMemo } from 'react';
import type { AgentRecord, PoolStatusResponse, AgentEventData } from 'david-shared';
import { api } from '../lib/api';
import { useSocketEvent } from './useSocket';

/** A tree node wrapping an AgentRecord with its child agents. */
export interface AgentTreeNode {
  agent: AgentRecord;
  children: AgentTreeNode[];
}

export function useAgents() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [poolStatus, setPoolStatus] = useState<Omit<PoolStatusResponse, 'agents' | 'queue'> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // View mode toggle: tree (hierarchical) or timeline (Gantt-style)
  const [viewMode, setViewMode] = useState<'tree' | 'timeline'>('tree');

  // Selected agent for the detail panel
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getAgents();
      const { agents: agentList, queue, ...status } = data;
      setAgents([...agentList, ...queue]);
      setPoolStatus(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch agents');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Live updates: refresh agent list on lifecycle events
  useSocketEvent<AgentEventData>('agent:started', () => {
    fetchAgents();
  });

  useSocketEvent<AgentEventData>('agent:completed', () => {
    fetchAgents();
  });

  useSocketEvent<AgentEventData>('agent:failed', () => {
    fetchAgents();
  });

  useSocketEvent<AgentEventData>('agent:queued', () => {
    fetchAgents();
  });

  const stopAgent = useCallback(async (id: string) => {
    try {
      await api.stopAgent(id);
      await fetchAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop agent');
    }
  }, [fetchAgents]);

  // Computed tree structure: group agents by parentAgentId into a hierarchy
  const agentTree = useMemo((): AgentTreeNode[] => {
    const agentMap = new Map<string, AgentRecord>();
    const childrenMap = new Map<string, AgentRecord[]>();

    // Index all agents by ID and group children by parentAgentId
    for (const agent of agents) {
      const id = agent._id ?? agent.taskId;
      agentMap.set(id, agent);
      const parentId = agent.parentAgentId ?? '__root__';
      if (!childrenMap.has(parentId)) {
        childrenMap.set(parentId, []);
      }
      childrenMap.get(parentId)!.push(agent);
    }

    // Recursively build tree nodes
    function buildNodes(parentId: string): AgentTreeNode[] {
      const children = childrenMap.get(parentId) ?? [];
      return children.map((agent) => ({
        agent,
        children: buildNodes(agent._id ?? agent.taskId),
      }));
    }

    return buildNodes('__root__');
  }, [agents]);

  // Convenience: get the currently selected agent record
  const selectedAgent = useMemo(() => {
    if (!selectedAgentId) return null;
    return agents.find((a) => (a._id ?? a.taskId) === selectedAgentId) ?? null;
  }, [agents, selectedAgentId]);

  return {
    agents,
    poolStatus,
    loading,
    error,
    stopAgent,
    refresh: fetchAgents,
    // Tree view / timeline toggle
    viewMode,
    setViewMode,
    // Agent selection
    selectedAgentId,
    setSelectedAgentId,
    selectedAgent,
    // Computed tree structure
    agentTree,
  };
}
