import { Router } from 'express';
import { agentPool } from '../agents/agent-pool.js';
import { AgentModel } from '../db/models.js';
import type { PoolStatusResponse } from 'david-shared';

interface AgentsRouterDeps {
  agentPool: typeof agentPool;
  AgentModel: typeof AgentModel;
}

export function createAgentsRouter(deps: AgentsRouterDeps) {
  const router = Router();

// GET /api/agents — get pool status + all agents (live + historical)
  router.get('/', async (req, res) => {
  try {
    const status = deps.agentPool.getStatus();
    const limit = parseInt(req.query.limit as string) || 100;
    const agents = await deps.agentPool.getAgentsWithHistory(limit);
    const queue = deps.agentPool.getQueue();

    const response: PoolStatusResponse = {
      ...status,
      agents,
      queue,
    };

    res.json(response);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
  });

// GET /api/agents/:id — get a specific agent
  router.get('/:id', async (req, res) => {
  try {
    const result = await deps.agentPool.getAgentWithHistory(req.params.id);
    if (!result) return res.status(404).json({ error: 'Agent not found' });

    // If it's a ManagedAgent (live), convert to record
    if ('toRecord' in result) {
      return res.json(result.toRecord());
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
  });

// GET /api/agents/:id/output — get agent output log
  router.get('/:id/output', async (req, res) => {
  try {
    const agent = deps.agentPool.getAgent(req.params.id);
    if (!agent) {
      // Try MongoDB
      const record = await deps.AgentModel.findById(req.params.id).select('outputLog').lean();
      if (!record) return res.status(404).json({ error: 'Agent not found' });
      return res.json({ output: record.outputLog || [] });
    }
    res.json({ output: agent.getOutputLog() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
  });

// POST /api/agents/:id/stop — stop a running agent
  router.post('/:id/stop', async (req, res) => {
  try {
    const stopped = await deps.agentPool.stopAgent(req.params.id);
    if (!stopped) return res.status(404).json({ error: 'Agent not found or not running' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
  });

// POST /api/agents/:id/retry — re-dispatch a failed/crashed agent
  router.post('/:id/retry', async (req, res) => {
  try {
    const record = await deps.AgentModel.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ error: 'Agent not found' });
    if (!['failed', 'timeout'].includes(record.status as string)) {
      return res.status(400).json({ error: 'Agent is not in a retryable state' });
    }
    if (!record.prompt) {
      return res.status(400).json({ error: 'Agent prompt not stored — cannot retry' });
    }

    // Reconstruct worktreeConfig from stored fields
    const worktreeConfig = record.worktreeType && record.worktreeIdentifier
      ? { type: record.worktreeType as 'branch' | 'snapshot', identifier: record.worktreeIdentifier as string }
      : undefined;

    const newAgent = await deps.agentPool.submit({
      id: `retry-${record._id}-${Date.now()}`,
      type: record.type as any,
      prompt: record.prompt as string,
      cwd: process.cwd(),
      taskId: record.taskId as string,
      nodeId: record.nodeId as string | undefined,
      parentAgentId: record.parentAgentId as string | undefined,
      systemPrompt: record.systemPrompt as string | undefined,
      worktreeConfig,
    });

    res.json({ agentId: newAgent.id, retryOf: record._id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
  });

  return router;
}

export default createAgentsRouter({
  agentPool,
  AgentModel,
});
