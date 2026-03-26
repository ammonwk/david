import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { execSync } from 'child_process';
import { config } from './config.js';
import { connectDB, disconnectDB } from './db/connection.js';
import { socketManager } from './ws/socket-manager.js';
import { scheduler } from './engine/scheduler.js';
import { agentPool } from './agents/agent-pool.js';
import { prTracker } from './pr/pr-tracker.js';
import { PullRequestModel } from './db/models.js';

// Import API routes
import scansRouter from './api/scans.js';
import stateRouter from './api/state.js';
import agentsRouter from './api/agents.js';
import topologyRouter from './api/topology.js';
import prsRouter from './api/prs.js';

/**
 * Kill orphaned Claude agent processes left behind by a previous crash.
 * Looks for processes with DAVID_AGENT=1 in their environment.
 */
function killOrphanedAgentProcesses(): void {
  try {
    // Find PIDs of processes with DAVID_AGENT=1 in their environment.
    // Uses /proc on Linux; silently skips on unsupported platforms.
    const output = execSync(
      'grep -rl "DAVID_AGENT=1" /proc/*/environ 2>/dev/null | grep -oP "/proc/\\K[0-9]+" || true',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();

    if (!output) return;

    const pids = output.split('\n').filter(Boolean).map(Number);
    const myPid = process.pid;

    for (const pid of pids) {
      if (pid === myPid) continue; // Don't kill ourselves
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`[startup] Killed orphaned agent process ${pid}`);
      } catch {
        // Process may have already exited — ignore
      }
    }

    if (pids.length > 0) {
      console.log(`[startup] Cleaned up ${pids.length} orphaned agent process(es)`);
    }
  } catch {
    // Non-Linux or /proc not available — skip silently
  }
}

