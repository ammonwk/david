// ============================================
// David — AI SRE Tool
// CloudWatch Log & ECS Metric Prefetch Module
// ============================================

import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  ECSClient,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import { config } from '../config.js';
import type {
  ScanTimeSpan,
  SeverityFilter,
  LogPattern,
  LogHeatmapBucket,
  ECSMetrics,
  ECSEvent,
} from 'david-shared';

// ============================================
// Types
// ============================================

export interface PrefetchResult {
  logPatterns: LogPattern[];
  rawLogEvents: Array<{ timestamp: string; message: string; logStream: string }>;
  ecsMetrics: ECSMetrics;
  ecsEvents: ECSEvent[];
  queryTimeMs: number;
}

// ============================================
// Module-level AWS clients (created once)
// ============================================

const logsClient = new CloudWatchLogsClient({ region: config.awsRegion });
const metricsClient = new CloudWatchClient({ region: config.awsRegion });
const ecsClient = new ECSClient({ region: config.awsRegion });

// ============================================
// Constants
// ============================================

const QUERY_POLL_INTERVAL_MS = 1_000;
const QUERY_TIMEOUT_MS = 60_000;
const PATTERN_GROUP_TRUNCATE_LENGTH = 200;
const METRIC_PERIOD_SECONDS = 300; // 5 minutes
const SPIKE_THRESHOLD_PERCENT = 70;

// ============================================
// Helpers
// ============================================

/** Convert a ScanTimeSpan string to milliseconds. */
function timeSpanToMs(span: ScanTimeSpan): number {
  const map: Record<ScanTimeSpan, number> = {
    '5m': 5 * 60 * 1_000,
    '15m': 15 * 60 * 1_000,
    '1h': 60 * 60 * 1_000,
    '6h': 6 * 60 * 60 * 1_000,
    '24h': 24 * 60 * 60 * 1_000,
  };
  return map[span];
}

/** Build a CloudWatch Insights query string filtered by severity. */
function buildQuery(severity: SeverityFilter): string {
  const baseFields = 'fields @timestamp, @message, @logStream';
  const sort = 'sort @timestamp desc';
  const limit = 'limit 10000';

  switch (severity) {
    case 'warn-error':
      return `${baseFields} | filter level in ("warn", "error") | ${sort} | ${limit}`;
    case 'error':
      return `${baseFields} | filter level = "error" | ${sort} | ${limit}`;
    case 'all':
    default:
      return `${baseFields} | ${sort} | ${limit}`;
  }
}

/** Build a CloudWatch Insights query that returns hourly severity counts. */
function buildHeatmapQuery(severity: SeverityFilter): string {
  const base = 'fields @timestamp, level';
  const stats = 'stats count(*) as count by bin(1h) as bucket, level | sort bucket asc';

  switch (severity) {
    case 'warn-error':
      return `${base} | filter level in ("warn", "warning", "error", "critical", "fatal") | ${stats}`;
    case 'error':
      return `${base} | filter level in ("error", "critical", "fatal") | ${stats}`;
    case 'all':
    default:
      return `${base} | ${stats}`;
  }
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runInsightsQuery(
  startTime: number,
  endTime: number,
  queryString: string,
): Promise<Array<Array<{ field?: string; value?: string }>>> {
  let queryId: string;
  try {
    const startResult = await logsClient.send(
      new StartQueryCommand({
        logGroupName: config.cloudwatchLogGroup,
        startTime,
        endTime,
        queryString,
      }),
    );
    if (!startResult.queryId) {
      console.warn('[prefetch] StartQuery returned no queryId');
      return [];
    }
    queryId = startResult.queryId;
  } catch (err) {
    console.warn('[prefetch] Failed to start CloudWatch Insights query:', err);
    return [];
  }

  const deadline = Date.now() + QUERY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(QUERY_POLL_INTERVAL_MS);
    try {
      const poll = await logsClient.send(
        new GetQueryResultsCommand({ queryId }),
      );
      const status = poll.status;

      if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
        console.warn(`[prefetch] CloudWatch Insights query ${status}`);
        return [];
      }

      if (status === 'Complete') {
        return (poll.results ?? []) as Array<Array<{ field?: string; value?: string }>>;
      }
    } catch (err) {
      console.warn('[prefetch] Error polling CloudWatch Insights query:', err);
      return [];
    }
  }

  console.warn('[prefetch] CloudWatch Insights query timed out');
  return [];
}

