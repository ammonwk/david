import { EventEmitter } from 'events';
import { config } from '../config.js';
import { ManagedAgent, type ManagedAgentOptions } from './managed-agent.js';
import { AgentModel } from '../db/models.js';
import type { AgentStatus, AgentRecord, PoolStatusData } from 'david-shared';

// ---------------------------------------------------------------------------
// AgentPool — manages up to N concurrent top-level agents with FIFO overflow
// ---------------------------------------------------------------------------

export interface AgentPoolServices {
  createAgent?: (options: ManagedAgentOptions) => ManagedAgent;
}

export class AgentPool extends EventEmitter {
  // Events:
  // 'agent:started'   -> (agent: ManagedAgent)
  // 'agent:completed' -> (agent: ManagedAgent)
  // 'agent:failed'    -> (agent: ManagedAgent)
  // 'agent:queued'    -> (agent: ManagedAgent)
  // 'agent:output'    -> (agentId: string, line: string)
  // 'pool:status'     -> (status: PoolStatusData)
  // 'drain'           -> () — queue is empty and all agents completed

  private active: Map<string, ManagedAgent> = new Map();
  private queue: ManagedAgent[] = [];
  private completed: Map<string, ManagedAgent> = new Map();
  private failed: Map<string, ManagedAgent> = new Map();
  private maxConcurrent: number;
  private shuttingDown: boolean = false;
  private services: AgentPoolServices;

  constructor(maxConcurrent?: number, services: AgentPoolServices = {}) {
    super();
    this.maxConcurrent = maxConcurrent ?? config.maxConcurrentAgents;
    this.services = services;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Submit a new agent to the pool.
   * If the pool is under capacity the agent starts immediately;
   * otherwise it is placed in a FIFO queue and starts when a slot opens.
   */
  async submit(options: ManagedAgentOptions): Promise<ManagedAgent> {
    if (this.shuttingDown) {
      throw new Error('[agent-pool] Cannot submit agents — pool is shutting down');
    }

    const agent = this.services.createAgent?.(options) ?? new ManagedAgent(options);

    this.wireAgentEvents(agent);

    // Persist initial agent record to MongoDB
    this.persistAgent(agent);

    if (this.active.size < this.maxConcurrent) {
      await this.startAgent(agent);
    } else {
      this.queue.push(agent);
      this.emit('agent:queued', agent);
      console.log(
        `[agent-pool] Agent ${agent.id} queued (active=${this.active.size}, queued=${this.queue.length})`,
      );
    }

    this.emitPoolStatus();
    return agent;
  }

  /**
   * Stop a specific agent by ID.
   * Returns true if the agent was found and stopped.
   */
  async stopAgent(agentId: string): Promise<boolean> {
    // Check active agents
    const activeAgent = this.active.get(agentId);
    if (activeAgent) {
      await activeAgent.stop();
      return true;
    }

    // Check queued agents — remove from queue without starting
    const queueIdx = this.queue.findIndex(a => a.id === agentId);
    if (queueIdx !== -1) {
      const [removed] = this.queue.splice(queueIdx, 1);
      this.failed.set(removed.id, removed);
      this.emit('agent:failed', removed);
      this.emitPoolStatus();
      return true;
    }

    return false;
  }

  /**
   * Gracefully shut down the pool: clear the queue and stop all active agents.
   * Called on server SIGTERM for graceful cleanup.
   */
  async shutdown(): Promise<void> {
    console.log('[agent-pool] Shutting down...');
    this.shuttingDown = true;

    // 1. Clear the queue — move queued agents to failed
    const queued = this.queue.splice(0, this.queue.length);
    for (const agent of queued) {
      this.failed.set(agent.id, agent);
    }

    // 2. Stop all active agents in parallel
    const stopPromises = Array.from(this.active.values()).map(agent =>
      agent.stop().catch(err => {
        console.error(`[agent-pool] Error stopping agent ${agent.id}:`, err);
      }),
    );

    await Promise.all(stopPromises);

    console.log('[agent-pool] Shutdown complete.');
  }

  /**
   * Get the current pool status summary.
   */
  getStatus(): PoolStatusData {
    return {
      activeCount: this.active.size,
      maxConcurrent: this.maxConcurrent,
      queuedCount: this.queue.length,
      completedCount: this.completed.size,
      failedCount: this.failed.size,
    };
  }

  /**
   * Get all agent records (active + completed + failed), sorted by createdAt descending.
   * Used for API responses and dashboard rendering.
   */
  getAgents(): AgentRecord[] {
    const all: ManagedAgent[] = [
      ...this.active.values(),
      ...this.completed.values(),
      ...this.failed.values(),
    ];

    return all
      .map(a => a.toRecord())
      .sort((a, b) => {
        const timeA = a.createdAt?.getTime() ?? 0;
        const timeB = b.createdAt?.getTime() ?? 0;
        return timeB - timeA;
      });
  }

  /**
   * Get queued agent records (for API responses).
   */
  getQueue(): AgentRecord[] {
    return this.queue.map(a => a.toRecord());
  }

  /**
   * Get a specific agent by ID, searching active, completed, failed, and queued.
   */
  getAgent(id: string): ManagedAgent | undefined {
    return (
      this.active.get(id) ??
      this.completed.get(id) ??
      this.failed.get(id) ??
      this.queue.find(a => a.id === id)
    );
  }

  /**
   * Get the number of currently active (running) agents.
   */
  getActiveCount(): number {
    return this.active.size;
  }

  /**
   * Check whether the pool can start another agent immediately.
   */
  hasCapacity(): boolean {
    return this.active.size < this.maxConcurrent;
  }

  /**
   * Get the current max concurrent limit.
   */
  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Dynamically update the max concurrent agent limit.
   *
   * - If scaling up: drains the queue to fill newly available slots.
   * - If scaling down below current active count: excess agents are stopped,
   *   requeued at the front of the queue, and will resume (via --resume)
   *   when a slot opens.
   */
  async setMaxConcurrent(n: number): Promise<void> {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error('maxConcurrent must be a positive integer');
    }

    const old = this.maxConcurrent;
    this.maxConcurrent = n;

    if (n > old) {
      // Scaling up — start queued agents that now fit
      this.drainQueue();
    } else if (n < this.active.size) {
      // Scaling down below current active count — evict excess agents
      await this.evictExcessAgents(this.active.size - n);
    }

    this.emitPoolStatus();
  }

