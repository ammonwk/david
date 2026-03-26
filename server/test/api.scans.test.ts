import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createJsonApp } from './helpers/app.js';
import { cleanupTestEnv, clearDatabase, createTestEnv, type TestEnvContext } from './helpers/test-env.js';

describe('scans API router', () => {
  let mongo: MongoMemoryServer;
  let testEnv: TestEnvContext;
  let connectDB: typeof import('../src/db/connection.js').connectDB;
  let disconnectDB: typeof import('../src/db/connection.js').disconnectDB;
  let ScanResultModel: typeof import('../src/db/models.js').ScanResultModel;
  let BugReportModel: typeof import('../src/db/models.js').BugReportModel;
  let createScansRouter: typeof import('../src/api/scans.js').createScansRouter;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    testEnv = await createTestEnv({ MONGODB_URI: mongo.getUri() });

    ({ connectDB, disconnectDB } = await import('../src/db/connection.js'));
    ({ ScanResultModel, BugReportModel } = await import('../src/db/models.js'));
    ({ createScansRouter } = await import('../src/api/scans.js'));

    await connectDB();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await disconnectDB();
    await cleanupTestEnv(testEnv);
    await mongo.stop();
  });

  it('creates a running scan record and kicks off the background scan', async () => {
    const scheduler = {
      getStatus: vi.fn(),
      updateScanConfig: vi.fn(),
      updateAuditConfig: vi.fn(),
    };
    const logScanner = {
      runScan: vi.fn().mockResolvedValue('scan-1'),
    };

    const app = createJsonApp(createScansRouter({
      ScanResultModel,
      BugReportModel,
      scheduler: scheduler as any,
      logScanner: logScanner as any,
      fetchLogHeatmap: vi.fn().mockResolvedValue([]) as any,
    }));

    const response = await request(app)
      .post('/trigger')
      .send({ timeSpan: '5m', severity: 'all' })
      .expect(201);

    const scan = await ScanResultModel.findById(response.body.scanId).lean();

    expect(scan?.status).toBe('running');
    expect(scan?.config).toMatchObject({ timeSpan: '5m', severity: 'all' });
    expect(logScanner.runScan).toHaveBeenCalledWith(
      { timeSpan: '5m', severity: 'all' },
      response.body.scanId,
    );
  });

  it('returns scheduler status', async () => {
    const scheduler = {
      getStatus: vi.fn().mockReturnValue({
        scan: { enabled: true },
        audit: { enabled: false },
      }),
      updateScanConfig: vi.fn(),
      updateAuditConfig: vi.fn(),
    };

    const app = createJsonApp(createScansRouter({
      ScanResultModel,
      BugReportModel,
      scheduler: scheduler as any,
      logScanner: { runScan: vi.fn() } as any,
      fetchLogHeatmap: vi.fn().mockResolvedValue([]) as any,
    }));

    const response = await request(app).get('/schedule/status').expect(200);

    expect(response.body).toEqual({
      scan: { enabled: true },
      audit: { enabled: false },
    });
  });

  it('forwards schedule updates to the scheduler dependency', async () => {
    const scheduler = {
      getStatus: vi.fn().mockReturnValue({
        scan: { enabled: true, cronExpression: '0 * * * *' },
        audit: { enabled: true, cronExpression: '0 3 * * *' },
      }),
      updateScanConfig: vi.fn(),
      updateAuditConfig: vi.fn(),
    };

    const app = createJsonApp(createScansRouter({
      ScanResultModel,
      BugReportModel,
      scheduler: scheduler as any,
      logScanner: { runScan: vi.fn() } as any,
      fetchLogHeatmap: vi.fn().mockResolvedValue([]) as any,
    }));

    await request(app)
      .put('/schedule')
      .send({
        scan: { enabled: true, timeSpan: '1h' },
        audit: { enabled: false, cronExpression: '0 6 * * *' },
      })
      .expect(200);

    expect(scheduler.updateScanConfig).toHaveBeenCalledWith({
      enabled: true,
      timeSpan: '1h',
    });
    expect(scheduler.updateAuditConfig).toHaveBeenCalledWith({
      enabled: false,
      cronExpression: '0 6 * * *',
    });
  });

  it('filters bug reports by query parameters', async () => {
    await BugReportModel.create([
      {
        source: 'log-scan',
        scanId: 'scan-1',
        pattern: 'Error A',
        severity: 'high',
        evidence: 'stack trace',
        suspectedRootCause: 'root cause',
        affectedFiles: ['src/a.ts'],
        status: 'reported',
      },
      {
        source: 'codebase-audit',
        scanId: 'scan-2',
        pattern: 'Error B',
        severity: 'low',
        evidence: 'logs',
        suspectedRootCause: 'other cause',
        affectedFiles: ['src/b.ts'],
        status: 'fixed',
      },
    ]);

    const app = createJsonApp(createScansRouter({
      ScanResultModel,
      BugReportModel,
      scheduler: {
        getStatus: vi.fn(),
        updateScanConfig: vi.fn(),
        updateAuditConfig: vi.fn(),
      } as any,
      logScanner: { runScan: vi.fn() } as any,
      fetchLogHeatmap: vi.fn().mockResolvedValue([]) as any,
    }));

    const response = await request(app)
      .get('/bugs')
      .query({ status: 'reported', severity: 'high' })
      .expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0].pattern).toBe('Error A');
  });

  it('returns scan records by id and 404s on missing records', async () => {
    await ScanResultModel.create({
      _id: 'scan-123',
      type: 'log',
      startedAt: new Date(),
      config: { timeSpan: '5m', severity: 'all' },
      logPatterns: [],
      newIssues: [],
      updatedIssues: [],
      resolvedIssues: [],
      status: 'completed',
    });

    const app = createJsonApp(createScansRouter({
      ScanResultModel,
      BugReportModel,
      scheduler: {
        getStatus: vi.fn(),
        updateScanConfig: vi.fn(),
        updateAuditConfig: vi.fn(),
      } as any,
      logScanner: { runScan: vi.fn() } as any,
      fetchLogHeatmap: vi.fn().mockResolvedValue([]) as any,
    }));

    const hit = await request(app).get('/scan-123').expect(200);
    const miss = await request(app).get('/missing').expect(404);

    expect(hit.body._id).toBe('scan-123');
    expect(miss.body.error).toBe('Scan not found');
  });

  it('returns historical heatmap buckets', async () => {
    const fetchLogHeatmap = vi.fn().mockResolvedValue([
      { hour: new Date('2026-03-25T10:00:00.000Z'), severity: 'error', count: 12 },
      { hour: new Date('2026-03-25T11:00:00.000Z'), severity: 'warn', count: 3 },
    ]);

    const app = createJsonApp(createScansRouter({
      ScanResultModel,
      BugReportModel,
      scheduler: {
        getStatus: vi.fn(),
        updateScanConfig: vi.fn(),
        updateAuditConfig: vi.fn(),
      } as any,
      logScanner: { runScan: vi.fn() } as any,
      fetchLogHeatmap: fetchLogHeatmap as any,
    }));

    const response = await request(app)
      .get('/heatmap')
      .query({ hours: 48, severity: 'warn-error' })
      .expect(200);

    expect(fetchLogHeatmap).toHaveBeenCalledWith(48, 'warn-error');
    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toMatchObject({ severity: 'error', count: 12 });
  });
});
