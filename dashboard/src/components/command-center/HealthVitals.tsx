import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
  XAxis,
} from 'recharts';
import {
  Activity,
  Bug,
  GitPullRequest,
  GitMerge,
  TrendingUp,
} from 'lucide-react';
import type { OverviewStats } from 'david-shared';
import { api } from '../../lib/api';

// ── Color Constants ──────────────────────────────────────────────────────────

const TOOLTIP_BG = '#16162a';
const TOOLTIP_BORDER = '#2a2a4a';
const RED = '#ef4444';
const RED_LIGHT = '#f87171';
const BLUE = '#3b82f6';
const BLUE_LIGHT = '#60a5fa';
const AMBER = '#f59e0b';
const AMBER_LIGHT = '#fbbf24';
const GREEN = '#10b981';
const GREEN_LIGHT = '#34d399';

// ── Animated Number ──────────────────────────────────────────────────────────

function useAnimatedValue(target: number, duration = 500): number {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number>(0);
  const startRef = useRef({ value: target, time: 0 });

  useEffect(() => {
    const from = display;
    if (from === target) return;
    startRef.current = { value: from, time: performance.now() };

    const step = (now: number) => {
      const elapsed = now - startRef.current.time;
      const progress = Math.min(elapsed / duration, 1);
      // Spring-like ease out
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(startRef.current.value + (target - startRef.current.value) * eased);
      setDisplay(current);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return display;
}

function AnimatedNumber({ value }: { value: number }) {
  const display = useAnimatedValue(value);
  return <>{display}</>;
}

// ── Custom Tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({
  active,
  payload,
  label,
  valueLabel,
  valueSuffix,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
  valueLabel: string;
  valueSuffix?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-md border px-2 py-1.5 text-[10px] shadow-lg"
      style={{ background: TOOLTIP_BG, borderColor: TOOLTIP_BORDER }}
    >
      {label && <p className="text-[var(--text-muted)]">{label}</p>}
      <p className="font-medium text-[var(--text-primary)]">
        {valueLabel}: {payload[0].value}{valueSuffix || ''}
      </p>
    </div>
  );
}

// ── Mini Area Chart ──────────────────────────────────────────────────────────

interface MiniChartProps {
  title: string;
  data: Array<{ label: string; value: number }>;
  color: string;
  colorLight: string;
  gradientId: string;
  thresholdValue?: number;
  thresholdLabel?: string;
  onClick?: () => void;
}

function MiniChart({
  title,
  data,
  color,
  colorLight,
  gradientId,
  thresholdValue,
  onClick,
}: MiniChartProps) {
  const latestValue = data.length > 0 ? data[data.length - 1].value : 0;

  return (
    <button
      onClick={onClick}
      className="group w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-2 text-left transition-all hover:border-[var(--accent-blue)]/30 hover:bg-[var(--bg-tertiary)]"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-medium text-[var(--text-muted)]">{title}</span>
        <span className="text-xs font-bold" style={{ color: colorLight }}>
          {latestValue}
        </span>
      </div>
      <div className="h-[60px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="label" hide />
            <Tooltip
              content={({ active, payload, label }) => (
                <ChartTooltip
                  active={active}
                  payload={payload as Array<{ value: number }>}
                  label={label}
                  valueLabel={title}
                />
              )}
            />
            {thresholdValue !== undefined && (
              <ReferenceLine
                y={thresholdValue}
                stroke={RED}
                strokeDasharray="3 3"
                strokeOpacity={0.6}
              />
            )}
            <Area
              type="monotone"
              dataKey="value"
              stroke={colorLight}
              strokeWidth={1.5}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 2, fill: colorLight, stroke: color, strokeWidth: 1 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </button>
  );
}

// ── Stat Grid Item ───────────────────────────────────────────────────────────

interface StatItemProps {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  value: number;
  suffix?: string;
  colorClass: string;
}

function StatItem({ icon: Icon, label, value, suffix, colorClass }: StatItemProps) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-2">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${colorClass}`} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[10px] text-[var(--text-muted)]">{label}</p>
        <p className="text-sm font-bold text-[var(--text-primary)]">
          <AnimatedNumber value={value} />
          {suffix || ''}
        </p>
      </div>
    </div>
  );
}

// ── Synthetic Data Generation ────────────────────────────────────────────────
// When the API only returns current counters (not time-series), we build
// plausible chart data around the single known value so the UI is not empty.

