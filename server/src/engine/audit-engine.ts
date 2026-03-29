import { execSync } from 'child_process';
import { agentPool } from '../agents/agent-pool.js';
import { renderPrompt, formatLearningContext } from '../agents/prompt-templates.js';
import { socketManager } from '../ws/socket-manager.js';
import { CodebaseTopologyModel, BugReportModel, PullRequestModel, SREStateModel } from '../db/models.js';
import { learningEngine } from '../pr/learning-engine.js';
import { createOrFindPR, getPRDiff } from '../pr/pr-manager.js';
import { config } from '../config.js';
import type { TopologyNode, CodebaseTopology, AuditGranularity } from 'david-shared';
import type { ManagedAgent } from '../agents/managed-agent.js';

export class AuditEngine {

  // Run a full codebase audit at the given granularity (default: config)
  async runFullAudit(granularity?: AuditGranularity): Promise<string> {
    const topology = await CodebaseTopologyModel.getLatest() as unknown as CodebaseTopology | null;
    if (!topology) throw new Error('No codebase topology available. Run mapping first.');

    const targetLevel = this.granularityToLevel(granularity);
    const nodes = topology.nodes.filter(n => n.level === targetLevel);
    return this.auditNodes(nodes, topology);
  }

  // Audit specific nodes (selected from UI)
  async auditSelectedNodes(nodeIds: string[], granularity?: AuditGranularity): Promise<string> {
    const topology = await CodebaseTopologyModel.getLatest() as unknown as CodebaseTopology | null;
    if (!topology) throw new Error('No codebase topology available.');

    const targetLevel = this.granularityToLevel(granularity);
    const nodes = this.resolveToLevel(nodeIds, topology, targetLevel);
    return this.auditNodes(nodes, topology);
  }

  // Core: dispatch audit agents for a set of topology nodes at the target granularity
  private async auditNodes(nodes: TopologyNode[], topology: CodebaseTopology): Promise<string> {
    const auditId = `audit-${Date.now()}`;

    // 1. Emit audit:started
    socketManager.emitAuditStarted({
      auditId,
      nodeIds: nodes.map(n => n.id),
      agentCount: nodes.length,
    });

    // 2. Load shared context
    const sreState = await SREStateModel.getOrCreateState();
    const topologySummary = this.formatTopologySummary(topology);

    // 3. For each node, create and submit an audit agent
    //    Worktrees are created lazily — only when the agent is dequeued and starts.
    const agentPromises = nodes.map(async (node) => {
      // Get learning context for this area
      const learning = await learningEngine.getLearningContext({
        nodeId: node.id,
        filePatterns: node.files,
      });

      const bugId = `audit-${node.id}-${Date.now()}`;

      // Pre-compute the learning section
      const learningSection = formatLearningContext(learning);
      const fileList = node.files.map((f) => `  - ${f}`).join('\n');

      // Submit to agent pool with lazy worktree + deferred prompt (loaded from DB)
      return agentPool.submit({
        id: `agent-audit-${node.id}-${Date.now()}`,
        type: 'audit',
        prompt: (repoPath: string) => renderPrompt('audit', {
          nodeName: node.name,
          nodeDescription: node.description,
          nodeId: node.id,
          fileList,
          topologySummary,
          sreState: JSON.stringify(sreState),
          repoPath,
          mongoUri: config.mongodbUri,
          learningSection,
        }),
        cwd: process.cwd(), // placeholder — overridden by lazy worktree
        taskId: auditId,
        nodeId: node.id,
        worktreeConfig: { identifier: bugId, type: 'branch' },
      });
    });

    // 4. Submit all agents (they'll queue if pool is full)
    await Promise.all(agentPromises);

    // 5. Set up completion tracking
    //    When all audit agents for this auditId complete:
    //    - Emit audit:completed
    //    - Summarize results
    this.trackAuditCompletion(auditId, nodes.length);

    return auditId;
  }

  // Convert granularity string to numeric level
  private granularityToLevel(granularity?: AuditGranularity): number {
    const g = granularity ?? config.defaultAuditGranularity;
    return g === 'L1' ? 1 : g === 'L2' ? 2 : 3;
  }