  // ---------------------------------------------------------------------------
  // Eviction (for setMaxConcurrent scale-down)
  // ---------------------------------------------------------------------------

  /**
   * Stop the N most recently started agents, remove them from active,
   * and requeue them at the front of the queue so they resume when a
   * slot opens.
   */
  private async evictExcessAgents(count: number): Promise<void> {
    // Pick the most recently started agents (LIFO — least work done)
    const sorted = [...this.active.values()].sort((a, b) => {
      const aTime = a.toRecord().startedAt
        ? new Date(a.toRecord().startedAt!).getTime()
        : 0;
      const bTime = b.toRecord().startedAt
        ? new Date(b.toRecord().startedAt!).getTime()
        : 0;
      return bTime - aTime; // most recent first
    });

    const toEvict = sorted.slice(0, count);

    // 1. Remove from active FIRST so handleAgentDone no-ops
    for (const agent of toEvict) {
      this.active.delete(agent.id);
    }

    // 2. Stop all evicted agents in parallel
    await Promise.all(
      toEvict.map(agent =>
        agent.stop().catch(err => {
          console.error(`[agent-pool] Error stopping evicted agent ${agent.id}:`, err);
        }),
      ),
    );

    // 3. Rebuild submission options and requeue at front
    const requeued: ManagedAgent[] = [];
    for (const agent of toEvict) {
      const record = agent.toRecord();
      try {
        const options: ManagedAgentOptions = {
          id: agent.id,
          type: record.type,
          prompt: record.prompt ?? '',
          cwd: record.worktreePath ?? process.cwd(),
          taskId: record.taskId,
          nodeId: record.nodeId ?? undefined,
          parentAgentId: record.parentAgentId ?? undefined,
          worktreePath: record.worktreePath ?? undefined,
          branch: record.branch ?? undefined,
          cliSessionId: record.cliSessionId ?? undefined,
          timeoutMs: record.timeoutMs,
          maxRestarts: record.maxRestarts,
          systemPrompt: record.systemPrompt ?? undefined,
          worktreeConfig:
            record.worktreeType && record.worktreeIdentifier
              ? { type: record.worktreeType, identifier: record.worktreeIdentifier }
              : undefined,
        };

        const newAgent =
          this.services.createAgent?.(options) ?? new ManagedAgent(options);
        this.wireAgentEvents(newAgent);
        this.persistAgent(newAgent);
        requeued.push(newAgent);
      } catch (err) {
        console.error(`[agent-pool] Failed to requeue agent ${record._id}:`, err);
      }
    }

    // Unshift requeued agents to front of queue (they get priority)
    this.queue.unshift(...requeued);
    for (const agent of requeued) {
      this.emit('agent:queued', agent);
      console.log(
        `[agent-pool] Agent ${agent.id} evicted and requeued (active=${this.active.size}, queued=${this.queue.length})`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Wire up event listeners on a ManagedAgent to integrate it with the pool.
   */
  private wireAgentEvents(agent: ManagedAgent): void {
    // Forward status changes and persist to DB
    agent.on('status', (status: AgentStatus) => {
      // Persist every status transition to MongoDB
      this.persistAgent(agent);

      if (status === 'completed') {
        this.handleAgentDone(agent);
      } else if (status === 'failed' || status === 'timeout') {
        this.handleAgentDone(agent);
      }
    });

    // Forward output lines to pool-level event (for dashboard live viewer)
    agent.on('output', (line: string) => {
      this.emit('agent:output', agent.id, line);
    });

    // Handle errors — the agent may restart itself internally;
    // only move to failed if it has exhausted restarts.
    agent.on('error', (err: Error) => {
      console.error(`[agent-pool] Agent ${agent.id} error:`, err.message);
    });
  }

  /**
   * Start an agent and add it to the active map.
   */
  private async startAgent(agent: ManagedAgent): Promise<void> {
    // The agent may already be in the active map (optimistically placed by
    // drainQueue) or not (direct submit path).  Ensure it is tracked.
    this.active.set(agent.id, agent);

    try {
      await agent.start();
      // Re-persist now that the prompt has been resolved (deferred prompts
      // are null at construction time, so the initial persist may lack it).
      this.persistAgent(agent);
      this.emit('agent:started', agent);
      console.log(
        `[agent-pool] Agent ${agent.id} started (active=${this.active.size}, queued=${this.queue.length})`,
      );
    } catch (err) {
      // If start itself fails, treat as immediate failure
      this.active.delete(agent.id);
      this.failed.set(agent.id, agent);
      this.emit('agent:failed', agent);
      this.emitPoolStatus();
      console.error(`[agent-pool] Agent ${agent.id} failed to start:`, err);

      // A slot just freed up — try to fill it from the queue.
      this.drainQueue();
    }
  }

  /**
   * Handle an agent reaching a terminal state (completed, failed, or timeout).
   * Moves it from active to the appropriate map, drains the queue, and
   * emits status events.
   */
  private handleAgentDone(agent: ManagedAgent): void {
    // Guard: if the agent is not in the active map, it was already handled
    // (possible when two terminal status events fire in quick succession).
    if (!this.active.has(agent.id)) return;

    // 1. Remove from active
    this.active.delete(agent.id);

    // 2. Categorise into completed or failed
    const record = agent.toRecord();
    if (record.status === 'completed') {
      this.completed.set(agent.id, agent);
      this.emit('agent:completed', agent);
      console.log(`[agent-pool] Agent ${agent.id} completed.`);
    } else {
      this.failed.set(agent.id, agent);
      this.emit('agent:failed', agent);
      console.log(`[agent-pool] Agent ${agent.id} failed (status=${record.status}).`);
    }

    // 3. Drain the queue (start next waiting agents)
    this.drainQueue();

    // 4. If nothing left, emit drain
    if (this.queue.length === 0 && this.active.size === 0) {
      this.emit('drain');
      console.log('[agent-pool] All agents finished — pool drained.');
    }

    // 5. Broadcast pool status update
    this.emitPoolStatus();
  }

  /**
   * Try to start queued agents while there is available capacity.
   *
   * Each agent is optimistically counted as active (to prevent over-scheduling
   * within the synchronous loop), then actually started via setImmediate.
   * If the start fails, startAgent removes the agent from active and calls
   * drainQueue again so the freed slot can be filled.
   */
  private drainQueue(): void {
    if (this.shuttingDown) return;

    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;

      // Optimistically count it as active for the capacity check in this
      // synchronous loop, so we don't over-schedule.
      this.active.set(next.id, next);

      // Use setImmediate so each agent start doesn't block the loop
      setImmediate(() => {
        this.startAgent(next).catch(err => {
          console.error(
            `[agent-pool] Failed to start queued agent ${next.id}:`,
            err,
          );
        });
      });
    }
  }

  /**
   * Emit a pool:status event with the current status snapshot.
   */
  private emitPoolStatus(): void {
    this.emit('pool:status', this.getStatus());
  }

  // ---------------------------------------------------------------------------
  // MongoDB persistence
  // ---------------------------------------------------------------------------

  /**
   * Persist the current agent state to MongoDB (fire-and-forget).
   */
  private persistAgent(agent: ManagedAgent): void {
    const record = agent.toRecord();
    AgentModel.findOneAndUpdate(
      { _id: record._id },
      record,
      { upsert: true },
    ).catch((err) => {
      console.error(`[agent-pool] Failed to persist agent ${agent.id}:`, err.message ?? err);
    });
  }

  /**
   * Load historical agents from MongoDB (those not currently in memory).
   * Merges with live in-memory agents and returns all, sorted by createdAt desc.
   */
  async getAgentsWithHistory(limit = 100): Promise<AgentRecord[]> {
    const liveAgents = this.getAgents();
    const liveQueue = this.getQueue();
    const liveIds = new Set([
      ...liveAgents.map(a => a._id),
      ...liveQueue.map(a => a._id),
    ]);

    try {
      const historicalDocs = await AgentModel
        .find({ _id: { $nin: [...liveIds] } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean() as unknown as AgentRecord[];

      return [...liveAgents, ...historicalDocs].sort((a, b) => {
        const timeA = (a.createdAt as Date)?.getTime?.() ?? 0;
        const timeB = (b.createdAt as Date)?.getTime?.() ?? 0;
        return timeB - timeA;
      });
    } catch (err) {
      console.error('[agent-pool] Failed to load historical agents:', err);
      return liveAgents;
    }
  }

  /**
   * Get a specific agent by ID — checks in-memory first, falls back to MongoDB.
   */
  async getAgentWithHistory(id: string): Promise<ManagedAgent | AgentRecord | undefined> {
    const live = this.getAgent(id);
    if (live) return live;

    try {
      const doc = await AgentModel.findById(id).lean() as unknown as AgentRecord | null;
      return doc ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resume agents that were interrupted by an unclean shutdown.
   * Re-submits them to the pool so they can pick up where they left off
   * (using --resume with their persisted CLI session ID).
   *
   * Returns the set of branch names belonging to resumed agents so the
   * caller can exclude them from orphaned-worktree cleanup.
   */
  async recoverCrashedAgents(): Promise<Set<string>> {
    const activeBranches = new Set<string>();

    try {
      const crashedDocs = await AgentModel.find({
        status: { $in: ['queued', 'starting', 'running'] },
      }).lean() as unknown as AgentRecord[];

      if (crashedDocs.length === 0) return activeBranches;

      console.log(`[agent-pool] Found ${crashedDocs.length} interrupted agent(s) — resuming`);

      for (const record of crashedDocs) {
        const agentId = record._id;

        // Can't resume an agent without an ID or prompt
        if (!agentId || !record.prompt) {
          console.warn(`[agent-pool] Agent ${agentId} missing id/prompt — marking failed`);
          await AgentModel.updateOne(
            { _id: agentId },
            { $set: { status: 'failed', completedAt: new Date() } },
          );
          continue;
        }

        // Track the branch so its worktree survives cleanup
        if (record.branch) {
          activeBranches.add(record.branch);
        }

        try {
          await this.submit({
            id: agentId,
            type: record.type,
            prompt: record.prompt,
            cwd: record.worktreePath ?? process.cwd(),
            taskId: record.taskId,
            nodeId: record.nodeId ?? undefined,
            parentAgentId: record.parentAgentId ?? undefined,
            worktreePath: record.worktreePath ?? undefined,
            branch: record.branch ?? undefined,
            cliSessionId: record.cliSessionId ?? undefined,
            timeoutMs: record.timeoutMs,
            maxRestarts: record.maxRestarts,
            systemPrompt: record.systemPrompt ?? undefined,
            worktreeConfig:
              record.worktreeType && record.worktreeIdentifier
                ? { type: record.worktreeType, identifier: record.worktreeIdentifier }
                : undefined,
          });
          console.log(`[agent-pool] Resumed agent ${agentId}`);
        } catch (err) {
          console.warn(`[agent-pool] Failed to resume agent ${agentId}:`, err);
          await AgentModel.updateOne(
            { _id: agentId },
            { $set: { status: 'failed', completedAt: new Date() } },
          );
        }
      }
    } catch (err) {
      console.warn('[agent-pool] Failed to recover crashed agents:', err);
    }

    return activeBranches;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const agentPool = new AgentPool();
