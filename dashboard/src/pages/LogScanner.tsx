import { useState, useEffect, useCallback } from 'react';
import type {
  ScanResult,
  ScanScheduleConfig,
  KnownIssue,
  SREState,
  ScanTimeSpan,
  SeverityFilter,
  LogHeatmapBucket,
} from 'david-shared';
import {
  Search,
  Settings,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { api } from '../lib/api';
import { useScanConfig } from '../hooks/useScanConfig';
import { useSocketEvent } from '../hooks/useSocket';
import { HeatmapTimeline } from '../components/log-scanner/HeatmapTimeline';
import { ScanHistory } from '../components/log-scanner/ScanHistory';
import { ScanConfigDrawer } from '../components/log-scanner/ScanConfigDrawer';

// ---------------------------------------------------------------------------
// Main LogScanner Page
// ---------------------------------------------------------------------------

export function LogScanner() {
  const {
    scanConfig,
    nextScanRun,
    updateScanConfig,
    triggerScan,
    loading: configLoading,
    error: configError,
  } = useScanConfig();

  const [scanHistory, setScanHistory] = useState<ScanResult[]>([]);
  const [heatmapBuckets, setHeatmapBuckets] = useState<LogHeatmapBucket[] | undefined>(undefined);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [heatmapFilter, setHeatmapFilter] = useState<{ start: Date; end: Date } | null>(null);

  // Known issues map for enriching issue IDs with pattern text
  const [knownIssuesMap, setKnownIssuesMap] = useState<Map<string, KnownIssue>>(new Map());

  // Fetch scan history
  const fetchHistory = useCallback(async () => {
    try {
      setHistoryError(null);
      const results = await api.getScanHistory(50);
      setScanHistory(results);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load scan history');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const fetchHeatmap = useCallback(async () => {
    try {
      const buckets = await api.getLogHeatmap(168);
      setHeatmapBuckets(buckets);
    } catch {
      setHeatmapBuckets(undefined);
    }
  }, []);

  // Fetch SRE state for known issues
  const fetchSREState = useCallback(async () => {
    try {
      const state = await api.getSREState();
      const map = new Map<string, KnownIssue>();
      for (const issue of [...state.knownIssues, ...state.resolvedIssues]) {
        map.set(issue.id, issue);
      }
      setKnownIssuesMap(map);
    } catch {
      // Non-critical, the page works without it
    }
  }, []);

  useEffect(() => {
    fetchHistory();
    fetchSREState();
    fetchHeatmap();
  }, [fetchHeatmap, fetchHistory, fetchSREState]);

  // Listen for real-time scan events
  useSocketEvent<{ scanId: string }>('scan:started', () => {
    setIsScanning(true);
    setScanProgress('Starting scan...');
    fetchHistory();
  });

  useSocketEvent<{ scanId: string }>('scan:completed', () => {
    setIsScanning(false);
    setScanProgress(null);
    fetchHistory();
    fetchSREState();
    fetchHeatmap();
  });

  useSocketEvent<{ scanId: string }>('scan:failed', () => {
    setIsScanning(false);
    setScanProgress(null);
    fetchHistory();
    fetchHeatmap();
  });

  // Handle triggering a scan
  const handleTriggerScan = async (config: { timeSpan: string; severity: string }) => {
    setIsScanning(true);
    setScanProgress('Initiating scan...');
    const result = await triggerScan(
      config.timeSpan as ScanTimeSpan,
      config.severity as SeverityFilter,
    );
    if (!result) {
      setIsScanning(false);
      setScanProgress(null);
    }
    // If successful, the socket event will update state
  };

  // Handle heatmap cell click
  const handleHeatmapClick = (start: Date, end: Date) => {
    setHeatmapFilter({ start, end });
  };

  const handleClearFilter = () => {
    setHeatmapFilter(null);
  };

  // Default config while loading
  const defaultConfig: ScanScheduleConfig = {
    enabled: true,
    timeSpan: '5m',
    severity: 'all',
    cronExpression: '*/5 * * * *',
  };

  const activeConfig = scanConfig || defaultConfig;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* ── Page Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent-blue)]/10">
            <Search className="h-5 w-5 text-[var(--accent-blue)]" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-[var(--text-primary)]">Log Scanner</h1>
            <p className="text-xs text-[var(--text-muted)]">
              Monitor CloudWatch logs for error patterns and anomalies
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Live scan indicator */}
          {isScanning && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--accent-blue)]/30 bg-[var(--accent-blue)]/5 px-3 py-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent-blue)]" />
              <span className="text-xs font-medium text-[var(--accent-blue)]">
                {scanProgress || 'Scanning...'}
              </span>
            </div>
          )}

          {/* Gear icon — opens config drawer */}
          <button
            onClick={() => setDrawerOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            aria-label="Open scan configuration"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Live Scan Progress Bar ───────────────────────────────── */}
      {isScanning && (
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent-blue)]"
            style={{
              animation: 'scan-progress 2s ease-in-out infinite',
              width: '40%',
            }}
          />
          <style>{`
            @keyframes scan-progress {
              0% { transform: translateX(-100%); }
              100% { transform: translateX(350%); }
            }
          `}</style>
        </div>
      )}

      {/* ── Config Error ─────────────────────────────────────────── */}
      {configError && (
        <div className="rounded-lg border border-[var(--accent-red)]/30 bg-[var(--accent-red)]/5 px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-[var(--accent-red)]" />
            <p className="text-xs text-[var(--accent-red)]">{configError}</p>
          </div>
        </div>
      )}

      {/* ── Heatmap Timeline ─────────────────────────────────────── */}
      <HeatmapTimeline
        scanHistory={scanHistory}
        heatmapData={heatmapBuckets}
        onCellClick={handleHeatmapClick}
      />

      {/* ── Scan History ─────────────────────────────────────────── */}
      <ScanHistory
        scanHistory={scanHistory}
        knownIssuesMap={knownIssuesMap}
        loading={historyLoading}
        error={historyError}
        timeFilter={heatmapFilter}
        onClearFilter={handleClearFilter}
      />

      {/* ── Config Drawer ────────────────────────────────────────── */}
      <ScanConfigDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        config={activeConfig}
        onConfigChange={updateScanConfig}
        onTriggerScan={handleTriggerScan}
        nextRunAt={nextScanRun ? new Date(nextScanRun) : undefined}
        isScanning={isScanning}
      />
    </div>
  );
}