  // Resolve selected node IDs to nodes at the target level.
  // If a selected node is above the target level, expand to descendants at that level.
  // If a selected node is at or below the target level, find its ancestor at the target level.
  private resolveToLevel(nodeIds: string[], topology: CodebaseTopology, targetLevel: number): TopologyNode[] {
    const nodesMap = new Map(topology.nodes.map(n => [n.id, n]));
    const result = new Set<TopologyNode>();

    for (const id of nodeIds) {
      const node = nodesMap.get(id);
      if (!node) continue;

      if (node.level === targetLevel) {
        result.add(node);
      } else if (node.level < targetLevel) {
        // Node is above target — expand to descendants at target level
        this.findDescendantsAtLevel(node, nodesMap, targetLevel, result);
      } else {
        // Node is below target — find its ancestor at target level
        const ancestor = this.findAncestorAtLevel(node, nodesMap, targetLevel);
        if (ancestor) result.add(ancestor);
      }
    }

    return [...result];
  }

  // Recursively find descendants at the specified level
  private findDescendantsAtLevel(
    node: TopologyNode,
    nodesMap: Map<string, TopologyNode>,
    targetLevel: number,
    result: Set<TopologyNode>
  ): void {
    for (const childId of node.children) {
      const child = nodesMap.get(childId);
      if (!child) continue;
      if (child.level === targetLevel) result.add(child);
      else if (child.level < targetLevel) this.findDescendantsAtLevel(child, nodesMap, targetLevel, result);
    }
  }

  // Walk up the tree to find the ancestor at the target level
  private findAncestorAtLevel(
    node: TopologyNode,
    nodesMap: Map<string, TopologyNode>,
    targetLevel: number,
  ): TopologyNode | null {
    let current = node;
    while (current.level > targetLevel && current.parentId) {
      const parent = nodesMap.get(current.parentId);
      if (!parent) return null;
      current = parent;
    }
    return current.level === targetLevel ? current : null;
  }

  // Track completion of all agents in an audit
  private trackAuditCompletion(auditId: string, totalAgents: number): void {
    let completed = 0;

    const completedHandler = (agent: ManagedAgent) => {
      if (agent.taskId !== auditId) return;

      // Process the agent's results (bugs, fixes, PRs)
      this.handleAuditAgentResult(agent).catch((err) => {
        console.error(
          `[audit-engine] Error processing results for agent ${agent.id}:`,
          err instanceof Error ? err.message : err,
        );
      });

      completed++;
      if (completed >= totalAgents) {
        socketManager.emitAuditCompleted({
          auditId,
          nodeIds: [],
          agentCount: totalAgents,
        });
        agentPool.removeListener('agent:completed', completedHandler);
        agentPool.removeListener('agent:failed', failedHandler);
      }
    };

    const failedHandler = (agent: ManagedAgent) => {
      if (agent.taskId !== auditId) return;
      completed++;
      if (completed >= totalAgents) {
        socketManager.emitAuditCompleted({
          auditId,
          nodeIds: [],
          agentCount: totalAgents,
        });
        agentPool.removeListener('agent:completed', completedHandler);
        agentPool.removeListener('agent:failed', failedHandler);
      }
    };

    agentPool.on('agent:completed', completedHandler);
    agentPool.on('agent:failed', failedHandler);
  }

