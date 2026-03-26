import { EventEmitter } from 'events';
import type { AgentStatus, AgentRecord } from 'david-shared';
import { AgentPool } from '../src/agents/agent-pool.js';
import type { ManagedAgentOptions } from '../src/agents/managed-agent.js';

class FakeManagedAgent extends EventEmitter {
  readonly id: string;
  readonly type;
  readonly taskId: string;
  readonly nodeId?: string;
  status: AgentStatus = 'queued';
  startCalls = 0;
  stopCalls = 0;
  createdAt = new Date();

  constructor(options: ManagedAgentOptions) {
    super();
    this.id = options.id;
    this.type = options.type;
    this.taskId = options.taskId;
    this.nodeId = options.nodeId;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this.status = 'running';
    this.emit('status', 'running');
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.status = 'failed';
    this.emit('status', 'failed');
  }

  emitTerminalStatus(status: 'completed' | 'failed' | 'timeout'): void {
    this.status = status;
    this.emit('status', status);
  }

  toRecord(): AgentRecord {
    return {
      _id: this.id,
      type: this.type,
      status: this.status,
      taskId: this.taskId,
      nodeId: this.nodeId,
      restarts: 0,
      maxRestarts: 0,
      timeoutMs: 0,
      outputLog: [],
      createdAt: this.createdAt,
    };
  }
}

describe('AgentPool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts agents immediately when capacity is available', async () => {
    const created: FakeManagedAgent[] = [];
    const pool = new AgentPool(2, {
      createAgent: (options) => {
        const agent = new FakeManagedAgent(options);
        created.push(agent);
        return agent as any;
      },
    });

    await pool.submit({
      id: 'agent-1',
      type: 'fix',
      prompt: 'prompt',
      cwd: process.cwd(),
      taskId: 'task-1',
    });

    expect(created[0].startCalls).toBe(1);
    expect(pool.getStatus().activeCount).toBe(1);
  });

  it('queues overflow agents and drains them in FIFO order', async () => {
    vi.useFakeTimers();

    const created: FakeManagedAgent[] = [];
    const pool = new AgentPool(1, {
      createAgent: (options) => {
        const agent = new FakeManagedAgent(options);
        created.push(agent);
        return agent as any;
      },
    });

    await pool.submit({
      id: 'agent-1',
      type: 'fix',
      prompt: 'prompt',
      cwd: process.cwd(),
      taskId: 'task-1',
    });
    await pool.submit({
      id: 'agent-2',
      type: 'fix',
      prompt: 'prompt',
      cwd: process.cwd(),
      taskId: 'task-2',
    });

    expect(created[0].startCalls).toBe(1);
    expect(created[1].startCalls).toBe(0);
    expect(pool.getStatus().queuedCount).toBe(1);

    created[0].emitTerminalStatus('completed');
    await vi.runAllTimersAsync();

    expect(created[1].startCalls).toBe(1);
    expect(pool.getStatus().queuedCount).toBe(0);
  });

  it('stops queued agents without starting them', async () => {
    const created: FakeManagedAgent[] = [];
    const pool = new AgentPool(1, {
      createAgent: (options) => {
        const agent = new FakeManagedAgent(options);
        created.push(agent);
        return agent as any;
      },
    });

    await pool.submit({
      id: 'agent-1',
      type: 'fix',
      prompt: 'prompt',
      cwd: process.cwd(),
      taskId: 'task-1',
    });
    await pool.submit({
      id: 'agent-2',
      type: 'fix',
      prompt: 'prompt',
      cwd: process.cwd(),
      taskId: 'task-2',
    });

    await expect(pool.stopAgent('agent-2')).resolves.toBe(true);

    expect(created[1].startCalls).toBe(0);
    expect(pool.getStatus().failedCount).toBe(1);
  });

  it('stops active agents and clears the queue on shutdown', async () => {
    const created: FakeManagedAgent[] = [];
    const pool = new AgentPool(1, {
      createAgent: (options) => {
        const agent = new FakeManagedAgent(options);
        created.push(agent);
        return agent as any;
      },
    });

    await pool.submit({
      id: 'agent-1',
      type: 'fix',
      prompt: 'prompt',
      cwd: process.cwd(),
      taskId: 'task-1',
    });
    await pool.submit({
      id: 'agent-2',
      type: 'fix',
      prompt: 'prompt',
      cwd: process.cwd(),
      taskId: 'task-2',
    });

    await pool.shutdown();

    expect(created[0].stopCalls).toBe(1);
    expect(pool.getStatus().queuedCount).toBe(0);
    expect(pool.getStatus().failedCount).toBe(2);
  });
});
