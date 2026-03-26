// ============================================
// David — AI SRE Tool
// API Routes — SRE State and Dashboard Overview
// ============================================

import { Router } from 'express';
import {
  SREStateModel,
  ScanResultModel,
  BugReportModel,
  AgentModel,
  PullRequestModel,
} from '../db/models.js';
import type {
  OverviewStats,
  UpdateRuntimeSettingsRequest,
} from 'david-shared';
import {
  getRuntimeSettings,
  updateRuntimeSettings,
} from '../runtime/runtime-settings.js';

const router = Router();

// GET /api/state — get current SRE state
router.get('/', async (_req, res) => {
  try {
    const state = await SREStateModel.getOrCreateState();
    res.json(state);
  } catch (err) {
    console.error('[API] GET /state failed:', err);
    res.status(500).json({ error: 'Failed to fetch SRE state' });
  }
});

// GET /api/state/overview — get overview stats for the dashboard
// NOTE: This must be defined before any parameterized routes on this router
router.get('/overview', async (_req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const [
      bugsToday,
      prsToday,
      prsAccepted,
      activeAgents,
      queuedAgents,
      lastScan,
      lastAudit,
      runtimeSettings,
    ] =
      await Promise.all([
        BugReportModel.countDocuments({ createdAt: { $gte: todayStart } }),
        PullRequestModel.countDocuments({ createdAt: { $gte: todayStart } }),
        PullRequestModel.countDocuments({
          resolution: 'accepted',
          resolvedAt: { $gte: weekStart },
        }),
        AgentModel.countDocuments({ status: { $in: ['running', 'starting'] } }),
        AgentModel.countDocuments({ status: 'queued' }),
        ScanResultModel.findOne({ type: 'log' })
          .sort({ startedAt: -1 })
          .select('startedAt')
          .lean(),
        ScanResultModel.findOne({ type: 'audit' })
          .sort({ startedAt: -1 })
          .select('startedAt')
          .lean(),
        getRuntimeSettings(),
      ]);

    const stats: OverviewStats = {
      bugsFoundToday: bugsToday,
      prsCreatedToday: prsToday,
      prsAcceptedThisWeek: prsAccepted,
      activeAgents,
      queuedAgents,
      lastScanAt: lastScan?.startedAt,
      lastAuditAt: lastAudit?.startedAt,
      systemStatus: 'running', // TODO: derive from actual system state
      cliBackend: runtimeSettings.cliBackend,
    };

    res.json(stats);
  } catch (err) {
    console.error('[API] GET /state/overview failed:', err);
    res.status(500).json({ error: 'Failed to fetch overview stats' });
  }
});

// GET /api/state/runtime — get current runtime settings
router.get('/runtime', async (_req, res) => {
  try {
    const settings = await getRuntimeSettings();
    res.json(settings);
  } catch (err) {
    console.error('[API] GET /state/runtime failed:', err);
    res.status(500).json({ error: 'Failed to fetch runtime settings' });
  }
});

// PUT /api/state/runtime — update runtime settings
router.put('/runtime', async (req, res) => {
  try {
    const { cliBackend } = req.body as Partial<UpdateRuntimeSettingsRequest>;

    if (cliBackend !== 'claude' && cliBackend !== 'codex') {
      res.status(400).json({ error: 'cliBackend must be "claude" or "codex"' });
      return;
    }

    const settings = await updateRuntimeSettings(cliBackend);
    res.json(settings);
  } catch (err) {
    console.error('[API] PUT /state/runtime failed:', err);
    res.status(500).json({ error: 'Failed to update runtime settings' });
  }
});

// PUT /api/state — update SRE state
router.put('/', async (req, res) => {
  try {
    const state = await SREStateModel.findOneAndUpdate(
      { _id: 'singleton' },
      req.body,
      { new: true, upsert: true },
    );
    res.json(state);
  } catch (err) {
    console.error('[API] PUT /state failed:', err);
    res.status(500).json({ error: 'Failed to update SRE state' });
  }
});

export default router;
