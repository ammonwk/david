import { Router } from 'express';
import { Octokit } from '@octokit/rest';
import { PullRequestModel, BugReportModel, AgentModel } from '../db/models.js';
import { config } from '../config.js';
import { completeWithGeminiFlash } from '../llm/openrouter.js';
import type { LearningMetrics, PipelineItem, PipelineColumn } from 'david-shared';

const router = Router();

// GET /api/prs — get PRs with optional filters
router.get('/', async (req, res) => {
  try {
    const query: any = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.scanType) query.scanType = req.query.scanType;
    if (req.query.agentId) query.agentId = req.query.agentId;

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

// POST /api/prs/backfill — scan GitHub for SRE PRs missing from the database and create records
router.post('/backfill', async (req, res) => {
  const octokit = new Octokit({ auth: config.githubToken });

  try {
    // 1. Fetch all open + closed + merged PRs on sre/* branches
    const [openPRs, closedPRs] = await Promise.all([
      octokit.paginate(octokit.pulls.list, {
        owner: config.githubOwner,
        repo: config.githubRepo,
        state: 'open',
        per_page: 100,
      }),
      octokit.paginate(octokit.pulls.list, {
        owner: config.githubOwner,
        repo: config.githubRepo,
        state: 'closed',
        per_page: 100,
      }),
    ]);

    const allPRs = [...openPRs, ...closedPRs].filter(
      (pr) => pr.head.ref.startsWith('sre/')
    );

    // 2. Find which PR numbers we already track
    const existingPRNumbers = new Set(
      (await PullRequestModel.find({}, { prNumber: 1 }).lean()).map((p) => p.prNumber)
    );

    // 3. Build a lookup: agent branch → agent record
    const agents = await AgentModel.find(
      { branch: { $exists: true, $ne: null } },
      { _id: 1, branch: 1, type: 1, taskId: 1, nodeId: 1 }
    ).lean();
    const agentByBranch = new Map(agents.map((a) => [a.branch, a]));

    // 4. Build a lookup: fixAgentId → bug report
    const bugs = await BugReportModel.find(
      { fixAgentId: { $exists: true, $ne: null } },
    ).lean();
    const bugByFixAgentId = new Map(bugs.map((b) => [b.fixAgentId, b]));

    let created = 0;
    let skipped = 0;
    let synthesized = 0;

    for (const ghPR of allPRs) {
      if (existingPRNumbers.has(ghPR.number)) {
        skipped++;
        continue;
      }

      const branch = ghPR.head.ref;
      const agent = agentByBranch.get(branch);
      let bug = agent ? bugByFixAgentId.get(agent._id) : null;

      // Fetch the diff from GitHub (truncated)
      let diff = '';
      try {
        const { data } = await octokit.pulls.get({
          owner: config.githubOwner,
          repo: config.githubRepo,
          pull_number: ghPR.number,
          mediaType: { format: 'diff' },
        });
        diff = typeof data === 'string' ? (data as string).slice(0, 8192) : '';
      } catch {
        diff = '(diff unavailable)';
      }

      // No matching bug report — use LLM to synthesize one from the PR content
      if (!bug) {
        try {
          const llmResult = await completeWithGeminiFlash(
            [
              {
                role: 'system',
                content: 'You extract structured bug report data from pull requests. Respond with ONLY a JSON object, no markdown fencing.',
              },
              {
                role: 'user',
                content: `Extract a bug report from this PR.

Title: ${ghPR.title}
Branch: ${branch}
Body:
${(ghPR.body || '').slice(0, 3000)}

Diff (first 2KB):
${diff.slice(0, 2048)}

Respond with JSON:
{
  "pattern": "<concise bug description, one sentence>",
  "severity": "low" | "medium" | "high" | "critical",
  "evidence": "<what evidence the PR shows for the bug>",
  "suspectedRootCause": "<root cause from the PR description or diff>",
  "affectedFiles": ["<files changed>"],
  "source": "log-scan" | "codebase-audit"
}`,
              },
            ],
            {
              temperature: 0.1,
              maxTokens: 512,
            },
          );

          const parsed = JSON.parse(llmResult.content);

          const isAudit = branch.includes('audit') || (agent?.type === 'audit');
          const bugDoc = await BugReportModel.create({
            source: isAudit ? 'codebase-audit' : (parsed.source || 'log-scan'),
            scanId: agent?.taskId || `backfill-${ghPR.number}`,
            nodeId: agent?.nodeId,
            pattern: parsed.pattern || ghPR.title.replace(/^\[SRE\]\s*/i, ''),
            severity: parsed.severity || 'medium',
            evidence: parsed.evidence || ghPR.body?.slice(0, 500) || 'Extracted from PR during backfill',
            suspectedRootCause: parsed.suspectedRootCause || 'See PR description',
            affectedFiles: parsed.affectedFiles || [],
            status: 'pr-created',
            fixAgentId: agent?._id,
          });

          bug = bugDoc.toObject() as any;
          synthesized++;
          console.log(`[backfill] Synthesized bug report for PR #${ghPR.number}: ${parsed.pattern}`);
        } catch (err) {
          console.error(`[backfill] LLM synthesis failed for PR #${ghPR.number}:`, err);
          continue;
        }
      }

      const status = ghPR.merged_at ? 'merged' : ghPR.state === 'closed' ? 'closed' : 'open';
      const scanType = agent?.type === 'audit' || bug!.source === 'codebase-audit' ? 'audit' : 'log';

      const prDoc = await PullRequestModel.create({
        prNumber: ghPR.number,
        prUrl: ghPR.html_url,
        title: ghPR.title,
        bugReportId: String(bug!._id),
        agentId: agent?._id || `backfill-${ghPR.number}`,
        branch,
        status,
        resolution: status === 'merged' ? 'accepted' : status === 'closed' ? 'rejected' : undefined,
        scanType,
        nodeId: bug!.nodeId || agent?.nodeId,
        diff,
        description: ghPR.body || '',
        verificationMethod: bug!.verificationResult?.method || 'code-review',
        createdAt: new Date(ghPR.created_at),
        resolvedAt: ghPR.merged_at ? new Date(ghPR.merged_at) : ghPR.closed_at ? new Date(ghPR.closed_at) : undefined,
      });

      // Update bug report with PR link
      await BugReportModel.findByIdAndUpdate(bug!._id, {
        prId: String(prDoc._id),
        status: 'pr-created',
      });

      created++;
    }

    console.log(`[backfill] Done: ${created} created (${synthesized} via LLM), ${skipped} already tracked`);
    res.json({ created, synthesized, skipped, total: allPRs.length });
  } catch (err: any) {
    console.error('[backfill] Failed:', err);
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
