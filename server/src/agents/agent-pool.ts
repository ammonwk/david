import { EventEmitter } from 'events';
import { config } from '../config.js';
import { ManagedAgent, type ManagedAgentOptions } from './managed-agent.js';
import type { AgentStatus, AgentRecord, PoolStatusData } from 'david-shared';

// ---------------------------------------------------------------------------
// AgentPool — manages up to N concurrent top-level agents with FIFO overflow
// ---------------------------------------------------------------------------

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

  constructor(maxConcurrent?: number) {
    super();
    this.maxConcurrent = maxConcurrent ?? config.maxConcurrentAgents;
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

    const agent = new ManagedAgent(options);

    this.wireAgentEvents(agent);

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

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Wire up event listeners on a ManagedAgent to integrate it with the pool.
   */
  private wireAgentEvents(agent: ManagedAgent): void {
    // Forward status changes
    agent.on('status', (status: AgentStatus) => {
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
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const agentPool = new AgentPool();
