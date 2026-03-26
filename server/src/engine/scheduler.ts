// ============================================
// David — AI SRE Tool
// Cron Scheduler — manages recurring log-scan and codebase-audit jobs
// ============================================

import cron from 'node-cron';
import { config } from '../config.js';
import type {
  ScanScheduleConfig,
  AuditScheduleConfig,
  ScanTimeSpan,
} from 'david-shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JobCallback = () => Promise<void>;

interface ScheduledJob {
  name: string;
  task: cron.ScheduledTask | null;
  config: ScanScheduleConfig | AuditScheduleConfig;
  isRunning: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  callback: JobCallback;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a ScanTimeSpan shorthand into a cron expression.
 *
 *   '5m'  -> '* /5 * * * *'   (every 5 minutes)
 *   '15m' -> '* /15 * * * *'  (every 15 minutes)
 *   '1h'  -> '0 * * * *'     (top of every hour)
 *   '6h'  -> '0 * /6 * * *'   (every 6 hours on the hour)
 *   '24h' -> '0 3 * * *'     (once daily at 3 AM)
 */
export function timeSpanToCron(timeSpan: ScanTimeSpan): string {
  switch (timeSpan) {
    case '5m':
      return '*/5 * * * *';
    case '15m':
      return '*/15 * * * *';
    case '1h':
      return '0 * * * *';
    case '6h':
      return '0 */6 * * *';
    case '24h':
      return '0 3 * * *';
    default: {
      // Exhaustiveness guard — should never happen with the ScanTimeSpan type.
      const _exhaustive: never = timeSpan;
      throw new Error(`Unknown time span: ${_exhaustive}`);
    }
  }
}

/**
 * Parse a standard 5-field cron expression and compute the next occurrence
 * after `after` (defaults to now).
 *
 * Supports: literal values, ranges (1-5), steps (* /n), comma-separated lists.
 * Does NOT support non-standard 6-field (seconds) expressions.
 */
function calculateNextCronRun(cronExpression: string, after?: Date): Date | null {
  try {
    const fields = cronExpression.trim().split(/\s+/);
    if (fields.length !== 5) return null;

    const [minuteField, hourField, domField, monthField, dowField] = fields;

    const expandField = (
      field: string,
      min: number,
      max: number,
    ): number[] => {
      const values = new Set<number>();

      for (const part of field.split(',')) {
        // Handle step notation, e.g. "*/5" or "1-10/2"
        const [rangePart, stepStr] = part.split('/');
        const step = stepStr ? parseInt(stepStr, 10) : 1;

        let rangeStart = min;
        let rangeEnd = max;

        if (rangePart === '*') {
          // full range
        } else if (rangePart.includes('-')) {
          const [lo, hi] = rangePart.split('-').map(Number);
          rangeStart = lo;
          rangeEnd = hi;
        } else {
          // single value
          rangeStart = parseInt(rangePart, 10);
          rangeEnd = rangeStart;
        }

        for (let v = rangeStart; v <= rangeEnd; v += step) {
          values.add(v);
        }
      }

      return [...values].sort((a, b) => a - b);
    };

    const minutes = expandField(minuteField, 0, 59);
    const hours = expandField(hourField, 0, 23);
    const doms = expandField(domField, 1, 31);
    const months = expandField(monthField, 1, 12);
    const dows = expandField(dowField, 0, 6); // 0 = Sunday

    const isDowWildcard = dowField === '*';
    const isDomWildcard = domField === '*';

    // Start searching from one minute after `after`
    const start = new Date(after ?? new Date());
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    // Search up to 366 days into the future
    const limit = 366 * 24 * 60;
    const cursor = new Date(start);

    for (let i = 0; i < limit; i++) {
      const m = cursor.getMinutes();
      const h = cursor.getHours();
      const dom = cursor.getDate();
      const mon = cursor.getMonth() + 1; // 1-based
      const dow = cursor.getDay(); // 0 = Sunday

      const monthMatch = months.includes(mon);
      const minuteMatch = minutes.includes(m);
      const hourMatch = hours.includes(h);

      // Standard cron: if both DOM and DOW are restricted (non-wildcard), the
      // match is their UNION (either one matching is sufficient). If only one
      // is restricted, the other acts as "all".
      let dayMatch: boolean;
      if (isDowWildcard && isDomWildcard) {
        dayMatch = true;
      } else if (isDowWildcard) {
        dayMatch = doms.includes(dom);
      } else if (isDomWildcard) {
        dayMatch = dows.includes(dow);
      } else {
        dayMatch = doms.includes(dom) || dows.includes(dow);
      }

      if (monthMatch && dayMatch && hourMatch && minuteMatch) {
        return new Date(cursor);
      }

      cursor.setMinutes(cursor.getMinutes() + 1);
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const SCAN_JOB_NAME = 'log-scan';
const AUDIT_JOB_NAME = 'codebase-audit';

export class Scheduler {
  private jobs: Map<string, ScheduledJob> = new Map();

  // ---------- Registration ---------------------------------------------------

  /** Register (or re-register) the recurring log-scan job. */
  registerScanJob(scanConfig: ScanScheduleConfig, callback: JobCallback): void {
    this.registerJob(SCAN_JOB_NAME, scanConfig, callback);
  }

  /** Register (or re-register) the recurring codebase-audit job. */
  registerAuditJob(auditConfig: AuditScheduleConfig, callback: JobCallback): void {
    this.registerJob(AUDIT_JOB_NAME, auditConfig, callback);
  }

  // ---------- Config updates -------------------------------------------------

  /** Update the scan schedule configuration. Returns the merged config. */
  updateScanConfig(updates: Partial<ScanScheduleConfig>): ScanScheduleConfig {
    const job = this.jobs.get(SCAN_JOB_NAME);
    if (!job) {
      throw new Error('Scan job has not been registered yet');
    }

    const prev = job.config as ScanScheduleConfig;
    const merged: ScanScheduleConfig = { ...prev, ...updates };

    // If the timeSpan changed but no explicit cronExpression was provided,
    // recompute the cron expression from the new timeSpan.
    if (updates.timeSpan && !updates.cronExpression) {
      merged.cronExpression = timeSpanToCron(merged.timeSpan);
    }

    const scheduleChanged =
      merged.cronExpression !== prev.cronExpression ||
      merged.enabled !== prev.enabled;

    if (scheduleChanged) {
      this.registerJob(SCAN_JOB_NAME, merged, job.callback);
    } else {
      job.config = merged;
    }

    return merged;
  }

  /** Update the audit schedule configuration. Returns the merged config. */
  updateAuditConfig(updates: Partial<AuditScheduleConfig>): AuditScheduleConfig {
    const job = this.jobs.get(AUDIT_JOB_NAME);
    if (!job) {
      throw new Error('Audit job has not been registered yet');
    }

    const prev = job.config as AuditScheduleConfig;
    const merged: AuditScheduleConfig = { ...prev, ...updates };

    const scheduleChanged =
      merged.cronExpression !== prev.cronExpression ||
      merged.enabled !== prev.enabled;

    if (scheduleChanged) {
      this.registerJob(AUDIT_JOB_NAME, merged, job.callback);
    } else {
      job.config = merged;
    }

    return merged;
  }

  // ---------- Job control ----------------------------------------------------

  /** Pause a running job by name. Returns `true` if the job was found and paused. */
  pauseJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (!job || !job.task) return false;

    job.task.stop();
    (job.config as { enabled: boolean }).enabled = false;
    job.nextRunAt = null;
    console.log(`[Scheduler] Paused job "${name}"`);
    return true;
  }

  /** Resume a paused job by name. Returns `true` if the job was found and resumed. */
  resumeJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (!job || !job.task) return false;

    job.task.start();
    (job.config as { enabled: boolean }).enabled = true;
    job.nextRunAt = this.calculateNextRun(job.config.cronExpression);
    console.log(`[Scheduler] Resumed job "${name}"`);
    return true;
  }

  /**
   * Manually trigger a job outside its normal schedule.
   * Respects the concurrency guard — returns `false` if the job is already running.
   */
  async triggerJob(name: string): Promise<boolean> {
    const job = this.jobs.get(name);
    if (!job) {
      console.warn(`[Scheduler] Cannot trigger unknown job "${name}"`);
      return false;
    }

    if (job.isRunning) {
      console.warn(`[Scheduler] Skipping manual trigger for "${name}" — already running`);
      return false;
    }

    await this.executeJob(job);
    return true;
  }

  // ---------- Status ---------------------------------------------------------

  /** Return current status for all registered jobs (for the dashboard). */
  getStatus(): {
    scan: ScanScheduleConfig & { isRunning: boolean; lastRunAt: Date | null; nextRunAt: Date | null };
    audit: AuditScheduleConfig & { isRunning: boolean; lastRunAt: Date | null; nextRunAt: Date | null };
  } {
    const scanJob = this.jobs.get(SCAN_JOB_NAME);
    const auditJob = this.jobs.get(AUDIT_JOB_NAME);

    const defaultScanConfig: ScanScheduleConfig = {
      enabled: false,
      timeSpan: config.defaultScanTimeSpan,
      severity: config.defaultSeverityFilter,
      cronExpression: config.defaultScanCron,
    };

    const defaultAuditConfig: AuditScheduleConfig = {
      enabled: false,
      cronExpression: config.defaultAuditCron,
    };

    return {
      scan: {
        ...(scanJob ? (scanJob.config as ScanScheduleConfig) : defaultScanConfig),
        isRunning: scanJob?.isRunning ?? false,
        lastRunAt: scanJob?.lastRunAt ?? null,
        nextRunAt: scanJob?.nextRunAt ?? null,
      },
      audit: {
        ...(auditJob ? (auditJob.config as AuditScheduleConfig) : defaultAuditConfig),
        isRunning: auditJob?.isRunning ?? false,
        lastRunAt: auditJob?.lastRunAt ?? null,
        nextRunAt: auditJob?.nextRunAt ?? null,
      },
    };
  }

  // ---------- Lifecycle ------------------------------------------------------

  /** Stop all scheduled tasks (for graceful server shutdown). */
  stopAll(): void {
    for (const job of this.jobs.values()) {
      job.task?.stop();
      job.task = null;
      job.nextRunAt = null;
    }
    console.log('[Scheduler] All jobs stopped');
  }

  // ---------- Private helpers ------------------------------------------------

  /**
   * Core registration logic shared by scan and audit jobs.
   * If a job with the same name already exists its cron task is stopped first.
   */
  private registerJob(
    name: string,
    jobConfig: ScanScheduleConfig | AuditScheduleConfig,
    callback: JobCallback,
  ): void {
    // Stop any existing task with this name
    const existing = this.jobs.get(name);
    if (existing?.task) {
      existing.task.stop();
    }

    const { cronExpression, enabled } = jobConfig;

    if (!cron.validate(cronExpression)) {
      throw new Error(
        `Invalid cron expression "${cronExpression}" for job "${name}"`,
      );
    }

    // Build the cron task (start in paused state — we enable below if needed)
    const task = cron.schedule(
      cronExpression,
      async () => {
        const job = this.jobs.get(name);
        if (!job) return;

        if (job.isRunning) {
          console.log(
            `[Scheduler] Skipping scheduled run of "${name}" — previous execution still in progress`,
          );
          return;
        }

        await this.executeJob(job);
      },
      { scheduled: false },
    );

    const job: ScheduledJob = {
      name,
      task,
      config: jobConfig,
      isRunning: existing?.isRunning ?? false,
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt: enabled ? this.calculateNextRun(cronExpression) : null,
      callback,
    };

    this.jobs.set(name, job);

    if (enabled) {
      task.start();
      console.log(
        `[Scheduler] Job "${name}" registered and started (cron: ${cronExpression})`,
      );
    } else {
      console.log(
        `[Scheduler] Job "${name}" registered but disabled (cron: ${cronExpression})`,
      );
    }
  }

  /** Execute a job's callback with the concurrency guard and bookkeeping. */
  private async executeJob(job: ScheduledJob): Promise<void> {
    job.isRunning = true;
    job.lastRunAt = new Date();

    try {
      await job.callback();
    } catch (err) {
      console.error(
        `[Scheduler] Job "${job.name}" failed:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      job.isRunning = false;
      if ((job.config as { enabled: boolean }).enabled) {
        job.nextRunAt = this.calculateNextRun(job.config.cronExpression);
      }
    }
  }

  /** Calculate the next run time from a cron expression. */
  private calculateNextRun(cronExpression: string): Date | null {
    return calculateNextCronRun(cronExpression);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const scheduler = new Scheduler();
