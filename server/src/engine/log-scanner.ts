// ============================================
// David — AI SRE Tool
// Log Scanner Engine
//
// Orchestrates the full log scan pipeline:
//   prefetch (CloudWatch) -> analysis agent -> bug reports -> fix agents
// ============================================

import { randomUUID } from 'crypto';
import { prefetch } from './prefetch.js';
import { agentPool } from '../agents/agent-pool.js';
import { buildLogAnalysisPrompt, buildFixAgentPrompt } from '../agents/prompts.js';
import type { LearningContext } from '../agents/prompts.js';
import { socketManager } from '../ws/socket-manager.js';
import { ScanResultModel, BugReportModel, SREStateModel, CodebaseTopologyModel, PullRequestModel } from '../db/models.js';
import { learningEngine } from '../pr/learning-engine.js';
import { createPR, getPRDiff } from '../pr/pr-manager.js';
import {
  createWorktree,
  createSnapshotWorktree,
  removeWorktreeByPath,
  getBranchName,
  getWorktreePath,
  type WorktreeInfo,
} from '../agents/worktree-manager.js';
import { config } from '../config.js';
import type { ManagedAgent } from '../agents/managed-agent.js';
import type {
  ScanConfig,
  IssueSeverity,
  BugReport,
  BugReportStatus,
  LogPattern,
  ECSMetrics,
  ECSEvent,
} from 'david-shared';

// ============================================
// Constants
// ============================================

const LOG_TAG = '[log-scanner]';

/** Max number of raw events to include in the analysis prompt. */
const MAX_RAW_EVENTS_IN_PROMPT = 200;

/** Max character length for the formatted log data section. */
const MAX_LOG_DATA_CHARS = 80_000;

// ============================================
// Types — Analysis agent output shape
// ============================================

interface AnalysisAgentBugReport {
  pattern: string;
  severity: IssueSeverity;
  evidence: string;
  suspectedRootCause: string;
  affectedFiles: string[];
  source: 'log-scan';
}

interface AnalysisAgentSREStateUpdates {
  newIssues: Array<{
    pattern: string;
    severity: IssueSeverity;
    rootCause?: string;
    affectedFiles?: string[];
  }>;
  updatedIssues: Array<{
    id: string;
    changes: Record<string, unknown>;
  }>;
  resolvedIssueIds: string[];
  baselineUpdates?: Record<string, unknown>;
}

interface AnalysisAgentFix {
  description: string;
  filesChanged: string[];
  commitMessage: string;
  testsPassed: boolean;
}

interface AnalysisAgentOutput {
  bugReports: AnalysisAgentBugReport[];
  sreStateUpdates: AnalysisAgentSREStateUpdates;
  fix: AnalysisAgentFix | null;
  summary: string;
}

// ============================================
// LogScanner
// ============================================

export class LogScanner {
  // ------------------------------------------
  // Run a full log scan
  // ------------------------------------------