async function main() {
  console.log('David AI SRE starting up...');

  // 0. Kill orphaned agent processes from a previous crash
  killOrphanedAgentProcesses();

  // 1. Connect to MongoDB (fail fast if unreachable)
  await connectDB();
  console.log('[startup] MongoDB connected');

  // 2. Verify target repo exists (warn only — topology mapping will fail gracefully)
  try {
    const fs = await import('fs/promises');
    await fs.access(config.targetRepoPath);
  } catch {
    console.warn(`[startup] Target repo not found at ${config.targetRepoPath} — topology mapping will be unavailable`);
  }

  // 3. Create Express app
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // 4. Mount API routes
  app.use('/api/scans', scansRouter);
  app.use('/api/state', stateRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/topology', topologyRouter);
  app.use('/api/prs', prsRouter);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // 5. Create HTTP server and attach Socket.IO
  const server = createServer(app);
  socketManager.init(server);
  console.log('[startup] Socket.IO initialized');

  // 6. Wire agent pool events to Socket.IO
  agentPool.on('agent:started', (agent) => {
    socketManager.emitAgentStarted({
      agentId: agent.id,
      type: agent.type,
      status: 'running',
      nodeId: agent.nodeId,
    });
  });
  agentPool.on('agent:completed', (agent) => {
    socketManager.emitAgentCompleted({
      agentId: agent.id,
      type: agent.type,
      status: 'completed',
      nodeId: agent.nodeId,
    });
  });
  agentPool.on('agent:failed', (agent) => {
    socketManager.emitAgentFailed({
      agentId: agent.id,
      type: agent.type,
      status: 'failed',
      nodeId: agent.nodeId,
    });
  });
  agentPool.on('agent:queued', (agent) => {
    socketManager.emitAgentQueued({
      agentId: agent.id,
      type: agent.type,
      status: 'queued',
      nodeId: agent.nodeId,
    });
  });
  agentPool.on('agent:output', (agentId, line) => {
    socketManager.broadcastAgentOutput(agentId, line);
  });
  agentPool.on('pool:status', (status) => {
    socketManager.emitPoolStatus(status);
  });

  // 7. Set up scheduled jobs
  // Log scan schedule
  scheduler.registerScanJob(
    {
      enabled: true,
      timeSpan: config.defaultScanTimeSpan,
      severity: config.defaultSeverityFilter,
      cronExpression: config.defaultScanCron,
    },
    async () => {
      try {
        const { logScanner } = await import('./engine/log-scanner.js');
        await logScanner.runScan({
          timeSpan: config.defaultScanTimeSpan,
          severity: config.defaultSeverityFilter,
        });
      } catch (err) {
        console.error('Scheduled scan failed:', err);
      }
    }
  );

  // Codebase audit schedule
  scheduler.registerAuditJob(
    {
      enabled: true,
      cronExpression: config.defaultAuditCron,
    },
    async () => {
      try {
        const { auditEngine } = await import('./engine/audit-engine.js');
        await auditEngine.runFullAudit();
      } catch (err) {
        console.error('Scheduled audit failed:', err);
      }
    }
  );
  console.log('[startup] Scheduler initialized');

  // 8. Start PR tracking (poll GitHub every 5 minutes)
  prTracker.startPolling(
    // getOpenPRs
    async () => {
      return PullRequestModel.find({ status: 'open' }).lean() as any;
    },
    // updatePR
    async (id, updates) => {
      await PullRequestModel.findByIdAndUpdate(id, updates);
    },
    // onStatusChange
    (pr, newStatus) => {
      if (newStatus === 'merged') {
        socketManager.emitPRMerged({
          prId: pr._id?.toString() || '',
          prNumber: pr.prNumber,
          prUrl: pr.prUrl,
          title: pr.title,
          status: 'merged',
        });
      } else if (newStatus === 'closed') {
        socketManager.emitPRClosed({
          prId: pr._id?.toString() || '',
          prNumber: pr.prNumber,
          prUrl: pr.prUrl,
          title: pr.title,
          status: 'closed',
        });
      }
    }
  );
  console.log('[startup] PR tracker polling started');

  // 9. Startup recovery
  try {
    // Clean up orphaned worktrees
    const { cleanupOrphanedWorktrees } = await import('./agents/worktree-manager.js');
    const activeAgentBranches = new Set<string>(); // No active agents on startup
    const cleaned = await cleanupOrphanedWorktrees(activeAgentBranches);
    if (cleaned > 0) console.log(`[startup] Cleaned up ${cleaned} orphaned worktrees`);
  } catch (err) {
    console.warn('[startup] Worktree cleanup failed (non-fatal):', err);
  }

  // 10. Start HTTP server
  server.listen(config.port, () => {
    console.log(`David server running on port ${config.port}`);
    console.log(`Dashboard: http://localhost:5173`);
    console.log(`API: http://localhost:${config.port}/api`);
  });

  // 11. Graceful shutdown
  let shutdownInProgress = false;

  const shutdown = async (signal: string) => {
    if (shutdownInProgress) {
      console.log(`[shutdown] ${signal} received again — already shutting down`);
      return;
    }
    shutdownInProgress = true;

    console.log(`\n[shutdown] ${signal} received. Shutting down gracefully...`);

    // Hard deadline: force exit after 30 seconds if graceful shutdown stalls
    const forceExitTimer = setTimeout(() => {
      console.error('[shutdown] Graceful shutdown timed out after 30s — forcing exit');
      process.exit(1);
    }, 30_000);
    forceExitTimer.unref(); // Don't let this timer keep the process alive

    // 1. Stop scheduler first (no new scans start)
    scheduler.stopAll();
    console.log('[shutdown] Scheduler stopped');

    // 2. Stop PR tracker polling
    prTracker.stopPolling();
    console.log('[shutdown] PR tracker stopped');

    // 3. Shut down agent pool (kills all agents, clears queue)
    try {
      await agentPool.shutdown();
    } catch (err) {
      console.error('[shutdown] Agent pool shutdown error:', err);
    }
    console.log('[shutdown] Agent pool shut down');

    // 4. Close HTTP server (stop accepting new connections, wait for in-flight)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // If server wasn't listening yet, close() callback may not fire
      setTimeout(() => resolve(), 5000).unref();
    });
    console.log('[shutdown] HTTP server closed');

    // 5. Remove agentPool event listeners to avoid dangling references
    agentPool.removeAllListeners();

    // 6. Disconnect MongoDB
    try {
      await disconnectDB();
    } catch (err) {
      console.error('[shutdown] MongoDB disconnect error:', err);
    }
    console.log('[shutdown] MongoDB disconnected');

    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
