import mongoose, { Schema, Model } from 'mongoose';
import type {
  SREState,
  KnownIssue,
  SREBaselines,
  RuntimeSettings,
  ScanResult,
  ScanConfig,
  LogPattern,
  ECSMetrics,
  ECSEvent,
  BugReport,
  VerificationResult,
  CodebaseTopology,
  TopologyNode,
  AgentRecord,
  AgentResult,
  PullRequestRecord,
  LearningRecord,
  PromptTemplate,
  PromptTemplateVersion,
  PromptVariable,
} from 'david-shared';

// ============================================
// Sub-schemas (reusable embedded documents)
// ============================================

const KnownIssueSchema = new Schema<KnownIssue>(
  {
    id: { type: String, required: true },
    pattern: { type: String, required: true },
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], required: true },
    firstSeen: { type: Date, required: true },
    lastSeen: { type: Date, required: true },
    status: { type: String, enum: ['active', 'investigating', 'fixing', 'resolved'], required: true },
    rootCause: { type: String },
    affectedFiles: { type: [String] },
    relatedPrIds: { type: [String] },
  },
  { _id: false },
);

const SREBaselinesSchema = new Schema<SREBaselines>(
  {
    cpuMax: { type: Number, required: true },
    memoryMax: { type: Number, required: true },
    errorRatePerHour: { type: Number, required: true },
    lastUpdated: { type: Date, required: true },
  },
  { _id: false },
);

const LogPatternSchema = new Schema<LogPattern>(
  {
    message: { type: String, required: true },
    count: { type: Number, required: true },
    level: { type: String, required: true },
    firstOccurrence: { type: Date, required: true },
    lastOccurrence: { type: Date, required: true },
  },
  { _id: false },
);

const SpikeSchema = new Schema(
  {
    timestamp: { type: Date, required: true },
    metric: { type: String, required: true },
    value: { type: Number, required: true },
  },
  { _id: false },
);

const ECSMetricsSchema = new Schema<ECSMetrics>(
  {
    cpuMax: { type: Number, required: true },
    memoryMax: { type: Number, required: true },
    spikes: { type: [SpikeSchema], default: [] },
  },
  { _id: false },
);

