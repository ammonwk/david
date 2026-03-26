import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createJsonApp } from './helpers/app.js';
import { cleanupTestEnv, clearDatabase, createTestEnv, type TestEnvContext } from './helpers/test-env.js';

describe('state API router', () => {
  let mongo: MongoMemoryServer;
  let testEnv: TestEnvContext;
  let connectDB: typeof import('../src/db/connection.js').connectDB;
  let disconnectDB: typeof import('../src/db/connection.js').disconnectDB;
  let models: typeof import('../src/db/models.js');
  let runtimeSettings: typeof import('../src/runtime/runtime-settings.js');
  let createStateRouter: typeof import('../src/api/state.js').createStateRouter;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    testEnv = await createTestEnv({ MONGODB_URI: mongo.getUri() });

    ({ connectDB, disconnectDB } = await import('../src/db/connection.js'));
    models = await import('../src/db/models.js');
    runtimeSettings = await import('../src/runtime/runtime-settings.js');
    ({ createStateRouter } = await import('../src/api/state.js'));

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

  function buildApp() {
    return createJsonApp(createStateRouter({
      SREStateModel: models.SREStateModel,
      ScanResultModel: models.ScanResultModel,
      BugReportModel: models.BugReportModel,
      AgentModel: models.AgentModel,
      PullRequestModel: models.PullRequestModel,
      getRuntimeSettings: runtimeSettings.getRuntimeSettings,
      updateRuntimeSettings: runtimeSettings.updateRuntimeSettings,
    }));
  }

  it('returns the singleton SRE state', async () => {
    const app = buildApp();
    const response = await request(app).get('/').expect(200);

    expect(response.body.knownIssues).toEqual([]);
    expect(response.body.resolvedIssues).toEqual([]);
  });

  it('aggregates overview metrics from persisted state', async () => {
    const now = new Date();

    await runtimeSettings.updateRuntimeSettings('codex');
    await models.BugReportModel.create({
      source: 'log-scan',
      scanId: 'scan-1',
      pattern: 'Error A',
      severity: 'high',
      evidence: 'stack trace',
      suspectedRootCause: 'root cause',
      affectedFiles: ['src/a.ts'],
      status: 'reported',
    });
    await models.AgentModel.create([
      {
        type: 'fix',
        status: 'running',
        taskId: 'task-running',
        outputLog: [],
        restarts: 0,
        maxRestarts: 0,
        timeoutMs: 0,
        createdAt: now,
      },
      {
        type: 'fix',
        status: 'queued',
        taskId: 'task-queued',
        outputLog: [],
        restarts: 0,
        maxRestarts: 0,
        timeoutMs: 0,
        createdAt: now,
      },
    ]);
    await models.ScanResultModel.create([
      {
        _id: 'scan-log',
        type: 'log',
        startedAt: now,
        config: { timeSpan: '5m', severity: 'all' },
        logPatterns: [],
        newIssues: [],
        updatedIssues: [],
        resolvedIssues: [],
        status: 'completed',
      },
      {
        _id: 'scan-audit',
        type: 'audit',
        startedAt: now,
        config: { timeSpan: '5m', severity: 'all' },
        logPatterns: [],
        newIssues: [],
        updatedIssues: [],
        resolvedIssues: [],
        status: 'completed',
      },
    ]);
    await models.PullRequestModel.create({
      prNumber: 12,
      prUrl: 'https://example.com/pr/12',
      title: 'Fix outage',
      bugReportId: 'bug-1',
      agentId: 'agent-running',
      branch: 'sre/bug-1',
      status: 'merged',
      resolution: 'accepted',
      scanType: 'log',
      diff: 'diff --git a/file b/file',
      description: 'Fix outage',
      verificationMethod: 'code-review',
      createdAt: now,
      resolvedAt: now,
    });

    const app = buildApp();
    const response = await request(app).get('/overview').expect(200);

    expect(response.body).toMatchObject({
      bugsFoundToday: 1,
      prsCreatedToday: 1,
      prsAcceptedThisWeek: 1,
      activeAgents: 1,
      queuedAgents: 1,
      cliBackend: 'codex',
      systemStatus: 'running',
    });
  });

  it('validates runtime setting updates and persists valid changes', async () => {
    const app = buildApp();

    const bad = await request(app)
      .put('/runtime')
      .send({ cliBackend: 'invalid' })
      .expect(400);
    const good = await request(app)
      .put('/runtime')
      .send({ cliBackend: 'claude' })
      .expect(200);

    expect(bad.body.error).toContain('cliBackend must be');
    expect(good.body.cliBackend).toBe('claude');
  });

  it('updates the SRE state document', async () => {
    const app = buildApp();

    const response = await request(app)
      .put('/')
      .send({
        knownIssues: [
          {
            id: 'issue-1',
            pattern: 'Error A',
            severity: 'high',
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            status: 'active',
          },
        ],
      })
      .expect(200);

    expect(response.body.knownIssues).toHaveLength(1);
    expect(response.body.knownIssues[0].pattern).toBe('Error A');
  });
});
