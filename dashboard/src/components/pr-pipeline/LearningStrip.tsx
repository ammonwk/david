import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { TrendingUp, TrendingDown, CheckCircle, XCircle, Brain } from 'lucide-react';
import type { LearningMetrics } from 'david-shared';
import { api } from '../../lib/api';

// ── Colors ──────────────────────────────────────────────────

const GREEN = '#10b981';
const GREEN_FILL = '#10b98130';
const TOOLTIP_BG = 'var(--bg-card)';
const TOOLTIP_BORDER = 'var(--border-color)';

// ── Custom Tooltip ──────────────────────────────────────────

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
      style={{
        background: TOOLTIP_BG,
        borderColor: TOOLTIP_BORDER,
      }}
    >
      <span className="text-[var(--text-muted)]">{label}: </span>
      <span className="font-semibold text-emerald-400">
        {payload[0].value}%
      </span>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────

export function LearningStrip() {
  const [metrics, setMetrics] = useState<LearningMetrics | null>(null);
  const [loading, setLoading] = useState(true);

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
    // Refresh every 60 seconds
    const interval = setInterval(fetchMetrics, 60_000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  // Compute acceptance rate trend data as percentages
  const trendData = useMemo(() => {
    if (!metrics?.recentTrend) return [];
    return metrics.recentTrend.map((d) => {
      const total = d.accepted + d.rejected;
      const rate = total > 0 ? Math.round((d.accepted / total) * 100) : 0;
      return { date: d.date, rate };
    });
  }, [metrics?.recentTrend]);

  // Compute current rate and trend direction
  const acceptanceRate = metrics
    ? Math.round(metrics.acceptanceRate * 100)
    : 0;

  // Compare last 7 days vs prior 7 days from the trend data
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

  // Loading / empty skeleton
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

  return (
    <div className="flex h-14 items-center gap-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-5 overflow-hidden">
      {/* Left: acceptance rate number with trend arrow */}
      <div className="flex items-center gap-2 shrink-0">
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

      {/* Center: mini area chart */}
      <div className="h-10 w-44 shrink-0">
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

      {/* Right: top patterns as chips */}
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
    </div>
  );
}