const ECSEventSchema = new Schema<ECSEvent>(
  {
    timestamp: { type: Date, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

const ScanConfigSchema = new Schema<ScanConfig>(
  {
    timeSpan: { type: String, enum: ['5m', '15m', '1h', '6h', '24h'], required: true },
    severity: { type: String, enum: ['all', 'warn-error', 'error'], required: true },
  },
  { _id: false },
);

const VerificationResultSchema = new Schema<VerificationResult>(
  {
    method: {
      type: String,
      enum: ['failing-test', 'log-correlation', 'data-check', 'reproduction', 'code-review'],
      required: true,
    },
    details: { type: String, required: true },
    confirmed: { type: Boolean, required: true },
  },
  { _id: false },
);

const TopologyNodeSchema = new Schema<TopologyNode>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    level: { type: Number, enum: [1, 2, 3], required: true },
    parentId: { type: String, default: null },
    files: { type: [String], default: [] },
    totalLines: { type: Number, required: true },
    children: { type: [String], default: [] },
  },
  { _id: false },
);

const AgentResultSchema = new Schema<AgentResult>(
  {
    bugsFound: { type: Number },
    bugsVerified: { type: Number },
    fixesApplied: { type: Number },
    prsCreated: { type: Number },
    summary: { type: String, required: true },
  },
  { _id: false },
);

// ============================================
// SRE State (singleton)
// ============================================

interface SREStateDocument extends SREState, mongoose.Document {}

interface SREStateModelType extends Model<SREStateDocument> {
  getOrCreateState(): Promise<SREStateDocument>;
}

const sreStateSchema = new Schema<SREStateDocument>(
  {
    knownIssues: { type: [KnownIssueSchema], default: [] },
    baselines: {
      type: SREBaselinesSchema,
      default: { cpuMax: 0, memoryMax: 0, errorRatePerHour: 0, lastUpdated: new Date() },
    },
    resolvedIssues: { type: [KnownIssueSchema], default: [] },
  },
  { collection: 'sre_state' },
);

sreStateSchema.statics.getOrCreateState = async function (): Promise<SREStateDocument> {
  let state = await this.findOne();
  if (!state) {
    state = await this.create({
      knownIssues: [],
      baselines: { cpuMax: 0, memoryMax: 0, errorRatePerHour: 0, lastUpdated: new Date() },
      resolvedIssues: [],
    });
  }
  return state;
};

export const SREStateModel = mongoose.model<SREStateDocument, SREStateModelType>(
  'SREState',
  sreStateSchema,
);

// ============================================
// Runtime Settings (singleton)
// ============================================

interface RuntimeSettingsDocument extends RuntimeSettings, mongoose.Document<string> {
  _id: string;
}

interface RuntimeSettingsModelType extends Model<RuntimeSettingsDocument> {
  getOrCreateSettings(): Promise<RuntimeSettingsDocument>;
}

const runtimeSettingsSchema = new Schema<RuntimeSettingsDocument>(
  {
    _id: { type: String, default: 'singleton' },
    cliBackend: { type: String, enum: ['claude', 'codex'], required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'runtime_settings' },
);

runtimeSettingsSchema.statics.getOrCreateSettings = async function (): Promise<RuntimeSettingsDocument> {
  let settings = await this.findById('singleton');
  if (!settings) {
    settings = await this.create({
      _id: 'singleton',
      cliBackend: 'codex',
      updatedAt: new Date(),
    });
  }
  return settings;
};

export const RuntimeSettingsModel = mongoose.model<
  RuntimeSettingsDocument,
  RuntimeSettingsModelType
>('RuntimeSettings', runtimeSettingsSchema);

// ============================================
// Scan Results
// ============================================

interface ScanResultDocument extends ScanResult, mongoose.Document<string> {
  _id: string;
}

const scanResultSchema = new Schema<ScanResultDocument>(
  {
    _id: { type: String, required: true },
    type: { type: String, enum: ['log', 'audit'], required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    config: { type: ScanConfigSchema, required: true },
    logPatterns: { type: [LogPatternSchema], default: [] },
    ecsMetrics: { type: ECSMetricsSchema },
    ecsEvents: { type: [ECSEventSchema] },
    newIssues: { type: [String], default: [] },
    updatedIssues: { type: [String], default: [] },
    resolvedIssues: { type: [String], default: [] },
    summary: { type: String },
    status: { type: String, enum: ['running', 'completed', 'failed'], required: true },
    error: { type: String },
  },
  { collection: 'scan_results' },
);

scanResultSchema.index({ type: 1, startedAt: -1, status: 1 });

export const ScanResultModel = mongoose.model<ScanResultDocument>('ScanResult', scanResultSchema);

// ============================================
// Bug Reports
// ============================================

interface BugReportDocument extends Omit<BugReport, '_id'>, mongoose.Document {}

const bugReportSchema = new Schema<BugReportDocument>(
  {
    source: { type: String, enum: ['log-scan', 'codebase-audit'], required: true },
    scanId: { type: String, required: true },
    nodeId: { type: String },
    pattern: { type: String, required: true },
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], required: true },
    evidence: { type: String, required: true },
    suspectedRootCause: { type: String, required: true },
    affectedFiles: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['reported', 'verifying', 'verified', 'fixing', 'fixed', 'pr-created', 'wont-fix'],
      required: true,
    },
    verificationResult: { type: VerificationResultSchema },
    fixAgentId: { type: String },
    prId: { type: String },
  },
  { collection: 'bug_reports', timestamps: true },
);

bugReportSchema.index({ status: 1, source: 1, severity: 1, scanId: 1 });

export const BugReportModel = mongoose.model<BugReportDocument>('BugReport', bugReportSchema);

// ============================================
// Codebase Topology
// ============================================

interface CodebaseTopologyDocument extends Omit<CodebaseTopology, '_id'>, mongoose.Document {}

interface CodebaseTopologyModelType extends Model<CodebaseTopologyDocument> {
  getLatest(): Promise<CodebaseTopology | null>;
}

const codebaseTopologySchema = new Schema<CodebaseTopologyDocument>(
  {
    mappedAt: { type: Date, required: true },
    commitHash: { type: String, required: true },
    repoPath: { type: String, required: true },
    fileCount: { type: Number, required: true },
    totalLines: { type: Number, required: true },
    nodes: { type: [TopologyNodeSchema], default: [] },
  },
  { collection: 'codebase_topology' },
);

codebaseTopologySchema.index({ mappedAt: -1 });

codebaseTopologySchema.statics.getLatest =
  async function (): Promise<CodebaseTopology | null> {
    const doc = await this.findOne().sort({ mappedAt: -1 }).lean();
    if (!doc) return null;
    return { ...doc, _id: String(doc._id) } as CodebaseTopology;
  };

export const CodebaseTopologyModel = mongoose.model<
  CodebaseTopologyDocument,
  CodebaseTopologyModelType
