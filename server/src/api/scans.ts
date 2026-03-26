// ============================================
// David — AI SRE Tool
// API Routes — Scans, Schedule, and Bug Reports
// ============================================

import crypto from 'crypto';
import { Router } from 'express';
import { ScanResultModel, SREStateModel, BugReportModel } from '../db/models.js';
import { scheduler } from '../engine/scheduler.js';
import { logScanner } from '../engine/log-scanner.js';
import type { TriggerScanRequest, UpdateScheduleRequest } from 'david-shared';

const router = Router();

// POST /api/scans/trigger — trigger an on-demand scan
router.post('/trigger', async (req, res) => {
  try {
    const { timeSpan, severity } = req.body as TriggerScanRequest;

    // Create a scan_result document first so we have a scanId to return immediately.
    // Then kick off the full pipeline (prefetch -> analysis -> fix) in the background.
    const scanId = crypto.randomUUID();

    const scan = await ScanResultModel.create({
      _id: scanId,
      type: 'log',
      startedAt: new Date(),
      config: { timeSpan, severity },
      status: 'running',
      logPatterns: [],
      newIssues: [],
      updatedIssues: [],
      resolvedIssues: [],
    });

    // Fire off the pipeline without awaiting — the client polls for progress.
    logScanner.runScan({ timeSpan, severity }, scanId).catch((err) => {
      console.error('[API] Background scan pipeline error:', err);
    });

    res.status(201).json({ scanId: scan._id });
  } catch (err) {
    console.error('[API] POST /scans/trigger failed:', err);
    res.status(500).json({ error: 'Failed to trigger scan' });
  }
});

// GET /api/scans/schedule/status — get current schedule status
// NOTE: This must be defined before the /:id route to avoid matching "schedule" as an ID
router.get('/schedule/status', async (_req, res) => {
  try {
    const status = scheduler.getStatus();
    res.json(status);
  } catch (err) {
    console.error('[API] GET /scans/schedule/status failed:', err);
    res.status(500).json({ error: 'Failed to get schedule status' });
  }
});

// GET /api/scans/schedule — legacy/dashboard-compatible schedule status route
router.get('/schedule', async (_req, res) => {
  try {
    res.json(scheduler.getStatus());
  } catch (err) {
    console.error('[API] GET /scans/schedule failed:', err);
    res.status(500).json({ error: 'Failed to get schedule status' });
  }
});

// PUT /api/scans/schedule — update schedule config
router.put('/schedule', async (req, res) => {
  try {
    const updates = req.body as UpdateScheduleRequest;
    if (updates.scan) scheduler.updateScanConfig(updates.scan);
    if (updates.audit) scheduler.updateAuditConfig(updates.audit);
    res.json(scheduler.getStatus());
  } catch (err) {
    console.error('[API] PUT /scans/schedule failed:', err);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// GET /api/scans/bugs — get bug reports with optional filters
router.get('/bugs', async (req, res) => {
  try {
    const query: Record<string, string> = {};
    if (req.query.status) query.status = req.query.status as string;
    if (req.query.source) query.source = req.query.source as string;
    if (req.query.severity) query.severity = req.query.severity as string;

    const bugs = await BugReportModel.find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(bugs);
  } catch (err) {
    console.error('[API] GET /scans/bugs failed:', err);
    res.status(500).json({ error: 'Failed to fetch bug reports' });
  }
});

// GET /api/scans — get scan history
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const scans = await ScanResultModel.find()
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();
    res.json(scans);
  } catch (err) {
    console.error('[API] GET /scans failed:', err);
    res.status(500).json({ error: 'Failed to fetch scans' });
  }
});

// GET /api/scans/:id — get a specific scan
router.get('/:id', async (req, res) => {
  try {
    const scan = await ScanResultModel.findById(req.params.id).lean();
    if (!scan) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }
    res.json(scan);
  } catch (err) {
    console.error('[API] GET /scans/:id failed:', err);
    res.status(500).json({ error: 'Failed to fetch scan' });
  }
});

export default router;
