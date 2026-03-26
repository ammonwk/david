import { Scheduler, calculateNextCronRun, timeSpanToCron } from '../src/engine/scheduler.js';

describe('scheduler helpers', () => {
  it('maps time spans to cron expressions', () => {
    expect(timeSpanToCron('5m')).toBe('*/5 * * * *');
    expect(timeSpanToCron('1h')).toBe('0 * * * *');
    expect(timeSpanToCron('24h')).toBe('0 3 * * *');
  });

  it('calculates the next stepped cron run', () => {
    const next = calculateNextCronRun(
      '*/15 * * * *',
      new Date('2026-01-01T10:07:00.000Z'),
    );

    expect(next?.toISOString()).toBe('2026-01-01T10:15:00.000Z');
  });

  it('recomputes scan cron when only the time span changes', () => {
    const scheduler = new Scheduler();

    scheduler.registerScanJob(
      {
        enabled: false,
        timeSpan: '5m',
        severity: 'all',
        cronExpression: timeSpanToCron('5m'),
      },
      async () => {},
    );

    const updated = scheduler.updateScanConfig({ timeSpan: '6h' });

    expect(updated.cronExpression).toBe('0 */6 * * *');

    scheduler.stopAll();
  });

  it('blocks manual triggers while a job is still running', async () => {
    let resolveJob!: () => void;
    const jobPromise = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });
    const scheduler = new Scheduler();

    scheduler.registerAuditJob(
      {
        enabled: false,
        cronExpression: '0 3 * * *',
      },
      async () => {
        await jobPromise;
      },
    );

    const firstRun = scheduler.triggerJob('codebase-audit');
    await Promise.resolve();

    await expect(scheduler.triggerJob('codebase-audit')).resolves.toBe(false);

    resolveJob();
    await firstRun;
    scheduler.stopAll();
  });
});
