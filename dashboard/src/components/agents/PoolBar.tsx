import type { AgentType } from 'david-shared';

export interface PoolBarProps {
  active: number;
  max: number;
  queued: number;
  /** Optional breakdown of active agents by type. */
  activeByType?: Partial<Record<AgentType, number>>;
}

/** Color for each agent type segment. */
const TYPE_COLORS: Record<AgentType, string> = {
  'log-analysis': 'bg-blue-500',
  audit: 'bg-violet-500',
  fix: 'bg-emerald-500',
  verify: 'bg-amber-500',
};

/**
 * Compact single-line pool capacity gauge for the page header.
 *
 * Renders something like:
 *   [colored segments][empty] 12/30 active  +8 queued
 */
export function PoolBar({ active, max, queued, activeByType }: PoolBarProps) {
  const safeMax = Math.max(max, 1);
  const fillPercent = Math.min((active / safeMax) * 100, 100);

  // Build per-type segments if breakdown is available, otherwise single blue bar
  const segments: { color: string; percent: number }[] = [];

  if (activeByType && Object.keys(activeByType).length > 0) {
    for (const [type, count] of Object.entries(activeByType)) {
      if (count && count > 0) {
        segments.push({
          color: TYPE_COLORS[type as AgentType] ?? 'bg-blue-500',
          percent: (count / safeMax) * 100,
        });
      }
    }
  } else if (active > 0) {
    segments.push({ color: 'bg-blue-500', percent: fillPercent });
  }

  return (
    <div className="flex items-center gap-3">
      {/* Gauge bar */}
      <div className="relative h-3 w-48 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
        <div className="absolute inset-0 flex h-full">
          {segments.map((seg, i) => (
            <div
              key={i}
              className={`h-full ${seg.color} transition-all duration-500 ease-out`}
              style={{ width: `${seg.percent}%` }}
            />
          ))}
        </div>
      </div>

      {/* Counts */}
      <span className="whitespace-nowrap text-xs font-medium text-[var(--text-secondary)]">
        <span className="font-semibold text-[var(--text-primary)]">{active}</span>
        /{max} active
      </span>

      {queued > 0 && (
        <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-400 ring-1 ring-amber-500/30">
          +{queued} queued
        </span>
      )}
    </div>
  );
}
