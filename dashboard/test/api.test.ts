import { describe, expect, it, vi, afterEach } from 'vitest';
import { api } from '../src/lib/api';

type FetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: {
    get: (name: string) => string | null;
  };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function mockFetch(
  body: unknown,
  init?: Partial<Pick<FetchResponse, 'ok' | 'status' | 'statusText'>> & {
    contentType?: string;
  },
) {
  const contentType = init?.contentType ?? 'application/json';
  const response: FetchResponse = {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: {
      get: vi.fn((name: string) => (name.toLowerCase() === 'content-type' ? contentType : null)),
    },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body ?? '')),
  };

  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, response };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('prefixes requests with /api and serializes POST bodies', async () => {
    const { fetchMock } = mockFetch({ scanId: 'scan-123' });

    await expect(
      api.triggerScan({ timeSpan: '5m', severity: 'error' }),
    ).resolves.toEqual({ scanId: 'scan-123' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/scans/trigger',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeSpan: '5m', severity: 'error' }),
      }),
    );
  });

  it('builds query strings and defaults limits', async () => {
    const { fetchMock } = mockFetch([{ _id: 'scan-1' }]);

    await api.getScanHistory();
    await api.getPRs({ status: 'open', scanType: 'bug' });
    await api.getBugReports({ status: 'open', source: 'log-scan' });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/scans?limit=20',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/prs?status=open&scanType=bug',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/scans/bugs?status=open&source=log-scan',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
  });

  it('throws a useful error for non-OK responses', async () => {
    mockFetch(null, { ok: false, status: 503, statusText: 'Service Unavailable' });

    let error: unknown;

    try {
      await api.getTopology();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('API error: 503 Service Unavailable');
  });
});
