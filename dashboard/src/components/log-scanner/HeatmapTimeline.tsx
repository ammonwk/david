import { useMemo, useState, useRef, useEffect } from 'react';
import type { LogHeatmapBucket, ScanResult } from 'david-shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HeatmapTimelineProps {
  scanHistory: ScanResult[];
  heatmapData?: LogHeatmapBucket[];
  onCellClick: (start: Date, end: Date) => void;
}

interface CellData {
  hour: Date;
  severity: 'error' | 'warn' | 'info';
  count: number;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  cell: CellData | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITY_ROWS: Array<{ key: 'error' | 'warn' | 'info'; label: string }> = [
  { key: 'error', label: 'Error' },
  { key: 'warn', label: 'Warn' },
  { key: 'info', label: 'Info' },
];

const CELL_SIZE = 14;
const CELL_GAP = 2;
const LABEL_WIDTH = 48;
const HOURS_TOTAL = 168; // 7 days * 24 hours

// Severity base colors (used for intensity scaling)
const SEVERITY_COLORS: Record<string, { r: number; g: number; b: number }> = {
  error: { r: 239, g: 68, b: 68 },   // --accent-red
  warn: { r: 245, g: 158, b: 11 },    // --accent-amber
  info: { r: 59, g: 130, b: 246 },    // --accent-blue
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHourBucket(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
  ).getTime();
}

function buildHourBuckets(): Date[] {
  const now = new Date();
  const currentHour = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
  );
  const buckets: Date[] = [];
  for (let i = HOURS_TOTAL - 1; i >= 0; i--) {
    const d = new Date(currentHour.getTime() - i * 3600_000);
    buckets.push(d);
  }
  return buckets;
}

function classifySeverity(level: string): 'error' | 'warn' | 'info' {
  const l = level.toLowerCase();
  if (l === 'error' || l === 'critical' || l === 'fatal') return 'error';
  if (l === 'warn' || l === 'warning') return 'warn';
  return 'info';
}

function aggregateCounts(
  scanHistory: ScanResult[],
  heatmapData?: LogHeatmapBucket[],
): Map<string, number> {
  // key = `${hourTimestamp}:${severity}`, value = count
  const map = new Map<string, number>();

  if (heatmapData) {
    for (const bucket of heatmapData) {
      const hourTs = getHourBucket(new Date(bucket.hour));
      const key = `${hourTs}:${bucket.severity}`;
      map.set(key, (map.get(key) || 0) + bucket.count);
    }
    return map;
  }

  for (const scan of scanHistory) {
    if (!scan.logPatterns) continue;
    for (const pattern of scan.logPatterns) {
      const sev = classifySeverity(pattern.level);
      // Use firstOccurrence to bucket into the right hour
      const hourTs = getHourBucket(new Date(pattern.firstOccurrence));
      const key = `${hourTs}:${sev}`;
      map.set(key, (map.get(key) || 0) + pattern.count);
    }
  }

  return map;
}

function cellColor(
  severity: 'error' | 'warn' | 'info',
  count: number,
  maxCount: number,
): string {
  if (count === 0) {
    return 'var(--bg-tertiary)';
  }
  const base = SEVERITY_COLORS[severity];
  // Logarithmic scale for better visual distribution
  const intensity = Math.min(1, Math.log(count + 1) / Math.log(maxCount + 1));
  // Minimum opacity 0.2, max 0.95
  const opacity = 0.15 + intensity * 0.8;
  return `rgba(${base.r}, ${base.g}, ${base.b}, ${opacity})`;
}

