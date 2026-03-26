// ============================================
// David — AI SRE Tool
// Shared Type Definitions
// ============================================

// ============================================
// Enums / Union Types
// ============================================

/** Time window for log scans. */
export type ScanTimeSpan = '5m' | '15m' | '1h' | '6h' | '24h';

/** Minimum severity threshold when filtering log entries. */
export type SeverityFilter = 'all' | 'warn-error' | 'error';

/** The kind of scan that was executed. */
export type ScanType = 'log' | 'audit';

/** Severity level assigned to a discovered issue. */
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Lifecycle status of a known issue. */
export type IssueStatus = 'active' | 'investigating' | 'fixing' | 'resolved';

/** Where a bug report originated from. */
export type BugReportSource = 'log-scan' | 'codebase-audit';

/** Lifecycle status of a bug report. */
export type BugReportStatus =
  | 'reported'
  | 'verifying'
  | 'verified'
  | 'fixing'
  | 'fixed'
  | 'pr-created'
  | 'wont-fix';

/** How a bug was verified to be real. */
export type VerificationMethod =
  | 'failing-test'
  | 'log-correlation'
  | 'data-check'
  | 'reproduction'
  | 'code-review';

/** The role an agent fulfils in the pipeline. */
export type AgentType = 'log-analysis' | 'audit' | 'verify' | 'fix';

/** Lifecycle status of an agent execution. */
export type AgentStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout';

/** Current state of a pull request. */
export type PRStatus = 'open' | 'merged' | 'closed';

/** Whether a PR was ultimately accepted or rejected. */
export type PRResolution = 'accepted' | 'rejected';

/** Depth in the codebase topology tree (1 = root area, 2 = module, 3 = leaf). */
export type TopologyNodeLevel = 1 | 2 | 3;

// ============================================
// SRE State (singleton document)
// ============================================

/** A single issue pattern that David is tracking. */
export interface KnownIssue {
  id: string;
  pattern: string;
  severity: IssueSeverity;
  firstSeen: Date;
  lastSeen: Date;
  status: IssueStatus;
  rootCause?: string;
  affectedFiles?: string[];
  relatedPrIds?: string[];
}

/** Baseline resource-usage thresholds used to detect anomalies. */
export interface SREBaselines {
  cpuMax: number;
  memoryMax: number;
  errorRatePerHour: number;
  lastUpdated: Date;
}

/**
 * Singleton state document that David maintains.
 * Tracks all known and resolved issues alongside resource baselines.
 */
export interface SREState {
  knownIssues: KnownIssue[];
  baselines: SREBaselines;
  resolvedIssues: KnownIssue[];
}

// ============================================
// Scan Results
// ============================================

/** A recurring log message pattern aggregated during a scan. */
export interface LogPattern {
  message: string;
  count: number;
  level: string;
  firstOccurrence: Date;
  lastOccurrence: Date;
}

/** Resource metrics collected from ECS during a scan window. */
export interface ECSMetrics {
  cpuMax: number;
  memoryMax: number;
  spikes: Array<{ timestamp: Date; metric: string; value: number }>;
}

/** A single timestamped event from the ECS service. */
export interface ECSEvent {
  timestamp: Date;
  message: string;
}

/** Parameters that control a log scan. */
export interface ScanConfig {
  timeSpan: ScanTimeSpan;
  severity: SeverityFilter;
}

/**
 * The persisted result of a log or audit scan.
 * Created when a scan starts and updated as it progresses.
 */
export interface ScanResult {
  _id?: string;
  type: ScanType;
  startedAt: Date;
  completedAt?: Date;
  config: ScanConfig;
  logPatterns: LogPattern[];
  ecsMetrics?: ECSMetrics;
  ecsEvents?: ECSEvent[];
  newIssues: string[];
  updatedIssues: string[];
  resolvedIssues: string[];
  summary?: string;
  status: 'running' | 'completed' | 'failed';
  error?: string;
}

// ============================================
// Bug Reports
// ============================================

/** Outcome of attempting to verify a suspected bug. */
export interface VerificationResult {
  method: VerificationMethod;
  details: string;
  confirmed: boolean;
}

/**
 * A bug that David has identified, optionally verified and linked to a fix PR.
 * Progresses through the BugReportStatus lifecycle.
 */
