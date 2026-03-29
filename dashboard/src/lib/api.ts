import type {
  ScanResult,
  BugReport,
  AgentRecord,
  PullRequestRecord,
  CodebaseTopology,
  SREState,
  PoolStatusResponse,
  LearningMetrics,
  ScheduleStatusResponse,
  TriggerScanRequest,
  TriggerAuditRequest,
  UpdateScheduleRequest,
  OverviewStats,
  PipelineItem,
  LogHeatmapBucket,
  HealthVitals,
  VitalsTimeframe,
  RuntimeSettings,
  UpdateRuntimeSettingsRequest,
  PoolStatusData,
  PromptTemplate,
  UpdatePromptTemplateRequest,
} from 'david-shared';

const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    let detail = '';

    try {
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const body = await res.json() as { error?: string; message?: string };
        detail = body.error ?? body.message ?? '';
      } else {
        detail = (await res.text()).trim();
      }
    } catch {
      // Ignore response-body parsing errors and fall back to status text.
    }

    const summary = `API error: ${res.status} ${res.statusText}`;
    throw new Error(detail ? `${summary} - ${detail}` : summary);
  }

  return res.json();
}

export const api = {
  // Overview
  getOverviewStats: () => request<OverviewStats>('/state/overview'),

  // Scans
  triggerScan: (config: TriggerScanRequest) =>
    request<{ scanId: string }>('/scans/trigger', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  getScanHistory: (limit?: number) =>
    request<ScanResult[]>(`/scans?limit=${limit || 20}`),
  getScan: (id: string) => request<ScanResult>(`/scans/${id}`),
  getLogHeatmap: (hours = 168) =>
    request<LogHeatmapBucket[]>(`/scans/heatmap?hours=${hours}`),

  // Schedule
  getSchedule: () => request<ScheduleStatusResponse>('/scans/schedule/status'),
  updateSchedule: (updates: UpdateScheduleRequest) =>
    request<ScheduleStatusResponse>('/scans/schedule', {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  // Topology
  getTopology: () => request<CodebaseTopology>('/topology'),
  triggerMapping: () =>
    request<{ topologyId: string }>('/topology/map', { method: 'POST' }),
  triggerAudit: (req: TriggerAuditRequest) =>
    request<{ auditId: string }>('/topology/audit', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  // Agents
  getAgents: () => request<PoolStatusResponse>('/agents'),
  getAgent: (id: string) => request<AgentRecord>(`/agents/${id}`),
  getAgentOutput: (id: string) =>
    request<{ output: string[] }>(`/agents/${id}/output`),
  stopAgent: (id: string) =>
    request<void>(`/agents/${id}/stop`, { method: 'POST' }),
  getMaxConcurrent: () =>
    request<{ maxConcurrent: number }>('/agents/pool/max-concurrent'),
  setMaxConcurrent: (maxConcurrent: number) =>
    request<PoolStatusData>('/agents/pool/max-concurrent', {
      method: 'PUT',
      body: JSON.stringify({ maxConcurrent }),
    }),

  // PRs
  getPRs: (filters?: { status?: string; scanType?: string; agentId?: string }) => {
    const params = new URLSearchParams(filters as Record<string, string>);
    return request<PullRequestRecord[]>(`/prs?${params}`);
  },
  getLearningMetrics: () => request<LearningMetrics>('/prs/learning'),

  // SRE State
  getSREState: () => request<SREState>('/state'),
  getRuntimeSettings: () => request<RuntimeSettings>('/state/runtime'),
  updateRuntimeSettings: (updates: UpdateRuntimeSettingsRequest) =>
    request<RuntimeSettings>('/state/runtime', {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  // Bug Reports
  getBugReports: (filters?: { status?: string; source?: string }) => {
    const params = new URLSearchParams(filters as Record<string, string>);
    return request<BugReport[]>(`/scans/bugs?${params}`);
  },

  // Pipeline (Kanban board)
  getPipelineItems: () => request<PipelineItem[]>('/prs/pipeline'),

  // Health vitals
  getHealthVitals: (timeframe?: VitalsTimeframe) =>
    request<HealthVitals>(`/state/vitals${timeframe ? `?timeframe=${timeframe}` : ''}`),

  // Topology history
  getTopologyHistory: (limit?: number) =>
    request<CodebaseTopology[]>(`/topology/history?limit=${limit || 10}`),

  // Prompt Templates
  getPrompts: () => request<PromptTemplate[]>('/prompts'),
  getPrompt: (id: string) => request<PromptTemplate>(`/prompts/${id}`),
  updatePrompt: (id: string, update: UpdatePromptTemplateRequest) =>
    request<PromptTemplate>(`/prompts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(update),
    }),
  revertPrompt: (id: string, version: number) =>
    request<PromptTemplate>(`/prompts/${id}/revert`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),
  resetPrompt: (id: string) =>
    request<PromptTemplate>(`/prompts/${id}/reset`, {
      method: 'POST',
    }),
};