>('CodebaseTopology', codebaseTopologySchema);

// ============================================
// Agents
// ============================================

interface AgentRecordDocument extends Omit<AgentRecord, '_id'>, mongoose.Document<string> {
  _id: string;
}

const agentSchema = new Schema<AgentRecordDocument>(
  {
    _id: { type: String, required: true },
    type: { type: String, enum: ['log-analysis', 'audit', 'verify', 'fix'], required: true },
    status: {
      type: String,
      enum: ['queued', 'starting', 'running', 'completed', 'failed', 'timeout'],
      required: true,
    },
    taskId: { type: String, required: true },
    nodeId: { type: String },
    parentAgentId: { type: String },
    worktreePath: { type: String },
    branch: { type: String },
    cliSessionId: { type: String },
    startedAt: { type: Date },
    completedAt: { type: Date },
    restarts: { type: Number, default: 0 },
    maxRestarts: { type: Number, required: true },
    timeoutMs: { type: Number, required: true },
    outputLog: { type: [String], default: [] },
    result: { type: AgentResultSchema },
    prompt: { type: String },
    systemPrompt: { type: String },
    worktreeType: { type: String, enum: ['branch', 'snapshot'] },
    worktreeIdentifier: { type: String },
  },
  { collection: 'agents', timestamps: true },
);

agentSchema.index({ status: 1, type: 1, parentAgentId: 1 });
agentSchema.index({ createdAt: -1 });

export const AgentModel = mongoose.model<AgentRecordDocument>('Agent', agentSchema);

// ============================================
// Pull Requests
// ============================================

interface PullRequestDocument extends Omit<PullRequestRecord, '_id'>, mongoose.Document {}

const pullRequestSchema = new Schema<PullRequestDocument>(
  {
    prNumber: { type: Number, required: true },
    prUrl: { type: String, required: true },
    title: { type: String, required: true },
    bugReportId: { type: String, required: true },
    agentId: { type: String, required: true },
    branch: { type: String, required: true },
    status: { type: String, enum: ['open', 'merged', 'closed'], required: true },
    resolution: { type: String, enum: ['accepted', 'rejected'] },
    scanType: { type: String, enum: ['log', 'audit'], required: true },
    nodeId: { type: String },
    diff: { type: String, required: true },
    description: { type: String, required: true },
    verificationMethod: { type: String, required: true },
    rejectionFeedback: { type: String },
    createdAt: { type: Date, required: true },
    resolvedAt: { type: Date },
  },
  { collection: 'pull_requests' },
);

pullRequestSchema.index({ status: 1, prNumber: 1, scanType: 1 });

export const PullRequestModel = mongoose.model<PullRequestDocument>(
  'PullRequest',
  pullRequestSchema,
);

// ============================================
// Learning Records
// ============================================

interface LearningRecordDocument extends Omit<LearningRecord, '_id'>, mongoose.Document {}

const learningRecordSchema = new Schema<LearningRecordDocument>(
  {
    bugCategory: { type: String, required: true },
    filePattern: { type: String, required: true },
    wasAccepted: { type: Boolean, required: true },
    confidence: { type: Number, required: true },
    verificationMethod: { type: String, required: true },
    prId: { type: String, required: true },
    feedbackNotes: { type: String },
    createdAt: { type: Date, required: true },
  },
  { collection: 'learning_records' },
);

learningRecordSchema.index({ bugCategory: 1, wasAccepted: 1, createdAt: 1 });

export const LearningRecordModel = mongoose.model<LearningRecordDocument>(
  'LearningRecord',
  learningRecordSchema,
);

// ============================================
// Prompt Templates
// ============================================

const PromptVariableSchema = new Schema<PromptVariable>(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
  },
  { _id: false },
);

const PromptTemplateVersionSchema = new Schema<PromptTemplateVersion>(
  {
    version: { type: Number, required: true },
    body: { type: String, required: true },
    editedAt: { type: Date, required: true },
    changeDescription: { type: String },
  },
  { _id: false },
);

interface PromptTemplateDocument extends Omit<PromptTemplate, '_id'>, mongoose.Document<string> {
  _id: string;
}

const promptTemplateSchema = new Schema<PromptTemplateDocument>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    body: { type: String, required: true },
    variables: { type: [PromptVariableSchema], default: [] },
    versions: { type: [PromptTemplateVersionSchema], default: [] },
    updatedAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: 'prompt_templates' },
);

export const PromptTemplateModel = mongoose.model<PromptTemplateDocument>(
  'PromptTemplate',
  promptTemplateSchema,
);