/**
 * Extract a grouping key from a log message.
 * If the message is JSON with a "message" field, use that field.
 * Otherwise, truncate the raw text.
 */
function extractGroupingKey(rawMessage: string): string {
  try {
    const parsed = JSON.parse(rawMessage);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.message === 'string') {
      return parsed.message.slice(0, PATTERN_GROUP_TRUNCATE_LENGTH);
    }
  } catch {
    // Not JSON — fall through
  }
  return rawMessage.slice(0, PATTERN_GROUP_TRUNCATE_LENGTH);
}

/**
 * Extract the log level from a raw message.
 * For JSON logs, reads the "level" field. Otherwise returns "unknown".
 */
function extractLevel(rawMessage: string): string {
  try {
    const parsed = JSON.parse(rawMessage);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.level === 'string') {
      return parsed.level;
    }
  } catch {
    // Not JSON — fall through
  }
  return 'unknown';
}

// ============================================
// Fetch Logs (CloudWatch Insights)
// ============================================

export async function fetchLogs(
  timeSpan: ScanTimeSpan,
  severity: SeverityFilter,
): Promise<{
  patterns: LogPattern[];
  rawEvents: Array<{ timestamp: string; message: string; logStream: string }>;
}> {
  const now = Date.now();
  const startTime = Math.floor((now - timeSpanToMs(timeSpan)) / 1_000);
  const endTime = Math.floor(now / 1_000);
  const queryString = buildQuery(severity);
  const results = await runInsightsQuery(startTime, endTime, queryString);

  if (results.length === 0) {
    return { patterns: [], rawEvents: [] };
  }

  // 3. Parse results into raw events
  const rawEvents: Array<{ timestamp: string; message: string; logStream: string }> = [];

  for (const row of results) {
    const fieldMap = new Map<string, string>();
    for (const cell of row) {
      if (cell.field && cell.value !== undefined) {
        fieldMap.set(cell.field, cell.value);
      }
    }
    rawEvents.push({
      timestamp: fieldMap.get('@timestamp') ?? '',
      message: fieldMap.get('@message') ?? '',
      logStream: fieldMap.get('@logStream') ?? '',
    });
  }

  // 4. Deduplicate into patterns
  const patternMap = new Map<
    string,
    {
      message: string;
      count: number;
      level: string;
      firstOccurrence: Date;
      lastOccurrence: Date;
    }
  >();

  for (const event of rawEvents) {
    const key = extractGroupingKey(event.message);
    const ts = event.timestamp ? new Date(event.timestamp) : new Date();

    const existing = patternMap.get(key);
    if (existing) {
      existing.count += 1;
      if (ts < existing.firstOccurrence) existing.firstOccurrence = ts;
      if (ts > existing.lastOccurrence) existing.lastOccurrence = ts;
    } else {
      patternMap.set(key, {
        message: key,
        count: 1,
        level: extractLevel(event.message),
        firstOccurrence: ts,
        lastOccurrence: ts,
      });
    }
  }

  // 5. Sort patterns by count descending
  const patterns: LogPattern[] = Array.from(patternMap.values()).sort(
    (a, b) => b.count - a.count,
  );

  return { patterns, rawEvents };
}

function classifySeverity(level: string): 'error' | 'warn' | 'info' {
  const normalized = level.toLowerCase();
  if (normalized === 'error' || normalized === 'critical' || normalized === 'fatal') {
    return 'error';
  }
  if (normalized === 'warn' || normalized === 'warning') {
    return 'warn';
  }
  return 'info';
}

// ============================================
// Heatmap Cache (in-memory, delta-aware)
// ============================================

interface HeatmapCache {
  buckets: LogHeatmapBucket[];
  cachedAt: number; // ms timestamp
  hours: number;
  severity: SeverityFilter;
}

