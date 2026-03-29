import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createJsonApp } from './helpers/app.js';
import { cleanupTestEnv, clearDatabase, createTestEnv, type TestEnvContext } from './helpers/test-env.js';

describe('agents API router', () => {
  let mongo: MongoMemoryServer;
  let testEnv: TestEnvContext;
  let connectDB: typeof import('../src/db/connection.js').connectDB;
  let disconnectDB: typeof import('../src/db/connection.js').disconnectDB;
  let AgentModel: typeof import('../src/db/models.js').AgentModel;
  let createAgentsRouter: typeof import('../src/api/agents.js').createAgentsRouter;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    testEnv = await createTestEnv({ MONGODB_URI: mongo.getUri() });

    ({ connectDB, disconnectDB } = await import('../src/db/connection.js'));
    ({ AgentModel } = await import('../src/db/models.js'));
    ({ createAgentsRouter } = await import('../src/api/agents.js'));

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

  it('returns pool status, active agents, and queue state', async () => {
    const liveAgent = {
      toRecord: () => ({
        _id: 'live-1',
        type: 'fix',
        status: 'running',
        taskId: 'task-1',
        outputLog: [],
        restarts: 0,
        maxRestarts: 0,
        timeoutMs: 0,
        createdAt: new Date(),
      }),
      getOutputLog: () => ['line 1'],
    };
    const agentPool = {
      getStatus: vi.fn().mockReturnValue({
        activeCount: 1,
        maxConcurrent: 2,
        queuedCount: 1,
        completedCount: 0,
        failedCount: 0,
      }),
      getAgents: vi.fn().mockReturnValue([liveAgent.toRecord()]),
      getAgentsWithHistory: vi.fn().mockResolvedValue([liveAgent.toRecord()]),
      getQueue: vi.fn().mockReturnValue([{ _id: 'queued-1', status: 'queued' }]),
      getAgent: vi.fn().mockReturnValue(undefined),
      getAgentWithHistory: vi.fn().mockResolvedValue(undefined),
      stopAgent: vi.fn(),
      getMaxConcurrent: vi.fn().mockReturnValue(2),
      setMaxConcurrent: vi.fn().mockResolvedValue(undefined),
    };

    const app = createJsonApp(createAgentsRouter({
      agentPool: agentPool as any,
      AgentModel,
    }));

    const response = await request(app).get('/').expect(200);

    expect(response.body.activeCount).toBe(1);
    expect(response.body.queue[0]._id).toBe('queued-1');
  });

  it('returns live agents directly from the pool', async () => {
    const liveAgent = {
      toRecord: () => ({
        _id: 'live-1',
        type: 'fix',
        status: 'running',
        taskId: 'task-1',
        outputLog: [],
        restarts: 0,
        maxRestarts: 0,
        timeoutMs: 0,
        createdAt: new Date(),
      }),
      getOutputLog: () => ['line 1', 'line 2'],
    };
    const agentPool = {
      getStatus: vi.fn(),
      getAgents: vi.fn(),
      getAgentsWithHistory: vi.fn().mockResolvedValue([]),
      getQueue: vi.fn(),
      getAgent: vi.fn().mockReturnValue(liveAgent),
      getAgentWithHistory: vi.fn().mockReturnValue(liveAgent),
      stopAgent: vi.fn().mockResolvedValue(true),
      getMaxConcurrent: vi.fn().mockReturnValue(30),
      setMaxConcurrent: vi.fn().mockResolvedValue(undefined),
    };

    const app = createJsonApp(createAgentsRouter({
      agentPool: agentPool as any,
      AgentModel,
    }));

    const record = await request(app).get('/live-1').expect(200);
    const output = await request(app).get('/live-1/output').expect(200);
    const stop = await request(app).post('/live-1/stop').expect(200);

    expect(record.body._id).toBe('live-1');
    expect(output.body.output).toEqual(['line 1', 'line 2']);
    expect(stop.body.success).toBe(true);
  });

  it('falls back to MongoDB when the agent is no longer live', async () => {
    const created = await AgentModel.create({
      _id: 'historical-1',
      type: 'fix',
      status: 'completed',
      taskId: 'task-historical',
      outputLog: ['persisted line'],
      restarts: 0,
      maxRestarts: 0,
      timeoutMs: 0,
      createdAt: new Date(),
    });

    const agentPool = {
      getStatus: vi.fn(),
      getAgents: vi.fn(),
      getAgentsWithHistory: vi.fn().mockResolvedValue([]),
      getQueue: vi.fn(),
      getAgent: vi.fn().mockReturnValue(undefined),
      getAgentWithHistory: vi.fn().mockImplementation(async (id: string) => {
        // Simulate pool fallback to MongoDB for historical agents
        const doc = await AgentModel.findById(id).lean();
        return doc ?? undefined;
      }),
      stopAgent: vi.fn().mockResolvedValue(false),
      getMaxConcurrent: vi.fn().mockReturnValue(30),
      setMaxConcurrent: vi.fn().mockResolvedValue(undefined),
    };

    const app = createJsonApp(createAgentsRouter({
      agentPool: agentPool as any,
      AgentModel,
    }));

    const agentId = created._id.toString();
    const record = await request(app).get(`/${agentId}`).expect(200);
    const output = await request(app).get(`/${agentId}/output`).expect(200);
    const stop = await request(app).post(`/${agentId}/stop`).expect(404);

    expect(record.body._id).toBe(agentId);
    expect(output.body.output).toEqual(['persisted line']);
    expect(stop.body.error).toBe('Agent not found or not running');
  });
});
