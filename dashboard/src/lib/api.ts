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
  HealthVitals,
  RuntimeSettings,
  UpdateRuntimeSettingsRequest,
} from 'david-shared';

const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
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

  // PRs
  getPRs: (filters?: { status?: string; scanType?: string }) => {
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
  getHealthVitals: () => request<HealthVitals>('/state/vitals'),

  // Topology history
  getTopologyHistory: (limit?: number) =>
    request<CodebaseTopology[]>(`/topology/history?limit=${limit || 10}`),
};