export interface BugReport {
  _id?: string;
  source: BugReportSource;
  scanId: string;
  nodeId?: string;
  pattern: string;
  severity: IssueSeverity;
  evidence: string;
  suspectedRootCause: string;
  affectedFiles: string[];
  status: BugReportStatus;
  verificationResult?: VerificationResult;
  fixAgentId?: string;
  prId?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// Codebase Topology
// ============================================

/** A single node in the hierarchical codebase map. */
export interface TopologyNode {
  id: string;
  name: string;
  description: string;
  level: TopologyNodeLevel;
  parentId: string | null;
  files: string[];
  totalLines: number;
  children: string[];
}

/**
 * A point-in-time snapshot of the repository's structure,
 * broken into a hierarchy of TopologyNodes for targeted auditing.
 */
export interface CodebaseTopology {
  _id?: string;
  mappedAt: Date;
  commitHash: string;
  repoPath: string;
  fileCount: number;
  totalLines: number;
  nodes: TopologyNode[];
}

// ============================================
// Agents
// ============================================

/** Summary of work completed by an agent after it finishes. */
export interface AgentResult {
  bugsFound?: number;
  bugsVerified?: number;
  fixesApplied?: number;
  prsCreated?: number;
  summary: string;
}

/**
 * Persistent record of a single agent execution.
 * Tracks lifecycle, output log, restart count, and final result.
 */
export interface AgentRecord {
  _id?: string;
  type: AgentType;
  status: AgentStatus;
  taskId: string;
  nodeId?: string;
  parentAgentId?: string;
  worktreePath?: string;
  branch?: string;
  cliSessionId?: string;
  startedAt?: Date;
  completedAt?: Date;
  restarts: number;
  maxRestarts: number;
  timeoutMs: number;
  outputLog: string[];
  result?: AgentResult;
  createdAt: Date;
}

// ============================================
// Pull Requests
// ============================================

/**
 * A pull request created by a fix agent.
 * Links back to the originating bug report and agent.
 */
export interface PullRequestRecord {
  _id?: string;
  prNumber: number;
  prUrl: string;
  title: string;
  bugReportId: string;
  agentId: string;
  branch: string;
  status: PRStatus;
  resolution?: PRResolution;
  scanType: ScanType;
  nodeId?: string;
  diff: string;
  description: string;
  verificationMethod: string;
  rejectionFeedback?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

// ============================================
// Learning Records
// ============================================

/**
 * A record of PR outcome used by the learning system
 * to improve future fix quality and acceptance rates.
 */
export interface LearningRecord {
  _id?: string;
  bugCategory: string;
  filePattern: string;
  wasAccepted: boolean;
  confidence: number;
  verificationMethod: string;
  prId: string;
  feedbackNotes?: string;
  createdAt: Date;
}

// ============================================
// Scan Schedule Config
// ============================================

/** Configuration for the recurring log-scan schedule. */
export interface ScanScheduleConfig {
  enabled: boolean;
  timeSpan: ScanTimeSpan;
  severity: SeverityFilter;
  /** Cron expression derived from the chosen timeSpan. */
  cronExpression: string;
}

/** Configuration for the recurring codebase-audit schedule. */
export interface AuditScheduleConfig {
  enabled: boolean;
  /** Cron expression (default: daily). */
  cronExpression: string;
}

// ============================================
// WebSocket Event Types
// ============================================

/** All possible WebSocket event type identifiers. */
export type WSEventType =
  | 'scan:started'
  | 'scan:completed'
  | 'scan:failed'
  | 'agent:queued'
  | 'agent:started'
  | 'agent:output'
  | 'agent:completed'
  | 'agent:failed'
  | 'agent:timeout'
  | 'agent:restarted'
  | 'bug:reported'
  | 'bug:verified'
  | 'bug:fixed'
  | 'pr:created'
  | 'pr:merged'
  | 'pr:closed'
  | 'topology:mapping-started'
  | 'topology:mapping-completed'
  | 'audit:started'
  | 'audit:completed'
  | 'pool:status-update';

/** Generic envelope for every WebSocket message. */
export interface WSEvent {
  type: WSEventType;
  timestamp: Date;
  data: unknown;
}

// -- Specific event data payloads --

/** Payload for scan-related WebSocket events. */
export interface ScanEventData {
  scanId: string;
  config: ScanConfig;
}

/** Payload for agent-related WebSocket events. */
export interface AgentEventData {
  agentId: string;
  type: AgentType;
  status: AgentStatus;
  nodeId?: string;
  /** For agent:output events, the latest line of output. */
  output?: string;
}

/** Payload for bug-related WebSocket events. */
export interface BugEventData {
  bugId: string;
  pattern: string;
  severity: IssueSeverity;
  status: BugReportStatus;
}

/** Payload for pull-request-related WebSocket events. */
export interface PREventData {
  prId: string;
  prNumber: number;
  prUrl: string;
  title: string;
  status: PRStatus;
}

/** Payload for pool:status-update events. */
export interface PoolStatusData {
  activeCount: number;
  maxConcurrent: number;
  queuedCount: number;
  completedCount: number;
  failedCount: number;
}

/** Payload for topology mapping events. */
export interface TopologyEventData {
  topologyId: string;
  nodeCount?: number;
  fileCount?: number;
}

/** Payload for audit lifecycle events. */
export interface AuditEventData {
  auditId: string;
  nodeIds: string[];
  agentCount: number;
}

// ============================================
// API Request/Response Types
// ============================================

/** Request body to trigger an on-demand log scan. */
export interface TriggerScanRequest {
  timeSpan: ScanTimeSpan;
  severity: SeverityFilter;
}

/** Request body to trigger an on-demand codebase audit. */
export interface TriggerAuditRequest {
  /** Specific topology node IDs to audit. If empty/undefined, all L3 nodes are audited. */
  nodeIds?: string[];
}

/** Request body to update scan and/or audit schedules. */
export interface UpdateScheduleRequest {
  scan?: Partial<ScanScheduleConfig>;
  audit?: Partial<AuditScheduleConfig>;
}

/** Response describing current schedule configuration and next run times. */
export interface ScheduleStatusResponse {
  scan: ScanScheduleConfig & {
    isRunning: boolean;
    lastRunAt: Date | null;
    nextRunAt: Date | null;
  };
  audit: AuditScheduleConfig & {
    isRunning: boolean;
    lastRunAt: Date | null;
    nextRunAt: Date | null;
  };
}

/** Response for the agent pool status endpoint. */
export interface PoolStatusResponse extends PoolStatusData {
  agents: AgentRecord[];
  queue: AgentRecord[];
}

/** Aggregated metrics from the learning system for the dashboard. */
export interface LearningMetrics {
  totalPRs: number;
  acceptedCount: number;
  rejectedCount: number;
  acceptanceRate: number;
  byCategory: Array<{
    category: string;
    total: number;
    accepted: number;
    rate: number;
  }>;
  byVerificationMethod: Array<{
    method: string;
    total: number;
    accepted: number;
    rate: number;
  }>;
  recentTrend: Array<{
    date: string;
    accepted: number;
    rejected: number;
  }>;
  topPatterns: {
    accepted: string[];
    rejected: string[];
  };
}

// ============================================
// Activity Feed
// ============================================

/** A human-readable event shown in the dashboard activity feed. */
export interface ActivityEvent {
  id: string;
  type: WSEventType;
  message: string;
  timestamp: Date;
  severity?: 'info' | 'success' | 'warning' | 'error';
  link?: { label: string; url: string };
  /** ID of the parent event that caused this one (for causal chain grouping) */
  parentId?: string;
  /** Source entity ID (scanId, bugId, agentId, prId) for cross-referencing */
  sourceId?: string;
}

// ============================================
// Dashboard Overview Stats
// ============================================

/** Top-level statistics displayed on the dashboard home page. */
export interface OverviewStats {
  bugsFoundToday: number;
  prsCreatedToday: number;
  prsAcceptedThisWeek: number;
  activeAgents: number;
  queuedAgents: number;
  lastScanAt?: Date;
  lastAuditAt?: Date;
  systemStatus: 'running' | 'paused' | 'error';
}

// ============================================
// Theme
// ============================================

/** Light/dark/system theme preference. */
export type ThemeMode = 'light' | 'dark' | 'system';

// ============================================
// Command Palette
// ============================================

/** An action available in the Cmd+K command palette. */
export interface CommandPaletteAction {
  id: string;
  label: string;
  category: 'action' | 'agent' | 'bug' | 'pr' | 'topology';
  icon?: string;
  shortcut?: string;
  handler?: () => void;
}

// ============================================
// Toast Notifications
// ============================================

/** Severity / style of a toast notification. */
export type ToastType = 'info' | 'success' | 'warning' | 'error';

/** A transient notification shown in the top-right corner. */
export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  link?: { label: string; url: string };
  duration?: number; // ms, default 5000
}

// ============================================
// Kanban Pipeline
// ============================================

/** Column identifiers for the PR pipeline kanban board. */
export type PipelineColumn = 'reported' | 'verifying' | 'fixing' | 'pr-open' | 'merged' | 'closed';

/** A card on the kanban board combining bug report + PR info. */
export interface PipelineItem {
  id: string;
  column: PipelineColumn;
  bugReport: BugReport;
  pr?: PullRequestRecord;
  agentIds: string[];
  area?: string; // L1 > L2 label
  diffStat?: { additions: number; deletions: number };
}

// ============================================
// Health Vitals
// ============================================

/** Time-series data for the Command Center health vitals charts. */
export interface HealthVitals {
  errorRate24h: Array<{ timestamp: Date; value: number }>;
  agentThroughput24h: Array<{ timestamp: Date; value: number }>;
  queueDepth24h: Array<{ timestamp: Date; value: number }>;
  prAcceptanceRate7d: Array<{ timestamp: Date; value: number }>;
}
