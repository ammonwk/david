import { Router } from 'express';
import { PullRequestModel, BugReportModel } from '../db/models.js';
// Will import learningEngine when available
import type { LearningMetrics, PipelineItem, PipelineColumn } from 'david-shared';

const router = Router();

// GET /api/prs — get PRs with optional filters
router.get('/', async (req, res) => {
  try {
    const query: any = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.scanType) query.scanType = req.query.scanType;

    const prs = await PullRequestModel.find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(prs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prs/pipeline — get pipeline items for Kanban board
router.get('/pipeline', async (req, res) => {
  try {
    // Get all active bug reports and their associated PRs
    const bugs = await BugReportModel.find({
      status: { $ne: 'wont-fix' }
    }).sort({ createdAt: -1 }).lean();

    const prs = await PullRequestModel.find().sort({ createdAt: -1 }).lean();
    const prByBugId = new Map(prs.map(pr => [pr.bugReportId?.toString(), pr]));

    // Map each bug to a pipeline column
    const items: PipelineItem[] = bugs.map(bug => {
      const pr = prByBugId.get(bug._id?.toString());

      let column: PipelineColumn;
      if (pr?.status === 'merged') column = 'merged';
      else if (pr?.status === 'closed') column = 'closed';
      else if (pr?.status === 'open') column = 'pr-open';
      else if (bug.status === 'fixing' || bug.status === 'fixed') column = 'fixing';
      else if (bug.status === 'verifying' || bug.status === 'verified') column = 'verifying';
      else column = 'reported';

      return {
        id: bug._id?.toString() || '',
        column,
        bugReport: bug as any,
        pr: pr as any,
        agentIds: bug.fixAgentId ? [bug.fixAgentId] : [],
        area: bug.nodeId || undefined,
        diffStat: pr?.diff ? countDiffStats(pr.diff) : undefined,
      };
    });

    res.json(items);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prs/learning — get learning metrics
router.get('/learning', async (req, res) => {
  try {
    const { learningEngine } = await import('../pr/learning-engine.js');
    const metrics = await learningEngine.getMetrics();
    res.json(metrics);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prs/:id — get a specific PR
router.get('/:id', async (req, res) => {
  try {
    const pr = await PullRequestModel.findById(req.params.id).lean();
    if (!pr) return res.status(404).json({ error: 'PR not found' });
    res.json(pr);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: count additions/deletions from a diff string
function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export default router;
