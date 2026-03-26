import { Router } from 'express';
import { CodebaseTopologyModel } from '../db/models.js';
// Will import codebaseMapper and auditEngine when available
import type { TriggerAuditRequest } from 'david-shared';

const router = Router();

// GET /api/topology — get latest codebase topology
router.get('/', async (req, res) => {
  try {
    const topology = await CodebaseTopologyModel.findOne()
      .sort({ mappedAt: -1 })
      .lean();
    if (!topology) return res.json(null);
    res.json(topology);
  } catch (err: any) {
    console.error('[API] GET /topology failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/topology/map — trigger codebase re-mapping
router.post('/map', async (req, res) => {
  try {
    // Lazy import to avoid circular dependencies
    const { codebaseMapper } = await import('../engine/codebase-mapper.js');
    const topologyId = await codebaseMapper.mapCodebase();
    res.json({ topologyId });
  } catch (err: any) {
    console.error('[API] POST /topology/map failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/topology/audit — trigger audit for selected nodes (or all)
router.post('/audit', async (req, res) => {
  try {
    const { nodeIds } = req.body as TriggerAuditRequest;
    const { auditEngine } = await import('../engine/audit-engine.js');

    let auditId: string;
    if (nodeIds && nodeIds.length > 0) {
      auditId = await auditEngine.auditSelectedNodes(nodeIds);
    } else {
      auditId = await auditEngine.runFullAudit();
    }

    res.json({ auditId });
  } catch (err: any) {
    console.error('[API] POST /topology/audit failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/topology/history — get topology mapping history
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const topologies = await CodebaseTopologyModel.find()
      .sort({ mappedAt: -1 })
      .limit(limit)
      .select('mappedAt commitHash fileCount totalLines')
      .lean();
    res.json(topologies);
  } catch (err: any) {
    console.error('[API] GET /topology/history failed:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
