import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  Cell,
} from 'recharts';
import {
  TrendingUp,
  TrendingDown,
  CheckCircle,
  XCircle,
  Brain,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { LearningMetrics } from 'david-shared';
import { api } from '../../lib/api';

// ── Colors ──────────────────────────────────────────────────

const GREEN = '#10b981';
const RED = '#ef4444';
const TOOLTIP_BG = 'var(--bg-card)';
const TOOLTIP_BORDER = 'var(--border-color)';

// ── Custom Tooltips ─────────────────────────────────────────

function StripTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-md border px-2 py-1 text-[10px] shadow-lg"
      style={{ background: TOOLTIP_BG, borderColor: TOOLTIP_BORDER }}
    >
      <span className="text-[var(--text-muted)]">{label}: </span>
      <span className="font-semibold text-emerald-400">
        {payload[0].value}%
      </span>
    </div>
  );
}

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-md border px-2.5 py-1.5 text-[11px] shadow-lg"
      style={{ background: TOOLTIP_BG, borderColor: TOOLTIP_BORDER }}
    >
      <p className="mb-1 text-[var(--text-muted)]">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.dataKey === 'accepted' ? 'Accepted' : 'Rejected'}: {p.value}
        </p>
      ))}
    </div>
  );
}

function CategoryTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { category: string; total: number; accepted: number; rate: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div
      className="rounded-md border px-2.5 py-1.5 text-[11px] shadow-lg"
      style={{ background: TOOLTIP_BG, borderColor: TOOLTIP_BORDER }}
    >
      <p className="mb-1 font-medium text-[var(--text-primary)]">{d.category}</p>
      <p className="text-emerald-400">Accepted: {d.accepted}</p>
      <p className="text-red-400">Rejected: {d.total - d.accepted}</p>
      <p className="text-[var(--text-muted)]">Rate: {Math.round(d.rate * 100)}%</p>
    </div>
  );
}

function MethodTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { method: string; total: number; accepted: number; rate: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div
      className="rounded-md border px-2.5 py-1.5 text-[11px] shadow-lg"
      style={{ background: TOOLTIP_BG, borderColor: TOOLTIP_BORDER }}
    >
      <p className="mb-1 font-medium text-[var(--text-primary)]">{d.method}</p>
      <p className="text-emerald-400">Accepted: {d.accepted}</p>
      <p className="text-red-400">Rejected: {d.total - d.accepted}</p>
      <p className="text-[var(--text-muted)]">Rate: {Math.round(d.rate * 100)}%</p>
    </div>
  );
}

// ── Category label formatter ────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  'null-check': 'Null Check',
  'error-handling': 'Error Handling',
  'race-condition': 'Race Condition',
  'type-error': 'Type Error',
  'missing-validation': 'Validation',
  'resource-leak': 'Resource Leak',
  'logic-error': 'Logic Error',
  'observability': 'Observability',
  'other': 'Other',
};

function formatCategory(cat: string): string {
  return CATEGORY_LABELS[cat] ?? cat;
}

// ── Verification method label formatter ─────────────────────

const METHOD_LABELS: Record<string, string> = {
  'failing-test': 'Failing Test',
  'log-correlation': 'Log Correlation',
  'data-check': 'Data Check',
  'reproduction': 'Reproduction',
  'code-review': 'Code Review',
};

function formatMethod(m: string): string {
  return METHOD_LABELS[m] ?? m;
}

// ── Section Header ──────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      {children}
    </h4>
  );
}

// ── Main Component ──────────────────────────────────────────

