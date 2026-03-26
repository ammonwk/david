import { EventEmitter } from 'events';
import { ManagedAgent } from '../src/agents/managed-agent.js';

class FakeCLIProcess extends EventEmitter {
  pid = 4242;
  sessionId: string | null = null;
  kill = vi.fn(async () => {});
  isAlive = vi.fn(() => true);
}

function createAgent(launchCLI: () => Promise<FakeCLIProcess>) {
  return new ManagedAgent(
    {
      id: 'agent-1',
      type: 'fix',
      prompt: 'fix it',
      cwd: process.cwd(),
      taskId: 'task-1',
      timeoutMs: 50,
      maxRestarts: 1,
    },
    { launchCLI },
  );
}

describe('ManagedAgent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes when the CLI emits a structured result', async () => {
    const process = new FakeCLIProcess();
    const launchCLI = vi.fn().mockResolvedValue(process);
    const agent = createAgent(launchCLI);

    await agent.start();
    process.emit('result', { summary: 'patched', fixesApplied: 1 });

    expect(agent.getStatus()).toBe('completed');
    expect(agent.toRecord().result).toEqual({
      summary: 'patched',
      fixesApplied: 1,
      bugsFound: undefined,
      bugsVerified: undefined,
      prsCreated: undefined,
    });
  });

  it('restarts after a non-zero exit and preserves the retry count', async () => {
    vi.useFakeTimers();

    const firstProcess = new FakeCLIProcess();
    const secondProcess = new FakeCLIProcess();
    const launchCLI = vi
      .fn()
      .mockResolvedValueOnce(firstProcess)
      .mockResolvedValueOnce(secondProcess);
    const agent = createAgent(launchCLI);

    await agent.start();
    firstProcess.emit('exit', 1, null);

    await vi.advanceTimersByTimeAsync(5000);

    expect(launchCLI).toHaveBeenCalledTimes(2);

    secondProcess.emit('result', { summary: 'recovered' });

    expect(agent.getStatus()).toBe('completed');
    expect(agent.toRecord().restarts).toBe(1);
  });

  it('times out when the retry budget is exhausted', async () => {
    vi.useFakeTimers();

    const cliProcess = new FakeCLIProcess();
    const launchCLI = vi.fn().mockResolvedValue(cliProcess);
    const agent = new ManagedAgent(
      {
        id: 'agent-timeout',
        type: 'fix',
        prompt: 'fix it',
        cwd: process.cwd(),
        taskId: 'task-timeout',
        timeoutMs: 25,
        maxRestarts: 0,
      },
      { launchCLI },
    );

    await agent.start();
    await vi.advanceTimersByTimeAsync(25);

    expect(cliProcess.kill).toHaveBeenCalledTimes(1);
    expect(agent.getStatus()).toBe('timeout');
    expect(agent.getOutputLog().some((line) => line.includes('timed out'))).toBe(true);
  });

  it('stores human-readable tool output instead of raw protocol payloads', async () => {
    const process = new FakeCLIProcess();
    const launchCLI = vi.fn().mockResolvedValue(process);
    const agent = createAgent(launchCLI);

    await agent.start();
    process.emit('tool_use', 'command_execution', {
      command: '/bin/bash -lc "npm test"',
      exit_code: 0,
      status: 'completed',
      aggregated_output: 'very long output',
    });

    expect(agent.getOutputLog()).toContain('$ /bin/bash -lc "npm test" (completed, exit 0)');
  });
});