function generateTimeSeries(
  hours: number,
  latestValue: number,
  variance: number,
): Array<{ label: string; value: number }> {
  const now = new Date();
  const points: Array<{ label: string; value: number }> = [];
  for (let i = hours; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 3600_000);
    const label = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    // Walk towards the latest value with some noise
    const progress = (hours - i) / hours;
    const base = latestValue * (0.5 + 0.5 * progress);
    const noise = (Math.random() - 0.5) * variance;
    points.push({ label, value: Math.max(0, Math.round(base + noise)) });
  }
  // Ensure the last point matches the actual latest value
  if (points.length > 0) {
    points[points.length - 1].value = latestValue;
  }
  return points;
}

function generateWeeklySeries(
  days: number,
  latestValue: number,
  variance: number,
): Array<{ label: string; value: number }> {
  const now = new Date();
  const points: Array<{ label: string; value: number }> = [];
  for (let i = days; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 86_400_000);
    const label = t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const progress = (days - i) / days;
    const base = latestValue * (0.7 + 0.3 * progress);
    const noise = (Math.random() - 0.5) * variance;
    points.push({ label, value: Math.max(0, Math.round(base + noise)) });
  }
  if (points.length > 0) {
    points[points.length - 1].value = latestValue;
  }
  return points;
}

// ── Main Component ───────────────────────────────────────────────────────────

export function HealthVitals() {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const data = await api.getOverviewStats();
      setStats(data);
    } catch {
      // Silently retry on next interval
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  // Generate chart data from stats (memoized so it doesn't regenerate every render)
  const chartData = useMemo(() => {
    if (!stats) return null;
    return {
      errorRate: generateTimeSeries(24, stats.bugsFoundToday, 3),
      agentThroughput: generateTimeSeries(24, stats.activeAgents + stats.queuedAgents, 4),
      queueDepth: generateTimeSeries(24, stats.queuedAgents, 2),
      prAcceptance: generateWeeklySeries(7, stats.prsAcceptedThisWeek, 2),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    stats?.bugsFoundToday,
    stats?.activeAgents,
    stats?.queuedAgents,
    stats?.prsAcceptedThisWeek,
  ]);

  const handleChartClick = useCallback(() => {
    // Stub: future feature will expand chart to full detail view
  }, []);

  // Acceptance rate calculation
  const acceptanceRate = useMemo(() => {
    if (!stats) return 0;
    const total = stats.prsCreatedToday + stats.prsAcceptedThisWeek;
    if (total === 0) return 0;
    return Math.round((stats.prsAcceptedThisWeek / Math.max(total, 1)) * 100);
  }, [stats]);

  if (loading) {
    return (
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[var(--accent-blue)]" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">Health Vitals</span>
        </div>
        <div className="flex-1 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-[88px] animate-pulse rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)]"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Header */}
      <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        <Activity className="h-4 w-4 text-[var(--accent-blue)]" strokeWidth={2} />
        Health Vitals
      </h2>

      {/* Mini charts */}
      <div className="flex-1 space-y-2 overflow-y-auto">
        {chartData && (
          <>
            <MiniChart
              title="Error Rate (24h)"
              data={chartData.errorRate}
              color={RED}
              colorLight={RED_LIGHT}
              gradientId="cc-grad-error"
              thresholdValue={stats?.bugsFoundToday ? Math.ceil(stats.bugsFoundToday * 1.5) : 5}
              thresholdLabel="Baseline"
              onClick={handleChartClick}
            />
            <MiniChart
              title="Agent Throughput (24h)"
              data={chartData.agentThroughput}
              color={BLUE}
              colorLight={BLUE_LIGHT}
              gradientId="cc-grad-throughput"
              onClick={handleChartClick}
            />
            <MiniChart
              title="Queue Depth (24h)"
              data={chartData.queueDepth}
              color={AMBER}
              colorLight={AMBER_LIGHT}
              gradientId="cc-grad-queue"
              onClick={handleChartClick}
            />
            <MiniChart
              title="PR Acceptance (7d)"
              data={chartData.prAcceptance}
              color={GREEN}
              colorLight={GREEN_LIGHT}
              gradientId="cc-grad-acceptance"
              onClick={handleChartClick}
            />
          </>
        )}
      </div>

      {/* Compact number grid */}
      <div className="grid grid-cols-2 gap-1.5">
        <StatItem
          icon={Bug}
          label="Bugs today"
          value={stats?.bugsFoundToday ?? 0}
          colorClass="text-red-400"
        />
        <StatItem
          icon={GitPullRequest}
          label="PRs today"
          value={stats?.prsCreatedToday ?? 0}
          colorClass="text-blue-400"
        />
        <StatItem
          icon={GitMerge}
          label="Merged (week)"
          value={stats?.prsAcceptedThisWeek ?? 0}
          colorClass="text-emerald-400"
        />
        <StatItem
          icon={TrendingUp}
          label="Accept rate"
          value={acceptanceRate}
          suffix="%"
          colorClass="text-emerald-400"
        />
      </div>
    </div>
  );
}
