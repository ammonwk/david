import { execSync } from 'child_process';
import { agentPool } from '../agents/agent-pool.js';
import { buildAuditAgentPrompt } from '../agents/prompts.js';
import { createWorktree } from '../agents/worktree-manager.js';
import { socketManager } from '../ws/socket-manager.js';
import { CodebaseTopologyModel, AgentModel, BugReportModel, PullRequestModel, SREStateModel } from '../db/models.js';
import { learningEngine } from '../pr/learning-engine.js';
import { createPR, getPRDiff } from '../pr/pr-manager.js';
import { config } from '../config.js';
import type { TopologyNode, CodebaseTopology } from 'david-shared';
import type { ManagedAgent } from '../agents/managed-agent.js';

export class AuditEngine {

  // Run a full codebase audit (all L3 nodes)
  async runFullAudit(): Promise<string> {
    const topology = await CodebaseTopologyModel.getLatest() as unknown as CodebaseTopology | null;
    if (!topology) throw new Error('No codebase topology available. Run mapping first.');

    const l3Nodes = topology.nodes.filter(n => n.level === 3);
    return this.auditNodes(l3Nodes, topology);
  }

  // Audit specific nodes (selected from UI)
  async auditSelectedNodes(nodeIds: string[]): Promise<string> {
    const topology = await CodebaseTopologyModel.getLatest() as unknown as CodebaseTopology | null;
    if (!topology) throw new Error('No codebase topology available.');

    // Resolve selected nodes — if an L1 or L2 is selected, expand to its L3 children
    const l3Nodes = this.resolveToL3Nodes(nodeIds, topology);
    return this.auditNodes(l3Nodes, topology);
  }

  // Core: dispatch audit agents for a set of L3 nodes
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

    // 3. For each L3 node, create and submit an audit agent
    const agentPromises = nodes.map(async (node) => {
      // Get learning context for this area
      const learning = await learningEngine.getLearningContext({
        nodeId: node.id,
        filePatterns: node.files,
      });

      // Create a worktree for this audit agent
      // (audit agents need worktrees because their fix sub-agents will modify code)
      const bugId = `audit-${node.id}-${Date.now()}`;
      const worktreeInfo = await createWorktree(bugId);

      // Build the prompt
      const prompt = buildAuditAgentPrompt({
        node,
        topologySummary,
        sreState: JSON.stringify(sreState),
        repoPath: worktreeInfo.path, // Agent works in its worktree
        mongoUri: config.mongodbUri,
        learning,
      });

      // Submit to agent pool
      return agentPool.submit({
        id: `agent-audit-${node.id}-${Date.now()}`,
        type: 'audit',
        prompt,
        cwd: worktreeInfo.path,
        taskId: auditId,
        nodeId: node.id,
        worktreePath: worktreeInfo.path,
        branch: worktreeInfo.branch,
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

  // Resolve selected node IDs to L3 nodes
  // If an L1 or L2 is selected, expand to all its L3 descendants
  private resolveToL3Nodes(nodeIds: string[], topology: CodebaseTopology): TopologyNode[] {
    const nodesMap = new Map(topology.nodes.map(n => [n.id, n]));
    const l3Nodes = new Set<TopologyNode>();

    for (const id of nodeIds) {
      const node = nodesMap.get(id);
      if (!node) continue;

      if (node.level === 3) {
        l3Nodes.add(node);
      } else {
        // Find all L3 descendants
        this.findL3Descendants(node, nodesMap, l3Nodes);
      }
    }

    return [...l3Nodes];
  }

  // Recursively find L3 descendants
  private findL3Descendants(
    node: TopologyNode,
    nodesMap: Map<string, TopologyNode>,
    result: Set<TopologyNode>
  ): void {
    for (const childId of node.children) {
      const child = nodesMap.get(childId);
      if (!child) continue;
      if (child.level === 3) result.add(child);
      else this.findL3Descendants(child, nodesMap, result);
    }
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

          // Push and create PR (createPR handles commit + push internally)
          const prResult = await createPR({
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

    // 6. Persist the agent record to MongoDB
    try {
      const record = agent.toRecord();
      await AgentModel.findOneAndUpdate(
        { _id: record._id },
        record,
        { upsert: true },
      );
    } catch (err) {
      console.error(
        `[audit-engine] Failed to persist agent record ${agentId}:`,
        err instanceof Error ? err.message : err,
      );
    }

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