export function LearningStrip() {
  const [metrics, setMetrics] = useState<LearningMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const fetchMetrics = useCallback(async () => {
    try {
      const data = await api.getLearningMetrics();
      setMetrics(data);
    } catch (err) {
      console.error('Failed to fetch learning metrics:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 60_000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  // Compute acceptance rate trend data as percentages (for the strip sparkline)
  const trendData = useMemo(() => {
    if (!metrics?.recentTrend) return [];
    return metrics.recentTrend.map((d) => {
      const total = d.accepted + d.rejected;
      const rate = total > 0 ? Math.round((d.accepted / total) * 100) : 0;
      return { date: d.date, rate };
    });
  }, [metrics?.recentTrend]);

  const acceptanceRate = metrics
    ? Math.round(metrics.acceptanceRate * 100)
    : 0;

  // Compare last 7 days vs prior 7 days
  const trendDirection = useMemo(() => {
    if (trendData.length < 14) return 'flat' as const;
    const recent = trendData.slice(-7);
    const prior = trendData.slice(-14, -7);
    const recentAvg =
      recent.reduce((s, d) => s + d.rate, 0) / recent.length;
    const priorAvg =
      prior.reduce((s, d) => s + d.rate, 0) / prior.length;
    if (recentAvg > priorAvg + 1) return 'up' as const;
    if (recentAvg < priorAvg - 1) return 'down' as const;
    return 'flat' as const;
  }, [trendData]);

  const topAccepted = metrics?.topPatterns.accepted.slice(0, 3) ?? [];
  const topRejected = metrics?.topPatterns.rejected.slice(0, 3) ?? [];

  // Category chart data
  const categoryData = useMemo(() => {
    if (!metrics?.byCategory) return [];
    return metrics.byCategory.map((c) => ({
      ...c,
      category: formatCategory(c.category),
      rejected: c.total - c.accepted,
    }));
  }, [metrics?.byCategory]);

  // Verification method chart data
  const methodData = useMemo(() => {
    if (!metrics?.byVerificationMethod) return [];
    return metrics.byVerificationMethod.map((m) => ({
      ...m,
      method: formatMethod(m.method),
      rejected: m.total - m.accepted,
    }));
  }, [metrics?.byVerificationMethod]);

  // Full pattern lists for expanded view
  const allAccepted = metrics?.topPatterns.accepted ?? [];
  const allRejected = metrics?.topPatterns.rejected ?? [];

  // ── Loading / Empty States ──────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-14 items-center rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-5">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-[var(--text-muted)]" />
          <div className="h-3 w-20 animate-pulse rounded bg-[var(--bg-tertiary)]" />
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="flex h-14 items-center rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-5 text-xs text-[var(--text-muted)]">
        <Brain className="mr-2 h-4 w-4" />
        Learning data will appear once PRs are reviewed.
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────

  return (
    <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] overflow-hidden transition-all duration-300">
      {/* ── Compact Strip (always visible) ─────────────────── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex h-14 w-full items-center gap-4 px-5 text-left transition-colors hover:bg-[var(--bg-secondary)]"
      >
        {/* Acceptance rate */}
        <div className="flex items-center gap-2 shrink-0">
          <Brain className="h-4 w-4 text-[var(--accent-blue)]" />
          <span className="text-2xl font-bold text-[var(--text-primary)] tabular-nums">
            {acceptanceRate}%
          </span>
          {trendDirection === 'up' && (
            <TrendingUp className="h-5 w-5 text-emerald-400" />
          )}
          {trendDirection === 'down' && (
            <TrendingDown className="h-5 w-5 text-red-400" />
          )}
          {trendDirection === 'flat' && (
            <span className="text-xs text-[var(--text-muted)]">--</span>
          )}
        </div>

        {/* Divider */}
        <div className="h-8 w-px shrink-0 bg-[var(--border-color)]" />

        {/* Mini sparkline */}
        <div className="h-10 w-44 shrink-0" onClick={(e) => e.stopPropagation()}>
          {trendData.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={trendData}
                margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
              >
                <defs>
                  <linearGradient id="stripGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={GREEN} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Tooltip
                  content={({ active, payload, label }) => (
                    <StripTooltip
                      active={active}
                      payload={payload as never}
                      label={label}
                    />
                  )}
                />
                <Area
                  type="monotone"
                  dataKey="rate"
                  stroke={GREEN}
                  strokeWidth={1.5}
                  fill="url(#stripGrad)"
                  dot={false}
                  activeDot={{ r: 2.5, fill: GREEN }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-[10px] text-[var(--text-muted)]">
              Not enough data
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="h-8 w-px shrink-0 bg-[var(--border-color)]" />

        {/* Pattern chips */}
        <div className="flex items-center gap-2 overflow-x-auto min-w-0">
          {topAccepted.map((p, i) => (
            <span
              key={`a-${i}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-emerald-500/20"
            >
              <CheckCircle className="h-2.5 w-2.5" />
              {p}
            </span>
          ))}
          {topRejected.map((p, i) => (
            <span
              key={`r-${i}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400 ring-1 ring-red-500/20"
            >
              <XCircle className="h-2.5 w-2.5" />
              {p}
            </span>
          ))}
          {topAccepted.length === 0 && topRejected.length === 0 && (
            <span className="text-[10px] text-[var(--text-muted)]">
              No pattern data yet
            </span>
          )}
        </div>

        {/* Expand/collapse chevron */}
        <div className="ml-auto shrink-0 pl-2">
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-[var(--text-muted)]" />
          ) : (
            <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
          )}
        </div>
      </button>

      {/* ── Expanded Panel ─────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-[var(--border-color)] p-5 space-y-5 animate-panel-expand">
          {/* Summary stats row */}
          <div className="grid grid-cols-4 gap-3">
            <StatCard
              label="Total PRs"
              value={metrics.totalPRs}
            />
            <StatCard
              label="Accepted"
              value={metrics.acceptedCount}
              color="text-emerald-400"
            />
            <StatCard
              label="Rejected"
              value={metrics.rejectedCount}
              color="text-red-400"
            />
            <StatCard
              label="Acceptance Rate"
              value={`${acceptanceRate}%`}
              color={acceptanceRate >= 70 ? 'text-emerald-400' : acceptanceRate >= 40 ? 'text-yellow-400' : 'text-red-400'}
            />
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-2 gap-5">
            {/* 30-day trend stacked area */}
            <div>
              <SectionLabel>30-Day Trend</SectionLabel>
              <div className="h-44 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
                {metrics.recentTrend.length > 1 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={metrics.recentTrend}
                      margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
                    >
                      <defs>
                        <linearGradient id="trendGreen" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={GREEN} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="trendRed" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={RED} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={RED} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(d: string) => d.slice(5)} // MM-DD
                        tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        content={({ active, payload, label }) => (
                          <TrendTooltip active={active} payload={payload as never} label={label} />
                        )}
                      />
                      <Area
                        type="monotone"
                        dataKey="accepted"
                        stackId="1"
                        stroke={GREEN}
                        strokeWidth={1.5}
                        fill="url(#trendGreen)"
                      />
                      <Area
                        type="monotone"
                        dataKey="rejected"
                        stackId="1"
                        stroke={RED}
                        strokeWidth={1.5}
                        fill="url(#trendRed)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyChart />
                )}
              </div>
            </div>

            {/* By category horizontal bars */}
            <div>
              <SectionLabel>By Bug Category</SectionLabel>
              <div className="h-44 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
                {categoryData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={categoryData}
                      layout="vertical"
                      margin={{ top: 0, right: 4, bottom: 0, left: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" horizontal={false} />
                      <XAxis
                        type="number"
                        allowDecimals={false}
                        tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="category"
                        width={80}
                        tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        content={({ active, payload }) => (
                          <CategoryTooltip active={active} payload={payload as never} />
                        )}
                        cursor={{ fill: 'var(--bg-tertiary)', opacity: 0.5 }}
                      />
                      <Bar dataKey="accepted" stackId="cat" fill={GREEN} radius={[0, 0, 0, 0]} />
                      <Bar dataKey="rejected" stackId="cat" fill={RED} radius={[0, 2, 2, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyChart />
                )}
              </div>
            </div>
          </div>

          {/* Second row: verification method + patterns */}
          <div className="grid grid-cols-2 gap-5">
            {/* By verification method */}
            <div>
              <SectionLabel>By Verification Method</SectionLabel>
              <div className="h-40 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
                {methodData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={methodData}
                      margin={{ top: 0, right: 4, bottom: 0, left: -20 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                      <XAxis
                        dataKey="method"
                        tick={{ fontSize: 9, fill: 'var(--text-secondary)' }}
                        axisLine={false}
                        tickLine={false}
                        interval={0}
                        angle={-20}
                        textAnchor="end"
                        height={40}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        content={({ active, payload }) => (
                          <MethodTooltip active={active} payload={payload as never} />
                        )}
                        cursor={{ fill: 'var(--bg-tertiary)', opacity: 0.5 }}
                      />
                      <Bar dataKey="accepted" stackId="method" fill={GREEN} />
                      <Bar dataKey="rejected" stackId="method" fill={RED} radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyChart />
                )}
              </div>
            </div>

            {/* Top patterns expanded */}
            <div>
              <SectionLabel>Top Patterns</SectionLabel>
              <div className="h-40 overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 space-y-3">
                {/* Accepted */}
                {allAccepted.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                      Accepted
                    </p>
                    <div className="space-y-1">
                      {allAccepted.map((p, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-1.5 text-[11px] text-[var(--text-secondary)]"
                        >
                          <CheckCircle className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                          <span className="break-all">{p}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Rejected */}
                {allRejected.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-400">
                      Rejected
                    </p>
                    <div className="space-y-1">
                      {allRejected.map((p, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-1.5 text-[11px] text-[var(--text-secondary)]"
                        >
                          <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                          <span className="break-all">{p}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {allAccepted.length === 0 && allRejected.length === 0 && (
                  <div className="flex h-full items-center justify-center text-[11px] text-[var(--text-muted)]">
                    No pattern data yet
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Animation */}
      <style>{`
        @keyframes panel-expand {
          from { opacity: 0; max-height: 0; }
          to { opacity: 1; max-height: 600px; }
        }
        .animate-panel-expand {
          animation: panel-expand 0.25s ease-out;
        }
      `}</style>
    </div>
  );
}

// ── Stat Card ───────────────────────────────────────────────

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5 text-center">
      <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </p>
      <p className={`mt-0.5 text-xl font-bold tabular-nums ${color ?? 'text-[var(--text-primary)]'}`}>
        {value}
      </p>
    </div>
  );
}

// ── Empty Chart Placeholder ─────────────────────────────────

function EmptyChart() {
  return (
    <div className="flex h-full items-center justify-center text-[11px] text-[var(--text-muted)]">
      Not enough data
    </div>
  );
}