/** Return cached data if it's less than 5 minutes old. */
const HEATMAP_CACHE_TTL_MS = 5 * 60_000;

let heatmapCache: HeatmapCache | null = null;

function parseHeatmapRows(
  results: Array<Array<{ field?: string; value?: string }>>,
): LogHeatmapBucket[] {
  const buckets = new Map<string, LogHeatmapBucket>();

  for (const row of results) {
    const fieldMap = new Map<string, string>();
    for (const cell of row) {
      if (cell.field && cell.value !== undefined) {
        fieldMap.set(cell.field, cell.value);
      }
    }

    const bucketValue =
      fieldMap.get('bucket') ??
      fieldMap.get('bin(1h)') ??
      fieldMap.get('@timestamp');

    if (!bucketValue) continue;

    const hour = new Date(bucketValue);
    if (Number.isNaN(hour.getTime())) continue;

    const severityKey = classifySeverity(fieldMap.get('level') ?? 'info');
    const count = parseInt(fieldMap.get('count') ?? '0', 10);
    if (!Number.isFinite(count) || count <= 0) continue;

    const key = `${hour.toISOString()}:${severityKey}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += count;
    } else {
      buckets.set(key, { hour, severity: severityKey, count });
    }
  }

  return Array.from(buckets.values());
}

export async function fetchLogHeatmap(
  hours = 168,
  severity: SeverityFilter = 'all',
): Promise<LogHeatmapBucket[]> {
  const safeHours = Math.min(Math.max(Math.floor(hours), 1), 24 * 30);
  const now = Date.now();

  // 1. Return cached data immediately if fresh and params match
  if (
    heatmapCache &&
    heatmapCache.hours === safeHours &&
    heatmapCache.severity === severity &&
    now - heatmapCache.cachedAt < HEATMAP_CACHE_TTL_MS
  ) {
    return heatmapCache.buckets;
  }

  // 2. Determine whether we can do a delta fetch or need a full fetch
  const canDelta =
    heatmapCache &&
    heatmapCache.hours === safeHours &&
    heatmapCache.severity === severity;

  let startTime: number;
  let existingBuckets: Map<string, LogHeatmapBucket> | null = null;

  if (canDelta) {
    // Delta: re-query from 1 hour before last cache time so the in-progress
    // hour bucket gets a fresh count.
    startTime = Math.floor((heatmapCache!.cachedAt - 3600_000) / 1_000);
    existingBuckets = new Map<string, LogHeatmapBucket>();
    for (const b of heatmapCache!.buckets) {
      existingBuckets.set(`${new Date(b.hour).toISOString()}:${b.severity}`, { ...b });
    }
  } else {
    startTime = Math.floor((now - safeHours * 3600_000) / 1_000);
  }

  const endTime = Math.floor(now / 1_000);
  const queryString = buildHeatmapQuery(severity);
  const results = await runInsightsQuery(startTime, endTime, queryString);

  // 3. Merge new results into the bucket map
  const merged = existingBuckets ?? new Map<string, LogHeatmapBucket>();
  const freshBuckets = parseHeatmapRows(results);

  for (const b of freshBuckets) {
    // Fresh data replaces cached data for overlapping hour/severity combos
    merged.set(`${new Date(b.hour).toISOString()}:${b.severity}`, b);
  }

  // 4. Prune buckets that have fallen outside the requested window
  const windowStart = now - safeHours * 3600_000;
  for (const [key, bucket] of merged) {
    if (new Date(bucket.hour).getTime() < windowStart) {
      merged.delete(key);
    }
  }

  const sorted = Array.from(merged.values()).sort(
    (a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime(),
  );

  // 5. Update cache
  heatmapCache = {
    buckets: sorted,
    cachedAt: now,
    hours: safeHours,
    severity,
  };

  return sorted;
}

// ============================================
// Fetch ECS Metrics (CloudWatch Metrics)
// ============================================

export async function fetchECSMetrics(
  timeSpan: ScanTimeSpan,
): Promise<ECSMetrics> {
  const now = new Date();
  const startTime = new Date(now.getTime() - timeSpanToMs(timeSpan));
  const dimensions = [
    { Name: 'ClusterName', Value: config.ecsClusterName },
    { Name: 'ServiceName', Value: config.ecsServiceName },
  ];

  const fetchMetric = async (
    metricName: string,
  ): Promise<{ average: number[]; maximum: number[]; timestamps: Date[] }> => {
    try {
      const result = await metricsClient.send(
        new GetMetricStatisticsCommand({
          Namespace: 'AWS/ECS',
          MetricName: metricName,
          Dimensions: dimensions,
          StartTime: startTime,
          EndTime: now,
          Period: METRIC_PERIOD_SECONDS,
          Statistics: ['Average', 'Maximum'],
        }),
      );

      const datapoints = result.Datapoints ?? [];
      // Sort by timestamp ascending
      datapoints.sort(
        (a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0),
      );

      return {
        average: datapoints.map((dp) => dp.Average ?? 0),
        maximum: datapoints.map((dp) => dp.Maximum ?? 0),
        timestamps: datapoints.map((dp) => dp.Timestamp ?? new Date()),
      };
    } catch (err) {
      console.warn(`[prefetch] Failed to fetch ${metricName} metric:`, err);
      return { average: [], maximum: [], timestamps: [] };
    }
  };

  const [cpu, memory] = await Promise.all([
    fetchMetric('CPUUtilization'),
    fetchMetric('MemoryUtilization'),
  ]);

  const cpuMax = cpu.maximum.length > 0 ? Math.max(...cpu.maximum) : 0;
  const memoryMax = memory.maximum.length > 0 ? Math.max(...memory.maximum) : 0;

  // Identify spikes (any data point where the maximum exceeded the threshold)
  const spikes: Array<{ timestamp: Date; metric: string; value: number }> = [];

  for (let i = 0; i < cpu.maximum.length; i++) {
    if (cpu.maximum[i] > SPIKE_THRESHOLD_PERCENT) {
      spikes.push({
        timestamp: cpu.timestamps[i],
        metric: 'CPUUtilization',
        value: cpu.maximum[i],
      });
    }
  }

  for (let i = 0; i < memory.maximum.length; i++) {
    if (memory.maximum[i] > SPIKE_THRESHOLD_PERCENT) {
      spikes.push({
        timestamp: memory.timestamps[i],
        metric: 'MemoryUtilization',
        value: memory.maximum[i],
      });
    }
  }

  return { cpuMax, memoryMax, spikes };
}

// ============================================
// Fetch ECS Service Events
// ============================================

export async function fetchECSEvents(
  timeSpan: ScanTimeSpan,
): Promise<ECSEvent[]> {
  try {
    const result = await ecsClient.send(
      new DescribeServicesCommand({
        cluster: config.ecsClusterName,
        services: [config.ecsServiceName],
      }),
    );

    const service = result.services?.[0];
    if (!service || !service.events) {
      return [];
    }

    const cutoff = new Date(Date.now() - timeSpanToMs(timeSpan));

    return service.events
      .filter((event) => event.createdAt && event.createdAt >= cutoff)
      .map((event) => ({
        timestamp: event.createdAt!,
        message: event.message ?? '',
      }));
  } catch (err) {
    console.warn('[prefetch] Failed to fetch ECS service events:', err);
    return [];
  }
}

// ============================================
// Main Prefetch (parallel execution)
// ============================================

export async function prefetch(
  timeSpan: ScanTimeSpan,
  severity: SeverityFilter,
): Promise<PrefetchResult> {
  const startTime = Date.now();

  const [logResult, ecsMetrics, ecsEvents] = await Promise.all([
    fetchLogs(timeSpan, severity),
    fetchECSMetrics(timeSpan),
    fetchECSEvents(timeSpan),
  ]);

  return {
    logPatterns: logResult.patterns,
    rawLogEvents: logResult.rawEvents,
    ecsMetrics,
    ecsEvents,
    queryTimeMs: Date.now() - startTime,
  };
}