  /**
   * Handle audit agent completion: parse structured output, create bug
   * reports in MongoDB, create PRs for fixed bugs, and emit WebSocket events.
   */
  async handleAuditAgentResult(agent: ManagedAgent): Promise<void> {
    const agentId = agent.id;
    const nodeId = agent.nodeId;
    const worktreePath = agent.worktreePath;
    const branch = agent.branch;

    console.log(`[audit-engine] Processing results for agent ${agentId}`);

    // 1. Parse the agent's full structured JSON output from the output log
    const auditOutput = this.parseAuditOutput(agent.getOutputLog());
    if (!auditOutput) {
      console.warn(`[audit-engine] Could not parse structured output from agent ${agentId}`);
      return;
    }

    // 2. Build a set of verified bug IDs for quick lookup
    const verifiedBugIds = new Set(
      (auditOutput.verificationResults ?? [])
        .filter((v: any) => v.confirmed && !v.falseAlarm)
        .map((v: any) => v.bugId),
    );

    // Build a map of fixes by bugId
    const fixesByBugId = new Map<string, any>();
    for (const fix of auditOutput.fixes ?? []) {
      fixesByBugId.set(fix.bugId, fix);
    }

    // 3. Check if the worktree has commits beyond the base branch
    let hasWorktreeCommits = false;
    if (worktreePath) {
      try {
        const commitLog = execSync(
          `git log origin/${config.baseBranch}..HEAD --oneline`,
          { cwd: worktreePath, encoding: 'utf-8' },
        ).trim();
        hasWorktreeCommits = commitLog.length > 0;
      } catch {
        // No commits or error — treat as no commits
      }
    }

    // Track whether we've already created a PR for this agent's worktree
    let prCreatedForWorktree = false;

    // 4. Process each potential bug
    for (const bug of auditOutput.potentialBugs ?? []) {
      const isVerified = verifiedBugIds.has(bug.id);
      const fix = fixesByBugId.get(bug.id);
      const isFixed = fix != null && fix.testsPassed !== false;

      // Determine initial status
      let status: 'reported' | 'verified' | 'fixed' | 'pr-created' = 'reported';
      if (isFixed) status = 'fixed';
      else if (isVerified) status = 'verified';

      // Find verification result for this bug
      const verification = (auditOutput.verificationResults ?? []).find(
        (v: any) => v.bugId === bug.id,
      );

      // Create bug report in MongoDB
      const bugReport = await BugReportModel.create({
        source: 'codebase-audit',
        scanId: agent.taskId,
        nodeId: nodeId ?? auditOutput.nodeId,
        pattern: bug.description,
        severity: bug.severity,
        evidence: bug.reasoning,
        suspectedRootCause: bug.reasoning,
        affectedFiles: bug.file ? [bug.file] : [],
        status,
        verificationResult: verification
          ? {
              method: verification.method ?? 'code-review',
              details: verification.details ?? '',
              confirmed: verification.confirmed ?? false,
            }
          : undefined,
        fixAgentId: isFixed ? agentId : undefined,
      });

      const bugReportId = bugReport._id.toString();

      // Emit bug:reported
      socketManager.emitBugReported({
        bugId: bugReportId,
        pattern: bug.description,
        severity: bug.severity,
        status: 'reported',
      });

      // If verified, emit bug:verified
      if (isVerified || isFixed) {
        socketManager.emitBugVerified({
          bugId: bugReportId,
          pattern: bug.description,
          severity: bug.severity,
          status: 'verified',
        });
      }

      // If fixed, emit bug:fixed
      if (isFixed) {
        socketManager.emitBugFixed({
          bugId: bugReportId,
          pattern: bug.description,
          severity: bug.severity,
          status: 'fixed',
        });
      }

      // 5. Create a PR if this bug was fixed, the worktree has commits,
      //    and we haven't already created a PR for this agent's worktree.
      if (isFixed && hasWorktreeCommits && worktreePath && branch && !prCreatedForWorktree) {
        try {
          const diff = await getPRDiff(worktreePath);
          const prTitle = fix.commitMessage || `[SRE] Fix: ${bug.description}`;
          const prDescription = [
            `## Bug Summary\n\n${bug.description}`,
            `\n**Severity:** ${bug.severity}`,
            `**File:** ${bug.file}`,
            `\n## Evidence\n\n${bug.reasoning}`,
            verification
              ? `\n## Verification\n\n**Method:** ${verification.method}\n\n${verification.details}`
              : '',
            `\n## Fix\n\n${fix.description}`,
            fix.riskAssessment ? `\n## Risk Assessment\n\n${fix.riskAssessment}` : '',
          ].filter(Boolean).join('\n');

          // Create PR or find the one the agent already created
          const prResult = await createOrFindPR({
            bugId: bugReportId,
            bugReport: bugReport.toObject() as any,
            worktreePath,
            branch,
            title: prTitle,
            description: prDescription,
            diff,
            verificationMethod: verification?.method ?? 'code-review',
          });

          // Store PR record in MongoDB
          const prDoc = await PullRequestModel.create({
            prNumber: prResult.prNumber,
            prUrl: prResult.prUrl,
            title: prTitle,
            bugReportId,
            agentId,
            branch: prResult.branch,
            status: 'open',
            scanType: 'audit',
            nodeId: nodeId ?? auditOutput.nodeId,
            diff,
            description: prDescription,
            verificationMethod: verification?.method ?? 'code-review',
            createdAt: new Date(),
          });

          // Update bug report with PR ID and status
          await BugReportModel.findByIdAndUpdate(bugReportId, {
            prId: prDoc._id.toString(),
            status: 'pr-created',
          });

          // Emit pr:created
          socketManager.emitPRCreated({
            prId: prDoc._id.toString(),
            prNumber: prResult.prNumber,
            prUrl: prResult.prUrl,
            title: prTitle,
            status: 'open',
          });

          console.log(
            `[audit-engine] Created PR #${prResult.prNumber} for bug ${bugReportId} (agent ${agentId})`,
          );

          // All fixes from this agent share the same worktree/branch
          prCreatedForWorktree = true;
        } catch (err) {
          console.error(
            `[audit-engine] Failed to create PR for bug ${bugReportId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // 6. Clean up the worktree (pool persists the agent record automatically)
    await agent.cleanupWorktree();

    console.log(`[audit-engine] Finished processing agent ${agentId}`);
  }

  /**
   * Parse the full structured audit output from the agent's output log.
   * The agent emits a JSON object matching the audit prompt's output format.
   * Returns null if no valid output is found.
   */
  private parseAuditOutput(outputLog: string[]): any | null {
    if (outputLog.length === 0) return null;

    // Scan the last 100 lines (audit output can be large)
    const tail = outputLog.slice(-100);
    const joined = tail.join('\n');

    // Strategy 1: fenced JSON block
    const fencedMatch = joined.match(/```json\s*\n([\s\S]*?)\n\s*```/);
    if (fencedMatch) {
      const parsed = this.tryParseAuditJSON(fencedMatch[1]);
      if (parsed) return parsed;
    }

    // Strategy 2: find the last large JSON object by matching braces
    let braceStart = -1;
    let braceEnd = -1;
    for (let i = tail.length - 1; i >= 0; i--) {
      if (braceEnd === -1 && tail[i].trim().endsWith('}')) {
        braceEnd = i;
      }
      if (braceEnd !== -1 && tail[i].trim().startsWith('{')) {
        braceStart = i;
        break;
      }
    }

    if (braceStart !== -1 && braceEnd !== -1 && braceStart <= braceEnd) {
      const candidate = tail.slice(braceStart, braceEnd + 1).join('\n');
      const parsed = this.tryParseAuditJSON(candidate);
      if (parsed) return parsed;
    }

    // Strategy 3: try each line as a standalone JSON object
    for (let i = tail.length - 1; i >= 0; i--) {
      const line = tail[i].trim();
      if (line.startsWith('{') && line.endsWith('}')) {
        const parsed = this.tryParseAuditJSON(line);
        if (parsed) return parsed;
      }
    }

    return null;
  }

  /**
   * Try to parse a string as the audit agent's structured JSON output.
   * Validates that it has the expected shape (must have `summary` and
   * at least one of `potentialBugs` / `verificationResults` / `fixes`).
   */
  private tryParseAuditJSON(raw: string): any | null {
    try {
      const obj = JSON.parse(raw);
      if (typeof obj !== 'object' || obj === null) return null;
      if (typeof obj.summary !== 'string') return null;
      // Must look like an audit output (has at least one audit-specific field)
      if (!obj.potentialBugs && !obj.verificationResults && !obj.fixes) return null;
      return obj;
    } catch {
      return null;
    }
  }

  // Format topology summary for agent prompts
  private formatTopologySummary(topology: CodebaseTopology): string {
    // Build a readable tree structure
    let summary = `Codebase: ${topology.fileCount} files, ${topology.totalLines} lines\n\n`;

    const l1Nodes = topology.nodes.filter(n => n.level === 1);
    for (const l1 of l1Nodes) {
      summary += `L1: ${l1.name} (${l1.files.length} files, ${l1.totalLines} lines)\n`;
      summary += `  ${l1.description}\n`;

      const l2Children = topology.nodes.filter(n => n.parentId === l1.id);
      for (const l2 of l2Children) {
        summary += `  L2: ${l2.name} (${l2.files.length} files, ${l2.totalLines} lines)\n`;

        const l3Children = topology.nodes.filter(n => n.parentId === l2.id);
        for (const l3 of l3Children) {
          summary += `    L3: ${l3.name} (${l3.files.length} files)\n`;
        }
      }
    }

    return summary;
  }
}

export const auditEngine = new AuditEngine();
