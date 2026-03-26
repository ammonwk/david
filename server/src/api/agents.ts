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

// GET /api/agents — get pool status + all agents
  router.get('/', async (req, res) => {
  try {
    const status = deps.agentPool.getStatus();
    const agents = deps.agentPool.getAgents();
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
    const agent = deps.agentPool.getAgent(req.params.id);
    if (!agent) {
      // Try MongoDB for historical agents
      const record = await deps.AgentModel.findById(req.params.id).lean();
      if (!record) return res.status(404).json({ error: 'Agent not found' });
      return res.json(record);
    }
    res.json(agent.toRecord());
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

  return router;
}

export default createAgentsRouter({
  agentPool,
  AgentModel,
});