function formatHourLabel(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(date: Date): string {
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HeatmapTimeline({ scanHistory, heatmapData, onCellClick }: HeatmapTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    cell: null,
  });

  const hourBuckets = useMemo(() => buildHourBuckets(), []);
  const countMap = useMemo(
    () => aggregateCounts(scanHistory, heatmapData),
    [scanHistory, heatmapData],
  );

  // Compute max count for color scaling
  const maxCount = useMemo(() => {
    let max = 1;
    for (const v of countMap.values()) {
      if (v > max) max = v;
    }
    return max;
  }, [countMap]);

  // Build grid data
  const gridData = useMemo(() => {
    const data: CellData[][] = SEVERITY_ROWS.map(({ key }) =>
      hourBuckets.map((hour) => {
        const ts = hour.getTime();
        const count = countMap.get(`${ts}:${key}`) || 0;
        return { hour, severity: key, count };
      }),
    );
    return data;
  }, [hourBuckets, countMap]);

  // Day separator positions (for vertical lines + labels)
  const dayMarkers = useMemo(() => {
    const markers: Array<{ index: number; label: string }> = [];
    let lastDay = -1;
    for (let i = 0; i < hourBuckets.length; i++) {
      const day = hourBuckets[i].getDate();
      if (day !== lastDay) {
        markers.push({ index: i, label: formatDayLabel(hourBuckets[i]) });
        lastDay = day;
      }
    }
    return markers;
  }, [hourBuckets]);

  const handleMouseEnter = (cell: CellData, e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      visible: true,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top - 8,
      cell,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!tooltip.visible) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip((prev) => ({
      ...prev,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top - 8,
    }));
  };

  const handleMouseLeave = () => {
    setTooltip({ visible: false, x: 0, y: 0, cell: null });
  };

  const handleCellClick = (cell: CellData) => {
    const start = new Date(cell.hour);
    const end = new Date(start.getTime() + 3600_000);
    onCellClick(start, end);
  };

  const gridWidth = HOURS_TOTAL * (CELL_SIZE + CELL_GAP);
  const gridHeight = SEVERITY_ROWS.length * (CELL_SIZE + CELL_GAP);
  const svgWidth = LABEL_WIDTH + gridWidth + 8;
  const svgHeight = gridHeight + 28; // extra for day labels

  // Auto-scroll to the right (most recent) on mount
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [gridData]);

  // Show loading skeleton while heatmap data hasn't arrived yet
  const isLoading = heatmapData === undefined && scanHistory.length === 0;

  return (
    <div
      className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4"
      ref={containerRef}
      style={{ position: 'relative' }}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
          Log Volume Heatmap
        </h2>
        <span className="text-[10px] text-[var(--text-muted)]">
          Last 7 days — hourly buckets
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-1.5">
          {SEVERITY_ROWS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-2">
              <span className="w-10 text-right text-[10px] text-[var(--text-muted)]">{label}</span>
              <div className="h-3.5 flex-1 animate-pulse rounded bg-[var(--bg-tertiary)]" />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            className="overflow-x-auto"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <svg
              width={svgWidth}
              height={svgHeight}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              style={{ display: 'block', minWidth: svgWidth }}
            >
              {/* Row labels */}
              {SEVERITY_ROWS.map(({ key, label }, rowIdx) => (
                <text
                  key={key}
                  x={LABEL_WIDTH - 6}
                  y={rowIdx * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2 + 4}
                  textAnchor="end"
                  className="fill-[var(--text-muted)]"
                  style={{ fontSize: 10, fontFamily: 'inherit' }}
                >
                  {label}
                </text>
              ))}

              {/* Heatmap cells */}
              {gridData.map((row, rowIdx) =>
                row.map((cell, colIdx) => (
                  <rect
                    key={`${rowIdx}-${colIdx}`}
                    x={LABEL_WIDTH + colIdx * (CELL_SIZE + CELL_GAP)}
                    y={rowIdx * (CELL_SIZE + CELL_GAP)}
                    width={CELL_SIZE}
                    height={CELL_SIZE}
                    rx={2}
                    ry={2}
                    fill={cellColor(cell.severity, cell.count, maxCount)}
                    style={{
                      cursor: 'pointer',
                      transition: 'fill 150ms ease, opacity 150ms ease',
                    }}
                    onMouseEnter={(e) => handleMouseEnter(cell, e)}
                    onClick={() => handleCellClick(cell)}
                  >
                    <title />
                  </rect>
                )),
              )}

              {/* Day separator lines & labels */}
              {dayMarkers.map(({ index, label }) => {
                const x = LABEL_WIDTH + index * (CELL_SIZE + CELL_GAP);
                return (
                  <g key={index}>
                    <line
                      x1={x}
                      y1={0}
                      x2={x}
                      y2={gridHeight}
                      stroke="var(--border-color)"
                      strokeWidth={1}
                      strokeDasharray="2,2"
                      opacity={0.5}
                    />
                    <text
                      x={x + 2}
                      y={gridHeight + 14}
                      className="fill-[var(--text-muted)]"
                      style={{ fontSize: 9, fontFamily: 'inherit' }}
                    >
                      {label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Tooltip */}
          {tooltip.visible && tooltip.cell && (
            <div
              className="pointer-events-none absolute z-50 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 shadow-lg"
              style={{
                left: tooltip.x,
                top: tooltip.y,
                transform: 'translate(-50%, -100%)',
              }}
            >
              <div className="text-[10px] font-medium text-[var(--text-primary)]">
                {formatDayLabel(tooltip.cell.hour)}{' '}
                {formatHourLabel(tooltip.cell.hour)}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{
                    backgroundColor: `rgb(${SEVERITY_COLORS[tooltip.cell.severity].r}, ${SEVERITY_COLORS[tooltip.cell.severity].g}, ${SEVERITY_COLORS[tooltip.cell.severity].b})`,
                  }}
                />
                <span className="text-[10px] text-[var(--text-secondary)]">
                  {tooltip.cell.severity}:
                </span>
                <span className="text-[10px] font-semibold text-[var(--text-primary)] tabular-nums">
                  {tooltip.cell.count.toLocaleString()}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
