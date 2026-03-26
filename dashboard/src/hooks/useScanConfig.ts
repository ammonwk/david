import { useState, useEffect, useCallback } from 'react';
import type {
  ScanScheduleConfig,
  AuditScheduleConfig,
  ScheduleStatusResponse,
  TriggerScanRequest,
  ScanTimeSpan,
  SeverityFilter,
} from 'david-shared';
import { api } from '../lib/api';

export function useScanConfig() {
  const [scanConfig, setScanConfig] = useState<ScanScheduleConfig | null>(null);
  const [auditConfig, setAuditConfig] = useState<AuditScheduleConfig | null>(null);
  const [nextScanRun, setNextScanRun] = useState<Date | undefined>();
  const [nextAuditRun, setNextAuditRun] = useState<Date | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSchedule = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getSchedule();
      setScanConfig(data.scan);
      setAuditConfig(data.audit);
      setNextScanRun(data.scan.nextRunAt ? new Date(data.scan.nextRunAt) : undefined);
      setNextAuditRun(data.audit.nextRunAt ? new Date(data.audit.nextRunAt) : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch schedule');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  const updateScanConfig = useCallback(async (updates: Partial<ScanScheduleConfig>) => {
    try {
      setError(null);
      const data = await api.updateSchedule({ scan: updates });
      setScanConfig(data.scan);
      setAuditConfig(data.audit);
      setNextScanRun(data.scan.nextRunAt ? new Date(data.scan.nextRunAt) : undefined);
      setNextAuditRun(data.audit.nextRunAt ? new Date(data.audit.nextRunAt) : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update scan config');
    }
  }, []);

  const updateAuditConfig = useCallback(async (updates: Partial<AuditScheduleConfig>) => {
    try {
      setError(null);
      const data = await api.updateSchedule({ audit: updates });
      setScanConfig(data.scan);
      setAuditConfig(data.audit);
      setNextScanRun(data.scan.nextRunAt ? new Date(data.scan.nextRunAt) : undefined);
      setNextAuditRun(data.audit.nextRunAt ? new Date(data.audit.nextRunAt) : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update audit config');
    }
  }, []);

  const triggerScan = useCallback(async (timeSpan: ScanTimeSpan, severity: SeverityFilter) => {
    try {
      setError(null);
      const config: TriggerScanRequest = { timeSpan, severity };
      return await api.triggerScan(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger scan');
      return null;
    }
  }, []);

  return {
    scanConfig,
    auditConfig,
    nextScanRun,
    nextAuditRun,
    updateScanConfig,
    updateAuditConfig,
    triggerScan,
    loading,
    error,
  };
}
