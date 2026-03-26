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

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // 1. Start the Insights query
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
      return { patterns: [], rawEvents: [] };
    }
    queryId = startResult.queryId;
  } catch (err) {
    console.warn('[prefetch] Failed to start CloudWatch Insights query:', err);
    return { patterns: [], rawEvents: [] };
  }

  // 2. Poll until Complete or Failed (timeout after 60 s)
  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  let results: Array<Array<{ field?: string; value?: string }>> = [];

  while (Date.now() < deadline) {
    await sleep(QUERY_POLL_INTERVAL_MS);
    try {
      const poll = await logsClient.send(
        new GetQueryResultsCommand({ queryId }),
      );
      const status = poll.status;

      if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
        console.warn(`[prefetch] CloudWatch Insights query ${status}`);
        return { patterns: [], rawEvents: [] };
      }

      if (status === 'Complete') {
        results = (poll.results ?? []) as Array<Array<{ field?: string; value?: string }>>;
        break;
      }
      // Still running — loop again
    } catch (err) {
      console.warn('[prefetch] Error polling CloudWatch Insights query:', err);
      return { patterns: [], rawEvents: [] };
    }
  }

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
