// ============================================
// David — AI SRE Tool
// API Routes — SRE State and Dashboard Overview
// ============================================

import { Router } from 'express';
import mongoose from 'mongoose';
import {
  SREStateModel,
  ScanResultModel,
  BugReportModel,
  AgentModel,
  PullRequestModel,
} from '../db/models.js';
import type {
  OverviewStats,
  HealthVitals,
  VitalsTimeframe,
  UpdateRuntimeSettingsRequest,
} from 'david-shared';
import {
  getRuntimeSettings,
  updateRuntimeSettings,
} from '../runtime/runtime-settings.js';

interface StateRouterDeps {
  SREStateModel: typeof SREStateModel;
  ScanResultModel: typeof ScanResultModel;
  BugReportModel: typeof BugReportModel;
  AgentModel: typeof AgentModel;
  PullRequestModel: typeof PullRequestModel;
  getRuntimeSettings: typeof getRuntimeSettings;
  updateRuntimeSettings: typeof updateRuntimeSettings;
}

export function createStateRouter(deps: StateRouterDeps) {
  const router = Router();

// GET /api/state — get current SRE state
  router.get('/', async (_req, res) => {
  try {
    const state = await deps.SREStateModel.getOrCreateState();
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
        deps.BugReportModel.countDocuments({ createdAt: { $gte: todayStart } }),
        deps.PullRequestModel.countDocuments({ createdAt: { $gte: todayStart } }),
        deps.PullRequestModel.countDocuments({
          resolution: 'accepted',
          resolvedAt: { $gte: weekStart },
        }),
        deps.AgentModel.countDocuments({ status: { $in: ['running', 'starting'] } }),
        deps.AgentModel.countDocuments({ status: 'queued' }),
        deps.ScanResultModel.findOne({ type: 'log' })
          .sort({ startedAt: -1 })
          .select('startedAt')
          .lean(),
        deps.ScanResultModel.findOne({ type: 'audit' })
          .sort({ startedAt: -1 })
          .select('startedAt')
          .lean(),
        deps.getRuntimeSettings(),
      ]);

    const stats: OverviewStats = {
      bugsFoundToday: bugsToday,
      prsCreatedToday: prsToday,
      prsAcceptedThisWeek: prsAccepted,
      activeAgents,
      queuedAgents,
      lastScanAt: lastScan?.startedAt,
      lastAuditAt: lastAudit?.startedAt,
      systemStatus: mongoose.connection.readyState === 1 ? 'running' : 'error',
      cliBackend: runtimeSettings.cliBackend,
    };

    res.json(stats);
  } catch (err) {
    console.error('[API] GET /state/overview failed:', err);
    res.status(500).json({ error: 'Failed to fetch overview stats' });
  }
  });

// GET /api/state/vitals — time-series data for health vitals charts
  router.get('/vitals', async (req, res) => {
    try {
      const timeframe = (req.query.timeframe as string) || '24h';
      const VALID: string[] = ['5m', '60m', '24h', '1w'];
      if (!VALID.includes(timeframe)) {
        res.status(400).json({ error: 'Invalid timeframe. Use 5m, 60m, 24h, or 1w.' });
        return;
      }

      const now = new Date();
      let windowMs: number;
      let bucketMs: number;

      switch (timeframe) {
        case '5m':  windowMs = 5 * 60_000;      bucketMs = 60_000;       break;
        case '60m': windowMs = 60 * 60_000;      bucketMs = 5 * 60_000;   break;
        case '1w':  windowMs = 7 * 86_400_000;   bucketMs = 86_400_000;   break;
        default:    windowMs = 24 * 3_600_000;    bucketMs = 3_600_000;    break;
      }

      const windowStart = new Date(now.getTime() - windowMs);

      // Aggregation pipeline: bucket documents by truncating dateField to bucketMs
      function pipeline(dateField: string, extraMatch: Record<string, unknown> = {}) {
        return [
          { $match: { [dateField]: { $gte: windowStart }, ...extraMatch } },
          {
            $group: {
              _id: {
                $toDate: {
                  $subtract: [
                    { $toLong: `$${dateField}` },
                    { $mod: [{ $toLong: `$${dateField}` }, bucketMs] },
                  ],
                },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 as const } },
        ];
      }

      const [bugBuckets, agentBuckets, queueBuckets, prBuckets] = await Promise.all([
        deps.BugReportModel.aggregate(pipeline('createdAt')),
        deps.AgentModel.aggregate(pipeline('startedAt')),
        deps.AgentModel.aggregate(pipeline('createdAt')),
        deps.PullRequestModel.aggregate(pipeline('resolvedAt', { resolution: 'accepted' })),
      ]);

      // Fill all expected time buckets (including zeros for gaps)
      function fill(data: Array<{ _id: Date; count: number }>) {
        const map = new Map(data.map(d => [new Date(d._id).getTime(), d.count]));
        const first = Math.floor(windowStart.getTime() / bucketMs) * bucketMs;
        const last = Math.floor(now.getTime() / bucketMs) * bucketMs;
        const points: Array<{ timestamp: string; value: number }> = [];
        for (let t = first; t <= last; t += bucketMs) {
          points.push({ timestamp: new Date(t).toISOString(), value: map.get(t) || 0 });
        }
        return points;
      }

      const result: HealthVitals = {
        errorRate: fill(bugBuckets),
        agentThroughput: fill(agentBuckets),
        queueDepth: fill(queueBuckets),
        prAcceptance: fill(prBuckets),
        timeframe: timeframe as VitalsTimeframe,
      };

      res.json(result);
    } catch (err) {
      console.error('[API] GET /state/vitals failed:', err);
      res.status(500).json({ error: 'Failed to fetch health vitals data' });
    }
  });

// GET /api/state/runtime — get current runtime settings
  router.get('/runtime', async (_req, res) => {
  try {
    const settings = await deps.getRuntimeSettings();
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

    const settings = await deps.updateRuntimeSettings(cliBackend);
    res.json(settings);
  } catch (err) {
    console.error('[API] PUT /state/runtime failed:', err);
    res.status(500).json({ error: 'Failed to update runtime settings' });
  }
  });

// PUT /api/state — update SRE state
  router.put('/', async (req, res) => {
    try {
      const state = await deps.SREStateModel.findOneAndUpdate(
        {},
        req.body,
        { new: true, upsert: true },
      );
      res.json(state);
    } catch (err) {
      console.error('[API] PUT /state failed:', err);
    res.status(500).json({ error: 'Failed to update SRE state' });
  }
  });

  return router;
}

export default createStateRouter({
  SREStateModel,
  ScanResultModel,
  BugReportModel,
  AgentModel,
  PullRequestModel,
  getRuntimeSettings,
  updateRuntimeSettings,
});