  async runScan(scanConfig: ScanConfig, existingScanId?: string): Promise<string> {
    const scanId = existingScanId ?? randomUUID();

    // 1. Create the scan_result document (status: running) — skip if the caller
    //    already created it (e.g. the API route pre-creates it to return scanId immediately).
    if (!existingScanId) {
      try {
        await ScanResultModel.create({
          _id: scanId,
          type: 'log',
          startedAt: new Date(),
          config: scanConfig,
          logPatterns: [],
          newIssues: [],
          updatedIssues: [],
          resolvedIssues: [],
          status: 'running',
        });
      } catch (err) {
        console.error(`${LOG_TAG} Failed to create scan_result document:`, err);
        throw err;
      }
    }

    // 2. Emit scan:started via WebSocket
    socketManager.emitScanStarted({ scanId, config: scanConfig });
    console.log(`${LOG_TAG} Scan ${scanId} started (${scanConfig.timeSpan}, severity: ${scanConfig.severity})`);

    // 3. Run prefetch (CloudWatch query)
    let prefetchResult;
    try {
      prefetchResult = await prefetch(scanConfig.timeSpan, scanConfig.severity);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_TAG} Prefetch failed for scan ${scanId}:`, errorMsg);

      await this.markScanFailed(scanId, scanConfig, `Prefetch failed: ${errorMsg}`);
      return scanId;
    }

    // 4. Update scan_result with prefetch data
    try {
      await ScanResultModel.updateOne(
        { _id: scanId },
        {
          $set: {
            logPatterns: prefetchResult.logPatterns,
            ecsMetrics: prefetchResult.ecsMetrics,
            ecsEvents: prefetchResult.ecsEvents,
          },
        },
      );
    } catch (err) {
      console.error(`${LOG_TAG} Failed to update scan_result with prefetch data:`, err);
      // Non-fatal — continue with the scan
    }

    console.log(
      `${LOG_TAG} Prefetch complete: ${prefetchResult.logPatterns.length} patterns, ` +
      `${prefetchResult.rawLogEvents.length} raw events in ${prefetchResult.queryTimeMs}ms`,
    );

    // If there are zero log events, mark the scan as completed with no findings
    if (prefetchResult.logPatterns.length === 0 && prefetchResult.rawLogEvents.length === 0) {
      console.log(`${LOG_TAG} No log events found — completing scan with no findings`);
      await this.markScanCompleted(scanId, scanConfig, {
        summary: 'No log events found in the configured time window.',
        newIssues: [],
        updatedIssues: [],
        resolvedIssues: [],
      });
      return scanId;
    }

    // 5. Load context for the analysis agent
    let sreState;
    try {
      sreState = await SREStateModel.getOrCreateState();
    } catch (err) {
      console.error(`${LOG_TAG} Failed to load SRE state:`, err);
      await this.markScanFailed(scanId, scanConfig, 'Failed to load SRE state');
      return scanId;
    }

    let topologySummary = 'No codebase topology available yet.';
    try {
      const latestTopology = await CodebaseTopologyModel.getLatest();
      if (latestTopology) {
        // Build a compact summary of L1/L2 nodes for the agent
        const l1Nodes = latestTopology.nodes.filter((n) => n.level === 1);
        const summaryLines = l1Nodes.map((n) => {
          const children = latestTopology.nodes.filter((c) => c.parentId === n.id && c.level === 2);
          const childNames = children.map((c) => c.name).join(', ');
          return `- ${n.name}: ${n.description}${childNames ? ` [${childNames}]` : ''}`;
        });
        topologySummary = summaryLines.join('\n') || topologySummary;
      }
    } catch (err) {
      console.warn(`${LOG_TAG} Failed to load codebase topology:`, err);
      // Non-fatal — continue without topology
    }

    let learning: LearningContext;
    try {
      learning = await learningEngine.getLearningContext({});
    } catch (err) {
      console.warn(`${LOG_TAG} Failed to load learning context:`, err);
      learning = {
        acceptanceRate: 0,
        recentAccepted: [],
        recentRejected: [],
        areaSpecificNotes: 'No learning data available yet.',
      };
    }

    // 6. Create a detached snapshot worktree from the latest remote base branch
    let snapshotWorktree: WorktreeInfo | undefined;
    try {
      snapshotWorktree = await createSnapshotWorktree(`scan-${scanId}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_TAG} Failed to create snapshot worktree for scan ${scanId}:`, errorMsg);
      await this.markScanFailed(scanId, scanConfig, `Failed to create analysis snapshot: ${errorMsg}`);
      return scanId;
    }

    const cleanupSnapshotWorktree = async () => {
      if (!snapshotWorktree) return;
      const pathToRemove = snapshotWorktree.path;
      const branchToRemove = snapshotWorktree.branch;
      snapshotWorktree = undefined;

      try {
        await removeWorktreeByPath(pathToRemove, branchToRemove);
      } catch (err) {
        console.warn(
          `${LOG_TAG} Failed to clean up snapshot worktree ${pathToRemove}:`,
          err instanceof Error ? err.message : err,
        );
      }
    };

    // 7. Build the analysis agent prompt
    const logData = this.formatLogData(prefetchResult.logPatterns, prefetchResult.rawLogEvents);
    const sreStateStr = this.formatSREState(sreState);

    const prompt = buildLogAnalysisPrompt({
      scanConfig,
      logData,
      sreState: sreStateStr,
      topologySummary,
      repoPath: snapshotWorktree.path,
      mongoUri: config.mongodbUri,
      learning,
    });

    // 8. Submit the analysis agent to the pool
    const agentId = randomUUID();
    const taskId = `log-scan-${scanId}`;

    let agent: ManagedAgent;
    try {
      agent = await agentPool.submit({
        id: agentId,
        type: 'log-analysis',
        prompt,
        cwd: snapshotWorktree.path,
        taskId,
        worktreePath: snapshotWorktree.path,
        branch: snapshotWorktree.branch,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_TAG} Failed to submit analysis agent:`, errorMsg);
      await cleanupSnapshotWorktree();
      await this.markScanFailed(scanId, scanConfig, `Failed to submit analysis agent: ${errorMsg}`);
      return scanId;
    }

    socketManager.emitAgentStarted({
      agentId,
      type: 'log-analysis',
      status: 'running',
    });

    // 9. Wire up completion handler
    agent.on('status', async (status) => {
      try {
        if (status === 'completed') {
          try {
            await this.handleAnalysisResult(agent, scanId, scanConfig);
          } catch (err) {
            console.error(`${LOG_TAG} Error handling analysis result for scan ${scanId}:`, err);
            await this.markScanFailed(scanId, scanConfig, 'Failed to process analysis agent result');
          }
        } else if (status === 'failed' || status === 'timeout') {
          console.error(`${LOG_TAG} Analysis agent ${agentId} ${status} for scan ${scanId}`);

          socketManager.emitAgentFailed({
            agentId,
            type: 'log-analysis',
            status,
          });

          await this.markScanFailed(scanId, scanConfig, `Analysis agent ${status}`);
        }
      } finally {
        await cleanupSnapshotWorktree();
      }
    });

    // Forward agent output events to WebSocket
    agent.on('output', (line: string) => {
      socketManager.broadcastAgentOutput(agentId, line);
    });

    // 12. Return the scan ID immediately — the agent runs asynchronously
    return scanId;
  }

  // ------------------------------------------
  // Queue a fix agent for a specific bug
  // ------------------------------------------

  async queueFixAgent(bugReportId: string): Promise<void> {
    // 1. Load the bug report from MongoDB
    const bugReport = await BugReportModel.findById(bugReportId);
    if (!bugReport) {
      throw new Error(`Bug report ${bugReportId} not found`);
    }

    // 2. Create a worktree for the fix
    let worktreeInfo;
    try {
      worktreeInfo = await createWorktree(bugReportId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_TAG} Failed to create worktree for bug ${bugReportId}:`, errorMsg);
      throw err;
    }

    // 3. Load learning context
    let learning: LearningContext;
    try {
      const filePatterns = bugReport.affectedFiles.map((f: string) => {
        const parts = f.split('/');
        return parts.length > 1 ? parts.slice(0, -1).join('/') + '/**' : '**';
      });
      learning = await learningEngine.getLearningContext({ filePatterns });
    } catch (err) {
      console.warn(`${LOG_TAG} Failed to load learning context for fix agent:`, err);
      learning = {
        acceptanceRate: 0,
        recentAccepted: [],
        recentRejected: [],
        areaSpecificNotes: 'No learning data available yet.',
      };
    }

    // 4. Build the fix agent prompt
    const prompt = buildFixAgentPrompt({
      bugDescription: `${bugReport.pattern}\n\nSuspected root cause: ${bugReport.suspectedRootCause}`,
      verificationDetails: bugReport.verificationResult
        ? `Method: ${bugReport.verificationResult.method}\nConfirmed: ${bugReport.verificationResult.confirmed}\nDetails: ${bugReport.verificationResult.details}`
        : 'No verification performed yet — the bug was identified during log analysis.',
      affectedFiles: bugReport.affectedFiles,
      repoPath: worktreeInfo.path,
      learning,
    });

    // 5. Submit to agent pool
    const agentId = randomUUID();
    const taskId = `fix-${bugReportId}`;

    // Update bug report status
    await BugReportModel.updateOne(
      { _id: bugReportId },
      { $set: { status: 'fixing' as BugReportStatus, fixAgentId: agentId } },
    );

    const agent = await agentPool.submit({
      id: agentId,
      type: 'fix',
      prompt,
      cwd: worktreeInfo.path,
      taskId,
      worktreePath: worktreeInfo.path,
      branch: worktreeInfo.branch,
    });

    socketManager.emitAgentStarted({
      agentId,
      type: 'fix',
      status: 'running',
    });

    // Wire up completion handler
    agent.on('status', async (status) => {
      if (status === 'completed') {
        try {
          await this.handleFixResult(agent, bugReportId);
        } catch (err) {
          console.error(`${LOG_TAG} Error handling fix result for bug ${bugReportId}:`, err);
        }
      } else if (status === 'failed' || status === 'timeout') {
        console.error(`${LOG_TAG} Fix agent ${agentId} ${status} for bug ${bugReportId}`);
        await BugReportModel.updateOne(
          { _id: bugReportId },
          { $set: { status: 'verified' as BugReportStatus } },
        );
        socketManager.emitAgentFailed({
          agentId,
          type: 'fix',
          status,
        });
      }
    });

    agent.on('output', (line: string) => {
      socketManager.broadcastAgentOutput(agentId, line);
    });

    console.log(`${LOG_TAG} Fix agent ${agentId} queued for bug ${bugReportId} in worktree ${worktreeInfo.path}`);
  }

  // ------------------------------------------
  // Format log data for the analysis prompt
  // ------------------------------------------

  private formatLogData(
    patterns: LogPattern[],
    rawEvents: Array<{ timestamp: string; message: string; logStream: string }>,
  ): string {
    const lines: string[] = [];

    // Pattern summaries
    lines.push('### Log Pattern Summary');
    lines.push('');
    lines.push(`Total unique patterns: ${patterns.length}`);
    lines.push(`Total raw events: ${rawEvents.length}`);
    lines.push('');

    if (patterns.length > 0) {
      lines.push('| # | Count | Level | Pattern (truncated) | First Seen | Last Seen |');
      lines.push('|---|-------|-------|---------------------|------------|-----------|');

      for (let i = 0; i < patterns.length; i++) {
        const p = patterns[i];
        const truncatedMsg = p.message.length > 100
          ? p.message.slice(0, 100) + '...'
          : p.message;
        const first = p.firstOccurrence instanceof Date
          ? p.firstOccurrence.toISOString()
          : String(p.firstOccurrence);
        const last = p.lastOccurrence instanceof Date
          ? p.lastOccurrence.toISOString()
          : String(p.lastOccurrence);

        lines.push(`| ${i + 1} | ${p.count} | ${p.level} | ${truncatedMsg} | ${first} | ${last} |`);
      }
      lines.push('');
    }

    // Sample raw events (capped to avoid prompt bloat)
    const sampleCount = Math.min(rawEvents.length, MAX_RAW_EVENTS_IN_PROMPT);
    if (sampleCount > 0) {
      lines.push(`### Sample Raw Events (${sampleCount} of ${rawEvents.length})`);
      lines.push('');

      for (let i = 0; i < sampleCount; i++) {
        const evt = rawEvents[i];
        lines.push(`**[${evt.timestamp}] (${evt.logStream})**`);
        lines.push('```');
        lines.push(evt.message);
        lines.push('```');
        lines.push('');
      }
    }

    // Truncate if the total text is too large
    const result = lines.join('\n');
    if (result.length > MAX_LOG_DATA_CHARS) {
      return result.slice(0, MAX_LOG_DATA_CHARS) + '\n\n... [log data truncated] ...';
    }

    return result;
  }

  // ------------------------------------------
  // Format SRE state for the analysis prompt
  // ------------------------------------------

  private formatSREState(state: any): string {
    try {
      // Extract the relevant fields, omitting Mongoose internals
      const plain = {
        knownIssues: state.knownIssues ?? [],
        baselines: state.baselines ?? {},
        resolvedIssues: state.resolvedIssues ?? [],
      };
      return JSON.stringify(plain, null, 2);
    } catch {
      return '{}';
    }
  }

  // ------------------------------------------
  // Handle analysis agent completion
  // ------------------------------------------

  private async handleAnalysisResult(
    agent: ManagedAgent,
    scanId: string,
    scanConfig: ScanConfig,
  ): Promise<void> {
    const agentRecord = agent.toRecord();
    const agentId = agent.id;

    socketManager.emitAgentCompleted({
      agentId,
      type: 'log-analysis',
      status: 'completed',
    });

    // Parse the agent's structured output
    const output = this.parseAnalysisOutput(agent);

    if (!output) {
      console.warn(`${LOG_TAG} Analysis agent ${agentId} produced no parseable output`);
      await this.markScanCompleted(scanId, scanConfig, {
        summary: agentRecord.result?.summary ?? 'Analysis agent completed but produced no structured output.',
        newIssues: [],
        updatedIssues: [],
        resolvedIssues: [],
      });
      return;
    }

    // Create bug_report documents for each new bug
    const newBugIds: string[] = [];
    for (const bug of output.bugReports) {
      try {
        const bugDoc = await BugReportModel.create({
          source: 'log-scan',
          scanId,
          pattern: bug.pattern,
          severity: bug.severity,
          evidence: bug.evidence,
          suspectedRootCause: bug.suspectedRootCause,
          affectedFiles: bug.affectedFiles ?? [],
          status: 'reported' as BugReportStatus,
        });

        const bugId = String(bugDoc._id);
        newBugIds.push(bugId);

        socketManager.emitBugReported({
          bugId,
          pattern: bug.pattern,
          severity: bug.severity,
          status: 'reported',
        });

        console.log(`${LOG_TAG} Bug report created: ${bugId} (${bug.severity}) — ${bug.pattern}`);
      } catch (err) {
        console.error(`${LOG_TAG} Failed to create bug report:`, err);
      }
    }

    // Apply SRE state updates
    const updatedIssueIds: string[] = [];
    const resolvedIssueIds: string[] = [];

    if (output.sreStateUpdates) {
      try {
        const sreState = await SREStateModel.getOrCreateState();

        // Add new issues to knownIssues
        if (output.sreStateUpdates.newIssues?.length > 0) {
          for (const issue of output.sreStateUpdates.newIssues) {
            const issueId = randomUUID();
            sreState.knownIssues.push({
              id: issueId,
              pattern: issue.pattern,
              severity: issue.severity,
              firstSeen: new Date(),
              lastSeen: new Date(),
              status: 'active',
              rootCause: issue.rootCause,
              affectedFiles: issue.affectedFiles ?? [],
              relatedPrIds: [],
            });
          }
        }

        // Update existing issues
        if (output.sreStateUpdates.updatedIssues?.length > 0) {
          for (const update of output.sreStateUpdates.updatedIssues) {
            const existing = sreState.knownIssues.find((i: any) => i.id === update.id);
            if (existing) {
              Object.assign(existing, update.changes, { lastSeen: new Date() });
              updatedIssueIds.push(update.id);
            }
          }
        }

        // Resolve issues
        if (output.sreStateUpdates.resolvedIssueIds?.length > 0) {
          for (const resolvedId of output.sreStateUpdates.resolvedIssueIds) {
            const idx = sreState.knownIssues.findIndex((i: any) => i.id === resolvedId);
            if (idx !== -1) {
              const resolved = sreState.knownIssues[idx];
              resolved.status = 'resolved';
              resolved.lastSeen = new Date();

              // Move to resolvedIssues
              sreState.resolvedIssues.push(resolved);
              sreState.knownIssues.splice(idx, 1);
              resolvedIssueIds.push(resolvedId);
            }
          }
        }

        // Apply baseline updates
        if (output.sreStateUpdates.baselineUpdates && Object.keys(output.sreStateUpdates.baselineUpdates).length > 0) {
          Object.assign(sreState.baselines, output.sreStateUpdates.baselineUpdates, {
            lastUpdated: new Date(),
          });
        }

        await sreState.save();
        console.log(
          `${LOG_TAG} SRE state updated: ${output.sreStateUpdates.newIssues?.length ?? 0} new, ` +
          `${updatedIssueIds.length} updated, ${resolvedIssueIds.length} resolved`,
        );
      } catch (err) {
        console.error(`${LOG_TAG} Failed to update SRE state:`, err);
      }
    }

    // Update the scan_result document with findings
    await this.markScanCompleted(scanId, scanConfig, {
      summary: output.summary,
      newIssues: newBugIds,
      updatedIssues: updatedIssueIds,
      resolvedIssues: resolvedIssueIds,
    });

    // 9. Queue fix agents for new bug reports
    //    Per spec 10.1: the analysis agent may have already made 0 or 1 PRs directly.
    //    Only queue fix agents for bugs that don't already have a fix from the analysis agent.
    const fixedPattern = output.fix?.description;

    for (const bugId of newBugIds) {
      try {
        const bugDoc = await BugReportModel.findById(bugId);
        if (!bugDoc) continue;

        // Skip if the analysis agent already fixed this bug (match by pattern similarity)
        if (fixedPattern && bugDoc.pattern.includes(fixedPattern.slice(0, 50))) {
          console.log(`${LOG_TAG} Skipping fix agent for bug ${bugId} — already fixed by analysis agent`);
          await BugReportModel.updateOne(
            { _id: bugId },
            { $set: { status: 'fixed' as BugReportStatus } },
          );
          continue;
        }

        // Only queue fix agents for medium+ severity bugs
        if (bugDoc.severity === 'low') {
          console.log(`${LOG_TAG} Skipping fix agent for low-severity bug ${bugId}`);
          continue;
        }

        await this.queueFixAgent(bugId);
      } catch (err) {
        console.error(`${LOG_TAG} Failed to queue fix agent for bug ${bugId}:`, err);
        // Non-fatal — continue with other bugs
      }
    }
  }

  // ------------------------------------------
  // Handle fix agent completion
  // ------------------------------------------

  private async handleFixResult(agent: ManagedAgent, bugReportId: string): Promise<void> {
    const agentRecord = agent.toRecord();

    socketManager.emitAgentCompleted({
      agentId: agent.id,
      type: 'fix',
      status: 'completed',
    });

    // Parse the fix agent's structured output from the result
    const result = agentRecord.result;
    if (!result) {
      console.warn(`${LOG_TAG} Fix agent ${agent.id} completed without structured result`);
      return;
    }

    // Check if the agent actually made a fix (the result summary should indicate)
    const fixApplied = (result.fixesApplied ?? 0) > 0;

    if (fixApplied) {
      await BugReportModel.updateOne(
        { _id: bugReportId },
        { $set: { status: 'fixed' as BugReportStatus } },
      );

      // Load the bug report to emit the event
      const bugReport = await BugReportModel.findById(bugReportId);
      if (bugReport) {
        socketManager.emitBugFixed({
          bugId: bugReportId,
          pattern: bugReport.pattern,
          severity: bugReport.severity,
          status: 'fixed',
        });
      }

      // Create a PR for the fix if the agent was in a worktree with a branch
      const worktreePath = agent.worktreePath;
      const branch = agent.branch;

      if (worktreePath && branch && bugReport) {
        try {
          const diff = await getPRDiff(worktreePath);
          const title = `[SRE] Fix: ${bugReport.pattern.slice(0, 60)}`;
          const description = [
            '## Bug Summary',
            '',
            `**Pattern:** ${bugReport.pattern}`,
            `**Severity:** ${bugReport.severity}`,
            `**Root Cause:** ${bugReport.suspectedRootCause ?? 'N/A'}`,
            '',
            '## Fix',
            '',
            result.summary ?? 'Automated fix applied by David SRE.',
          ].join('\n');

          const prResult = await createPR({
            bugId: bugReportId,
            bugReport: { ...bugReport.toObject(), _id: String(bugReport._id) } as BugReport,
            worktreePath,
            branch,
            title,
            description,
            diff,
            verificationMethod: 'log-scan',
          });

          // Store the PR record in MongoDB
          const prDoc = await PullRequestModel.create({
            prNumber: prResult.prNumber,
            prUrl: prResult.prUrl,
            title,
            bugReportId,
            agentId: agent.id,
            branch: prResult.branch,
            status: 'open',
            scanType: 'log',
            diff,
            description,
            verificationMethod: bugReport.verificationResult?.method ?? 'code-review',
            createdAt: new Date(),
          });

          const prId = String(prDoc._id);

          // Update bug report with PR reference and status
          await BugReportModel.updateOne(
            { _id: bugReportId },
            { $set: { prId, status: 'pr-created' as BugReportStatus } },
          );

          socketManager.emitPRCreated({
            prId,
            prNumber: prResult.prNumber,
            prUrl: prResult.prUrl,
            title,
            status: 'open',
          });

          console.log(`${LOG_TAG} PR #${prResult.prNumber} created for bug ${bugReportId}`);
        } catch (err) {
          console.error(`${LOG_TAG} Failed to create PR for bug ${bugReportId}:`, err);
          // Non-fatal — the fix is still applied in the worktree
        }
      }

      console.log(`${LOG_TAG} Fix agent ${agent.id} applied fix for bug ${bugReportId}`);
    } else {
      // Agent completed but did not apply a fix — revert status to verified
      await BugReportModel.updateOne(
        { _id: bugReportId },
        { $set: { status: 'verified' as BugReportStatus } },
      );

      console.log(`${LOG_TAG} Fix agent ${agent.id} completed without applying a fix for bug ${bugReportId}`);
    }
  }

  // ------------------------------------------
  // Parse analysis agent output
  // ------------------------------------------

  private parseAnalysisOutput(agent: ManagedAgent): AnalysisAgentOutput | null {
    const outputLog = agent.getOutputLog();
    if (outputLog.length === 0) return null;

    // Scan the last portion of output for the JSON result
    const tail = outputLog.slice(-100);
    const joined = tail.join('\n');

    // Strategy 1: Look for fenced JSON
    const fencedMatch = joined.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    if (fencedMatch) {
      const parsed = this.tryParseAnalysisOutput(fencedMatch[1]);
      if (parsed) return parsed;
    }

    // Strategy 2: Find the last JSON block by brace matching
    let braceDepth = 0;
    let braceEnd = -1;
    let braceStart = -1;

    for (let i = joined.length - 1; i >= 0; i--) {
      if (joined[i] === '}') {
        if (braceEnd === -1) braceEnd = i;
        braceDepth++;
      } else if (joined[i] === '{') {
        braceDepth--;
        if (braceDepth === 0 && braceEnd !== -1) {
          braceStart = i;
          break;
        }
      }
    }

    if (braceStart !== -1 && braceEnd !== -1) {
      const candidate = joined.slice(braceStart, braceEnd + 1);
      const parsed = this.tryParseAnalysisOutput(candidate);
      if (parsed) return parsed;
    }

    // Strategy 3: Use the agent's result if available (may be a summary-only result)
    const record = agent.toRecord();
    if (record.result?.summary) {
      return {
        bugReports: [],
        sreStateUpdates: { newIssues: [], updatedIssues: [], resolvedIssueIds: [] },
        fix: null,
        summary: record.result.summary,
      };
    }

    return null;
  }

  private tryParseAnalysisOutput(raw: string): AnalysisAgentOutput | null {
    try {
      const obj = JSON.parse(raw);
      if (typeof obj !== 'object' || obj === null) return null;
      if (typeof obj.summary !== 'string') return null;

      return {
        bugReports: Array.isArray(obj.bugReports) ? obj.bugReports : [],
        sreStateUpdates: obj.sreStateUpdates ?? {
          newIssues: [],
          updatedIssues: [],
          resolvedIssueIds: [],
        },
        fix: obj.fix ?? null,
        summary: obj.summary,
      };
    } catch {
      return null;
    }
  }

  // ------------------------------------------
  // Scan status helpers
  // ------------------------------------------

  private async markScanFailed(
    scanId: string,
    scanConfig: ScanConfig,
    error: string,
  ): Promise<void> {
    try {
      await ScanResultModel.updateOne(
        { _id: scanId },
        { $set: { status: 'failed', error, completedAt: new Date() } },
      );
    } catch (err) {
      console.error(`${LOG_TAG} Failed to mark scan ${scanId} as failed:`, err);
    }

    socketManager.emitScanFailed({ scanId, config: scanConfig, error });
    console.log(`${LOG_TAG} Scan ${scanId} failed: ${error}`);
  }

  private async markScanCompleted(
    scanId: string,
    scanConfig: ScanConfig,
    results: {
      summary: string;
      newIssues: string[];
      updatedIssues: string[];
      resolvedIssues: string[];
    },
  ): Promise<void> {
    try {
      await ScanResultModel.updateOne(
        { _id: scanId },
        {
          $set: {
            status: 'completed',
            completedAt: new Date(),
            summary: results.summary,
            newIssues: results.newIssues,
            updatedIssues: results.updatedIssues,
            resolvedIssues: results.resolvedIssues,
          },
        },
      );
    } catch (err) {
      console.error(`${LOG_TAG} Failed to mark scan ${scanId} as completed:`, err);
    }

    socketManager.emitScanCompleted({ scanId, config: scanConfig });
    console.log(
      `${LOG_TAG} Scan ${scanId} completed: ${results.newIssues.length} new, ` +
      `${results.updatedIssues.length} updated, ${results.resolvedIssues.length} resolved`,
    );
  }
}

// ============================================
// Singleton
// ============================================

export const logScanner = new LogScanner();
